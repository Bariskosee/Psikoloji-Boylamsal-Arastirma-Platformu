import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { consentVersionTranslations, consentVersions, type Database } from "@lpr/db";
import type {
  ConsentVersionListResponse,
  ConsentVersionResponse,
  ConsentVersionStatus,
  Locale,
  ResearcherProfile,
  UpsertConsentTranslationRequest,
} from "@lpr/contracts";
import { ApiErrors } from "../../common/api-error.js";
import { DATABASE } from "../database/database.module.js";
import { AuditService } from "../audit/audit.service.js";
import type { RequestContext } from "../auth/session.service.js";

type ConsentVersionRow = typeof consentVersions.$inferSelect;

/**
 * Consent documents (FR-05, PLAN.md Phase 5).
 *
 * Same draft-then-immutable-publish shape as questionnaires and protocols. The
 * reason is sharpest here: an enrollment records which version was agreed to
 * and in which language, and an ethics committee asking "what did this person
 * consent to?" must be able to read it back verbatim years later.
 *
 * The platform stores consent text; it never writes it. Language comes from the
 * research team (AGENT.md §16).
 */
@Injectable()
export class ConsentService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async list(studyId: string): Promise<ConsentVersionListResponse> {
    const versions = await this.db
      .select()
      .from(consentVersions)
      .where(eq(consentVersions.studyId, studyId))
      .orderBy(desc(consentVersions.createdAt));

    return { versions: await Promise.all(versions.map((row) => this.present(row))) };
  }

  /** The draft, created on demand so a study need not pre-declare one. */
  async draft(studyId: string, now: Date): Promise<ConsentVersionResponse> {
    const existing = (
      await this.db
        .select()
        .from(consentVersions)
        .where(and(eq(consentVersions.studyId, studyId), eq(consentVersions.status, "DRAFT")))
        .limit(1)
    )[0];
    if (existing) return this.present(existing);

    const created = (
      await this.db
        .insert(consentVersions)
        .values({ studyId, status: "DRAFT", createdAt: now, updatedAt: now })
        .returning()
    )[0];
    if (!created) throw new Error("consent version insert returned no row");

    return this.present(created);
  }

  async upsertTranslation(
    studyId: string,
    input: UpsertConsentTranslationRequest,
    now: Date,
  ): Promise<ConsentVersionResponse> {
    const draft = await this.requireDraft(studyId);

    const existing = (
      await this.db
        .select()
        .from(consentVersionTranslations)
        .where(
          and(
            eq(consentVersionTranslations.consentVersionId, draft.id),
            eq(consentVersionTranslations.locale, input.locale),
          ),
        )
        .limit(1)
    )[0];

    if (existing) {
      await this.db
        .update(consentVersionTranslations)
        .set({ title: input.title, body: input.body, updatedAt: now })
        .where(eq(consentVersionTranslations.id, existing.id));
    } else {
      await this.db.insert(consentVersionTranslations).values({
        consentVersionId: draft.id,
        locale: input.locale,
        title: input.title,
        body: input.body,
        createdAt: now,
        updatedAt: now,
      });
    }

    return this.present(draft);
  }

  /**
   * Publish the draft.
   *
   * Unlike questionnaires and protocols, publishing here transitions the draft
   * row itself rather than deep-copying it. There is nothing to copy — a
   * consent version owns only its translations, which are already its own — and
   * the immutability trigger takes effect the moment the status changes.
   */
  async publish(
    actor: ResearcherProfile,
    studyId: string,
    now: Date,
    context: RequestContext,
  ): Promise<ConsentVersionResponse> {
    const draft = await this.requireDraft(studyId);

    const translations = await this.db
      .select()
      .from(consentVersionTranslations)
      .where(eq(consentVersionTranslations.consentVersionId, draft.id));
    if (translations.length === 0) throw ApiErrors.consentVersionEmpty();

    const published = await this.db.transaction(async (tx) => {
      const highest = (
        await tx
          .select({ versionNumber: consentVersions.versionNumber })
          .from(consentVersions)
          .where(eq(consentVersions.studyId, studyId))
          .orderBy(desc(consentVersions.versionNumber))
          .limit(1)
      )[0];

      // `max()` semantics via a filtered read would be equivalent; what matters
      // is that the draft's NULL never reads as the highest number, which a
      // plain DESC ordering would do because PostgreSQL sorts NULLS FIRST.
      const next = (highest?.versionNumber ?? 0) + 1;

      const row = (
        await tx
          .update(consentVersions)
          .set({
            status: "PUBLISHED",
            versionNumber: next,
            publishedAt: now,
            publishedBy: actor.id,
            updatedAt: now,
          })
          .where(eq(consentVersions.id, draft.id))
          .returning()
      )[0];
      if (!row) throw ApiErrors.consentVersionNotFound();
      return row;
    });

    await this.audit.record({
      actorType: "RESEARCHER",
      actorId: actor.id,
      actorLabel: actor.email,
      studyId,
      action: "consent.version.published",
      entityType: "consent_version",
      entityId: published.id,
      metadata: {
        versionNumber: published.versionNumber,
        locales: translations.map((t) => t.locale),
      },
      context,
      occurredAt: now,
    });

    return this.present(published);
  }

  private async requireDraft(studyId: string): Promise<ConsentVersionRow> {
    const draft = (
      await this.db
        .select()
        .from(consentVersions)
        .where(and(eq(consentVersions.studyId, studyId), eq(consentVersions.status, "DRAFT")))
        .limit(1)
    )[0];
    if (!draft) throw ApiErrors.consentVersionNotFound();
    return draft;
  }

  private async present(version: ConsentVersionRow): Promise<ConsentVersionResponse> {
    const translations = await this.db
      .select()
      .from(consentVersionTranslations)
      .where(eq(consentVersionTranslations.consentVersionId, version.id));

    return {
      id: version.id,
      studyId: version.studyId,
      status: version.status as ConsentVersionStatus,
      versionNumber: version.versionNumber,
      publishedAt: version.publishedAt?.toISOString() ?? null,
      translations: translations.map((row) => ({
        locale: row.locale as Locale,
        title: row.title,
        body: row.body,
      })),
      createdAt: version.createdAt.toISOString(),
      updatedAt: version.updatedAt.toISOString(),
    };
  }
}
