import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { consentVersionTranslations, consentVersions, studies, type Database } from "@lpr/db";
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
type ConsentTranslationRow = typeof consentVersionTranslations.$inferSelect;

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
    const result = await this.db.transaction(async (tx) => {
      // First-open requests from two dashboard tabs must not both observe an
      // empty draft and race into the one-draft partial unique index. Publish
      // already locks this same study row first, so this also preserves one
      // consistent lock order across draft creation and publication.
      const study = (
        await tx
          .select({ id: studies.id })
          .from(studies)
          .where(eq(studies.id, studyId))
          .limit(1)
          .for("update")
      )[0];
      if (!study) throw ApiErrors.studyNotFound();

      let version = (
        await tx
          .select()
          .from(consentVersions)
          .where(and(eq(consentVersions.studyId, studyId), eq(consentVersions.status, "DRAFT")))
          .limit(1)
      )[0];

      if (!version) {
        version = (
          await tx
            .insert(consentVersions)
            .values({ studyId, status: "DRAFT", createdAt: now, updatedAt: now })
            .returning()
        )[0];
      }
      if (!version) throw new Error("consent version insert returned no row");

      const translations = await tx
        .select()
        .from(consentVersionTranslations)
        .where(eq(consentVersionTranslations.consentVersionId, version.id));
      return { version, translations };
    });

    return this.toResponse(result.version, result.translations);
  }

  async upsertTranslation(
    studyId: string,
    input: UpsertConsentTranslationRequest,
    now: Date,
  ): Promise<ConsentVersionResponse> {
    return this.db.transaction(async (tx) => {
      // Publishing takes this same lock. A save that starts before publish is
      // therefore included in the version; a save that starts after it is
      // rejected because there is no longer a draft. Consent wording can never
      // change between publish validation and the immutable transition.
      const draft = (
        await tx
          .select()
          .from(consentVersions)
          .where(and(eq(consentVersions.studyId, studyId), eq(consentVersions.status, "DRAFT")))
          .limit(1)
          .for("update")
      )[0];
      if (!draft) throw ApiErrors.consentVersionNotFound();

      const existing = (
        await tx
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
        await tx
          .update(consentVersionTranslations)
          .set({ title: input.title, body: input.body, updatedAt: now })
          .where(eq(consentVersionTranslations.id, existing.id));
      } else {
        await tx.insert(consentVersionTranslations).values({
          consentVersionId: draft.id,
          locale: input.locale,
          title: input.title,
          body: input.body,
          createdAt: now,
          updatedAt: now,
        });
      }

      const translations = await tx
        .select()
        .from(consentVersionTranslations)
        .where(eq(consentVersionTranslations.consentVersionId, draft.id));
      return this.toResponse(draft, translations);
    });
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
    const result = await this.db.transaction(async (tx) => {
      // Lock the study first so the required locale set cannot change between
      // validation and publication. Study updates take the same PostgreSQL row
      // lock implicitly, giving this operation one atomic point in time.
      const study = (
        await tx
          .select({ supportedLocales: studies.supportedLocales })
          .from(studies)
          .where(eq(studies.id, studyId))
          .limit(1)
          .for("update")
      )[0];
      if (!study) throw ApiErrors.studyNotFound();

      // Shared with upsertTranslation: the wording cannot move underneath the
      // completeness check (no validation/read/update TOCTOU window).
      const draft = (
        await tx
          .select()
          .from(consentVersions)
          .where(and(eq(consentVersions.studyId, studyId), eq(consentVersions.status, "DRAFT")))
          .limit(1)
          .for("update")
      )[0];
      if (!draft) throw ApiErrors.consentVersionNotFound();

      const translations = await tx
        .select()
        .from(consentVersionTranslations)
        .where(eq(consentVersionTranslations.consentVersionId, draft.id));
      const translationsByLocale = new Map(translations.map((row) => [row.locale, row]));
      const missingLocales = study.supportedLocales.filter((locale) => {
        const translation = translationsByLocale.get(locale);
        return !translation?.title.trim() || !translation.body.trim();
      });
      if (missingLocales.length > 0) throw ApiErrors.consentVersionIncomplete(missingLocales);

      const highest = (
        await tx
          .select({ versionNumber: sql<number | null>`max(${consentVersions.versionNumber})` })
          .from(consentVersions)
          .where(eq(consentVersions.studyId, studyId))
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
      return { row, translations };
    });

    const published = result.row;

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
        locales: result.translations.map((translation) => translation.locale),
      },
      context,
      occurredAt: now,
    });

    return this.present(published);
  }

  private async present(version: ConsentVersionRow): Promise<ConsentVersionResponse> {
    const translations = await this.db
      .select()
      .from(consentVersionTranslations)
      .where(eq(consentVersionTranslations.consentVersionId, version.id));

    return this.toResponse(version, translations);
  }

  private toResponse(
    version: ConsentVersionRow,
    translations: readonly ConsentTranslationRow[],
  ): ConsentVersionResponse {
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
