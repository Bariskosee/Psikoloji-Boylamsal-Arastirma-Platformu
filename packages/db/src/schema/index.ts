/**
 * Drizzle schema definitions.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MERGE NOTE — Phase 1 owns the complete schema.
 *
 * PLAN.md authors the full model for both PostgreSQL schemas in Phase 1, in
 * migration 0001. This branch defines only the five tables Phase 2 needs to
 * function — `researcher_users`, `researcher_sessions`, `studies`,
 * `study_members`, `audit_events` — because Phase 2 cannot authenticate anyone
 * against a schema that does not exist yet.
 *
 * When Phase 1 merges, ITS definitions are authoritative for anything that
 * disagrees. The migration here is written idempotently (`IF NOT EXISTS`
 * throughout) so the two can be reconciled without a destructive reset.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export * from "./schemas";

// identity — re-identifying data and authentication secrets.
export * from "./identity/researcher-users";
export * from "./identity/researcher-sessions";

// research — canonical research data.
export * from "./research/studies";
export * from "./research/study-members";
export * from "./research/audit-events";
export * from "./research/questionnaires";
export * from "./research/questionnaire-versions";
export * from "./research/question-versions";
export * from "./research/question-version-translations";
export * from "./research/question-options";
export * from "./research/question-option-translations";
