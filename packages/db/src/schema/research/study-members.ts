import { sql } from "drizzle-orm";
import { check, index, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { researcherUsers } from "../identity/researcher-users";
import { research } from "../schemas";
import { studies } from "./studies";

/**
 * Study membership — the authorization edge between a researcher and a study.
 *
 * This table IS the authorization model at rest. A role held here grants
 * nothing in any other study, which is what "scoped per study"
 * (REQUIREMENTS.md §5.2) means in practice.
 *
 * The `(study_id, user_id)` uniqueness is a database constraint rather than an
 * application check because a race between two concurrent "add member" calls
 * would otherwise leave one user holding two roles in one study, and the
 * effective-role question would then have two answers.
 */
export const studyMembers = research.table(
  "study_members",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id, { onDelete: "cascade" }),

    userId: uuid("user_id")
      .notNull()
      .references(() => researcherUsers.id, { onDelete: "cascade" }),

    /** `OWNER | EDITOR | ANALYST | VIEWER`. Ranked in @lpr/domain. */
    role: text("role").notNull(),

    /** Who granted this access. Kept for the audit trail (NFR-05). */
    addedBy: uuid("added_by").references(() => researcherUsers.id, { onDelete: "set null" }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("study_members_study_user_key").on(table.studyId, table.userId),
    // "Which studies may I see?" runs on every dashboard load, keyed by user.
    index("study_members_user_idx").on(table.userId),
    check(
      "study_members_role_valid",
      sql`${table.role} IN ('OWNER', 'EDITOR', 'ANALYST', 'VIEWER')`,
    ),
  ],
);

export type StudyMemberRow = typeof studyMembers.$inferSelect;
export type NewStudyMemberRow = typeof studyMembers.$inferInsert;
