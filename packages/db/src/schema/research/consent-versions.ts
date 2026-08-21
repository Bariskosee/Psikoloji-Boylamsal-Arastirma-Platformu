import { sql } from "drizzle-orm";
import { check, integer, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { researcherUsers } from "../identity/researcher-users";
import { research } from "../schemas";
import { studies } from "./studies";

/**
 * A consent document version (FR-05).
 *
 * Immutable once published, like questionnaire and protocol versions, and for
 * the sharpest reason of the three: an enrollment records which version the
 * participant agreed to and in which language. If the text behind that
 * reference can change, the record is worthless — an ethics committee asking
 * "what exactly did this person consent to?" would have no answer.
 */
export const consentVersions = research.table(
  "consent_versions",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id, { onDelete: "cascade" }),

    status: text("status").notNull().default("DRAFT"),
    versionNumber: integer("version_number"),

    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedBy: uuid("published_by").references(() => researcherUsers.id, {
      onDelete: "set null",
    }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "consent_versions_status_valid",
      sql`${table.status} IN ('DRAFT', 'PUBLISHED', 'RETIRED')`,
    ),
    check(
      "consent_versions_publication_complete",
      sql`(${table.status} = 'DRAFT' AND ${table.versionNumber} IS NULL AND ${table.publishedAt} IS NULL)
          OR (${table.status} <> 'DRAFT' AND ${table.versionNumber} IS NOT NULL AND ${table.publishedAt} IS NOT NULL)`,
    ),
    uniqueIndex("consent_versions_one_draft_idx")
      .on(table.studyId)
      .where(sql`${table.status} = 'DRAFT'`),
    uniqueIndex("consent_versions_number_idx").on(table.studyId, table.versionNumber),
  ],
);

/**
 * One row per locale.
 *
 * Plain text, never markup: a consent document rendered from researcher-supplied
 * HTML would be an injection surface aimed at participants, and the formatting
 * is not worth it.
 */
export const consentVersionTranslations = research.table(
  "consent_version_translations",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    consentVersionId: uuid("consent_version_id")
      .notNull()
      .references(() => consentVersions.id, { onDelete: "cascade" }),

    locale: text("locale").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("consent_version_translations_locale_idx").on(table.consentVersionId, table.locale),
  ],
);
