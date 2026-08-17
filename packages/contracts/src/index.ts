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
 * Phase 0 scope: health contracts only. Domain contracts arrive in Phase 1.
 */

export * from "./health.js";
export * from "./locale.js";
