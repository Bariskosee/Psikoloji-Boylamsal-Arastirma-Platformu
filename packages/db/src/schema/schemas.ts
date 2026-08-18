import { pgSchema } from "drizzle-orm/pg-core";

/**
 * The two PostgreSQL schemas (ADR-003, NFR-03).
 *
 * `research` — canonical research data. Readable by the analytics role.
 * `identity` — everything that can re-identify a person, plus authentication
 *              secrets. The analytics role has NO privileges here at all.
 *
 * The split is what makes NFR-03 enforceable instead of aspirational: an
 * export query that accidentally joins a contact detail or a password hash
 * fails at the database, in CI, before anyone reviews it.
 */
export const research = pgSchema("research");
export const identity = pgSchema("identity");
