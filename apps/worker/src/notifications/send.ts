import {
  NOTIFICATION_SEND_JOB,
  notificationSingletonKey,
  type JobQueue,
  type Pool,
  type PoolClient,
} from "@lpr/db";
import {
  evaluateNotification,
  nextChainLink,
  resolveQuietHoursZone,
  type NotificationDecision,
  type NotificationPolicy,
  type SessionStatus,
} from "@lpr/domain";
import {
  isoDurationSeconds,
  type Locale,
  type NotificationKind,
  type PushPayload,
} from "@lpr/contracts";
/**
 * The notification strings come from the shared catalogs, not from this file.
 *
 * AGENT.md §3.4 forbids hard-coding user-visible language, and the catalog
 * parity test in `@lpr/i18n` is what stops a string being added in English and
 * forgotten in Turkish — which for a push notification would mean a Turkish
 * participant receiving an English lock-screen message from a study they joined
 * in Turkish.
 */
import en from "@lpr/i18n/messages/en.json";
import tr from "@lpr/i18n/messages/tr.json";
import type { PushTransport } from "./transport.js";

/**
 * The send pipeline (PLAN.md Phase 9, STRUCTURE.md §9.1).
 *
 * ONE implementation of the guard chain's execution, called from two places:
 * the `notification.send` job handler, and the `sweep.notifications_due`
 * sweeper that exists so a lost job cannot silence a participant. Two
 * implementations would eventually disagree, and the disagreement would show up
 * as a participant notified twice — which is the one failure this subsystem is
 * built to prevent.
 *
 * ── The transaction shape, and why it is what it is ─────────────────────────
 *
 *   T1: BEGIN; SELECT … FOR UPDATE on the session
 *       re-read canonical state, run the guard chain
 *       write the attempt row (ATTEMPTED, or SUPPRESSED with its reason)
 *       enqueue the next link of the chain
 *       COMMIT                          ← before any network call
 *
 *       send over the network
 *
 *   T2: UPDATE the attempt row with the outcome
 *       deactivate the subscription if the service said it is gone
 *
 * **T1 commits before the send.** A process that dies between T1 and T2 leaves
 * a row reading `ATTEMPTED`, which is exactly right: we may or may not have
 * sent it, and we will not try again. At-most-once is the deliberate choice —
 * losing a reminder costs one nudge, while notifying someone twice is an
 * annoyance and a compliance-data artefact no later analysis can distinguish
 * from a genuine second contact.
 *
 * **The next link is enqueued in T1, not T2.** It commits with the attempt row,
 * so a crash during the network call cannot break the chain. Enqueuing after a
 * successful send would make the chain's survival depend on the least reliable
 * step in the whole sequence.
 *
 * **Completion cannot race a send.** `POST /complete` sets COMPLETED while
 * holding this same row lock, so an in-flight handler blocks on it, then reads
 * COMPLETED and fails guard 1 (STRUCTURE.md §9.2). No job-cancellation API is
 * needed, and none is trusted.
 */

const CATALOGS: Record<Locale, { push: Record<string, string> }> = {
  en: en as { push: Record<string, string> },
  tr: tr as { push: Record<string, string> },
};

export interface SendDependencies {
  readonly pool: Pool;
  readonly transport: PushTransport;
  /** Null when the queue is unavailable; the chain then relies on the sweeper. */
  readonly queue: JobQueue | null;
  readonly logger: { info(m: string): void; warn(m: string): void; error(m: string): void };
}

export interface SendRequest {
  readonly sessionId: string;
  readonly kind: NotificationKind;
  readonly occurrenceIndex: number;
  readonly scheduledFor: Date;
}

export type SendResult =
  | { readonly status: "SENT" }
  | { readonly status: "SEND_FAILED" }
  | { readonly status: "SUPPRESSED"; readonly reason: string }
  | { readonly status: "DEFERRED"; readonly until: Date }
  | { readonly status: "ALREADY_ATTEMPTED" }
  /** The session vanished between the claim and the lock. */
  | { readonly status: "SESSION_GONE" };

interface LockedRow {
  session_status: string;
  available_until: Date | null;
  participant_id: string;
  participant_status: string;
  participant_locale: string;
  participant_timezone: string | null;
  study_timezone: string;
  max_reminders: number | null;
  interval_iso: string | null;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  quiet_hours_behavior: string | null;
  attempt_exists: boolean;
  subscription_id: string | null;
  endpoint: string | null;
  p256dh_key: string | null;
  auth_key: string | null;
  db_now: Date;
}

/**
 * Everything the guard chain needs, read under one lock, at one instant.
 *
 * `now()` comes from the DATABASE and is selected in the same statement as the
 * row. Two workers with drifted process clocks would otherwise disagree about
 * quiet hours and about staleness — and a worker an hour fast would notify
 * participants an hour inside their quiet window with nothing in the system to
 * contradict it. The same discipline as the Phase 7 sweepers, for the same
 * reason.
 *
 * The subscription is picked as the most recently seen ACTIVE one. A
 * participant with two devices gets the one they used last, which is the best
 * available guess at where they are — and sending to every device would
 * multiply one reminder into several buzzes for one person.
 */
const LOCK_SQL = `
  SELECT s.status                              AS session_status,
         s.available_until,
         p.id                                  AS participant_id,
         p.status                              AS participant_status,
         p.locale                              AS participant_locale,
         p.timezone                            AS participant_timezone,
         st.timezone                           AS study_timezone,
         rp.max_reminders,
         rp.interval_iso,
         rp.quiet_hours_start,
         rp.quiet_hours_end,
         rp.quiet_hours_behavior,
         EXISTS (
           SELECT 1 FROM research.notification_attempts na
            WHERE na.session_id = s.id AND na.kind = $2 AND na.occurrence_index = $3
         )                                     AS attempt_exists,
         sub.id                                AS subscription_id,
         sub.endpoint,
         sub.p256dh_key,
         sub.auth_key,
         now()                                 AS db_now
    FROM research.participant_sessions s
    JOIN research.participants p   ON p.id  = s.participant_id
    JOIN research.studies st       ON st.id = s.study_id
    JOIN research.protocol_steps ps ON ps.id = s.protocol_step_id
    LEFT JOIN research.reminder_policies rp ON rp.id = ps.reminder_policy_id
    LEFT JOIN LATERAL (
      SELECT ps2.id, ps2.endpoint, ps2.p256dh_key, ps2.auth_key
        FROM identity.push_subscriptions ps2
       WHERE ps2.participant_id = s.participant_id AND ps2.is_active = true
       ORDER BY ps2.last_seen_at DESC
       LIMIT 1
    ) sub ON true
   WHERE s.id = $1
   FOR UPDATE OF s`;

export async function processNotification(
  deps: SendDependencies,
  request: SendRequest,
): Promise<SendResult> {
  const client = await deps.pool.connect();

  let committed: {
    attemptId: string;
    target: { subscriptionId: string; endpoint: string; p256dh: string; auth: string };
    payload: PushPayload;
  } | null = null;
  let decision: NotificationDecision | null = null;

  try {
    await client.query("BEGIN");

    const locked = await client.query<LockedRow>(LOCK_SQL, [
      request.sessionId,
      request.kind,
      request.occurrenceIndex,
    ]);
    const row = locked.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return { status: "SESSION_GONE" };
    }

    const policy = readPolicy(row);
    const now = row.db_now;

    decision = evaluateNotification(
      {
        kind: request.kind,
        occurrenceIndex: request.occurrenceIndex,
        scheduledFor: request.scheduledFor,
        sessionStatus: row.session_status as SessionStatus,
        availableUntil: row.available_until,
        participantActive: row.participant_status === "ACTIVE",
        attemptAlreadyRecorded: row.attempt_exists,
        hasActiveSubscription: row.subscription_id !== null,
        timezone: resolveQuietHoursZone(row.participant_timezone, row.study_timezone),
        policy,
      },
      now,
    );

    if (decision.action === "ALREADY_ATTEMPTED") {
      await client.query("ROLLBACK");
      return { status: "ALREADY_ATTEMPTED" };
    }

    if (decision.action === "DEFER") {
      // Nothing is recorded. The notification has not been decided about — it
      // will run the whole guard chain again when the quiet window ends, and by
      // then the participant may well have finished.
      await enqueue(deps, client, request, decision.until);
      await client.query("COMMIT");
      return { status: "DEFERRED", until: decision.until };
    }

    if (decision.action === "SUPPRESS") {
      await recordAttempt(client, row, request, {
        outcome: "SUPPRESSED",
        suppressionReason: decision.reason,
      });

      if (decision.continueChain) {
        await enqueueNextLink(deps, client, request, policy);
      }

      await client.query("COMMIT");
      return { status: "SUPPRESSED", reason: decision.reason };
    }

    // ── SEND ────────────────────────────────────────────────────────────────
    const attemptId = await recordAttempt(client, row, request, {
      outcome: "ATTEMPTED",
      attemptedAt: now,
      pushSubscriptionId: row.subscription_id,
    });

    // Enqueued here, inside T1, so a crash during the network call below cannot
    // break the chain.
    await enqueueNextLink(deps, client, request, policy);

    await client.query("COMMIT");

    committed = {
      attemptId,
      target: {
        subscriptionId: row.subscription_id as string,
        endpoint: row.endpoint as string,
        p256dh: row.p256dh_key as string,
        auth: row.auth_key as string,
      },
      payload: buildPayload(request.kind, request.sessionId, row.participant_locale as Locale),
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  if (committed === null) return { status: "ALREADY_ATTEMPTED" };

  // ── The network call, outside any transaction ─────────────────────────────
  const result = await deps.transport.send(
    {
      endpoint: committed.target.endpoint,
      p256dh: committed.target.p256dh,
      auth: committed.target.auth,
    },
    committed.payload,
  );

  // ── T2: record what the push service said ─────────────────────────────────
  if (result.outcome === "ACCEPTED") {
    await deps.pool.query(
      `UPDATE research.notification_attempts
          SET outcome = 'SENT_ACCEPTED', push_status_code = $2, updated_at = now()
        WHERE id = $1`,
      [committed.attemptId, result.statusCode],
    );
    return { status: "SENT" };
  }

  await deps.pool.query(
    `UPDATE research.notification_attempts
        SET outcome = 'FAILED', push_status_code = $2, error_detail = $3, updated_at = now()
      WHERE id = $1`,
    [
      committed.attemptId,
      result.statusCode,
      result.outcome === "GONE" ? "subscription gone" : result.detail,
    ],
  );

  if (result.outcome === "GONE") {
    /**
     * 404 or 410: this subscription is permanently finished (ADR-006).
     *
     * Deactivated immediately rather than left for the retention sweeper to
     * notice. Every later link in this chain would otherwise select the same
     * dead endpoint and fail identically, filling the attempt table with
     * failures that all describe one fact.
     */
    await deps.pool.query(
      `UPDATE identity.push_subscriptions
          SET is_active = false,
              deactivated_at = now(),
              deactivation_reason = 'REJECTED_BY_SERVICE',
              updated_at = now()
        WHERE id = $1 AND is_active = true`,
      [committed.target.subscriptionId],
    );
    deps.logger.info(
      `push subscription deactivated after ${String(result.statusCode)} from the push service`,
    );
  }

  return { status: "SEND_FAILED" };
}

/**
 * Insert the attempt row.
 *
 * A unique violation here means another worker got there first, which is the
 * duplicate-delivery case the constraint exists for. It is re-raised so the
 * caller's transaction rolls back and nothing is double-recorded; callers treat
 * it as `ALREADY_ATTEMPTED`.
 */
async function recordAttempt(
  client: PoolClient,
  row: LockedRow,
  request: SendRequest,
  outcome: {
    outcome: string;
    suppressionReason?: string;
    attemptedAt?: Date;
    pushSubscriptionId?: string | null;
  },
): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO research.notification_attempts
       (session_id, participant_id, kind, occurrence_index, push_subscription_id,
        scheduled_for, attempted_at, outcome, suppression_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      request.sessionId,
      row.participant_id,
      request.kind,
      request.occurrenceIndex,
      outcome.pushSubscriptionId ?? null,
      request.scheduledFor,
      outcome.attemptedAt ?? null,
      outcome.outcome,
      outcome.suppressionReason ?? null,
    ],
  );

  const id = inserted.rows[0]?.id;
  if (id === undefined) throw new Error("notification attempt insert returned no row");
  return id;
}

async function enqueueNextLink(
  deps: SendDependencies,
  client: PoolClient,
  request: SendRequest,
  policy: NotificationPolicy,
): Promise<void> {
  const next = nextChainLink({
    kind: request.kind,
    occurrenceIndex: request.occurrenceIndex,
    scheduledFor: request.scheduledFor,
    policy,
  });
  if (next === null) return;

  await enqueue(
    deps,
    client,
    { ...request, kind: "REMINDER", occurrenceIndex: next.occurrenceIndex },
    next.scheduledFor,
  );
}

/**
 * Enqueue one link, transactionally with the caller's writes (ADR-004).
 *
 * A queue that is unavailable is logged and tolerated, not thrown. The
 * notifications-due sweeper re-derives the whole chain from
 * `notification_attempts` every cycle, so a lost enqueue costs promptness and
 * not correctness — which is the entire point of ADR-005.
 */
async function enqueue(
  deps: SendDependencies,
  client: PoolClient,
  request: SendRequest,
  when: Date,
): Promise<void> {
  if (deps.queue === null) return;

  const payload = {
    sessionId: request.sessionId,
    kind: request.kind,
    occurrenceIndex: request.occurrenceIndex,
    scheduledFor: when.toISOString(),
  };

  try {
    await deps.queue.send(NOTIFICATION_SEND_JOB, payload, {
      singletonKey: notificationSingletonKey(payload),
      startAfter: when,
      connection: {
        executeSql: async (text: string, values: unknown[]) => await client.query(text, values),
      },
    });
  } catch (error) {
    deps.logger.warn(
      `could not enqueue the next notification link; the sweeper will pick it up: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Read the reminder policy, or the implied one for a step that has none.
 *
 * A step with no `reminder_policy_id` is a step the researcher chose not to
 * chase. It still gets its INITIAL notification — the participant has to learn
 * the questionnaire is open somehow — and no reminders at all. Modelling that
 * as `maxReminders: 0` puts it through the same guard chain as everything else
 * rather than adding a branch that would need its own tests.
 */
function readPolicy(row: LockedRow): NotificationPolicy {
  const quietHours =
    row.quiet_hours_start !== null && row.quiet_hours_end !== null
      ? { start: row.quiet_hours_start, end: row.quiet_hours_end }
      : null;

  return {
    maxReminders: row.max_reminders ?? 0,
    // Converted from the stored ISO-8601 duration. `isoDurationSeconds` lives
    // in the dependency leaf precisely so a duration can be measured without
    // pulling a date library into every consumer.
    intervalMs: row.interval_iso === null ? 0 : isoDurationSeconds(row.interval_iso) * 1000,
    quietHours,
    quietHoursBehavior: (row.quiet_hours_behavior as "SKIP" | "DEFER" | null) ?? "SKIP",
  };
}

/**
 * The push payload — generic, localised, and carrying NO research content
 * (ADR-006, STRUCTURE.md §9.4).
 *
 * Payloads pass through Google's, Apple's or Mozilla's infrastructure. No
 * question text, no answers, and not even the questionnaire's name: a study
 * about a sensitive topic must not announce itself on a lock screen in front of
 * whoever is standing next to the participant.
 *
 * The only identifier is the session id, and the page it opens re-authorises
 * from the credential rather than trusting it.
 */
function buildPayload(kind: NotificationKind, sessionId: string, locale: Locale): PushPayload {
  const catalog = CATALOGS[locale] ?? CATALOGS.en;
  const prefix = kind === "INITIAL" ? "initial" : "reminder";

  return {
    title: catalog.push[`${prefix}Title`] ?? "",
    body: catalog.push[`${prefix}Body`] ?? "",
    locale,
    sessionId,
    // Collapses an older notification for the same session on the device, so a
    // participant who missed three reminders finds one notification waiting
    // rather than a stack of three saying the same thing.
    tag: `session:${sessionId}`,
  };
}
