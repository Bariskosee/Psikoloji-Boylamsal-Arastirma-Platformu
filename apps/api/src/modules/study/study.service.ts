import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { studies, studyMembers, type Database } from "@lpr/db";
import {
  acceptsConfigurationChanges,
  buildEnrollmentUrl,
  canTransitionStudy,
  ENROLLMENT_CODE_BYTES,
  generateEnrollmentCode,
} from "@lpr/domain";
import type {
  CreateStudyRequest,
  Locale,
  ResearcherProfile,
  StudyResponse,
  StudyRole,
  StudyStatus,
  UpdateStudyRequest,
} from "@lpr/contracts";
import { ApiErrors } from "../../common/api-error.js";
import { generateRandomBytes } from "../../common/crypto.js";
import { loadEnv } from "../../config/env.js";
import { DATABASE } from "../database/database.module.js";
import { AuditService } from "../audit/audit.service.js";
import type { RequestContext } from "../auth/session.service.js";

/**
 * How many times to retry on an enrollment-code collision.
 *
 * With a 32-character alphabet and six characters there are ~1.07 billion
 * codes, so a collision at a few hundred studies is a lottery win. Retrying is
 * still correct — the uniqueness is enforced by the database, and hoping is
 * not an error-handling strategy.
 */
const CODE_ATTEMPTS = 5;

@Injectable()
export class StudyService {
  private readonly env = loadEnv();

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  /**
   * Studies the caller can see — and ONLY those.
   *
   * The join to `study_members` is the authorization: there is no "list all
   * studies then filter" path, because that is the query that leaks the moment
   * someone adds a condition in the wrong place (NFR-04).
   */
  async listForUser(userId: string): Promise<StudyResponse[]> {
    const rows = await this.db
      .select({ study: studies, role: studyMembers.role })
      .from(studyMembers)
      .innerJoin(studies, eq(studies.id, studyMembers.studyId))
      .where(eq(studyMembers.userId, userId))
      .orderBy(desc(studies.createdAt));

    return rows.map((row) => this.toResponse(row.study, row.role as StudyRole));
  }

  async getForUser(studyId: string, role: StudyRole): Promise<StudyResponse> {
    const rows = await this.db.select().from(studies).where(eq(studies.id, studyId)).limit(1);
    const study = rows[0];
    if (!study) throw ApiErrors.studyNotFound();
    return this.toResponse(study, role);
  }

  /**
   * Create a study and make the creator its OWNER, atomically.
   *
   * One transaction, because a study with no OWNER is unmanageable: nobody
   * could add members, change its lifecycle, or read its audit trail. If the
   * membership insert fails, the study must not exist.
   */
  async create(
    actor: ResearcherProfile,
    input: CreateStudyRequest,
    now: Date,
    context: RequestContext,
  ): Promise<StudyResponse> {
    const study = await this.db.transaction(async (tx) => {
      const inserted = await this.insertWithUniqueCode(tx, actor.id, input, now);

      await tx.insert(studyMembers).values({
        studyId: inserted.id,
        userId: actor.id,
        role: "OWNER",
        addedBy: actor.id,
        createdAt: now,
        updatedAt: now,
      });

      return inserted;
    });

    await this.audit.record({
      actorType: "RESEARCHER",
      actorId: actor.id,
      actorLabel: actor.email,
      studyId: study.id,
      action: "study.created",
      entityType: "study",
      entityId: study.id,
      metadata: { name: study.name, timezone: study.timezone },
      context,
      occurredAt: now,
    });

    return this.toResponse(study, "OWNER");
  }

  async update(
    actor: ResearcherProfile,
    studyId: string,
    role: StudyRole,
    input: UpdateStudyRequest,
    now: Date,
    context: RequestContext,
  ): Promise<StudyResponse> {
    const current = (
      await this.db.select().from(studies).where(eq(studies.id, studyId)).limit(1)
    )[0];
    if (!current) throw ApiErrors.studyNotFound();

    if (!acceptsConfigurationChanges(current.status as StudyStatus)) {
      // Editing metadata after closure would rewrite the description of a
      // dataset that has already been analysed under the old one.
      throw ApiErrors.conflict(`A ${current.status} study cannot be edited`);
    }

    const defaultLocale = input.defaultLocale ?? (current.defaultLocale as Locale);
    const supportedLocales = input.supportedLocales ?? (current.supportedLocales as Locale[]);
    if (!supportedLocales.includes(defaultLocale)) {
      // The database enforces this too; catching it here produces a usable
      // error instead of a constraint-violation 500.
      throw ApiErrors.conflict("The default locale must be one of the supported locales");
    }

    const updated = (
      await this.db
        .update(studies)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
          ...(input.defaultLocale !== undefined ? { defaultLocale: input.defaultLocale } : {}),
          ...(input.supportedLocales !== undefined
            ? { supportedLocales: input.supportedLocales }
            : {}),
          ...(input.enrollmentCapacity !== undefined
            ? { enrollmentCapacity: input.enrollmentCapacity }
            : {}),
        })
        .where(eq(studies.id, studyId))
        .returning()
    )[0];
    if (!updated) throw ApiErrors.studyNotFound();

    await this.audit.record({
      actorType: "RESEARCHER",
      actorId: actor.id,
      actorLabel: actor.email,
      studyId,
      action: "study.updated",
      entityType: "study",
      entityId: studyId,
      // Field NAMES, not values. Which settings changed is the auditable fact;
      // the values are readable from the study itself by anyone entitled to.
      metadata: { fields: Object.keys(input) },
      context,
      occurredAt: now,
    });

    return this.toResponse(updated, role);
  }

  /**
   * Move a study through its lifecycle.
   *
   * The transition is validated by @lpr/domain and applied CONDITIONALLY on the
   * status still being what was read. Two owners closing a study at once would
   * otherwise both pass validation against the same stale row; the conditional
   * update means the second one changes nothing and is told so.
   */
  async changeStatus(
    actor: ResearcherProfile,
    studyId: string,
    role: StudyRole,
    target: StudyStatus,
    now: Date,
    context: RequestContext,
  ): Promise<StudyResponse> {
    const current = (
      await this.db.select().from(studies).where(eq(studies.id, studyId)).limit(1)
    )[0];
    if (!current) throw ApiErrors.studyNotFound();

    const from = current.status as StudyStatus;
    const decision = canTransitionStudy(from, target);
    if (!decision.ok) throw ApiErrors.invalidStudyTransition(from, target);

    const updated = (
      await this.db
        .update(studies)
        .set({ status: target })
        .where(and(eq(studies.id, studyId), eq(studies.status, from)))
        .returning()
    )[0];

    if (!updated) throw ApiErrors.conflict("The study status changed concurrently; retry");

    await this.audit.record({
      actorType: "RESEARCHER",
      actorId: actor.id,
      actorLabel: actor.email,
      studyId,
      action: "study.status.changed",
      entityType: "study",
      entityId: studyId,
      metadata: { from, to: target },
      context,
      occurredAt: now,
    });

    return this.toResponse(updated, role);
  }

  /** The enrollment URL a QR code encodes (FR-01, FR-02). */
  async enrollmentUrl(studyId: string): Promise<string> {
    const rows = await this.db
      .select({ code: studies.enrollmentCode })
      .from(studies)
      .where(eq(studies.id, studyId))
      .limit(1);
    const code = rows[0]?.code;
    if (!code) throw ApiErrors.studyNotFound();
    return buildEnrollmentUrl(this.env.PARTICIPANT_ORIGIN, code);
  }

  private async insertWithUniqueCode(
    tx: Database,
    actorId: string,
    input: CreateStudyRequest,
    now: Date,
  ): Promise<typeof studies.$inferSelect> {
    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
      const enrollmentCode = generateEnrollmentCode(generateRandomBytes(ENROLLMENT_CODE_BYTES));
      try {
        const inserted = await tx
          .insert(studies)
          .values({
            name: input.name,
            description: input.description,
            timezone: input.timezone,
            defaultLocale: input.defaultLocale,
            supportedLocales: input.supportedLocales,
            enrollmentCapacity: input.enrollmentCapacity,
            enrollmentCode,
            createdBy: actorId,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        const study = inserted[0];
        if (study) return study;
      } catch (error) {
        // Retry ONLY a unique violation on the code. Any other failure is a
        // real error and must not be swallowed by a retry loop.
        if (!isUniqueViolation(error, "studies_enrollment_code_key")) throw error;
      }
    }
    throw ApiErrors.enrollmentCodeUnavailable();
  }

  private toResponse(study: typeof studies.$inferSelect, role: StudyRole): StudyResponse {
    return {
      id: study.id,
      name: study.name,
      description: study.description,
      status: study.status as StudyStatus,
      enrollmentCode: study.enrollmentCode,
      enrollmentUrl: buildEnrollmentUrl(this.env.PARTICIPANT_ORIGIN, study.enrollmentCode),
      timezone: study.timezone,
      defaultLocale: study.defaultLocale as Locale,
      supportedLocales: study.supportedLocales as Locale[],
      enrollmentCapacity: study.enrollmentCapacity,
      createdAt: study.createdAt.toISOString(),
      updatedAt: study.updatedAt.toISOString(),
      viewerRole: role,
    };
  }
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: string; constraint?: string };
  if (candidate.code !== "23505") return false;
  return constraint ? candidate.constraint === constraint : true;
}
