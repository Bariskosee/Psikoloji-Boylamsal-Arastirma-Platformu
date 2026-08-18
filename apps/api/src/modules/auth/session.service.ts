import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { researcherSessions, researcherUsers, type Database } from "@lpr/db";
import { DATABASE } from "../database/database.module.js";
import { generateToken, hashIp, hashToken } from "../../common/crypto.js";
import { loadEnv } from "../../config/env.js";

export interface AuthenticatedSession {
  sessionId: string;
  csrfTokenHash: string;
  user: {
    id: string;
    email: string;
    displayName: string;
    locale: "en" | "tr";
    isAdmin: boolean;
  };
}

export interface IssuedSession {
  sessionToken: string;
  csrfToken: string;
  expiresAt: Date;
}

export interface RequestContext {
  ip?: string;
  userAgent?: string;
}

/**
 * Database-backed session lifecycle.
 *
 * Server-side sessions rather than stateless tokens, because REVOCATION MUST
 * TAKE EFFECT ON THE NEXT REQUEST. A signed token stays valid until it expires
 * no matter what the server decides, which would make "log out" and "disable
 * this account" promises the system cannot keep — unacceptable for an account
 * that can read psychological response data.
 */
@Injectable()
export class SessionService {
  private readonly env = loadEnv();

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Mint a new session.
   *
   * Called only after a successful credential check. A brand-new row with a
   * brand-new token is what makes session fixation impossible: there is no
   * pre-authentication session identifier to inherit, so an attacker cannot
   * plant one in the victim's browser and wait for it to become privileged.
   */
  async issue(userId: string, now: Date, context: RequestContext): Promise<IssuedSession> {
    const sessionToken = generateToken();
    const csrfToken = generateToken();
    const expiresAt = new Date(now.getTime() + this.env.SESSION_ABSOLUTE_TTL_HOURS * 3_600_000);

    await this.db.insert(researcherSessions).values({
      tokenHash: hashToken(sessionToken),
      csrfTokenHash: hashToken(csrfToken),
      userId,
      expiresAt,
      lastSeenAt: now,
      createdAt: now,
      ipHash: hashIp(context.ip, this.env.SESSION_SECRET),
      // Truncated: a full User-Agent adds fingerprinting surface for no
      // operational benefit over "which browser was this".
      userAgent: context.userAgent?.slice(0, 200) ?? null,
    });

    return { sessionToken, csrfToken, expiresAt };
  }

  /**
   * Resolve a presented token to a live session, or null.
   *
   * Every rejection reason collapses to null on purpose: the caller has no
   * business distinguishing "revoked" from "expired" from "never existed",
   * and neither has the client.
   */
  async resolve(sessionToken: string, now: Date): Promise<AuthenticatedSession | null> {
    const idleCutoff = new Date(now.getTime() - this.env.SESSION_IDLE_TIMEOUT_MINUTES * 60_000);

    const rows = await this.db
      .select({
        sessionId: researcherSessions.id,
        csrfTokenHash: researcherSessions.csrfTokenHash,
        lastSeenAt: researcherSessions.lastSeenAt,
        userId: researcherUsers.id,
        email: researcherUsers.email,
        displayName: researcherUsers.displayName,
        locale: researcherUsers.locale,
        isAdmin: researcherUsers.isAdmin,
        isActive: researcherUsers.isActive,
      })
      .from(researcherSessions)
      .innerJoin(researcherUsers, eq(researcherUsers.id, researcherSessions.userId))
      .where(
        and(
          eq(researcherSessions.tokenHash, hashToken(sessionToken)),
          isNull(researcherSessions.revokedAt),
          sql`${researcherSessions.expiresAt} > ${now}`,
          sql`${researcherSessions.lastSeenAt} > ${idleCutoff}`,
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    // Deactivation takes effect on the next request, without needing to hunt
    // down every session the account holds.
    if (!row.isActive) return null;

    await this.touch(row.sessionId, row.lastSeenAt, now);

    return {
      sessionId: row.sessionId,
      csrfTokenHash: row.csrfTokenHash,
      user: {
        id: row.userId,
        email: row.email,
        displayName: row.displayName,
        locale: row.locale as "en" | "tr",
        isAdmin: row.isAdmin,
      },
    };
  }

  /**
   * Advance the idle clock, at most once a minute.
   *
   * Writing on every authenticated request would make session validation the
   * busiest write path in the system — one UPDATE per dashboard poll — for no
   * security gain, since a minute of granularity is irrelevant against a
   * two-hour idle timeout.
   */
  private async touch(sessionId: string, lastSeenAt: Date, now: Date): Promise<void> {
    if (now.getTime() - lastSeenAt.getTime() < 60_000) return;
    await this.db
      .update(researcherSessions)
      .set({ lastSeenAt: now })
      .where(eq(researcherSessions.id, sessionId));
  }

  /** Logout. The next request finds nothing, which is the entire point. */
  async revoke(sessionId: string, now: Date): Promise<void> {
    await this.db
      .update(researcherSessions)
      .set({ revokedAt: now })
      .where(and(eq(researcherSessions.id, sessionId), isNull(researcherSessions.revokedAt)));
  }

  /**
   * Revoke every session a user holds, optionally sparing one.
   *
   * Called on password change: whoever changed the password keeps working,
   * and anyone who had stolen a session is thrown out immediately. A password
   * change that leaves the attacker's session alive has achieved nothing.
   */
  async revokeAllForUser(userId: string, now: Date, exceptSessionId?: string): Promise<number> {
    const conditions = [
      eq(researcherSessions.userId, userId),
      isNull(researcherSessions.revokedAt),
    ];
    if (exceptSessionId) {
      conditions.push(sql`${researcherSessions.id} <> ${exceptSessionId}`);
    }
    const result = await this.db
      .update(researcherSessions)
      .set({ revokedAt: now })
      .where(and(...conditions))
      .returning({ id: researcherSessions.id });
    return result.length;
  }

  /**
   * Delete rows that can no longer authenticate anyone.
   *
   * Not scheduled in Phase 2 — the durable job system arrives in Phase 7 and
   * this belongs there, next to the other sweepers. Exposed now so the
   * cleanup is written and tested alongside the code that creates the rows,
   * rather than remembered later.
   */
  async deleteExpired(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - 30 * 24 * 3_600_000);
    const deleted = await this.db
      .delete(researcherSessions)
      .where(
        or(
          lt(researcherSessions.expiresAt, now),
          and(
            sql`${researcherSessions.revokedAt} is not null`,
            lt(researcherSessions.createdAt, cutoff),
          ),
        ),
      )
      .returning({ id: researcherSessions.id });
    return deleted.length;
  }
}
