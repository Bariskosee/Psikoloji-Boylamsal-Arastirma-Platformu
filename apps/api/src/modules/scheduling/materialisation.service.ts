import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import {
  enrollments,
  participantSessions,
  participants,
  protocolSteps,
  studies,
  type Database,
} from "@lpr/db";
import {
  findUnreachable,
  planMaterialisation,
  propagateCompletion,
  type MaterialisableStep,
  type MaterialisationContext,
} from "@lpr/domain";
import type { AnchorTimezoneSource, StepKind, TriggerType } from "@lpr/contracts";
import { DATABASE } from "../database/database.module.js";

/**
 * Materialisation and trigger propagation (PLAN.md Phase 7, STRUCTURE.md §8.2).
 *
 * The engine that turns a protocol version into the sessions a participant
 * actually receives. Every instant it writes is computed by @lpr/domain from
 * the server's clock; nothing a participant sends can influence availability or
 * expiry.
 *
 * ── Everything in ONE transaction ───────────────────────────────────────────
 * `materialiseEnrollment` is called inside the enrollment transaction, and
 * `propagate` inside the completion transaction. Both take the caller's `tx`
 * rather than opening their own, because a partially materialised enrollment
 * is a participant with a silently truncated protocol that no sweeper can
 * detect — the sweepers reconcile the sessions that exist, not the protocol
 * they should have come from.
 */
@Injectable()
export class MaterialisationService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Expand a bound protocol version into this participant's sessions.
   *
   * Returns how many rows were written, so the caller can log a number that
   * makes a truncated enrollment visible rather than silent.
   */
  async materialiseEnrollment(
    tx: Database,
    input: {
      participantId: string;
      studyId: string;
      protocolVersionId: string;
      enrolledAt: Date;
      consentedAt: Date;
      participantTimezone: string | null;
      studyTimezone: string;
      groupId: string | null;
    },
    now: Date,
  ): Promise<number> {
    const steps = await loadSteps(tx, input.protocolVersionId);
    if (steps.length === 0) return 0;

    const planned = planMaterialisation(
      steps,
      {
        enrolledAt: input.enrolledAt,
        consentedAt: input.consentedAt,
        participantTimezone: input.participantTimezone,
        studyTimezone: input.studyTimezone,
        groupId: input.groupId,
      },
      now,
    );
    if (planned.length === 0) return 0;

    await tx.insert(participantSessions).values(
      planned.map((session) => ({
        participantId: input.participantId,
        studyId: input.studyId,
        protocolVersionId: input.protocolVersionId,
        protocolStepId: session.protocolStepId,
        occurrenceIndex: session.occurrenceIndex,
        questionnaireVersionId: session.questionnaireVersionId,
        status: session.status,
        scheduledAt: session.status === "SCHEDULED" ? now : null,
        availableFrom: session.availableFrom,
        availableUntil: session.availableUntil,
        cancelledAt: session.status === "CANCELLED" ? now : null,
        cancellationReason: session.cancellationReason,
        createdAt: now,
        updatedAt: now,
      })),
    );

    return planned.length;
  }

  /**
   * Move sessions waiting on a completed step to SCHEDULED, with real times.
   *
   * Runs inside the completion transaction, so the state change and the
   * schedule it implies commit together. A crash between them would leave a
   * participant whose baseline is complete and whose follow-up never arrives —
   * invisible until the data came back short.
   */
  async propagate(
    tx: Database,
    sessionId: string,
    completedStepId: string,
    completedAt: Date,
    now: Date,
  ): Promise<number> {
    const context = await this.contextFor(tx, sessionId);
    if (!context) return 0;

    const steps = await loadSteps(tx, context.protocolVersionId);
    const propagations = propagateCompletion(
      steps,
      completedStepId,
      completedAt,
      context.materialisation,
      now,
    );

    let moved = 0;
    for (const propagation of propagations) {
      const updated = await tx
        .update(participantSessions)
        .set({
          status: propagation.status,
          triggerFiredAt: completedAt,
          scheduledAt: now,
          availableFrom: propagation.availableFrom,
          availableUntil: propagation.availableUntil,
          updatedAt: now,
        })
        .where(
          and(
            eq(participantSessions.participantId, context.participantId),
            eq(participantSessions.protocolStepId, propagation.protocolStepId),
            eq(participantSessions.occurrenceIndex, propagation.occurrenceIndex),
            // Only a session still waiting. A completed or cancelled one must
            // never be dragged back into the schedule by a late trigger.
            eq(participantSessions.status, "PENDING_TRIGGER"),
          ),
        )
        .returning();

      moved += updated.length;
    }

    return moved;
  }

  /**
   * Cancel what can never fire, once a step reached a terminal state without
   * completing.
   *
   * Cascades: a step waiting on the cancelled one is equally unreachable and
   * would otherwise sit in PENDING_TRIGGER forever, counting toward a
   * denominator it can never satisfy.
   */
  async cancelUnreachable(
    tx: Database,
    sessionId: string,
    unreachableStepId: string,
    now: Date,
  ): Promise<number> {
    const context = await this.contextFor(tx, sessionId);
    if (!context) return 0;

    const steps = await loadSteps(tx, context.protocolVersionId);
    const unreachable = findUnreachable(steps, [unreachableStepId]);
    if (unreachable.length === 0) return 0;

    const cancelled = await tx
      .update(participantSessions)
      .set({
        status: "CANCELLED",
        cancelledAt: now,
        cancellationReason: "TRIGGER_UNREACHABLE",
        updatedAt: now,
      })
      .where(
        and(
          eq(participantSessions.participantId, context.participantId),
          inArray(participantSessions.protocolStepId, [...unreachable]),
          eq(participantSessions.status, "PENDING_TRIGGER"),
        ),
      )
      .returning();

    return cancelled.length;
  }

  /**
   * Cancel every non-terminal session on withdrawal.
   *
   * Terminal ones are left exactly as they are: a completed questionnaire is
   * data the participant gave and does not become uncollected because they
   * later left, and an expired one is a fact about a window that has passed.
   */
  async cancelForWithdrawal(tx: Database, participantId: string, now: Date): Promise<number> {
    const cancelled = await tx
      .update(participantSessions)
      .set({
        status: "CANCELLED",
        cancelledAt: now,
        cancellationReason: "WITHDRAWAL",
        updatedAt: now,
      })
      .where(
        and(
          eq(participantSessions.participantId, participantId),
          // Exactly the non-terminal states. Terminal ones are untouched: a
          // completed questionnaire is data the participant gave and does not
          // become uncollected because they later left.
          inArray(participantSessions.status, [
            "PENDING_TRIGGER",
            "SCHEDULED",
            "AVAILABLE",
            "STARTED",
          ]),
        ),
      )
      .returning();

    return cancelled.length;
  }

  private async contextFor(
    tx: Database,
    sessionId: string,
  ): Promise<{
    participantId: string;
    protocolVersionId: string;
    materialisation: MaterialisationContext;
  } | null> {
    const row = (
      await tx
        .select({
          participantId: participantSessions.participantId,
          protocolVersionId: participantSessions.protocolVersionId,
          timezone: participants.timezone,
          enrolledAt: participants.enrolledAt,
          studyTimezone: studies.timezone,
          consentedAt: enrollments.consentedAt,
          groupId: enrollments.groupId,
        })
        .from(participantSessions)
        .innerJoin(participants, eq(participants.id, participantSessions.participantId))
        .innerJoin(studies, eq(studies.id, participantSessions.studyId))
        .innerJoin(enrollments, eq(enrollments.participantId, participantSessions.participantId))
        .where(eq(participantSessions.id, sessionId))
        .limit(1)
    )[0];
    if (!row) return null;

    return {
      participantId: row.participantId,
      protocolVersionId: row.protocolVersionId,
      materialisation: {
        enrolledAt: row.enrolledAt,
        consentedAt: row.consentedAt,
        participantTimezone: row.timezone,
        studyTimezone: row.studyTimezone,
        groupId: row.groupId,
      },
    };
  }
}

/** The steps of a published version, in the shape the domain planner expects. */
async function loadSteps(db: Database, protocolVersionId: string): Promise<MaterialisableStep[]> {
  const rows = await db
    .select()
    .from(protocolSteps)
    .where(eq(protocolSteps.protocolVersionId, protocolVersionId))
    .orderBy(protocolSteps.stepIndex);

  return rows.map((row) => ({
    id: row.id,
    stepKey: row.stepKey,
    questionnaireVersionId: row.questionnaireVersionId,
    stepKind: row.stepKind as StepKind,
    triggerType: row.triggerType as TriggerType,
    triggerStepId: row.triggerStepId,
    triggerOccurrenceIndex: row.triggerOccurrenceIndex,
    triggerFixedDate: row.triggerFixedDate,
    allowedGroupIds: row.allowedGroupIds,
    timing: {
      offsetIso: row.offsetIso,
      anchorLocalTime: row.anchorLocalTime,
      anchorTimezoneSource: row.anchorTimezoneSource as AnchorTimezoneSource | null,
      windowDurationIso: row.windowDurationIso,
      occurrenceCount: row.occurrenceCount,
      recurrenceIntervalIso: row.recurrenceIntervalIso,
    },
  }));
}
