import { sql } from "drizzle-orm";
import { boolean, check, index, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { identity } from "../schemas";

/**
 * Researcher accounts.
 *
 * **In the `identity` schema, not `research`.** A researcher row holds an email
 * address and an argon2id password hash — directly identifying data and
 * authentication secrets. `app_analytics` holds SELECT on the whole of
 * `research`, so placing this table there would put every researcher's
 * credential hash one accidental join away from an export code path. The
 * privacy boundary in ADR-003 is drawn around re-identifying and secret data,
 * and this table is both.
 *
 * Participants have no row here and never will. They authenticate with an
 * opaque continuity credential and have no password at all (NFR-09, ADR-007).
 */
export const researcherUsers = identity.table(
  "researcher_users",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    /**
     * Lowercased at the contract boundary AND enforced here, so `A@x.org` and
     * `a@x.org` cannot become two accounts through a code path that forgot to
     * normalise. Application-level checks lose races; constraints do not.
     */
    email: text("email").notNull(),

    /**
     * argon2id, encoded in PHC string format (`$argon2id$v=19$m=...`), which
     * carries its own parameters. That is what makes the work factor
     * upgradable: a future login can detect an outdated cost and rehash.
     *
     * Never selected into a DTO. No contract type in @lpr/contracts contains
     * this column.
     */
    passwordHash: text("password_hash").notNull(),

    displayName: text("display_name").notNull(),

    /** Locale for this researcher's own interface (FR-37). */
    locale: text("locale").notNull().default("en"),

    /**
     * Operational health endpoints only (`/api/ops/*`), never research data
     * (REQUIREMENTS.md §5.2). Study access always comes from a membership row.
     */
    isAdmin: boolean("is_admin").notNull().default(false),

    /**
     * Deactivation rather than deletion. Deleting a researcher would orphan
     * the audit trail that records what they did, and NFR-05 requires that
     * trail to remain interpretable.
     */
    isActive: boolean("is_active").notNull().default(true),

    passwordChangedAt: timestamp("password_changed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("researcher_users_email_key").on(table.email),
    index("researcher_users_active_idx").on(table.isActive),
    check("researcher_users_email_lowercase", sql`${table.email} = lower(${table.email})`),
    check("researcher_users_email_shape", sql`${table.email} LIKE '%_@_%'`),
    check("researcher_users_locale_valid", sql`${table.locale} IN ('en', 'tr')`),
  ],
);

export type ResearcherUserRow = typeof researcherUsers.$inferSelect;
export type NewResearcherUserRow = typeof researcherUsers.$inferInsert;
