import { NOTIFICATION_SEND_JOB, type JobQueue } from "@lpr/db";
import type { NotificationSendPayload } from "@lpr/contracts";
import { processNotification, type SendDependencies } from "./send.js";

/**
 * The `notification.send` job handler (ADR-004, ADR-005, PLAN.md Phase 9).
 *
 * The first job handler in this system. Everything before Phase 9 was done by
 * reconciliation sweepers, which is ADR-005 working as designed — jobs make the
 * system prompt, sweepers make it correct. A reminder is the first piece of
 * work where promptness is the whole point: a notification that arrives when
 * the next sweep happens to run is a notification whose timing the researcher
 * did not choose.
 *
 * The handler itself is four lines, and that is the design. Every guard, every
 * transaction boundary and every write lives in `processNotification`, which
 * the notifications-due sweeper calls identically. Two callers, one
 * implementation: a divergence between them would surface as a participant
 * notified twice, and it would surface in production rather than in a test.
 */
export async function registerNotificationHandler(
  queue: JobQueue,
  deps: SendDependencies,
): Promise<void> {
  await queue.work<NotificationSendPayload>(NOTIFICATION_SEND_JOB, async (payload, context) => {
    const result = await processNotification(deps, {
      sessionId: payload.sessionId,
      kind: payload.kind,
      occurrenceIndex: payload.occurrenceIndex,
      scheduledFor: new Date(payload.scheduledFor),
    });

    /**
     * Logged as counts and outcomes, never as identifiers.
     *
     * A job id and a result are what an operator needs; a participant id is
     * what AGENT.md §5 forbids putting in a log by default. The canonical
     * record of who was contacted is `notification_attempts`, which lives
     * behind the same access controls as the rest of the research data.
     */
    deps.logger.info(
      `${NOTIFICATION_SEND_JOB.name} job ${context.jobId}: ${result.status}` +
        (result.status === "SUPPRESSED" ? ` (${result.reason})` : ""),
    );
  });
}
