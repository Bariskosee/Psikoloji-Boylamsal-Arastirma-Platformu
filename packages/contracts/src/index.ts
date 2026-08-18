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
 */

export * from "./health.js";
export * from "./locale.js";
export * from "./errors.js";
export * from "./roles.js";
export * from "./auth.js";
export * from "./study.js";
export * from "./audit.js";
