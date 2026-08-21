import { z } from "zod";
import { localeSchema } from "./locale.js";
import { ianaTimezoneSchema } from "./study.js";

/**
 * Participant vocabulary (STRUCTURE.md §6, §11.3; PLAN.md Phase 5).
 *
 * Nothing in these shapes directly identifies a person. A participant has a
 * `publicCode`, a locale, and a timezone; there is no name, no email, and no
 * device identifier. The platform is PSEUDONYMOUS, not anonymous — a
 * continuity credential and, later, a push endpoint keep re-identification
 * possible — and saying so plainly is required (AGENT.md §3.3).
 *
 * The continuity token is absent from every shape here on purpose. It exists
 * only in an HttpOnly cookie and, hashed, in `identity.participant_credentials`;
 * giving it a shared type is the first step toward something serialising it.
 */

/**
 * The continuity cookie.
 *
 * Named apart from the researcher session cookie so the two can never be
 * confused by a guard, and host-only like it. The value is the 256-bit token
 * itself; nothing else ever carries it.
 */
export const PARTICIPANT_COOKIE_NAME = "lpr_participant";

/** How long the cookie lives — STRUCTURE.md §11.3 fixes this at one year. */
export const PARTICIPANT_COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

export const PARTICIPANT_STATUSES = ["ACTIVE", "COMPLETED", "WITHDRAWN"] as const;
export const participantStatusSchema = z.enum(PARTICIPANT_STATUSES);
export type ParticipantStatus = z.infer<typeof participantStatusSchema>;

/** `P-` plus six Crockford base-32 characters, excluding I, L, O and U. */
export const publicCodeSchema = z.string().regex(/^P-[0-9A-HJKMNP-TV-Z]{6}$/);

export const recoveryCodeSchema = z
  .string()
  .min(8)
  .max(20)
  .describe("Eight characters, as shown once at enrollment; separators are tolerated");

/**
 * What a visitor sees BEFORE consenting, from the enrollment link.
 *
 * Deliberately thin. This endpoint is public and unauthenticated, so anything
 * in it is readable by anyone holding a study code: enough to decide whether
 * to take part, and nothing about who else has.
 */
export const publicStudySchema = z.object({
  studyId: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  defaultLocale: localeSchema,
  supportedLocales: z.array(localeSchema),
  /** False when the study is not recruiting, or its capacity is full. */
  acceptingEnrollments: z.boolean(),
  consent: z.object({
    versionId: z.string().uuid(),
    versionNumber: z.number().int(),
    /** The consent document in the requested locale, as plain text. */
    title: z.string(),
    body: z.string(),
  }),
});

export type PublicStudyResponse = z.infer<typeof publicStudySchema>;

export const enrollRequestSchema = z.object({
  /** Which consent version the participant was actually shown. */
  consentVersionId: z.string().uuid(),
  /**
   * The affirmative action itself. Sent rather than assumed so that a client
   * bug cannot enroll someone who never ticked it — though the server treats
   * this as one signal and records consent from its own state, not from here.
   */
  consented: z.literal(true),
  consentLocale: localeSchema,
  locale: localeSchema,
  /** Read from the device; null when the browser will not say. */
  timezone: ianaTimezoneSchema.nullable(),
});

export type EnrollRequest = z.infer<typeof enrollRequestSchema>;

/**
 * The one and only response that carries a recovery code.
 *
 * Shown once, at enrollment. It is stored hashed, so the platform genuinely
 * cannot show it again — which is the property that makes it safe to hand out
 * and the reason the interface must insist the participant keeps it.
 */
export const enrollResponseSchema = z.object({
  publicCode: publicCodeSchema,
  recoveryCode: z.string(),
  locale: localeSchema,
});

export type EnrollResponse = z.infer<typeof enrollResponseSchema>;

export const recoverRequestSchema = z.object({
  recoveryCode: recoveryCodeSchema,
});

export type RecoverRequest = z.infer<typeof recoverRequestSchema>;

/**
 * Who the caller is, resolved from the continuity cookie.
 *
 * `hasAvailableWork` exists so the participant home screen can say "nothing
 * right now" truthfully in Phase 5, where sessions do not exist yet, without
 * the client inferring emptiness from a missing endpoint.
 */
export const participantMeSchema = z.object({
  publicCode: publicCodeSchema,
  studyId: z.string().uuid(),
  studyName: z.string(),
  status: participantStatusSchema,
  locale: localeSchema,
  timezone: ianaTimezoneSchema.nullable(),
  enrolledAt: z.string(),
  hasAvailableWork: z.boolean(),
});

export type ParticipantMeResponse = z.infer<typeof participantMeSchema>;

export const updateParticipantSchema = z.object({
  locale: localeSchema.optional(),
  timezone: ianaTimezoneSchema.nullable().optional(),
});

export type UpdateParticipantRequest = z.infer<typeof updateParticipantSchema>;

/**
 * Withdrawal is not deletion (FR-30, AGENT.md §4).
 *
 * The participant stops receiving anything, and their existing responses
 * remain part of the dataset unless erasure is separately requested. Conflating
 * the two would either destroy collected data on a "stop contacting me" click
 * or ignore a genuine erasure request.
 */
export const withdrawRequestSchema = z.object({
  reason: z.string().max(500).optional(),
});

export type WithdrawRequest = z.infer<typeof withdrawRequestSchema>;
