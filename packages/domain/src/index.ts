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
 * Phase 7 adds: session/materialisation — expanding a protocol version into
 *               the sessions one enrollment implies, trigger propagation, and
 *               unreachable-trigger cascades.
 * Phase 8 adds: push/ — the push subscription retention rule the worker's
 *               prune sweeper applies; participant/handoff — the single-use
 *               install handoff code.
 * Phase 9 adds: notification/ — the eight-guard chain that decides whether one
 *               reminder may be sent, the quiet-hours window in the
 *               participant's own zone, and the self-chaining rule. The order
 *               of the guards is itself the contract: which one reports a
 *               suppression decides what the data means.
 *
 *               NOT here: the push availability matrix that decides what a
 *               participant is told about notifications on their device. It is
 *               a decision about a browser, made in a browser, and the frontends
 *               are forbidden from importing this package (STRUCTURE.md §3). It
 *               lives beside its only caller, in
 *               `apps/participant/src/lib/push-availability.ts`, with its own
 *               unit tests.
 * Phase 10 adds: compliance/ — the single implementation of every metric in
 *               `docs/compliance-formula.md`. Nothing outside this directory
 *               may re-derive a denominator: a compliance figure that reaches a
 *               methods section has to be reproducible, and a second copy of
 *               the rule in a dashboard component is how two numbers that
 *               should agree stop agreeing.
 *
 * Phase 11 adds: export/ — the missingness contract shared by the inspector
 *               and both export formats, CSV encoding, wide-format column
 *               naming, and per-type value encoding. `docs/export-codebook.md`
 *               §1 names the worst thing this platform can do — exporting a
 *               missing value as `0` — and this directory is where that is
 *               made impossible rather than merely discouraged.
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
export * from "./participant/handoff.js";
export * from "./session/state-machine.js";
export * from "./session/answer-validation.js";
export * from "./session/materialisation.js";
export * from "./push/index.js";
export * from "./notification/index.js";
export * from "./compliance/index.js";
export * from "./export/index.js";
