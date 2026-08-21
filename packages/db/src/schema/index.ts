/**
 * Drizzle schema definitions.
 *
 * Two PostgreSQL schemas, kept apart deliberately (ADR-003): `identity` holds
 * the researcher accounts and their sessions, `research` holds study data.
 *
 * What is defined here is what the implemented phases need — the tables below,
 * across migrations 0000–0002. Later phases add their own tables as they land;
 * this file and the migration journal are the pair to read together, because
 * Drizzle cannot express the triggers, roles, and immutability guards the
 * migrations install alongside them.
 */

export * from "./schemas";

// identity — re-identifying data and authentication secrets.
export * from "./identity/researcher-users";
export * from "./identity/researcher-sessions";
export * from "./identity/participant-credentials";

// research — canonical research data.
export * from "./research/studies";
export * from "./research/study-members";
export * from "./research/audit-events";
export * from "./research/system-heartbeats";
export * from "./research/questionnaires";
export * from "./research/questionnaire-versions";
export * from "./research/question-versions";
export * from "./research/question-version-translations";
export * from "./research/question-options";
export * from "./research/question-option-translations";
export * from "./research/protocols";
export * from "./research/protocol-versions";
export * from "./research/reminder-policies";
export * from "./research/protocol-steps";
export * from "./research/consent-versions";
export * from "./research/study-groups";
export * from "./research/participants";
export * from "./research/enrollments";
export * from "./research/participant-sessions";
export * from "./research/responses";
