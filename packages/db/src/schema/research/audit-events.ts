import { sql } from "drizzle-orm";
import { check, index, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { research } from "../schemas";
import { studies } from "./studies";

/**
 * The audit trail (NFR-05, STRUCTURE.md §6).
 *
 * Append-only by contract: nothing in the codebase updates or deletes a row
 * here, and the migration revokes UPDATE and DELETE from the application role
 * so the contract is enforced by the database rather than by discipline.
 *
 * **This table must never contain a response payload or a secret.** It records
 * that an action happened, by whom, to which entity — not what a participant
 * answered. `metadata` is redacted before it is written; see the audit module.
 */
export const auditEvents = research.table(
  "audit_events",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    /** `RESEARCHER | PARTICIPANT | SYSTEM`. */
    actorType: text("actor_type").notNull(),

    /**
     * Polymorphic by design, so deliberately NOT a foreign key: a researcher
     * id, a participant id, or NULL for a system actor. A single FK cannot
     * express that, and splitting into two nullable FK columns would put the
     * two identity systems in one row — precisely the coupling ADR-007 avoids.
     */
    actorId: uuid("actor_id"),

    /**
     * Denormalised actor label (an email for a researcher). Written at event
     * time so the trail stays readable after the account is renamed or
     * deactivated — an audit entry that resolves to "unknown user" months
     * later has failed at its only job.
     */
    actorLabel: text("actor_label"),

    /**
     * NULL for events that are not study-scoped, such as a login. No cascade:
     * the trail must outlive anything it describes.
     */
    studyId: uuid("study_id").references(() => studies.id),

    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    /** Text, not uuid — some entities are keyed by a stable string key. */
    entityId: text("entity_id"),

    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),

    /** Salted hash, never the address (STRUCTURE.md §11.5). */
    ipHash: text("ip_hash"),

    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * The study audit view reads newest-first and pages by cursor, so the
     * index carries both sort keys. `id` breaks ties: two events in the same
     * millisecond would otherwise make a cursor ambiguous, and a paginated
     * audit log that skips a row is worse than one that is slow.
     */
    index("audit_events_study_occurred_idx").on(
      table.studyId,
      table.occurredAt.desc(),
      table.id.desc(),
    ),
    index("audit_events_actor_idx").on(table.actorId, table.occurredAt.desc()),
    index("audit_events_action_idx").on(table.action, table.occurredAt.desc()),
    check(
      "audit_events_actor_type_valid",
      sql`${table.actorType} IN ('RESEARCHER', 'PARTICIPANT', 'SYSTEM')`,
    ),
  ],
);

export type AuditEventRow = typeof auditEvents.$inferSelect;
export type NewAuditEventRow = typeof auditEvents.$inferInsert;
