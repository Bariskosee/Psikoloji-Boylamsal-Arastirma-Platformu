import { sql } from "drizzle-orm";
import { index, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { identity } from "../schemas";
import { researcherUsers } from "./researcher-users";

/**
 * Password-reset tokens for researcher accounts (PLAN.md Phase 12, FR-06).
 *
 * ── Why a table and not a signed token ──────────────────────────────────────
 * The same reason `researcher_sessions` is a table: a signed token stays valid
 * until it expires no matter what the server thinks. A reset link must be
 * usable exactly once and must be killable — if a researcher reports that a
 * reset email reached the wrong inbox, "we cannot revoke it, wait an hour" is
 * not an answer. With a row, spending it is an `UPDATE` and revoking it is a
 * `DELETE`.
 *
 * ── The token is never stored ───────────────────────────────────────────────
 * Only its SHA-256. A reset token is a bearer credential for the ACCOUNT, so a
 * leaked dump of this table would otherwise be a leaked set of account
 * takeovers. SHA-256 rather than argon2id for the same reason as the session
 * token: it is 256 bits of CSPRNG output, so there is no low-entropy secret for
 * a slow hash to protect.
 */
export const researcherPasswordResets = identity.table(
  "researcher_password_resets",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    /** SHA-256 of the reset token, hex-encoded. Never the token itself. */
    tokenHash: text("token_hash").notNull(),

    userId: uuid("user_id")
      .notNull()
      .references(() => researcherUsers.id, { onDelete: "cascade" }),

    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

    /**
     * Set the moment the token is spent, in the same transaction that changes
     * the password.
     *
     * Kept rather than deleted: "this link was already used" and "this link
     * never existed" are different facts during an incident, and only the row
     * can tell them apart. Both are reported to the caller identically.
     */
    usedAt: timestamp("used_at", { withTimezone: true }),

    /**
     * Salted hash of the requesting IP, never the address (STRUCTURE.md §11.5).
     * Enough to see that one address requested resets for forty accounts.
     */
    requestedIpHash: text("requested_ip_hash"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("researcher_password_resets_token_hash_key").on(table.tokenHash),
    // Drives "invalidate this account's outstanding links", which runs on every
    // successful reset and on every password change.
    index("researcher_password_resets_user_idx").on(table.userId),
    index("researcher_password_resets_expires_idx").on(table.expiresAt),
  ],
);

export type ResearcherPasswordResetRow = typeof researcherPasswordResets.$inferSelect;
export type NewResearcherPasswordResetRow = typeof researcherPasswordResets.$inferInsert;
