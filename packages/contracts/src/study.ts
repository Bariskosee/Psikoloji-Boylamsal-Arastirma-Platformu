import { z } from "zod";
import { localeSchema } from "./locale.js";
import { studyRoleSchema } from "./roles.js";

/**
 * Study lifecycle (STRUCTURE.md §5).
 *
 * `DRAFT → ACTIVE → PAUSED → CLOSED → ARCHIVED`. The legal transitions and
 * their guards are in @lpr/domain; this is only the vocabulary.
 *
 * There is no `DELETED`. A study that has enrolled anyone can never be
 * destroyed — deleting it would destroy the responses that reference it, and a
 * longitudinal dataset that can vanish on a mis-click is not a research record.
 * `ARCHIVED` is the terminal state.
 */
export const STUDY_STATUSES = ["DRAFT", "ACTIVE", "PAUSED", "CLOSED", "ARCHIVED"] as const;

export const studyStatusSchema = z.enum(STUDY_STATUSES);
export type StudyStatus = z.infer<typeof studyStatusSchema>;

/**
 * An IANA timezone identifier, verified against the runtime's own tz database
 * rather than a regular expression.
 *
 * `Europe/Istanbul` must be a real zone, because every participant-relative
 * schedule and every wall-clock anchor is computed in it (STRUCTURE.md §10). A
 * typo accepted here surfaces weeks later as a questionnaire that arrives at
 * the wrong hour, which is unrecoverable for the data already collected.
 */
export const ianaTimezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidIanaTimezone, { message: "Not a valid IANA timezone identifier" });

export function isValidIanaTimezone(value: string): boolean {
  // `UTC` and fixed offsets are accepted by Intl but are not study timezones:
  // a study anchored to a fixed offset silently gets daylight saving wrong for
  // every participant in a zone that observes it.
  if (!value.includes("/") && value !== "UTC") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * The public enrollment code that appears in the join URL (FR-01, FR-02).
 *
 * Crockford base-32 without the visually ambiguous I, L, O and U, so a code
 * read off a poster or a QR fallback cannot be mistyped into someone else's
 * study. Generation lives in @lpr/domain; this schema is the wire format.
 */
export const ENROLLMENT_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ENROLLMENT_CODE_LENGTH = 6;

export const enrollmentCodeSchema = z
  .string()
  .length(ENROLLMENT_CODE_LENGTH)
  .regex(new RegExp(`^[${ENROLLMENT_CODE_ALPHABET}]+$`), "Invalid enrollment code");

export const studyNameSchema = z.string().trim().min(1).max(200);
export const studyDescriptionSchema = z.string().trim().max(4000);

/**
 * Locales a study offers to participants.
 *
 * Constrained to the platform's interface locales for the MVP: offering a
 * study language the participant application cannot render produces a
 * half-translated consent screen, which is a research-ethics problem rather
 * than a cosmetic one.
 */
export const studyLocalesSchema = z.array(localeSchema).min(1).max(8);

const createStudyFieldsSchema = z.object({
  name: studyNameSchema,
  description: studyDescriptionSchema.default(""),
  timezone: ianaTimezoneSchema,
  defaultLocale: localeSchema,
  supportedLocales: studyLocalesSchema,
  /**
   * Enrollment capacity (FR-42). `null` means uncapped. Enforced server-side
   * at enrollment in Phase 5; stored here so the setting exists before the
   * endpoint that honours it.
   */
  enrollmentCapacity: z.number().int().positive().max(1_000_000).nullable().default(null),
});

/**
 * The cross-field rule lives here rather than in the service, so it is applied
 * identically by the create endpoint, by the update endpoint, and by the form
 * that submits to them.
 *
 * The database enforces it too. Without this schema-level check, the
 * constraint violation would surface as a 500 — an internal error for what is
 * plainly a validation mistake the user can fix.
 */
export const createStudyRequestSchema = createStudyFieldsSchema.refine(
  (value) => value.supportedLocales.includes(value.defaultLocale),
  {
    message: "The default locale must be one of the supported locales",
    path: ["defaultLocale"],
  },
);

export type CreateStudyRequest = z.infer<typeof createStudyRequestSchema>;

/**
 * Partial update. `status` is deliberately absent — a lifecycle change goes
 * through its own endpoint so it is guarded, audited, and validated as a
 * transition rather than as a field assignment.
 */
export const updateStudyRequestSchema = createStudyFieldsSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "No fields to update" });

export type UpdateStudyRequest = z.infer<typeof updateStudyRequestSchema>;

export const changeStudyStatusRequestSchema = z.object({
  status: studyStatusSchema,
});

export type ChangeStudyStatusRequest = z.infer<typeof changeStudyStatusRequestSchema>;

export const studyResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  status: studyStatusSchema,
  enrollmentCode: enrollmentCodeSchema,
  /** Absolute participant-facing join URL, built from the participant origin. */
  enrollmentUrl: z.string().url(),
  timezone: z.string(),
  defaultLocale: localeSchema,
  supportedLocales: z.array(localeSchema),
  enrollmentCapacity: z.number().int().positive().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  /** The requesting user's role in this study. Drives what the UI offers. */
  viewerRole: studyRoleSchema,
});

export type StudyResponse = z.infer<typeof studyResponseSchema>;

export const studyListResponseSchema = z.object({
  studies: z.array(studyResponseSchema),
});

export type StudyListResponse = z.infer<typeof studyListResponseSchema>;

// ───────────────────────────── Membership ──────────────────────────────────

export const addStudyMemberRequestSchema = z.object({
  /**
   * An existing researcher account's email. Phase 2 has no invitation email —
   * that is Phase 12 — so a member must already have an account.
   */
  email: z.string().trim().toLowerCase().email().max(320),
  role: studyRoleSchema,
});

export type AddStudyMemberRequest = z.infer<typeof addStudyMemberRequestSchema>;

export const updateStudyMemberRequestSchema = z.object({
  role: studyRoleSchema,
});

export type UpdateStudyMemberRequest = z.infer<typeof updateStudyMemberRequestSchema>;

export const studyMemberResponseSchema = z.object({
  userId: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string(),
  role: studyRoleSchema,
  addedAt: z.string().datetime(),
});

export type StudyMemberResponse = z.infer<typeof studyMemberResponseSchema>;

export const studyMemberListResponseSchema = z.object({
  members: z.array(studyMemberResponseSchema),
});

export type StudyMemberListResponse = z.infer<typeof studyMemberListResponseSchema>;
