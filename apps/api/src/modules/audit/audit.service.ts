import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { auditEvents, type Database } from "@lpr/db";
import type {
  AuditAction,
  AuditActorType,
  AuditEntityType,
  AuditEventResponse,
  AuditListResponse,
} from "@lpr/contracts";
import { DATABASE } from "../database/database.module.js";
import { hashIp } from "../../common/crypto.js";
import { loadEnv } from "../../config/env.js";
import type { RequestContext } from "../auth/session.service.js";

export interface AuditInput {
  actorType: AuditActorType;
  actorId: string | null;
  actorLabel: string | null;
  studyId: string | null;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: string | null;
  metadata: Record<string, unknown>;
  context: RequestContext;
  occurredAt: Date;
}

/**
 * Keys whose values are never written to the audit trail, whatever a caller
 * passes. A defence against the audit log becoming an accidental secret store
 * the day someone spreads a request body into `metadata`.
 */
const REDACTED_KEYS = new Set([
  "password",
  "newpassword",
  "currentpassword",
  "passwordhash",
  "token",
  "sessiontoken",
  "csrftoken",
  "tokenhash",
  "secret",
  "authorization",
  "cookie",
  "endpoint",
  "keys",
  "p256dh",
  "auth",
  "answer",
  "answers",
  "response",
  "responses",
  "value",
]);

@Injectable()
export class AuditService {
  private readonly logger = new Logger("Audit");
  private readonly env = loadEnv();

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Append one audit event (NFR-05).
   *
   * **Never throws.** An audit write that fails must not roll back the
   * operation it describes — a researcher who successfully created a study
   * should not see an error because the trail insert hit a constraint. The
   * failure is logged loudly instead, which is the correct trade for an MVP;
   * a system that requires guaranteed audit-or-abort semantics would need the
   * event written in the same transaction as the mutation, and that is a
   * Phase 12 decision the research team has not been asked to make.
   */
  async record(input: AuditInput): Promise<void> {
    try {
      await this.db.insert(auditEvents).values({
        actorType: input.actorType,
        actorId: input.actorId,
        actorLabel: input.actorLabel,
        studyId: input.studyId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        metadata: redact(input.metadata),
        ipHash: hashIp(input.context.ip, this.env.SESSION_SECRET),
        occurredAt: input.occurredAt,
      });
    } catch (error) {
      this.logger.error(
        `failed to write audit event ${input.action}: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
  }

  /**
   * A failed login, recorded without an actor id.
   *
   * The email is recorded because "someone tried to log in as this account
   * forty times" is exactly the question an audit trail exists to answer.
   * `actorId` stays null: attributing the attempt to the account would imply
   * the account holder made it.
   */
  async recordAuthFailure(email: string, context: RequestContext, now: Date): Promise<void> {
    await this.record({
      actorType: "RESEARCHER",
      actorId: null,
      actorLabel: email,
      studyId: null,
      action: "auth.login.failed",
      entityType: "researcher_user",
      entityId: null,
      metadata: {},
      context,
      occurredAt: now,
    });
  }

  /**
   * Read a study's trail, newest first, with cursor pagination.
   *
   * The study filter is in the WHERE clause rather than applied after the
   * fact, per NFR-04. The cursor is `occurredAt|id`: offset pagination over an
   * append-only log shifts rows under the reader as new events arrive, so
   * page 2 silently repeats or skips entries.
   */
  async listForStudy(studyId: string, limit: number, cursor?: string): Promise<AuditListResponse> {
    const decoded = decodeCursor(cursor);

    const rows = await this.db
      .select()
      .from(auditEvents)
      .where(
        decoded
          ? and(
              eq(auditEvents.studyId, studyId),
              or(
                lt(auditEvents.occurredAt, decoded.occurredAt),
                and(eq(auditEvents.occurredAt, decoded.occurredAt), lt(auditEvents.id, decoded.id)),
              ),
            )
          : eq(auditEvents.studyId, studyId),
      )
      .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
      // One extra row answers "is there another page" without a second query.
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];

    return {
      events: page.map(toResponse),
      nextCursor: rows.length > limit && last ? encodeCursor(last.occurredAt, last.id) : null,
    };
  }

  /** Sessions and audit rows both need a cleanup story; see SessionService. */
  async countForStudy(studyId: string): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditEvents)
      .where(eq(auditEvents.studyId, studyId));
    return rows[0]?.count ?? 0;
  }
}

function toResponse(row: typeof auditEvents.$inferSelect): AuditEventResponse {
  return {
    id: row.id,
    actorType: row.actorType as AuditActorType,
    actorId: row.actorId,
    actorLabel: row.actorLabel,
    studyId: row.studyId,
    action: row.action as AuditAction,
    entityType: row.entityType as AuditEntityType,
    entityId: row.entityId,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    occurredAt: row.occurredAt.toISOString(),
  };
}

/**
 * Strip anything that must never reach the trail.
 *
 * Shallow-recursive and key-based rather than value-based: a value-based
 * heuristic ("does this look like a token") fails open, while an unknown key
 * containing a secret is a bug that this catches by name. Response payloads
 * are excluded by the same list — an audit row must never contain what a
 * participant answered (STRUCTURE.md §6).
 */
export function redact(metadata: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (depth > 3) return {};
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (REDACTED_KEYS.has(key.toLowerCase())) {
      output[key] = "[redacted]";
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      output[key] = redact(value as Record<string, unknown>, depth + 1);
      continue;
    }
    output[key] = value;
  }
  return output;
}

export function encodeCursor(occurredAt: Date, id: string): string {
  return Buffer.from(`${occurredAt.toISOString()}|${id}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor?: string): { occurredAt: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const [timestamp, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    if (!timestamp || !id) return null;
    const occurredAt = new Date(timestamp);
    if (Number.isNaN(occurredAt.getTime())) return null;
    return { occurredAt, id };
  } catch {
    // A malformed cursor is a client bug or a probe. Treating it as "start
    // from the beginning" is safer than a 500 and leaks nothing.
    return null;
  }
}
