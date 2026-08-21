import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import {
  protocolSteps,
  questionnaireVersions,
  questionnaires,
  reminderPolicies,
  type Database,
} from "@lpr/db";
import { planReorder } from "@lpr/domain";
import {
  protocolStepInputSchema,
  type AuditAction,
  type ProtocolStepInput,
  type ProtocolStepResponse,
  type ReminderPolicyInput,
  type ResearcherProfile,
  type UpdateProtocolStepRequest,
} from "@lpr/contracts";
import { ApiErrors } from "../../common/api-error.js";
import { DATABASE } from "../database/database.module.js";
import { AuditService } from "../audit/audit.service.js";
import type { RequestContext } from "../auth/session.service.js";
import { ProtocolService, toStepResponse } from "./protocol.service.js";

type ProtocolStepRow = typeof protocolSteps.$inferSelect;

/**
 * Steps of a protocol's DRAFT (PLAN.md Phase 4).
 *
 * Every mutation here resolves the protocol's draft server-side rather than
 * accepting a version id, which makes "edit a published version" unrepresentable
 * in the URL space rather than merely rejected — the same shape the questionnaire
 * module uses, and for the same reason (AGENT.md §17).
 */
@Injectable()
export class ProtocolStepService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly protocols: ProtocolService,
    private readonly audit: AuditService,
  ) {}

  async create(
    actor: ResearcherProfile,
    studyId: string,
    protocolId: string,
    input: ProtocolStepInput,
    now: Date,
    context: RequestContext,
  ): Promise<ProtocolStepResponse> {
    await this.protocols.requireProtocol(studyId, protocolId);
    const draft = await this.protocols.requireDraft(protocolId);

    await this.assertQuestionnaireVersionUsable(studyId, input.questionnaireVersionId);
    await this.assertTriggerStepInDraft(draft.id, input.triggerStepId);

    const created = await this.db.transaction(async (tx) => {
      // Appended at the end. Position is the researcher's to change, and doing
      // it here would need a rule nobody asked for.
      const next = (
        await tx
          .select({ next: sql<number>`coalesce(max(${protocolSteps.stepIndex}), -1) + 1` })
          .from(protocolSteps)
          .where(eq(protocolSteps.protocolVersionId, draft.id))
      )[0];

      const policyId = await insertPolicy(tx, input.reminderPolicy, now);

      const row = (
        await tx
          .insert(protocolSteps)
          .values({
            protocolVersionId: draft.id,
            stepIndex: next?.next ?? 0,
            stepKey: input.stepKey,
            questionnaireVersionId: input.questionnaireVersionId,
            stepKind: input.stepKind,
            triggerType: input.triggerType,
            triggerStepId: input.triggerStepId,
            triggerOccurrenceIndex: input.triggerOccurrenceIndex,
            triggerFixedDate: input.triggerFixedDate,
            offsetIso: input.offsetIso,
            anchorLocalTime: input.anchorLocalTime,
            anchorTimezoneSource: input.anchorTimezoneSource,
            windowDurationIso: input.windowDurationIso,
            occurrenceCount: input.occurrenceCount,
            recurrenceIntervalIso: input.recurrenceIntervalIso,
            reminderPolicyId: policyId,
            countsTowardCompliance: input.countsTowardCompliance,
            minIntervalIso: input.minIntervalIso,
            maxPerDay: input.maxPerDay,
            maxTotal: input.maxTotal,
            allowedGroupIds: input.allowedGroupIds,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
      )[0];
      if (!row) throw new Error("protocol step insert returned no row");
      return row;
    });

    await this.record(actor, studyId, protocolId, "protocol.step.created", created, now, context);
    return this.present(created);
  }

  async update(
    actor: ResearcherProfile,
    studyId: string,
    protocolId: string,
    stepId: string,
    input: UpdateProtocolStepRequest,
    now: Date,
    context: RequestContext,
  ): Promise<ProtocolStepResponse> {
    await this.protocols.requireProtocol(studyId, protocolId);
    const draft = await this.protocols.requireDraft(protocolId);
    const existing = await this.requireStep(draft.id, stepId);

    /**
     * The merged row is re-validated against the full step schema rather than
     * validating the patch alone.
     *
     * Almost every rule on a step is a cross-field one — a wall-clock anchor
     * needs both halves, a repeating step needs an interval, a fixed-date
     * trigger needs its date. A patch that clears one half of a pair is valid
     * in isolation and leaves the row incoherent, so what must satisfy the
     * schema is the row as it will be, not the change being made to it.
     */
    const merged = { ...toStepInput(existing), ...input };
    const parsed = protocolStepInputSchema.safeParse(merged);
    if (!parsed.success) {
      throw ApiErrors.validationFailed(
        parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      );
    }
    const next = parsed.data;

    if (next.questionnaireVersionId !== existing.questionnaireVersionId) {
      await this.assertQuestionnaireVersionUsable(studyId, next.questionnaireVersionId);
    }
    if (next.triggerStepId !== existing.triggerStepId) {
      await this.assertTriggerStepInDraft(draft.id, next.triggerStepId, stepId);
    }

    const updated = await this.db.transaction(async (tx) => {
      /**
       * The policy is touched only when the patch mentions it.
       *
       * `toStepInput` cannot reconstruct the existing policy — it has the id,
       * not the row — so it supplies null, and merging a patch that says
       * nothing about reminders would otherwise read as "remove them" and
       * silently delete a cadence the researcher configured earlier.
       */
      const policyId =
        input.reminderPolicy === undefined
          ? existing.reminderPolicyId
          : await replacePolicy(tx, existing.reminderPolicyId, input.reminderPolicy, now);

      const row = (
        await tx
          .update(protocolSteps)
          .set({
            stepKey: next.stepKey,
            questionnaireVersionId: next.questionnaireVersionId,
            stepKind: next.stepKind,
            triggerType: next.triggerType,
            triggerStepId: next.triggerStepId,
            triggerOccurrenceIndex: next.triggerOccurrenceIndex,
            triggerFixedDate: next.triggerFixedDate,
            offsetIso: next.offsetIso,
            anchorLocalTime: next.anchorLocalTime,
            anchorTimezoneSource: next.anchorTimezoneSource,
            windowDurationIso: next.windowDurationIso,
            occurrenceCount: next.occurrenceCount,
            recurrenceIntervalIso: next.recurrenceIntervalIso,
            reminderPolicyId: policyId,
            countsTowardCompliance: next.countsTowardCompliance,
            minIntervalIso: next.minIntervalIso,
            maxPerDay: next.maxPerDay,
            maxTotal: next.maxTotal,
            allowedGroupIds: next.allowedGroupIds,
          })
          .where(eq(protocolSteps.id, stepId))
          .returning()
      )[0];
      if (!row) throw ApiErrors.protocolStepNotFound();
      return row;
    });

    await this.record(actor, studyId, protocolId, "protocol.step.updated", updated, now, context);
    return this.present(updated);
  }

  async remove(
    actor: ResearcherProfile,
    studyId: string,
    protocolId: string,
    stepId: string,
    now: Date,
    context: RequestContext,
  ): Promise<void> {
    await this.protocols.requireProtocol(studyId, protocolId);
    const draft = await this.protocols.requireDraft(protocolId);
    const existing = await this.requireStep(draft.id, stepId);

    await this.db.transaction(async (tx) => {
      /**
       * Any step whose trigger names this one loses its reference.
       *
       * Set to null rather than cascade-deleted: deleting a step because the
       * one it followed was deleted would remove a measurement the researcher
       * never asked to remove. A step with a null reference is caught at
       * publish as a dangling trigger, which is a question the researcher can
       * answer — unlike a step that has silently vanished.
       */
      await tx
        .update(protocolSteps)
        .set({ triggerStepId: null, triggerType: "ENROLLMENT", triggerOccurrenceIndex: null })
        .where(
          and(
            eq(protocolSteps.protocolVersionId, draft.id),
            eq(protocolSteps.triggerStepId, stepId),
          ),
        );

      await tx.delete(protocolSteps).where(eq(protocolSteps.id, stepId));

      if (existing.reminderPolicyId !== null) {
        await tx.delete(reminderPolicies).where(eq(reminderPolicies.id, existing.reminderPolicyId));
      }

      await this.compactOrder(tx, draft.id);
    });

    await this.audit.record({
      actorType: "RESEARCHER",
      actorId: actor.id,
      actorLabel: actor.email,
      studyId,
      action: "protocol.step.deleted",
      entityType: "protocol_step",
      entityId: stepId,
      metadata: { protocolId, stepKey: existing.stepKey },
      context,
      occurredAt: now,
    });
  }

  async reorder(
    actor: ResearcherProfile,
    studyId: string,
    protocolId: string,
    stepIds: string[],
    now: Date,
    context: RequestContext,
  ): Promise<ProtocolStepResponse[]> {
    await this.protocols.requireProtocol(studyId, protocolId);
    const draft = await this.protocols.requireDraft(protocolId);
    const existing = await this.protocols.loadSteps(draft.id);

    // The same domain check the questionnaire builder uses: the request must be
    // a permutation of what exists, never a partial list that would silently
    // drop a step.
    const plan = planReorder(
      existing.map((step) => step.id),
      stepIds,
    );
    if (!plan.ok) throw ApiErrors.invalidReorder(plan.reason ?? "INVALID");

    await this.db.transaction(async (tx) => {
      // Two passes through a negative range, because `(version, step_index)` is
      // unique: assigning the new order directly would collide with a row that
      // has not moved yet.
      for (const [index, id] of stepIds.entries()) {
        await tx
          .update(protocolSteps)
          .set({ stepIndex: -1 - index })
          .where(eq(protocolSteps.id, id));
      }
      for (const [index, id] of stepIds.entries()) {
        await tx.update(protocolSteps).set({ stepIndex: index }).where(eq(protocolSteps.id, id));
      }
    });

    await this.audit.record({
      actorType: "RESEARCHER",
      actorId: actor.id,
      actorLabel: actor.email,
      studyId,
      action: "protocol.steps.reordered",
      entityType: "protocol_version",
      entityId: draft.id,
      metadata: { protocolId, stepCount: stepIds.length },
      context,
      occurredAt: now,
    });

    const reordered = await this.protocols.loadSteps(draft.id);
    return Promise.all(reordered.map((step) => this.present(step)));
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async requireStep(versionId: string, stepId: string): Promise<ProtocolStepRow> {
    const row = (
      await this.db
        .select()
        .from(protocolSteps)
        .where(and(eq(protocolSteps.id, stepId), eq(protocolSteps.protocolVersionId, versionId)))
        .limit(1)
    )[0];
    if (!row) throw ApiErrors.protocolStepNotFound();
    return row;
  }

  /**
   * A step may only administer a PUBLISHED questionnaire version belonging to
   * this study (ADR-008). Pointing at a draft would let the instrument change
   * under participants already enrolled on the protocol.
   */
  private async assertQuestionnaireVersionUsable(
    studyId: string,
    questionnaireVersionId: string,
  ): Promise<void> {
    const row = (
      await this.db
        .select({ status: questionnaireVersions.status, studyId: questionnaires.studyId })
        .from(questionnaireVersions)
        .innerJoin(questionnaires, eq(questionnaires.id, questionnaireVersions.questionnaireId))
        .where(eq(questionnaireVersions.id, questionnaireVersionId))
        .limit(1)
    )[0];

    // Same answer for "belongs to another study" as for "does not exist", so
    // the endpoint is not an existence oracle across studies.
    if (!row || row.studyId !== studyId) throw ApiErrors.questionnaireNotFound();
    if (row.status !== "PUBLISHED") throw ApiErrors.questionnaireVersionNotPublished();
  }

  /** A trigger may only name a step in the same draft. */
  private async assertTriggerStepInDraft(
    versionId: string,
    triggerStepId: string | null,
    selfId?: string,
  ): Promise<void> {
    if (triggerStepId === null) return;
    if (selfId !== undefined && triggerStepId === selfId) {
      throw ApiErrors.protocolTriggerCycle([selfId]);
    }
    await this.requireStep(versionId, triggerStepId);
  }

  /** Close the gap a delete leaves, so indexes stay 0..n-1. */
  private async compactOrder(tx: Database, versionId: string): Promise<void> {
    const remaining = await tx
      .select({ id: protocolSteps.id })
      .from(protocolSteps)
      .where(eq(protocolSteps.protocolVersionId, versionId))
      .orderBy(protocolSteps.stepIndex);

    for (const [index, row] of remaining.entries()) {
      await tx
        .update(protocolSteps)
        .set({ stepIndex: -1 - index })
        .where(eq(protocolSteps.id, row.id));
    }
    for (const [index, row] of remaining.entries()) {
      await tx.update(protocolSteps).set({ stepIndex: index }).where(eq(protocolSteps.id, row.id));
    }
  }

  private async present(step: ProtocolStepRow): Promise<ProtocolStepResponse> {
    if (step.reminderPolicyId === null) return toStepResponse(step, new Map());

    const policy = (
      await this.db
        .select()
        .from(reminderPolicies)
        .where(eq(reminderPolicies.id, step.reminderPolicyId))
        .limit(1)
    )[0];

    return toStepResponse(step, policy ? new Map([[policy.id, policy]]) : new Map());
  }

  private async record(
    actor: ResearcherProfile,
    studyId: string,
    protocolId: string,
    action: AuditAction,
    step: ProtocolStepRow,
    now: Date,
    context: RequestContext,
  ): Promise<void> {
    await this.audit.record({
      actorType: "RESEARCHER",
      actorId: actor.id,
      actorLabel: actor.email,
      studyId,
      action,
      entityType: "protocol_step",
      entityId: step.id,
      metadata: { protocolId, stepKey: step.stepKey },
      context,
      occurredAt: now,
    });
  }
}

async function insertPolicy(
  tx: Database,
  policy: ReminderPolicyInput | null,
  now: Date,
): Promise<string | null> {
  if (policy === null) return null;

  const row = (
    await tx
      .insert(reminderPolicies)
      .values({
        initialDelayIso: policy.initialDelayIso,
        intervalIso: policy.intervalIso,
        maxReminders: policy.maxReminders,
        quietHoursStart: policy.quietHoursStart,
        quietHoursEnd: policy.quietHoursEnd,
        quietHoursBehavior: policy.quietHoursBehavior,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
  )[0];
  return row?.id ?? null;
}

/**
 * Replace a step's policy wholesale rather than patching it.
 *
 * A policy has no identity a researcher cares about — it is part of the step —
 * so "no policy" and "a different policy" are both just the step's new state.
 */
async function replacePolicy(
  tx: Database,
  currentId: string | null,
  next: ReminderPolicyInput | null,
  now: Date,
): Promise<string | null> {
  if (currentId !== null) {
    await tx.delete(reminderPolicies).where(eq(reminderPolicies.id, currentId));
  }
  return insertPolicy(tx, next, now);
}

/** The step as the input schema sees it, for merge-then-validate on PATCH. */
function toStepInput(step: ProtocolStepRow): Record<string, unknown> {
  return {
    stepKey: step.stepKey,
    questionnaireVersionId: step.questionnaireVersionId,
    stepKind: step.stepKind,
    triggerType: step.triggerType,
    triggerStepId: step.triggerStepId,
    triggerOccurrenceIndex: step.triggerOccurrenceIndex,
    triggerFixedDate: step.triggerFixedDate,
    offsetIso: step.offsetIso,
    anchorLocalTime: step.anchorLocalTime,
    anchorTimezoneSource: step.anchorTimezoneSource,
    windowDurationIso: step.windowDurationIso,
    occurrenceCount: step.occurrenceCount,
    recurrenceIntervalIso: step.recurrenceIntervalIso,
    countsTowardCompliance: step.countsTowardCompliance,
    minIntervalIso: step.minIntervalIso,
    maxPerDay: step.maxPerDay,
    maxTotal: step.maxTotal,
    allowedGroupIds: step.allowedGroupIds,
    reminderPolicy: null,
  };
}
