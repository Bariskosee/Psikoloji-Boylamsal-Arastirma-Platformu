import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  protocolSteps,
  protocolVersions,
  protocols,
  questionnaireVersions,
  reminderPolicies,
  studies,
  type Database,
} from "@lpr/db";
import {
  previewProtocol,
  validateTriggerGraph,
  type HypotheticalParticipant,
  type PreviewStepInput,
  type TriggerGraphProblem,
} from "@lpr/domain";
import type {
  CreateProtocolRequest,
  PreviewProtocolRequest,
  ProtocolDetail,
  ProtocolListResponse,
  ProtocolPreviewResponse,
  ProtocolStepResponse,
  ProtocolVersionDetail,
  ProtocolVersionStatus,
  ProtocolVersionSummary,
  ReminderPolicyResponse,
  ResearcherProfile,
  StepKind,
  TriggerType,
  UpdateProtocolRequest,
} from "@lpr/contracts";
import { ApiErrors, type ApiException } from "../../common/api-error.js";
import { DATABASE } from "../database/database.module.js";
import { AuditService } from "../audit/audit.service.js";
import type { RequestContext } from "../auth/session.service.js";

type ProtocolRow = typeof protocols.$inferSelect;
type ProtocolVersionRow = typeof protocolVersions.$inferSelect;
type ProtocolStepRow = typeof protocolSteps.$inferSelect;
type ReminderPolicyRow = typeof reminderPolicies.$inferSelect;

/**
 * Protocols (PLAN.md Phase 4).
 *
 * Definition only. This service writes protocol rows and validates them; it
 * materialises nothing, enqueues nothing, and starts no engine. That is Phase 7.
 *
 * The publish path mirrors questionnaires exactly — deep-copy the draft into a
 * new immutable version rather than transitioning the draft — because an
 * enrollment pins a `protocol_version_id` for the participant's whole life in
 * the study (NFR-17). See `protocol-versions.ts` for why the database enforces
 * that with a trigger rather than trusting this service.
 */
@Injectable()
export class ProtocolService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async list(studyId: string): Promise<ProtocolListResponse["protocols"]> {
    const rows = await this.db
      .select()
      .from(protocols)
      .where(eq(protocols.studyId, studyId))
      .orderBy(desc(protocols.createdAt));

    if (rows.length === 0) return [];

    const versions = await this.db
      .select()
      .from(protocolVersions)
      .where(
        inArray(
          protocolVersions.protocolId,
          rows.map((row) => row.id),
        ),
      );

    const stepCounts = await this.countStepsByVersion(versions.map((version) => version.id));

    return rows.map((row) => {
      const mine = versions.filter((version) => version.protocolId === row.id);
      const draft = mine.find((version) => version.status === "DRAFT");
      if (!draft) throw new Error(`protocol ${row.id} has no draft version`);

      const published = mine
        .filter((version) => version.status !== "DRAFT")
        .sort((a, b) => (b.versionNumber ?? 0) - (a.versionNumber ?? 0));

      return {
        id: row.id,
        name: row.name,
        description: row.description,
        draft: { id: draft.id, stepCount: stepCounts.get(draft.id) ?? 0 },
        latestPublished: published[0]
          ? toVersionSummary(published[0], stepCounts.get(published[0].id) ?? 0)
          : null,
      };
    });
  }

  async create(
    actor: ResearcherProfile,
    studyId: string,
    input: CreateProtocolRequest,
    now: Date,
    context: RequestContext,
  ): Promise<ProtocolDetail> {
    const created = await this.db.transaction(async (tx) => {
      const inserted = (
        await tx
          .insert(protocols)
          .values({
            studyId,
            name: input.name,
            description: input.description,
            createdBy: actor.id,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
      )[0];
      if (!inserted) throw new Error("protocol insert returned no row");

      // The draft is created with the protocol, never lazily. A protocol
      // without one has no editable surface, and every read path would need a
      // "create it if missing" branch that races with itself.
      const draft = (
        await tx
          .insert(protocolVersions)
          .values({ protocolId: inserted.id, status: "DRAFT", createdAt: now, updatedAt: now })
          .returning()
      )[0];
      if (!draft) throw new Error("protocol version insert returned no row");

      return { protocol: inserted, draft };
    });

    await this.audit.record({
      actorType: "RESEARCHER",
      actorId: actor.id,
      actorLabel: actor.email,
      studyId,
      action: "protocol.created",
      entityType: "protocol",
      entityId: created.protocol.id,
      metadata: { name: created.protocol.name },
      context,
      occurredAt: now,
    });

    return this.get(studyId, created.protocol.id);
  }

  async get(studyId: string, protocolId: string): Promise<ProtocolDetail> {
    const protocol = await this.requireProtocol(studyId, protocolId);

    const versions = await this.db
      .select()
      .from(protocolVersions)
      .where(eq(protocolVersions.protocolId, protocolId));

    const draft = versions.find((version) => version.status === "DRAFT");
    if (!draft) throw new Error(`protocol ${protocolId} has no draft version`);

    const stepCounts = await this.countStepsByVersion(versions.map((version) => version.id));

    const published = versions
      .filter((version) => version.status !== "DRAFT")
      .sort((a, b) => (b.versionNumber ?? 0) - (a.versionNumber ?? 0))
      .map((version) => toVersionSummary(version, stepCounts.get(version.id) ?? 0));

    return {
      id: protocol.id,
      studyId: protocol.studyId,
      name: protocol.name,
      description: protocol.description,
      draft: await this.versionDetail(draft),
      publishedVersions: published,
      createdAt: protocol.createdAt.toISOString(),
      updatedAt: protocol.updatedAt.toISOString(),
    };
  }

  async update(
    actor: ResearcherProfile,
    studyId: string,
    protocolId: string,
    input: UpdateProtocolRequest,
    now: Date,
    context: RequestContext,
  ): Promise<ProtocolDetail> {
    await this.requireProtocol(studyId, protocolId);

    await this.db
      .update(protocols)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      })
      .where(eq(protocols.id, protocolId));

    await this.audit.record({
      actorType: "RESEARCHER",
      actorId: actor.id,
      actorLabel: actor.email,
      studyId,
      action: "protocol.updated",
      entityType: "protocol",
      entityId: protocolId,
      metadata: { fields: Object.keys(input) },
      context,
      occurredAt: now,
    });

    return this.get(studyId, protocolId);
  }

  async getVersion(
    studyId: string,
    protocolId: string,
    versionId: string,
  ): Promise<ProtocolVersionDetail> {
    await this.requireProtocol(studyId, protocolId);

    const version = (
      await this.db
        .select()
        .from(protocolVersions)
        .where(and(eq(protocolVersions.id, versionId), eq(protocolVersions.protocolId, protocolId)))
        .limit(1)
    )[0];
    if (!version) throw ApiErrors.protocolNotFound();

    return this.versionDetail(version);
  }

  /**
   * Publish the draft as a new immutable version.
   *
   * The graph is validated BEFORE the transaction opens, so a researcher gets
   * every problem at once and nothing is written when there are any. Publishing
   * cannot be undone, so being told one problem per attempt would be a guessing
   * game played against an irreversible operation.
   */
  async publish(
    actor: ResearcherProfile,
    studyId: string,
    protocolId: string,
    now: Date,
    context: RequestContext,
  ): Promise<ProtocolVersionDetail> {
    await this.requireProtocol(studyId, protocolId);
    const draft = await this.requireDraft(protocolId);

    const steps = await this.loadSteps(draft.id);
    if (steps.length === 0) throw ApiErrors.protocolEmpty();

    const validation = validateTriggerGraph(
      steps.map((step) => ({
        id: step.id,
        stepKey: step.stepKey,
        triggerType: step.triggerType as TriggerType,
        triggerStepId: step.triggerStepId,
        triggerOccurrenceIndex: step.triggerOccurrenceIndex,
        occurrenceCount: step.occurrenceCount,
      })),
    );
    if (!validation.ok) throw publishRefusal(validation.problems);

    // Every referenced questionnaire version must already be immutable
    // (ADR-008): a step pointing at a draft would let the instrument change
    // under participants who were already enrolled on it.
    await this.assertQuestionnaireVersionsPublished(steps);

    const published = await this.db.transaction(async (tx) => {
      /**
       * `max()` rather than ORDER BY … DESC LIMIT 1.
       *
       * The draft's `version_number` is NULL, and PostgreSQL sorts NULLS FIRST
       * on a descending order — so the ordered query returns the draft, reads
       * its NULL as "no versions yet", and allocates 1 again on every publish.
       * The second publish then collides with version 1's unique index.
       * `max()` ignores NULLs, which is the question actually being asked.
       */
      const highest = (
        await tx
          .select({ versionNumber: sql<number | null>`max(${protocolVersions.versionNumber})` })
          .from(protocolVersions)
          .where(eq(protocolVersions.protocolId, protocolId))
      )[0];

      const version = (
        await tx
          .insert(protocolVersions)
          .values({
            protocolId,
            status: "PUBLISHED",
            versionNumber: (highest?.versionNumber ?? 0) + 1,
            publishedAt: now,
            publishedBy: actor.id,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
      )[0];
      if (!version) throw new Error("protocol version insert returned no row");

      /**
       * Steps are copied in TOPOLOGICAL order — every step after the one its
       * trigger names — so each reference can be remapped to the new id as it
       * is inserted, in a single pass.
       *
       * The obvious alternative, inserting everything and then rewriting the
       * references, cannot work: the copies belong to a PUBLISHED version, and
       * `protocol_steps_published_immutable` refuses the UPDATE. The publish
       * would be blocked by the very trigger that protects what it just wrote.
       * Nor can the reference be left null in between —
       * `protocol_steps_trigger_reference_matches_type` requires a
       * step-referencing trigger to have one at all times.
       *
       * Safe because `validateTriggerGraph` has already rejected cycles, so the
       * steps are a DAG by the time this runs.
       *
       * Remapping rather than carrying the draft's ids over is what keeps a
       * published version self-contained: a reference pointing into the draft
       * would make the published schedule depend on rows still being edited.
       */
      const idMap = new Map<string, string>();

      for (const step of topologicalOrder(steps)) {
        const policyId = await this.copyReminderPolicy(tx, step.reminderPolicyId, now);

        const copied = (
          await tx
            .insert(protocolSteps)
            .values({
              protocolVersionId: version.id,
              stepIndex: step.stepIndex,
              stepKey: step.stepKey,
              questionnaireVersionId: step.questionnaireVersionId,
              stepKind: step.stepKind,
              triggerType: step.triggerType,
              // Already remapped, because the target was inserted first.
              triggerStepId:
                step.triggerStepId === null ? null : (idMap.get(step.triggerStepId) ?? null),
              triggerOccurrenceIndex: step.triggerOccurrenceIndex,
              triggerFixedDate: step.triggerFixedDate,
              offsetIso: step.offsetIso,
              anchorLocalTime: step.anchorLocalTime,
              anchorTimezoneSource: step.anchorTimezoneSource,
              windowDurationIso: step.windowDurationIso,
              occurrenceCount: step.occurrenceCount,
              recurrenceIntervalIso: step.recurrenceIntervalIso,
              reminderPolicyId: policyId,
              countsTowardCompliance: step.countsTowardCompliance,
              minIntervalIso: step.minIntervalIso,
              maxPerDay: step.maxPerDay,
              maxTotal: step.maxTotal,
              allowedGroupIds: step.allowedGroupIds,
              createdAt: now,
              updatedAt: now,
            })
            .returning()
        )[0];
        if (!copied) throw new Error("protocol step insert returned no row");
        idMap.set(step.id, copied.id);
      }

      return version;
    });

    await this.audit.record({
      actorType: "RESEARCHER",
      actorId: actor.id,
      actorLabel: actor.email,
      studyId,
      action: "protocol.version.published",
      entityType: "protocol_version",
      entityId: published.id,
      metadata: {
        protocolId,
        versionNumber: published.versionNumber,
        stepCount: steps.length,
      },
      context,
      occurredAt: now,
    });

    return this.versionDetail(published);
  }

  /**
   * The timeline preview.
   *
   * Runs @lpr/domain's `previewProtocol` — the same function Phase 7's
   * materialisation will call — against a hypothetical participant the caller
   * describes. Nothing is written and nothing is scheduled.
   */
  async preview(
    studyId: string,
    protocolId: string,
    versionId: string | null,
    request: PreviewProtocolRequest,
  ): Promise<ProtocolPreviewResponse> {
    await this.requireProtocol(studyId, protocolId);

    const version =
      versionId === null
        ? await this.requireDraft(protocolId)
        : (
            await this.db
              .select()
              .from(protocolVersions)
              .where(
                and(
                  eq(protocolVersions.id, versionId),
                  eq(protocolVersions.protocolId, protocolId),
                ),
              )
              .limit(1)
          )[0];
    if (!version) throw ApiErrors.protocolNotFound();

    const study = (await this.db.select().from(studies).where(eq(studies.id, studyId)).limit(1))[0];
    if (!study) throw ApiErrors.studyNotFound();

    const steps = await this.loadSteps(version.id);

    const completions: Record<string, Date> = {};
    for (const [stepKey, iso] of Object.entries(request.completions)) {
      completions[stepKey] = new Date(iso);
    }

    const participant: HypotheticalParticipant = {
      enrolledAt: new Date(request.enrolledAt),
      participantTimezone: request.participantTimezone,
      completions,
    };

    const inputs: PreviewStepInput[] = steps.map((step) => ({
      id: step.id,
      stepKey: step.stepKey,
      questionnaireVersionId: step.questionnaireVersionId,
      triggerType: step.triggerType as TriggerType,
      triggerStepId: step.triggerStepId,
      triggerOccurrenceIndex: step.triggerOccurrenceIndex,
      triggerFixedDate: step.triggerFixedDate,
      occurrenceCount: step.occurrenceCount,
      timing: {
        offsetIso: step.offsetIso,
        anchorLocalTime: step.anchorLocalTime,
        anchorTimezoneSource: step.anchorTimezoneSource as "STUDY" | "PARTICIPANT" | null,
        windowDurationIso: step.windowDurationIso,
        occurrenceCount: step.occurrenceCount,
        recurrenceIntervalIso: step.recurrenceIntervalIso,
      },
    }));

    const kindById = new Map(steps.map((step) => [step.id, step.stepKind as StepKind]));

    const preview = previewProtocol(
      inputs,
      participant,
      study.timezone,
      (step) => kindById.get(step.id) ?? "SCHEDULED",
    );

    return {
      steps: preview.steps.map((step) => ({
        stepId: step.stepId,
        stepKey: step.stepKey,
        questionnaireVersionId: step.questionnaireVersionId,
        dependency: step.dependency,
        dependsOnCompletionOf: [...step.dependsOnCompletionOf],
        occurrences:
          step.occurrences?.map((occurrence) => ({
            occurrenceIndex: occurrence.occurrenceIndex,
            availableFrom: occurrence.availableFrom.toISOString(),
            availableUntil: occurrence.availableUntil.toISOString(),
            adjustment: occurrence.adjustment,
          })) ?? null,
        unresolvedReason: step.unresolvedReason,
      })),
      totalOccurrences: preview.totalOccurrences,
    };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  async requireProtocol(studyId: string, protocolId: string): Promise<ProtocolRow> {
    const row = (
      await this.db
        .select()
        .from(protocols)
        .where(and(eq(protocols.id, protocolId), eq(protocols.studyId, studyId)))
        .limit(1)
    )[0];
    // Scoped by study in the query itself, never by trusting a checked path
    // parameter (STRUCTURE.md §11, NFR-04).
    if (!row) throw ApiErrors.protocolNotFound();
    return row;
  }

  async requireDraft(protocolId: string): Promise<ProtocolVersionRow> {
    const draft = (
      await this.db
        .select()
        .from(protocolVersions)
        .where(
          and(eq(protocolVersions.protocolId, protocolId), eq(protocolVersions.status, "DRAFT")),
        )
        .limit(1)
    )[0];
    if (!draft) throw new Error(`protocol ${protocolId} has no draft version`);
    return draft;
  }

  private async copyReminderPolicy(
    tx: Database,
    policyId: string | null,
    now: Date,
  ): Promise<string | null> {
    if (policyId === null) return null;

    const source = (
      await tx.select().from(reminderPolicies).where(eq(reminderPolicies.id, policyId)).limit(1)
    )[0];
    if (!source) return null;

    // Copied rather than shared: a published step must keep the cadence it was
    // published with even after the draft's policy is edited.
    const copy = (
      await tx
        .insert(reminderPolicies)
        .values({
          initialDelayIso: source.initialDelayIso,
          intervalIso: source.intervalIso,
          maxReminders: source.maxReminders,
          quietHoursStart: source.quietHoursStart,
          quietHoursEnd: source.quietHoursEnd,
          quietHoursBehavior: source.quietHoursBehavior,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
    )[0];
    return copy?.id ?? null;
  }

  private async assertQuestionnaireVersionsPublished(steps: ProtocolStepRow[]): Promise<void> {
    const ids = [...new Set(steps.map((step) => step.questionnaireVersionId))];
    if (ids.length === 0) return;

    const rows = await this.db
      .select({ id: questionnaireVersions.id, status: questionnaireVersions.status })
      .from(questionnaireVersions)
      .where(inArray(questionnaireVersions.id, ids));

    const byId = new Map(rows.map((row) => [row.id, row.status]));
    for (const id of ids) {
      if (byId.get(id) !== "PUBLISHED") throw ApiErrors.questionnaireVersionNotPublished();
    }
  }

  async loadSteps(versionId: string): Promise<ProtocolStepRow[]> {
    return this.db
      .select()
      .from(protocolSteps)
      .where(eq(protocolSteps.protocolVersionId, versionId))
      .orderBy(asc(protocolSteps.stepIndex));
  }

  private async countStepsByVersion(versionIds: string[]): Promise<Map<string, number>> {
    if (versionIds.length === 0) return new Map();

    const rows = await this.db
      .select({
        versionId: protocolSteps.protocolVersionId,
        count: sql<number>`count(*)::int`,
      })
      .from(protocolSteps)
      .where(inArray(protocolSteps.protocolVersionId, versionIds))
      .groupBy(protocolSteps.protocolVersionId);

    return new Map(rows.map((row) => [row.versionId, row.count]));
  }

  private async versionDetail(version: ProtocolVersionRow): Promise<ProtocolVersionDetail> {
    const steps = await this.loadSteps(version.id);
    const policies = await this.loadPolicies(steps);

    return {
      id: version.id,
      protocolId: version.protocolId,
      status: version.status as ProtocolVersionStatus,
      versionNumber: version.versionNumber,
      stepCount: steps.length,
      publishedAt: version.publishedAt?.toISOString() ?? null,
      steps: steps.map((step) => toStepResponse(step, policies)),
      createdAt: version.createdAt.toISOString(),
      updatedAt: version.updatedAt.toISOString(),
    };
  }

  private async loadPolicies(steps: ProtocolStepRow[]): Promise<Map<string, ReminderPolicyRow>> {
    const ids = steps
      .map((step) => step.reminderPolicyId)
      .filter((id): id is string => id !== null);
    if (ids.length === 0) return new Map();

    const rows = await this.db
      .select()
      .from(reminderPolicies)
      .where(inArray(reminderPolicies.id, ids));

    return new Map(rows.map((row) => [row.id, row]));
  }
}

/**
 * Turn the first graph problem into the error the builder branches on.
 *
 * One code per blocking condition, never a shared CONFLICT — the same contract
 * the questionnaire publish path follows, and for the same reason: a frontend
 * with only CONFLICT to go on ends up rendering the server's English.
 *
 * Only the first is raised because `ApiException` carries one code, but every
 * problem is in `details`, so the builder can mark them all at once.
 */
function publishRefusal(problems: readonly TriggerGraphProblem[]): ApiException {
  const first = problems[0];
  if (!first) return ApiErrors.protocolEmpty();

  const referenced = first.referencedStepKey ?? "";
  const count = first.occurrenceCount ?? 0;

  switch (first.code) {
    case "DANGLING_TRIGGER_REFERENCE":
      return ApiErrors.protocolTriggerDangling(first.stepKey);
    case "TRIGGER_CYCLE":
      return ApiErrors.protocolTriggerCycle(first.cycle ?? [first.stepKey]);
    case "RECURRING_TRIGGER_NEEDS_OCCURRENCE":
      return ApiErrors.protocolTriggerNeedsOccurrence(first.stepKey, referenced, count);
    case "OCCURRENCE_INDEX_OUT_OF_RANGE":
      return ApiErrors.protocolTriggerOccurrenceOutOfRange(first.stepKey, referenced, count);
    case "COMPLETION_OF_RECURRING_STEP":
      return ApiErrors.protocolStepCompletionOfRecurring(first.stepKey, referenced);
    case "DUPLICATE_STEP_KEY":
    default:
      return ApiErrors.protocolDuplicateStepKey(first.stepKey);
  }
}

/**
 * Steps ordered so that every step follows the one its trigger names.
 *
 * Depth-first post-order. The graph is a DAG here — cycles are rejected before
 * publish opens its transaction — and the `visiting` guard exists only so a
 * malformed draft that somehow reached this point terminates instead of
 * recursing forever.
 */
function topologicalOrder(steps: readonly ProtocolStepRow[]): ProtocolStepRow[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const ordered: ProtocolStepRow[] = [];
  const placed = new Set<string>();
  const visiting = new Set<string>();

  const visit = (step: ProtocolStepRow): void => {
    if (placed.has(step.id) || visiting.has(step.id)) return;
    visiting.add(step.id);

    if (step.triggerStepId !== null) {
      const target = byId.get(step.triggerStepId);
      if (target) visit(target);
    }

    visiting.delete(step.id);
    placed.add(step.id);
    ordered.push(step);
  };

  for (const step of steps) visit(step);
  return ordered;
}

function toVersionSummary(version: ProtocolVersionRow, stepCount: number): ProtocolVersionSummary {
  return {
    id: version.id,
    status: version.status as ProtocolVersionStatus,
    versionNumber: version.versionNumber,
    stepCount,
    publishedAt: version.publishedAt?.toISOString() ?? null,
  };
}

export function toStepResponse(
  step: ProtocolStepRow,
  policies: ReadonlyMap<string, ReminderPolicyRow>,
): ProtocolStepResponse {
  const policy = step.reminderPolicyId === null ? null : policies.get(step.reminderPolicyId);

  return {
    id: step.id,
    stepIndex: step.stepIndex,
    stepKey: step.stepKey,
    questionnaireVersionId: step.questionnaireVersionId,
    stepKind: step.stepKind as StepKind,
    triggerType: step.triggerType as TriggerType,
    triggerStepId: step.triggerStepId,
    triggerOccurrenceIndex: step.triggerOccurrenceIndex,
    triggerFixedDate: step.triggerFixedDate,
    offsetIso: step.offsetIso,
    anchorLocalTime: step.anchorLocalTime,
    anchorTimezoneSource: step.anchorTimezoneSource as "STUDY" | "PARTICIPANT" | null,
    windowDurationIso: step.windowDurationIso,
    occurrenceCount: step.occurrenceCount,
    recurrenceIntervalIso: step.recurrenceIntervalIso,
    countsTowardCompliance: step.countsTowardCompliance,
    minIntervalIso: step.minIntervalIso,
    maxPerDay: step.maxPerDay,
    maxTotal: step.maxTotal,
    allowedGroupIds: step.allowedGroupIds,
    reminderPolicy: policy ? toPolicyResponse(policy) : null,
  };
}

function toPolicyResponse(policy: ReminderPolicyRow): ReminderPolicyResponse {
  return {
    id: policy.id,
    initialDelayIso: policy.initialDelayIso,
    intervalIso: policy.intervalIso,
    maxReminders: policy.maxReminders,
    quietHoursStart: policy.quietHoursStart,
    quietHoursEnd: policy.quietHoursEnd,
    quietHoursBehavior: policy.quietHoursBehavior as "SKIP" | "DEFER",
  };
}
