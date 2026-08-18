/**
 * @lpr/db — Drizzle schema, migrations, and connectivity.
 *
 * Server-side only. Frontends must never import this package; the ESLint
 * boundary rule enforces it, so a database credential cannot reach a browser
 * bundle by accident. See STRUCTURE.md §3 and ADR-001.
 *
 * Phase 0 scope: connectivity and migration tooling.
 * Phase 2 adds: the five tables researcher authentication, studies, membership
 * and audit need, plus the two database roles. Phase 1 owns the complete
 * schema — see the merge note in `src/schema/index.ts`.
 */

export * from "./client.js";
export * from "./drizzle.js";
export * from "./schema/index.js";
