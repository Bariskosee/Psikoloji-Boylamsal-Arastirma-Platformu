import { notificationSendPayloadSchema, type NotificationSendPayload } from "@lpr/contracts";
import { defineJob, type JobDefinition } from "./job-definition.js";

/**
 * The job definitions this system actually runs (ADR-004, PLAN.md Phase 9).
 *
 * Declared here, in `@lpr/db`, because both the process that ENQUEUES and the
 * process that CONSUMES must agree on every part of the delivery policy — and
 * `apps/api` and `apps/worker` are forbidden from importing each other
 * (STRUCTURE.md §3). One definition, imported twice, is what makes disagreement
 * impossible rather than merely unlikely.
 *
 * Phase 9 is the first phase to define a job at all. Everything before it was
 * done by reconciliation sweepers, which is ADR-005 working as intended: jobs
 * make the system prompt, sweepers make it correct. A notification is the first
 * piece of work where promptness is the whole point — a reminder that arrives
 * up to a sweep interval late is fine, but one that arrives up to a sweep
 * interval late *and* was never enqueued would mean the participant's phone
 * stays silent until the next cycle.
 */

/**
 * `notification.send` — one link in a reminder chain.
 *
 * ── Deduplication ───────────────────────────────────────────────────────────
 * `while-queued`, keyed on (session, kind, occurrence). Two sources can enqueue
 * the same link: the previous link's handler, and the notifications-due sweeper
 * that exists precisely so a lost job does not silence a participant. Collapsing
 * them in the queue keeps the common case clean.
 *
 * It is NOT the guarantee. The `notification_attempts` unique index is, because
 * a job that has already left the queue and is running cannot be collapsed with
 * one being enqueued now. Both exist, and only the second is load-bearing.
 *
 * ── Retries ─────────────────────────────────────────────────────────────────
 * `retryLimit: 0`. This is the one job in the system that must not retry, and
 * the reason is the whole of STRUCTURE.md §9.1: the attempt row is committed
 * BEFORE the network call, so a handler that dies mid-send has already recorded
 * that it may have sent. A retry would find that row, stop at the idempotency
 * guard, and achieve nothing — or, if the row were written after the send
 * instead, would notify the participant twice.
 *
 * At-most-once is chosen deliberately. Losing a reminder costs one nudge;
 * double-notifying is an annoyance and a compliance-data artefact that no later
 * analysis can distinguish from a genuine second contact.
 *
 * A genuinely transient failure — the database was unreachable before the
 * attempt row was written — is caught by the notifications-due sweeper on its
 * next cycle, which is the same safety net every other piece of work in this
 * system relies on.
 *
 * ── Expiry ──────────────────────────────────────────────────────────────────
 * Short. A notification job that has been held for two minutes is a job whose
 * moment has passed; guard 8 would suppress it anyway, and releasing it early
 * lets the sweeper make a fresh decision with fresh state.
 */
export const NOTIFICATION_SEND_JOB: JobDefinition<NotificationSendPayload> = defineJob({
  name: "notification.send",
  payload: notificationSendPayloadSchema,
  dedupe: "while-queued",
  retry: { retryLimit: 0, retryDelaySeconds: 30, retryBackoff: false },
  expireInSeconds: 120,
  // Longer than the default: these rows are the operational evidence for "did
  // the reminder actually fire, and when". The canonical answer lives in
  // `notification_attempts`, but a dead-lettered job is how an operator finds
  // out the canonical record is missing something.
  retentionDays: 30,
});

/** The singleton key that collapses duplicate sends of the same chain link. */
export function notificationSingletonKey(payload: NotificationSendPayload): string {
  return `${payload.sessionId}:${payload.kind}:${String(payload.occurrenceIndex)}`;
}

/** Every definition this system registers, for the worker to create at boot. */
export const ALL_JOB_DEFINITIONS: readonly JobDefinition<never>[] = Object.freeze([
  NOTIFICATION_SEND_JOB as JobDefinition<never>,
]);
