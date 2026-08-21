import { sql } from "drizzle-orm";
import { check, integer, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { researcherUsers } from "../identity/researcher-users";
import { research } from "../schemas";
import { protocols } from "./protocols";

/**
 * A protocol version (STRUCTURE.md §8, ADR-008).
 *
 * Same construction as `questionnaire_versions`: publishing DEEP-COPIES the
 * draft's steps into a new row rather than transitioning the draft, so the
 * draft keeps accumulating edits and a published version is unchanged by
 * construction rather than by a check someone has to remember to write.
 *
 * The stakes are higher here than for a questionnaire. An enrollment pins a
 * `protocol_version_id` for the participant's entire life in the study
 * (NFR-17), so a published version is the schedule a real person is living
 * under. Editing one would silently re-time measurements that have already
 * been taken, and there is no way to tell afterwards which schedule produced
 * which response.
 */
export const protocolVersions = research.table(
  "protocol_versions",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    protocolId: uuid("protocol_id")
      .notNull()
      .references(() => protocols.id, { onDelete: "cascade" }),

    status: text("status").notNull().default("DRAFT"),

    /** NULL for the draft; assigned at publish so a race cannot duplicate one. */
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
      "protocol_versions_status_valid",
      sql`${table.status} IN ('DRAFT', 'PUBLISHED', 'RETIRED')`,
    ),
    /**
     * A published version must carry its number and its publication instant,
     * and a draft must carry neither. Stated as one constraint because the
     * three fields only make sense together — a PUBLISHED row with a NULL
     * version number is not a lesser version, it is an unidentifiable one.
     */
    check(
      "protocol_versions_publication_complete",
      sql`(${table.status} = 'DRAFT' AND ${table.versionNumber} IS NULL AND ${table.publishedAt} IS NULL)
          OR (${table.status} <> 'DRAFT' AND ${table.versionNumber} IS NOT NULL AND ${table.publishedAt} IS NOT NULL)`,
    ),

    // One open draft per protocol, enforced by the database so a create race
    // cannot leave two.
    uniqueIndex("protocol_versions_one_draft_idx")
      .on(table.protocolId)
      .where(sql`${table.status} = 'DRAFT'`),

    uniqueIndex("protocol_versions_number_idx").on(table.protocolId, table.versionNumber),
  ],
);
