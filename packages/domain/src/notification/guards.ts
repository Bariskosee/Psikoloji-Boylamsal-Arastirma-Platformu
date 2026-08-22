import type { NotificationKind, NotificationSuppressionReason } from "@lpr/contracts";
import { classifyStaleness, reminderStalenessToleranceMs } from "../scheduling/staleness.js";
import type { SessionStatus } from "../session/state-machine.js";
import { isWithinQuietHours, quietHoursEndAfter, type QuietHours } from "./quiet-hours.js";

/**
 * The notification guard chain (STRUCTURE.md §9.1, PLAN.md Phase 9).
 *
 * Eight guards, in a fixed order, deciding whether one link in a reminder chain
 * may be sent. This function is the whole decision; the handler around it
 * supplies canonical state read under a row lock and then does as it is told.
 *
 * ── Why the ORDER is part of the contract ───────────────────────────────────
 * Several guards would stop the same notification, and which one *reports* it
 * changes what the data means. A participant who completed their questionnaire
 * during quiet hours must be recorded as `SUPPRESSED_STATE` — "they were
 * finished" — and never as `SUPPRESSED_QUIET_HOURS`, which would read as "we
 * chose not to contact them" and quietly turn a success into an apparent
 * outreach failure in every later analysis.
 *
 * So the chain runs cheapest-and-most-final first:
 *
 *   1. state       the session is closed. Completion lands here (FR-18).
 *   2. expired     the window has passed.
 *   3. withdrawn   the participant has left (FR-30).
 *   4. cap         the policy's reminder limit (FR-40).
 *   5. duplicate   this exact attempt already exists — idempotency.
 *   6. no sub      nothing to send to.
 *   7. quiet hours skip, or defer to the end of the window (FR-40).
 *   8. stale       too late to be worth sending (ADR-005, no post-outage burst).
 *
 * Guards 1–4 are facts about whether this notification was ever owed. Guards
 * 5–8 are facts about this particular attempt. Putting the first group first
 * means a suppression reason always names the most fundamental cause.
 *
 * ── Why the cap is checked before the duplicate guard ───────────────────────
 * A cap breach means the chain should have stopped earlier — a bug, or a policy
 * edited between links. Reporting it as `SUPPRESSED_CAP` says so. Letting the
 * duplicate guard answer first would report "already attempted", which is both
 * less true and unactionable.
 *
 * Pure and clock-free: `now` is an argument. Every branch below is a unit test
 * rather than a scenario someone has to reproduce against a live queue.
 */

export interface NotificationPolicy {
  /** FR-40: mandatory, and 0 legitimately means "notify once, never chase". */
  readonly maxReminders: number;
  /** Spacing between reminders, in milliseconds. */
  readonly intervalMs: number;
  /** Null when the study set no quiet window. */
  readonly quietHours: QuietHours | null;
  readonly quietHoursBehavior: "SKIP" | "DEFER";
}

export interface NotificationContext {
  readonly kind: NotificationKind;
  /** 0 for the initial notification; 1..n for reminders. */
  readonly occurrenceIndex: number;
  /** When this link was asked to run. Guard 8 measures lateness from it. */
  readonly scheduledFor: Date;

  readonly sessionStatus: SessionStatus;
  /** Null only for a session with no computed window, which cannot be open. */
  readonly availableUntil: Date | null;
  readonly participantActive: boolean;
  /** True when an attempt row for this (session, kind, occurrence) exists. */
  readonly attemptAlreadyRecorded: boolean;
  readonly hasActiveSubscription: boolean;

  /** The zone quiet hours are read in — participant's, else the study's. */
  readonly timezone: string;
  readonly policy: NotificationPolicy;
}

export type NotificationDecision =
  | { readonly action: "SEND" }
  | {
      readonly action: "SUPPRESS";
      readonly reason: NotificationSuppressionReason;
      /**
       * True when the chain should still schedule its next link. Only quiet-hours
       * SKIP sets this: the participant was not disturbed *this* time, but the
       * chain is alive and tomorrow's reminder is still owed. Every other
       * suppression is terminal.
       */
      readonly continueChain: boolean;
    }
  /** Quiet-hours DEFER: not suppressed, just moved. Nothing is recorded. */
  | { readonly action: "DEFER"; readonly until: Date }
  /**
   * The duplicate guard. Distinct from SUPPRESS because there is nothing to
   * record — the attempt row this would duplicate already says what happened.
   * Writing a second suppression row would corrupt the very count that makes
   * "how many times was this participant contacted?" answerable.
   */
  | { readonly action: "ALREADY_ATTEMPTED" };

export function evaluateNotification(
  context: NotificationContext,
  now: Date,
): NotificationDecision {
  // ── 1. The session is no longer open ──────────────────────────────────────
  // COMPLETED lands here, and this is how FR-18 is enforced: the handler takes
  // the same row lock `POST /complete` holds, so an in-flight reminder blocks
  // on the completion and then sees it (STRUCTURE.md §9.2). No job-cancellation
  // API is needed, or trusted.
  if (context.sessionStatus !== "AVAILABLE" && context.sessionStatus !== "STARTED") {
    return { action: "SUPPRESS", reason: "SUPPRESSED_STATE", continueChain: false };
  }

  // ── 2. The window has closed ──────────────────────────────────────────────
  // Checked against the window itself rather than trusting the status label: a
  // session the expiry sweeper has not reached yet is still expired in fact,
  // and chasing someone about a questionnaire they can no longer open is worse
  // than saying nothing.
  if (context.availableUntil === null || context.availableUntil.getTime() <= now.getTime()) {
    return { action: "SUPPRESS", reason: "SUPPRESSED_EXPIRED", continueChain: false };
  }

  // ── 3. The participant has withdrawn ──────────────────────────────────────
  // Withdrawal already deactivates their subscriptions (Phase 8), so guard 6
  // would usually catch this too. It is checked separately and earlier because
  // the REASON matters: "they left" and "we had no way to reach them" are
  // different facts, and only one of them is a delivery problem worth chasing.
  if (!context.participantActive) {
    return { action: "SUPPRESS", reason: "SUPPRESSED_WITHDRAWN", continueChain: false };
  }

  // ── 4. The reminder cap (FR-40) ───────────────────────────────────────────
  // The cap counts REMINDERS. The initial notification is not a reminder and is
  // not counted against it — a policy of `maxReminders: 0` means "tell them
  // once, then leave them alone", which is a legitimate and gentle design, not
  // a policy that sends nothing.
  if (context.kind === "REMINDER" && context.occurrenceIndex > context.policy.maxReminders) {
    return { action: "SUPPRESS", reason: "SUPPRESSED_CAP", continueChain: false };
  }

  // ── 5. Idempotency ────────────────────────────────────────────────────────
  // At-least-once delivery means this handler WILL run twice for the same job.
  // The database's unique constraint on (session, kind, occurrence) is the real
  // guarantee; this is the cheap check that keeps the common case from relying
  // on a constraint violation.
  if (context.attemptAlreadyRecorded) {
    return { action: "ALREADY_ATTEMPTED" };
  }

  // ── 6. Nothing to send to ─────────────────────────────────────────────────
  // Terminal for this occurrence, and deliberately NOT for the chain: a
  // participant who re-enables notifications tomorrow should get tomorrow's
  // reminder. The chain is driven by the next link's own enqueue, so returning
  // false here only stops this one.
  if (!context.hasActiveSubscription) {
    return { action: "SUPPRESS", reason: "SUPPRESSED_NO_SUBSCRIPTION", continueChain: false };
  }

  // ── 7. Quiet hours (FR-40) ────────────────────────────────────────────────
  if (context.policy.quietHours !== null) {
    if (isWithinQuietHours(now, context.timezone, context.policy.quietHours)) {
      if (context.policy.quietHoursBehavior === "DEFER") {
        // Moved, not suppressed. Nothing is recorded, because nothing has yet
        // been decided about this notification — it will run the guard chain
        // again from the top when the window ends, and by then the session may
        // well be completed.
        return {
          action: "DEFER",
          until: quietHoursEndAfter(now, context.timezone, context.policy.quietHours),
        };
      }

      // SKIP: this reminder is dropped, and the chain continues. The researcher
      // asked for a cadence, not for every link of it to be delivered — and
      // stopping the chain here would mean a single overnight reminder silently
      // ended all contact for the rest of the window.
      return { action: "SUPPRESS", reason: "SUPPRESSED_QUIET_HOURS", continueChain: true };
    }
  }

  // ── 8. Too late to be worth sending (ADR-005) ─────────────────────────────
  // The post-outage burst guard. After an eight-hour outage the sweepers
  // correctly discover every notification that was owed; sending them all is
  // literally correct and operationally indefensible.
  //
  // Last in the chain on purpose. It is the only guard whose answer depends on
  // how long the SYSTEM was broken rather than on anything about the
  // participant, so every reason that describes them gets to answer first.
  const staleness = classifyStaleness({
    scheduledFor: context.scheduledFor,
    toleranceMs: reminderStalenessToleranceMs(context.policy.intervalMs),
    clock: { now: () => now },
  });
  if (staleness.stale) {
    // The chain does NOT continue. Its later links are stale too, and
    // re-enqueueing from here is how a suppressed burst becomes a delayed one.
    return { action: "SUPPRESS", reason: "SUPPRESSED_STALE", continueChain: false };
  }

  return { action: "SEND" };
}

/**
 * When the next link in the chain should run, or null when there is none.
 *
 * Self-chaining (STRUCTURE.md §9.1): reminder *n* schedules reminder *n+1*.
 * Nothing is pre-scheduled, so nothing has to be cancelled when a participant
 * completes — the chain simply stops being extended, and any link already in
 * flight fails guard 1.
 *
 * Measured from the instant this link was SCHEDULED for, not from now. Chaining
 * off `now` would let each delay's jitter accumulate, so a policy of "every
 * three hours" would drift later all day; and after a deferral it would push
 * the whole remaining chain past the end of the window.
 */
export function nextChainLink(
  context: Pick<NotificationContext, "kind" | "occurrenceIndex" | "scheduledFor" | "policy">,
): { readonly occurrenceIndex: number; readonly scheduledFor: Date } | null {
  const nextIndex = context.kind === "INITIAL" ? 1 : context.occurrenceIndex + 1;

  if (nextIndex > context.policy.maxReminders) return null;

  return {
    occurrenceIndex: nextIndex,
    scheduledFor: new Date(context.scheduledFor.getTime() + context.policy.intervalMs),
  };
}
