import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { notificationAttempts, type Database } from "@lpr/db";
import type {
  NotificationHistoryEntry,
  NotificationKind,
  NotificationOutcome,
  NotificationSuppressionReason,
  ReportNotificationEventRequest,
} from "@lpr/contracts";
import { ApiErrors } from "../../common/api-error.js";
import { DATABASE } from "../database/database.module.js";

/**
 * The participant's side of the notification record (PLAN.md Phase 9).
 *
 * Two jobs, and neither of them is sending: the API never sends a push. The
 * worker owns that entirely, because it owns the VAPID private key and because
 * sending from a request handler would tie a participant's reminder to whether
 * an API instance happened to be awake.
 *
 * What lives here is the participant-facing half — what they were sent, and
 * what their device managed to tell us about it afterwards.
 */
@Injectable()
export class NotificationService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Record a best-effort client event (FR-19, STRUCTURE.md §9.3).
   *
   * ── Why this updates rather than inserts ────────────────────────────────
   * The attempt row already exists — the server wrote it before sending. A
   * client report is new information *about* that attempt, not a new event of
   * its own, and modelling it as a row would let a device fabricate contacts
   * that never happened and inflate every outreach count in the study.
   *
   * ── Why it is scoped by participant in the WHERE clause ─────────────────
   * The client supplies a session id from a push payload. Trusting it and
   * checking ownership afterwards would let anyone holding a session id stamp
   * "clicked" onto somebody else's record. Scoping the update itself means an
   * unauthorised report simply matches nothing.
   *
   * ── Why these timestamps are never a denominator ────────────────────────
   * The service worker is not running when the device is off, when it has been
   * killed under memory pressure, or — on iOS — reliably at all. An absent
   * `displayed_at` means "we do not know", never "it was not displayed". The
   * column comment and STRUCTURE.md §9.3 both say so, and any analysis built on
   * this must repeat it.
   */
  async recordClientEvent(
    participantId: string,
    input: ReportNotificationEventRequest,
    now: Date,
  ): Promise<void> {
    const updated = await this.db
      .update(notificationAttempts)
      .set(
        input.event === "DISPLAYED"
          ? { displayedAt: now, updatedAt: now }
          : { clickedAt: now, updatedAt: now },
      )
      .where(
        and(
          eq(notificationAttempts.participantId, participantId),
          eq(notificationAttempts.sessionId, input.sessionId),
          eq(notificationAttempts.kind, input.kind),
          eq(notificationAttempts.occurrenceIndex, input.occurrenceIndex),
        ),
      )
      .returning({ id: notificationAttempts.id });

    if (updated.length === 0) throw ApiErrors.notificationAttemptNotFound();
  }

  /**
   * What this study has sent this participant, newest first.
   *
   * Suppressions are included, deliberately. "We did not remind you because you
   * had already finished" is a more honest answer than a gap, and a participant
   * who believes they were never told is otherwise unanswerable — the record
   * exists partly so that question has an answer.
   *
   * Bounded, because a thirty-occurrence daily block with four reminders each
   * is a hundred and twenty rows and a phone should not have to render all of
   * them to answer "did you contact me yesterday?".
   */
  async history(participantId: string, limit = 50): Promise<NotificationHistoryEntry[]> {
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 200);

    const rows = await this.db
      .select()
      .from(notificationAttempts)
      .where(eq(notificationAttempts.participantId, participantId))
      .orderBy(desc(notificationAttempts.scheduledFor))
      .limit(bounded);

    return rows.map((row) => ({
      sessionId: row.sessionId,
      kind: row.kind as NotificationKind,
      occurrenceIndex: row.occurrenceIndex,
      outcome: row.outcome as NotificationOutcome,
      suppressionReason: (row.suppressionReason as NotificationSuppressionReason | null) ?? null,
      scheduledFor: row.scheduledFor.toISOString(),
      attemptedAt: row.attemptedAt?.toISOString() ?? null,
    }));
  }
}
