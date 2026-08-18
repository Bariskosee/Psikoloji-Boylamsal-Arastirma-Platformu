import { sql } from "drizzle-orm";
import { index, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { identity } from "../schemas";
import { researcherUsers } from "./researcher-users";

/**
 * Database-backed researcher sessions.
 *
 * Server-side sessions rather than stateless JWTs, for one reason that matters
 * more here than convenience: **revocation must take effect on the next
 * request**. A signed token stays valid until it expires no matter what the
 * server thinks, so "log out everywhere" and "disable this account" become
 * promises the system cannot keep. With a session row, logout is a `DELETE`
 * and the next request finds nothing.
 *
 * The session token itself is NEVER stored. Only its SHA-256 hash is, so a
 * dump of this table cannot be replayed as a login. SHA-256 rather than
 * argon2id is correct here and only here: the token is 256 bits of CSPRNG
 * output, so there is no low-entropy secret to slow an attacker down, and
 * every authenticated request would otherwise pay a deliberately expensive
 * hash.
 */
export const researcherSessions = identity.table(
  "researcher_sessions",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    /** SHA-256 of the session token, hex-encoded. Never the token itself. */
    tokenHash: text("token_hash").notNull(),

    /**
     * SHA-256 of the double-submit CSRF token (STRUCTURE.md §11.5). Stored
     * alongside the session so the pair is invalidated together — a CSRF token
     * that outlives its session is a token nobody can reason about.
     */
    csrfTokenHash: text("csrf_token_hash").notNull(),

    userId: uuid("user_id")
      .notNull()
      .references(() => researcherUsers.id, { onDelete: "cascade" }),

    /**
     * Absolute expiry. Independent of activity: a session that has been alive
     * for the maximum lifetime ends even if it is being used constantly.
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

    /**
     * Idle-timeout input. Updated at most once per minute rather than on every
     * request — a write on every authenticated request would make session
     * validation the busiest write path in the system for no security gain.
     */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),

    /**
     * Set on logout and on password change. The row is kept rather than
     * deleted so that "this session was revoked" stays distinguishable from
     * "this session never existed" while investigating an incident.
     */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),

    /**
     * Salted hash of the client IP, never the address itself (STRUCTURE.md
     * §11.5). Enough to notice a session moving between networks; not enough
     * to reconstruct where a researcher was working from.
     */
    ipHash: text("ip_hash"),
    /** Truncated User-Agent, for the "your sessions" view. Not a fingerprint. */
    userAgent: text("user_agent"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("researcher_sessions_token_hash_key").on(table.tokenHash),
    index("researcher_sessions_user_idx").on(table.userId),
    // Drives the expired-session sweep, which would otherwise scan the table.
    index("researcher_sessions_expires_idx").on(table.expiresAt),
  ],
);

export type ResearcherSessionRow = typeof researcherSessions.$inferSelect;
export type NewResearcherSessionRow = typeof researcherSessions.$inferInsert;
