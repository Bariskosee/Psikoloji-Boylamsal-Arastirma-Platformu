import { sql } from "drizzle-orm";
import { index, timestamp, uniqueIndex, uuid, text } from "drizzle-orm/pg-core";
import { research } from "../schemas";
import { consentVersions } from "./consent-versions";
import { participants } from "./participants";
import { protocolVersions } from "./protocol-versions";
import { studies } from "./studies";
import { studyGroups } from "./study-groups";

/**
 * An enrollment — where version pinning and group assignment happen
 * (NFR-17, FR-45).
 *
 * Both are decided once, here, and never change. An enrolled participant stays
 * on their bound protocol version for life: re-pointing them at a newer one
 * would re-time measurements they have already given, and nothing afterwards
 * could say which schedule produced which response. Re-assigning their group
 * would mean earlier responses were collected under one condition and later
 * ones under another, invalidating that participant entirely.
 *
 * The consent reference is part of the same record: which document, in which
 * language, at which instant.
 */
export const enrollments = research.table(
  "enrollments",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    participantId: uuid("participant_id")
      .notNull()
      .references(() => participants.id, { onDelete: "restrict" }),

    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id, { onDelete: "restrict" }),

    /**
     * `restrict`, not `cascade`: a published version referenced by a live
     * enrollment must be undeletable, because deleting it would strand the
     * responses collected under it.
     */
    protocolVersionId: uuid("protocol_version_id")
      .notNull()
      .references(() => protocolVersions.id, { onDelete: "restrict" }),

    consentVersionId: uuid("consent_version_id")
      .notNull()
      .references(() => consentVersions.id, { onDelete: "restrict" }),

    consentedAt: timestamp("consented_at", { withTimezone: true }).notNull(),
    consentLocale: text("consent_locale").notNull(),

    /** Null in a study with no groups (FR-45). */
    groupId: uuid("group_id").references(() => studyGroups.id, { onDelete: "restrict" }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One enrollment per participant. A valid credential resumes rather than
    // creating a second enrollment (PLAN.md Phase 5), and the database is what
    // makes that true even under a double-submitted form.
    uniqueIndex("enrollments_participant_idx").on(table.participantId),
    index("enrollments_study_idx").on(table.studyId),
    index("enrollments_protocol_version_idx").on(table.protocolVersionId),
  ],
);
