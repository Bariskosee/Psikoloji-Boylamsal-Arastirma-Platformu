import { sql } from "drizzle-orm";
import { check, index, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { identity } from "../schemas";

/**
 * Participant continuity credentials (STRUCTURE.md §11.3).
 *
 * In the `identity` schema, apart from research data, because this is the one
 * table that can turn a pseudonymous row back into "this specific device and
 * person". The analytics role has no access to this schema at all.
 *
 * ── What is stored, and what is not ─────────────────────────────────────────
 * The token itself is NEVER stored. Enrollment mints 256 bits from a CSPRNG,
 * sends them in an HttpOnly cookie, and keeps only a SHA-256 hash plus a short
 * lookup prefix.
 *
 * The prefix exists because a hash cannot be indexed usefully for "find the
 * row matching this token" without hashing every candidate: the prefix narrows
 * the search to a handful of rows, and the constant-time hash comparison then
 * decides. It is short enough that it identifies nothing on its own.
 *
 * SHA-256 rather than argon2 — unlike a password, this is 256 bits of
 * CSPRNG output with no guessable structure, so the slow-hash defence against
 * offline brute force buys nothing and would cost a KDF on every request.
 *
 * ── Rotation ────────────────────────────────────────────────────────────────
 * `rotated_at` marks a credential superseded; it stays usable for a grace
 * period so requests already in flight with the old token do not fail and sign
 * a participant out mid-questionnaire. `revoked_at` is immediate and beats the
 * grace period — withdrawal and recovery both use it.
 */
export const participantCredentials = identity.table(
  "participant_credentials",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    /**
     * Deliberately NOT a foreign key to `research.participants`.
     *
     * The two schemas are separated so a compromise or a mis-scoped grant on
     * one does not imply the other, and a cross-schema constraint would
     * reintroduce exactly the coupling that separation exists to prevent. The
     * application resolves the participant after the credential verifies.
     */
    participantId: uuid("participant_id").notNull(),

    /** SHA-256 of the token, hex. The token itself is never written anywhere. */
    tokenHash: text("token_hash").notNull(),
    /** First characters of the token, to narrow the lookup before comparing. */
    lookupPrefix: text("lookup_prefix").notNull(),

    /**
     * Which storage container this credential was minted in — BROWSER or
     * INSTALLED (STRUCTURE.md §11.4, Phase 8).
     *
     * On iOS the Home-Screen application and the Safari tab can hold separate
     * cookie stores, so a participant who enrolled in a tab and then installed
     * arrives as a stranger. This column is what makes that visible BEFORE the
     * data is lost: a participant whose only credential is `BROWSER` is one
     * cleared browser away from leaving the study, and a researcher can be
     * shown that cohort while there is still time to intervene.
     *
     * Defaults to BROWSER because that is where enrollment happens. The
     * handoff redemption is the only path that writes INSTALLED, and it does so
     * because the request arrived from inside the installed application.
     */
    credentialContext: text("credential_context").notNull().default("BROWSER"),

    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "participant_credentials_context_valid",
      sql`${table.credentialContext} IN ('BROWSER', 'INSTALLED')`,
    ),
    index("participant_credentials_lookup_idx").on(table.lookupPrefix),
    index("participant_credentials_participant_idx").on(table.participantId),
    uniqueIndex("participant_credentials_hash_idx").on(table.tokenHash),
  ],
);

/**
 * Recovery codes (STRUCTURE.md §11.3).
 *
 * Separate from the credential because they have different lifetimes and
 * different failure modes: a credential rotates silently and often, a recovery
 * code is shown once and redeemed at most once, possibly months later.
 *
 * Hashed for the same reason and — unlike the continuity token — this one is
 * eight characters a human can type, so it IS guessable at scale. That is why
 * redemption is rate limited, why `redeemed_at` makes reuse impossible, and
 * why a wrong code and an unknown code are answered identically.
 */
export const participantRecoveryCodes = identity.table(
  "participant_recovery_codes",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    participantId: uuid("participant_id").notNull(),

    codeHash: text("code_hash").notNull(),

    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set on first successful redemption; a second attempt then fails. */
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("participant_recovery_codes_hash_idx").on(table.codeHash),
    index("participant_recovery_codes_participant_idx").on(table.participantId),
  ],
);

/**
 * Install handoff codes (STRUCTURE.md §11.4, ADR-007, FR-41).
 *
 * Shaped like the recovery codes above and governed by different numbers,
 * because the two failure modes are different. A recovery code is written down
 * and redeemed months later from a new device. A handoff code is minted in the
 * tab the participant is looking at, tapped minutes later inside the
 * application they just installed, and worthless after that.
 *
 * Hashed at rest for the same reason: the column must not be a list of live
 * capabilities to become other people. `expires_at` is stored rather than
 * derived from `issued_at` so that the TTL a code was minted under travels with
 * the row — changing the policy later must not silently extend or revoke codes
 * that are already out in the world.
 *
 * The single-use guarantee is `redeemed_at` plus a conditional UPDATE, never a
 * read followed by a write: two simultaneous taps of the same link would both
 * pass a read-then-check, and only one may win.
 */
export const participantHandoffCodes = identity.table(
  "participant_handoff_codes",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    participantId: uuid("participant_id").notNull(),

    codeHash: text("code_hash").notNull(),

    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Set on first successful redemption; a second attempt then fails. */
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * A code that expires before it was issued is not a short-lived code, it is
     * a code that was never redeemable — and it would fail silently, at the
     * exact moment a participant is most likely to be lost.
     */
    check(
      "participant_handoff_codes_expiry_after_issue",
      sql`${table.expiresAt} > ${table.issuedAt}`,
    ),
    uniqueIndex("participant_handoff_codes_hash_idx").on(table.codeHash),
    index("participant_handoff_codes_participant_idx").on(table.participantId),
  ],
);
