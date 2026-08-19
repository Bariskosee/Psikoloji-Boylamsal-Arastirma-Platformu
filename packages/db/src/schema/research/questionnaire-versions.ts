import { sql } from "drizzle-orm";
import { check, index, integer, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { researcherUsers } from "../identity/researcher-users";
import { research } from "../schemas";
import { questionnaires } from "./questionnaires";

/**
 * A questionnaire version (STRUCTURE.md §6, ADR-008).
 *
 * `DRAFT → PUBLISHED → RETIRED`, but unlike a normal state machine the
 * `DRAFT` row is never the one that transitions to `PUBLISHED`: publishing
 * DEEP-COPIES the draft's current content into a brand-new row with a fresh
 * id and `status = 'PUBLISHED'`. The draft row keeps its own id and keeps
 * accumulating edits toward whatever gets published next. This is what makes
 * "editing the draft after publishing v1 leaves v1 provably unchanged" true
 * by construction rather than by a separate immutability check.
 *
 * `RETIRED` is declared for forward compatibility with a later phase that
 * needs to mark a published version as superseded without touching its
 * content; nothing in Phase 3 writes it.
 */
export const questionnaireVersions = research.table(
  "questionnaire_versions",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    questionnaireId: uuid("questionnaire_id")
      .notNull()
      .references(() => questionnaires.id, { onDelete: "cascade" }),

    status: text("status").notNull().default("DRAFT"),

    /**
     * `NULL` for the draft. `1, 2, 3, ...` assigned at publish time, so a gap
     * or a race can never produce two published versions sharing a number.
     */
    versionNumber: integer("version_number"),

    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedBy: uuid("published_by").references(() => researcherUsers.id, {
      onDelete: "set null",
    }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * "One draft per questionnaire" (STRUCTURE.md §6) enforced by the
     * database, not only by the service: a partial unique index over rows
     * still in `DRAFT` status means a second concurrent "create questionnaire"
     * style race on the same questionnaire cannot leave two open drafts.
     */
    uniqueIndex("questionnaire_versions_one_draft_idx")
      .on(table.questionnaireId)
      .where(sql`${table.status} = 'DRAFT'`),
    // Postgres treats every NULL as distinct in a unique index, so the many
    // questionnaires with at most one NULL `version_number` (their draft)
    // never collide with each other here.
    uniqueIndex("questionnaire_versions_number_key").on(table.questionnaireId, table.versionNumber),
    index("questionnaire_versions_questionnaire_idx").on(table.questionnaireId),
    check(
      "questionnaire_versions_status_valid",
      sql`${table.status} IN ('DRAFT', 'PUBLISHED', 'RETIRED')`,
    ),
    check(
      "questionnaire_versions_number_shape",
      sql`(${table.status} = 'DRAFT') = (${table.versionNumber} IS NULL)`,
    ),
    check(
      "questionnaire_versions_published_at_shape",
      sql`(${table.status} = 'DRAFT') = (${table.publishedAt} IS NULL)`,
    ),
  ],
);

export type QuestionnaireVersionRow = typeof questionnaireVersions.$inferSelect;
export type NewQuestionnaireVersionRow = typeof questionnaireVersions.$inferInsert;
