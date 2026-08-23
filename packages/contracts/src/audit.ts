import { z } from "zod";

/**
 * Audit contracts (NFR-05).
 *
 * An audit event answers "who did what, to which entity, in which study, and
 * when". It never answers "what did the participant reply" — response payloads
 * and secrets are prohibited from these rows (STRUCTURE.md §6, AGENT.md §5).
 */

export const AUDIT_ACTOR_TYPES = ["RESEARCHER", "PARTICIPANT", "SYSTEM"] as const;
export const auditActorTypeSchema = z.enum(AUDIT_ACTOR_TYPES);
export type AuditActorType = z.infer<typeof auditActorTypeSchema>;

/**
 * Audited actions.
 *
 * NFR-05 names the operations that must be auditable: authentication, study
 * creation and lifecycle changes, version publication, withdrawal and erasure,
 * role changes, and every export. Phase 2 implements the subset it owns; the
 * remaining values are declared now so later phases add a handler rather than
 * re-opening the vocabulary — and so `entity_type` stays consistent across
 * phases written by different people.
 */
export const AUDIT_ACTIONS = [
  // Authentication (Phase 2)
  "auth.login.succeeded",
  "auth.login.failed",
  "auth.logout",
  "auth.password.changed",
  /**
   * A reset was ASKED for. Recorded even when the address matches no account,
   * because "one address requested resets for forty researchers last night" is
   * only visible if the misses are recorded too (Phase 12).
   */
  "auth.password_reset.requested",
  "auth.password_reset.completed",

  // Study (Phase 2)
  "study.created",
  "study.updated",
  "study.status.changed",
  "study.member.added",
  "study.member.role.changed",
  "study.member.removed",

  // Questionnaire (Phase 3)
  "questionnaire.created",
  "questionnaire.updated",
  "questionnaire.version.published",

  // Protocol (Phase 4)
  "protocol.created",
  "protocol.updated",
  "protocol.step.created",
  "protocol.step.updated",
  "protocol.step.deleted",
  "protocol.steps.reordered",
  "protocol.version.published",

  // Later phases — declared, not yet emitted
  "consent.version.published",
  "participant.withdrawn",
  "participant.erased",
  "export.run",
  /**
   * Reading an individual participant's answers (Phase 10, NFR-05).
   *
   * Audited because it is the one dashboard action that exposes psychological
   * data about a named person. Aggregate monitoring is not audited — a trail
   * that records every page view is a trail nobody reads.
   */
  "response.view",
] as const;

export const auditActionSchema = z.enum(AUDIT_ACTIONS);
export type AuditAction = z.infer<typeof auditActionSchema>;

export const AUDIT_ENTITY_TYPES = [
  "researcher_user",
  "study",
  "study_member",
  "questionnaire",
  "questionnaire_version",
  "protocol",
  "protocol_step",
  "protocol_version",
  "consent_version",
  "participant",
  "participant_session",
  "export",
] as const;

export const auditEntityTypeSchema = z.enum(AUDIT_ENTITY_TYPES);
export type AuditEntityType = z.infer<typeof auditEntityTypeSchema>;

export const auditEventResponseSchema = z.object({
  id: z.string().uuid(),
  actorType: auditActorTypeSchema,
  actorId: z.string().uuid().nullable(),
  actorLabel: z.string().nullable(),
  studyId: z.string().uuid().nullable(),
  action: auditActionSchema,
  entityType: auditEntityTypeSchema,
  entityId: z.string().nullable(),
  /** Redacted, non-sensitive context: changed field names, old/new status. */
  metadata: z.record(z.unknown()),
  occurredAt: z.string().datetime(),
});

export type AuditEventResponse = z.infer<typeof auditEventResponseSchema>;

/**
 * Cursor pagination (STRUCTURE.md §12).
 *
 * Offset pagination over an append-only log shifts rows underneath the reader
 * as new events arrive, so page 2 silently repeats or skips entries. The
 * cursor is an opaque `occurredAt|id` pair; callers must not parse it.
 */
export const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});

export type AuditQuery = z.infer<typeof auditQuerySchema>;

export const auditListResponseSchema = z.object({
  events: z.array(auditEventResponseSchema),
  /** Absent when the last page has been reached. */
  nextCursor: z.string().nullable(),
});

export type AuditListResponse = z.infer<typeof auditListResponseSchema>;
