/**
 * @lpr/contracts — the dependency leaf.
 *
 * Zod schemas here are the single definition used by NestJS request validation,
 * by both frontends' forms, and by the export shaper. A question type or an
 * export column cannot drift between server and client because there is only
 * one definition of it. See ADR-001.
 *
 * This package must not import any other workspace package (enforced by lint).
 *
 * Secret material — password hashes, session token hashes, credential hashes,
 * push endpoints and keys — is deliberately absent. Those columns exist only in
 * `packages/db`, so nothing can serialise one by reaching for a shared type.
 *
 * Phase 0 scope: health and locale.
 * Phase 2 adds: errors, roles, auth, study, audit.
 * Phase 3 adds: question-types, questionnaire.
 * Phase 4 adds: protocol — trigger vocabulary, step and reminder-policy shapes,
 *               and the timeline-preview request and response.
 * Phase 5 adds: consent — versioned documents and their translations;
 *               participant — public study view, enrollment, recovery, and
 *               withdrawal. The continuity token is deliberately absent: it
 *               exists only in an HttpOnly cookie and, hashed, in the identity
 *               schema, so nothing here can serialise it.
 * Phase 6 adds: session — the runtime's questions, saved answers, autosave
 *               batch, and completion result.
 * Phase 8 adds: push — subscription registration, the participant's own view of
 *               their registered devices, and the install handoff code. The
 *               VAPID private key and the push endpoint are absent from every
 *               response shape here, deliberately.
 * Phase 9 adds: notification — kinds, outcomes, suppression reasons, the send
 *               job payload, and the push payload. `SENT_ACCEPTED` is named for
 *               what is observable: a push service took the message. Nothing
 *               here may be read as a delivery receipt (FR-15, FR-19).
 */

export * from "./health.js";
export * from "./locale.js";
export * from "./errors.js";
export * from "./roles.js";
export * from "./auth.js";
export * from "./study.js";
export * from "./audit.js";
export * from "./question-types.js";
export * from "./questionnaire.js";
export * from "./protocol.js";
export * from "./consent.js";
export * from "./participant.js";
export * from "./session.js";
export * from "./push.js";
export * from "./notification.js";
export * from "./analytics.js";
