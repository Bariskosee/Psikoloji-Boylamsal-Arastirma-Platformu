/**
 * @lpr/db — Drizzle schema, migrations, and connectivity.
 *
 * Server-side only. Frontends must never import this package; the ESLint
 * boundary rule enforces it, so a database credential cannot reach a browser
 * bundle by accident. See STRUCTURE.md §3 and ADR-001.
 *
 * Phase 0 scope: connectivity and migration tooling only. ZERO migrations are
 * authored in this phase — the full schema lands in Phase 1.
 */

export * from "./client.js";
export * from "./schema/index.js";
