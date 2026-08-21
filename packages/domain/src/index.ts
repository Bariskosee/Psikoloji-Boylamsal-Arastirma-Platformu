/**
 * @lpr/domain — pure domain logic.
 *
 * This package holds the logic most capable of silently corrupting research
 * data: protocol timing, session state transitions, compliance denominators,
 * missingness classification, and export shaping.
 *
 * It is deliberately pure — no database, no framework, no I/O, no wall-clock
 * access — so all of it is exhaustively unit-testable in milliseconds without a
 * database and without waiting for real time. Everything else in the system is
 * plumbing around this package. See STRUCTURE.md §3 and ADR-001.
 *
 * Phase 0 scope: the Clock port.
 * Phase 2 adds: authz/ — the researcher permission matrix and password policy;
 *               study/ — lifecycle transitions and enrollment codes.
 * Phase 3 adds: question-types/ — the question-type registry; questionnaire/ —
 *               entity-key generation, reorder validation, publish eligibility.
 * ADR-005 adds: scheduling/ — sweeper-liveness classification and the
 *               staleness guard that stops a post-outage notification burst.
 * Phase 4 adds: protocol/ — occurrence timing in both anchor modes, the
 *               trigger-graph rules of FR-48 and ADR-011, and the timeline
 *               preview the builder and the Phase 7 engine both call.
 * Phase 5 adds: participant/ — public and recovery code generation, the
 *               continuity rotation policy, and weighted group allocation.
 * Phase 6 adds: session/ — the ParticipantSession state machine, per-type
 *               answer validation, and the autosave revision rule.
 * Later phases add: compliance/, missingness/, export/.
 */

export * from "./clock.js";
export * from "./authz/permissions.js";
export * from "./authz/password-policy.js";
export * from "./study/lifecycle.js";
export * from "./study/enrollment-code.js";
export * from "./question-types/registry.js";
export * from "./questionnaire/entity-key.js";
export * from "./questionnaire/reorder.js";
export * from "./questionnaire/publish.js";
export * from "./scheduling/index.js";
export * from "./protocol/trigger-graph.js";
export * from "./protocol/timing.js";
export * from "./protocol/preview.js";
export * from "./participant/identity.js";
export * from "./participant/continuity.js";
export * from "./participant/group-allocation.js";
export * from "./session/state-machine.js";
export * from "./session/answer-validation.js";
