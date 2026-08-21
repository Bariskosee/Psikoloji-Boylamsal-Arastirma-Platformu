import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import {
  consentVersionTranslations,
  consentVersions,
  enrollments,
  participants,
  protocolVersions,
  protocols,
  studies,
  studyGroups,
  type Database,
} from "@lpr/db";
import {
  allocateGroup,
  generatePublicCode,
  normalizeEnrollmentCode,
  PUBLIC_CODE_BYTES,
} from "@lpr/domain";
import type {
  EnrollRequest,
  Locale,
  ParticipantMeResponse,
  ParticipantStatus,
  PublicStudyResponse,
  UpdateParticipantRequest,
} from "@lpr/contracts";
import { ApiErrors } from "../../common/api-error.js";
import { generateRandomBytes } from "../../common/crypto.js";
import { DATABASE } from "../database/database.module.js";
import { MaterialisationService } from "../scheduling/materialisation.service.js";
import { ContinuityService } from "./continuity.service.js";

/**
 * Participants (PLAN.md Phase 5).
 *
 * Enrollment, resumption, recovery, and withdrawal. **No ParticipantSession is
 * created here** — materialising a protocol into sessions is Phase 7, and the
 * home screen legitimately shows an empty state until then.
 *
 * ── Enumeration ─────────────────────────────────────────────────────────────
 * Every public lookup answers a nonexistent study, a closed study, and a
 * mistyped code with the same body and the same shape of work, because a
 * difference in either is an oracle telling an outsider which studies exist and
 * how many people are in them.
 */
@Injectable()
export class ParticipantService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly continuity: ContinuityService,
    private readonly materialisation: MaterialisationService,
  ) {}

  /**
   * What a visitor sees from an enrollment link, before consenting.
   *
   * Requires the study to have BOTH a published consent version and a published
   * protocol version: without either, enrolling would bind the participant to
   * nothing, and showing them a consent form they cannot act on wastes their
   * time. Answered as "no such study" rather than "misconfigured study", so a
   * researcher's setup state is not readable from outside.
   */
  async publicStudy(rawCode: string, locale: Locale): Promise<PublicStudyResponse> {
    // A malformed code gets the SAME answer as an unknown one. Rejecting it
    // earlier or differently would tell a caller which shapes are even worth
    // trying, which is the first step of an enumeration sweep.
    const code = normalizeEnrollmentCode(rawCode);
    if (code === null) throw ApiErrors.studyNotFound();

    const study = (
      await this.db.select().from(studies).where(eq(studies.enrollmentCode, code)).limit(1)
    )[0];
    if (!study) throw ApiErrors.studyNotFound();

    const consent = await this.latestPublishedConsent(study.id);
    const protocolVersionId = await this.latestPublishedProtocolVersion(study.id);
    if (!consent || protocolVersionId === null) throw ApiErrors.studyNotFound();

    const translations = await this.db
      .select()
      .from(consentVersionTranslations)
      .where(eq(consentVersionTranslations.consentVersionId, consent.id));

    // The requested locale, then the study's default, then whatever exists.
    // A participant must never be shown an empty consent document.
    const text =
      translations.find((row) => row.locale === locale) ??
      translations.find((row) => row.locale === study.defaultLocale) ??
      translations[0];
    if (!text) throw ApiErrors.studyNotFound();

    return {
      studyId: study.id,
      name: study.name,
      description: study.description,
      defaultLocale: study.defaultLocale as Locale,
      supportedLocales: study.supportedLocales as Locale[],
      acceptingEnrollments: study.status === "ACTIVE",
      consent: {
        versionId: consent.id,
        versionNumber: consent.versionNumber ?? 0,
        title: text.title,
        body: text.body,
      },
    };
  }

  /**
   * Enroll, in one transaction.
   *
   * The participant row, the enrollment binding, the continuity credential and
   * the recovery code commit together or not at all. A half-enrolled
   * participant — a row with no credential — would be someone who consented and
   * can never come back, and nothing could detect it afterwards.
   */
  async enroll(
    rawCode: string,
    input: EnrollRequest,
    now: Date,
  ): Promise<{ publicCode: string; recoveryCode: string; token: string; locale: Locale }> {
    // A malformed code gets the SAME answer as an unknown one. Rejecting it
    // earlier or differently would tell a caller which shapes are even worth
    // trying, which is the first step of an enumeration sweep.
    const code = normalizeEnrollmentCode(rawCode);
    if (code === null) throw ApiErrors.studyNotFound();

    const study = (
      await this.db.select().from(studies).where(eq(studies.enrollmentCode, code)).limit(1)
    )[0];
    if (!study) throw ApiErrors.studyNotFound();
    if (study.status !== "ACTIVE") throw ApiErrors.studyNotAcceptingEnrollments();

    const consent = await this.latestPublishedConsent(study.id);
    const protocolVersionId = await this.latestPublishedProtocolVersion(study.id);
    if (!consent || protocolVersionId === null) throw ApiErrors.studyNotFound();

    // Consent is server-authoritative: the version the participant actually saw
    // must be the one still current. If a new version was published while they
    // were reading, they consented to text that is no longer the study's.
    if (input.consentVersionId !== consent.id) throw ApiErrors.consentVersionStale();

    if (study.enrollmentCapacity !== null) {
      const enrolled = await this.countEnrolled(study.id);
      if (enrolled >= study.enrollmentCapacity) throw ApiErrors.studyNotAcceptingEnrollments();
    }

    const groups = await this.db
      .select()
      .from(studyGroups)
      .where(eq(studyGroups.studyId, study.id));
    // One draw from the same CSPRNG everything else uses, scaled to [0, 1).
    const draw = drawUnitInterval();
    const group = allocateGroup(
      groups.map((row) => ({
        id: row.id,
        key: row.key,
        allocationWeight: row.allocationWeight,
        isActive: row.isActive,
      })),
      draw,
    );

    return this.db.transaction(async (tx) => {
      const participant = await this.insertWithUniquePublicCode(tx, study.id, input, now);

      await tx.insert(enrollments).values({
        participantId: participant.id,
        studyId: study.id,
        protocolVersionId,
        consentVersionId: consent.id,
        consentedAt: now,
        consentLocale: input.consentLocale,
        groupId: group?.id ?? null,
        createdAt: now,
        updatedAt: now,
      });

      /**
       * Every session this participant will ever be offered, in THIS
       * transaction (STRUCTURE.md §8.2).
       *
       * A partially materialised enrollment is a participant with a silently
       * truncated protocol, and no sweeper can detect it: the sweepers
       * reconcile the sessions that exist against the clock, not against the
       * protocol they should have come from.
       */
      await this.materialisation.materialiseEnrollment(
        tx,
        {
          participantId: participant.id,
          studyId: study.id,
          protocolVersionId,
          enrolledAt: now,
          consentedAt: now,
          participantTimezone: input.timezone,
          studyTimezone: study.timezone,
          groupId: group?.id ?? null,
        },
        now,
      );

      const credential = await this.continuity.mint(tx, participant.id, now);
      const recoveryCode = await this.continuity.issueRecoveryCode(tx, participant.id, now);

      return {
        publicCode: participant.publicCode,
        recoveryCode,
        token: credential.token,
        locale: participant.locale as Locale,
      };
    });
  }

  async me(participantId: string): Promise<ParticipantMeResponse> {
    const row = (
      await this.db
        .select({ participant: participants, studyName: studies.name })
        .from(participants)
        .innerJoin(studies, eq(studies.id, participants.studyId))
        .where(eq(participants.id, participantId))
        .limit(1)
    )[0];
    if (!row) throw ApiErrors.participantNotFound();

    return {
      publicCode: row.participant.publicCode,
      studyId: row.participant.studyId,
      studyName: row.studyName,
      status: row.participant.status as ParticipantStatus,
      locale: row.participant.locale as Locale,
      timezone: row.participant.timezone,
      enrolledAt: row.participant.enrolledAt.toISOString(),
      // Sessions do not exist until Phase 7. Stated by the server rather than
      // inferred by the client from a missing endpoint, so the home screen can
      // say "nothing right now" truthfully instead of guessing.
      hasAvailableWork: false,
    };
  }

  async update(
    participantId: string,
    input: UpdateParticipantRequest,
    now: Date,
  ): Promise<ParticipantMeResponse> {
    await this.db
      .update(participants)
      .set({
        ...(input.locale !== undefined ? { locale: input.locale } : {}),
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        updatedAt: now,
      })
      .where(eq(participants.id, participantId));

    return this.me(participantId);
  }

  /**
   * Withdrawal stops contact; it does not delete data (FR-30).
   *
   * Conflating the two would either destroy collected responses on a "stop
   * contacting me" click, or quietly ignore a genuine erasure request. Erasure
   * is a separate, researcher-mediated operation.
   */
  async withdraw(participantId: string, reason: string | undefined, now: Date): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(participants)
        .set({
          status: "WITHDRAWN",
          withdrawnAt: now,
          withdrawalReason: reason ?? null,
          updatedAt: now,
        })
        .where(eq(participants.id, participantId));

      // Every credential, not just the one in use: a withdrawn participant must
      // not be resumable from another device that still holds a cookie.
      await this.continuity.revokeAll(tx, participantId, now);

      // And nothing further is asked of them. Terminal sessions are untouched:
      // a completed questionnaire is data they gave, and withdrawal is not
      // erasure (FR-30).
      await this.materialisation.cancelForWithdrawal(tx, participantId, now);
    });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async insertWithUniquePublicCode(
    tx: Database,
    studyId: string,
    input: EnrollRequest,
    now: Date,
  ): Promise<typeof participants.$inferSelect> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const publicCode = generatePublicCode(generateRandomBytes(PUBLIC_CODE_BYTES));
      try {
        // Each attempt in its own savepoint: in PostgreSQL the first failed
        // statement aborts the transaction, so a retry issued directly on it
        // fails with 25P02 and the retry loop could never succeed.
        return await tx.transaction(async (savepoint) => {
          const inserted = (
            await savepoint
              .insert(participants)
              .values({
                studyId,
                publicCode,
                enrolledAt: now,
                timezone: input.timezone,
                locale: input.locale,
                status: "ACTIVE",
                createdAt: now,
                updatedAt: now,
              })
              .returning()
          )[0];
          if (!inserted) throw ApiErrors.participantNotFound();
          return inserted;
        });
      } catch (error) {
        if (!isUniqueViolation(error, "participants_public_code_idx")) throw error;
      }
    }
    throw ApiErrors.participantCodeUnavailable();
  }

  private async latestPublishedConsent(
    studyId: string,
  ): Promise<typeof consentVersions.$inferSelect | undefined> {
    return (
      await this.db
        .select()
        .from(consentVersions)
        .where(and(eq(consentVersions.studyId, studyId), eq(consentVersions.status, "PUBLISHED")))
        .orderBy(desc(consentVersions.versionNumber))
        .limit(1)
    )[0];
  }

  private async latestPublishedProtocolVersion(studyId: string): Promise<string | null> {
    const row = (
      await this.db
        .select({ id: protocolVersions.id })
        .from(protocolVersions)
        .innerJoin(protocols, eq(protocols.id, protocolVersions.protocolId))
        .where(and(eq(protocols.studyId, studyId), eq(protocolVersions.status, "PUBLISHED")))
        .orderBy(desc(protocolVersions.versionNumber))
        .limit(1)
    )[0];
    return row?.id ?? null;
  }

  private async countEnrolled(studyId: string): Promise<number> {
    const rows = await this.db
      .select({ id: enrollments.id })
      .from(enrollments)
      .where(eq(enrollments.studyId, studyId));
    return rows.length;
  }
}

/** A uniform value in [0, 1) from the same CSPRNG everything else uses. */
function drawUnitInterval(): number {
  const bytes = generateRandomBytes(6);
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  return value / 2 ** 48;
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === "23505" && candidate.constraint === constraint;
}
