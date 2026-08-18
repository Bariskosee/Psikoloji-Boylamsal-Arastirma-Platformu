import { sql } from "drizzle-orm";
import { check, index, integer, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { researcherUsers } from "../identity/researcher-users";
import { research } from "../schemas";

/**
 * A study — the unit of research, of configuration, and of authorization.
 *
 * Every researcher permission in this platform is scoped to a study row
 * (REQUIREMENTS.md §5.2), and NFR-04 requires every study-scoped query to
 * filter by `study_id` in the query itself rather than trusting a path
 * parameter that was checked earlier.
 */
export const studies = research.table(
  "studies",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    name: text("name").notNull(),
    description: text("description").notNull().default(""),

    /**
     * `DRAFT → ACTIVE → PAUSED → CLOSED → ARCHIVED` (STRUCTURE.md §5).
     *
     * A text column with a CHECK rather than a native enum type: adding a
     * status to a PostgreSQL enum is a schema migration that cannot run inside
     * some transaction contexts, while a CHECK is an ordinary constraint
     * change. Legal transitions live in @lpr/domain, which is where they can
     * be exhaustively tested.
     */
    status: text("status").notNull().default("DRAFT"),

    /**
     * The public code in the join URL (FR-01, FR-02). Random, never
     * sequential — a sequential code would leak how many studies exist.
     */
    enrollmentCode: text("enrollment_code").notNull(),

    /**
     * The study's IANA timezone. Every wall-clock protocol anchor that is
     * configured as `STUDY`-sourced resolves in this zone (STRUCTURE.md §10),
     * so it is required at creation rather than defaulted to the server's.
     */
    timezone: text("timezone").notNull(),

    defaultLocale: text("default_locale").notNull().default("en"),
    supportedLocales: text("supported_locales").array().notNull(),

    /**
     * FR-42. `NULL` means uncapped. The check that honours it happens at
     * enrollment, server-side, in Phase 5; the setting exists here first so
     * the study can be configured before participants arrive.
     */
    enrollmentCapacity: integer("enrollment_capacity"),

    /**
     * Provenance for the audit trail. `SET NULL` rather than cascade: a study
     * must survive the deactivation or removal of the person who created it.
     */
    createdBy: uuid("created_by").references(() => researcherUsers.id, { onDelete: "set null" }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("studies_enrollment_code_key").on(table.enrollmentCode),
    index("studies_status_idx").on(table.status),
    check(
      "studies_status_valid",
      sql`${table.status} IN ('DRAFT', 'ACTIVE', 'PAUSED', 'CLOSED', 'ARCHIVED')`,
    ),
    // Crockford base-32 minus the ambiguous I, L, O and U (FR-01).
    check(
      "studies_enrollment_code_shape",
      sql`${table.enrollmentCode} ~ '^[0-9A-HJKMNP-TV-Z]{6}$'`,
    ),
    check(
      "studies_supported_locales_nonempty",
      sql`array_length(${table.supportedLocales}, 1) >= 1`,
    ),
    /**
     * A default locale absent from the supported set would render a consent
     * screen the study never translated — an ethics problem, not a cosmetic
     * one, so the database refuses the combination outright.
     */
    check(
      "studies_default_locale_supported",
      sql`${table.defaultLocale} = ANY(${table.supportedLocales})`,
    ),
    check(
      "studies_capacity_positive",
      sql`${table.enrollmentCapacity} IS NULL OR ${table.enrollmentCapacity} > 0`,
    ),
  ],
);

export type StudyRow = typeof studies.$inferSelect;
export type NewStudyRow = typeof studies.$inferInsert;
