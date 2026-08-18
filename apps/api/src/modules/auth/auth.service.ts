import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { researcherUsers, type Database } from "@lpr/db";
import { checkPassword } from "@lpr/domain";
import type { ResearcherProfile } from "@lpr/contracts";
import { DATABASE } from "../database/database.module.js";
import { ApiErrors } from "../../common/api-error.js";
import { loadEnv } from "../../config/env.js";
import { AuditService } from "../audit/audit.service.js";
import { PasswordService } from "./password.service.js";
import { RateLimitService } from "./rate-limit.service.js";
import { SessionService, type IssuedSession, type RequestContext } from "./session.service.js";

export interface LoginOutcome {
  profile: ResearcherProfile;
  session: IssuedSession;
}

/**
 * Researcher authentication.
 *
 * Participants never pass through here. They have no password and no session
 * of this kind (NFR-09, ADR-007); their credential flow arrives in Phase 5 as
 * a separate mechanism, deliberately not merged with this one.
 */
@Injectable()
export class AuthService {
  private readonly env = loadEnv();

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly rateLimit: RateLimitService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Verify credentials and mint a session.
   *
   * Three properties this method must keep, all of them about what a FAILURE
   * reveals:
   *
   * 1. **Uniform response.** Unknown email, wrong password, and disabled
   *    account all produce `INVALID_CREDENTIALS`. Anything else is an account
   *    enumeration oracle — and for a research platform, knowing who holds an
   *    account is itself disclosure.
   * 2. **Uniform timing.** The unknown-email path still pays for an argon2id
   *    verification (`verifyDummy`). Without that, a ~50ms difference tells an
   *    attacker which addresses are registered no matter how identical the
   *    bodies look.
   * 3. **Rate limited** on both email and IP, so neither a targeted guess nor a
   *    spray gets an unbounded budget.
   */
  async login(
    email: string,
    password: string,
    now: Date,
    context: RequestContext,
  ): Promise<LoginOutcome> {
    this.enforceLoginRateLimit(email, context.ip, now);

    const rows = await this.db
      .select({
        id: researcherUsers.id,
        email: researcherUsers.email,
        displayName: researcherUsers.displayName,
        locale: researcherUsers.locale,
        isAdmin: researcherUsers.isAdmin,
        isActive: researcherUsers.isActive,
        passwordHash: researcherUsers.passwordHash,
      })
      .from(researcherUsers)
      .where(eq(researcherUsers.email, email))
      .limit(1);

    const user = rows[0];

    if (!user) {
      // Spend the same CPU as a real verification before failing.
      await this.passwords.verifyDummy(password);
      await this.audit.recordAuthFailure(email, context, now);
      throw ApiErrors.invalidCredentials();
    }

    const passwordMatches = await this.passwords.verify(user.passwordHash, password);

    // The active check happens AFTER the password check, and produces the same
    // error, so a disabled account is indistinguishable from a wrong password.
    if (!passwordMatches || !user.isActive) {
      await this.audit.recordAuthFailure(email, context, now);
      throw ApiErrors.invalidCredentials();
    }

    const session = await this.sessions.issue(user.id, now, context);

    await this.db
      .update(researcherUsers)
      .set({ lastLoginAt: now })
      .where(eq(researcherUsers.id, user.id));

    this.clearLoginRateLimit(email, context.ip);

    const profile: ResearcherProfile = {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      locale: user.locale as "en" | "tr",
      isAdmin: user.isAdmin,
    };

    await this.audit.record({
      actorType: "RESEARCHER",
      actorId: user.id,
      actorLabel: user.email,
      studyId: null,
      action: "auth.login.succeeded",
      entityType: "researcher_user",
      entityId: user.id,
      metadata: {},
      context,
      occurredAt: now,
    });

    return { profile, session };
  }

  async logout(sessionId: string, actor: ResearcherProfile, now: Date, context: RequestContext) {
    await this.sessions.revoke(sessionId, now);
    await this.audit.record({
      actorType: "RESEARCHER",
      actorId: actor.id,
      actorLabel: actor.email,
      studyId: null,
      action: "auth.logout",
      entityType: "researcher_user",
      entityId: actor.id,
      metadata: {},
      context,
      occurredAt: now,
    });
  }

  /**
   * Change a password, then invalidate every OTHER session the account holds.
   *
   * A password change whose purpose is "someone may have my session" achieves
   * nothing if the stolen session survives it. The current session is spared
   * so the person changing the password is not logged out mid-action.
   */
  async changePassword(
    actor: ResearcherProfile,
    currentSessionId: string,
    currentPassword: string,
    newPassword: string,
    now: Date,
    context: RequestContext,
  ): Promise<{ revokedSessions: number }> {
    const rows = await this.db
      .select({ passwordHash: researcherUsers.passwordHash })
      .from(researcherUsers)
      .where(and(eq(researcherUsers.id, actor.id), eq(researcherUsers.isActive, true)))
      .limit(1);

    const current = rows[0];
    if (!current || !(await this.passwords.verify(current.passwordHash, currentPassword))) {
      throw ApiErrors.invalidCredentials();
    }

    const policy = checkPassword(newPassword, actor.email);
    if (!policy.ok) throw ApiErrors.passwordTooWeak(policy.reasons);

    await this.db
      .update(researcherUsers)
      .set({ passwordHash: await this.passwords.hash(newPassword), passwordChangedAt: now })
      .where(eq(researcherUsers.id, actor.id));

    const revokedSessions = await this.sessions.revokeAllForUser(actor.id, now, currentSessionId);

    await this.audit.record({
      actorType: "RESEARCHER",
      actorId: actor.id,
      actorLabel: actor.email,
      studyId: null,
      action: "auth.password.changed",
      entityType: "researcher_user",
      entityId: actor.id,
      // The count is useful ("four other sessions were ended"); nothing about
      // the password itself is recorded, at any level.
      metadata: { revokedSessions },
      context,
      occurredAt: now,
    });

    return { revokedSessions };
  }

  private enforceLoginRateLimit(email: string, ip: string | undefined, now: Date): void {
    const windowMs = this.env.LOGIN_RATE_LIMIT_WINDOW_MINUTES * 60_000;
    const limit = this.env.LOGIN_RATE_LIMIT_MAX;

    // Two independent budgets. Keying only on IP lets a botnet spread a
    // guessing attack across addresses; keying only on email lets one attacker
    // lock a known researcher out of their own account by exhausting it.
    for (const key of loginKeys(email, ip)) {
      const decision = this.rateLimit.hit(key, limit, windowMs, now.getTime());
      if (!decision.allowed) throw ApiErrors.rateLimited(decision.retryAfterSeconds);
    }
  }

  private clearLoginRateLimit(email: string, ip: string | undefined): void {
    for (const key of loginKeys(email, ip)) this.rateLimit.reset(key);
  }
}

function loginKeys(email: string, ip: string | undefined): string[] {
  const keys = [`login:email:${email}`];
  if (ip) keys.push(`login:ip:${ip}`);
  return keys;
}
