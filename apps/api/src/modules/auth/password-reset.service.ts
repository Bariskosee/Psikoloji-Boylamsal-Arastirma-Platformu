import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { researcherPasswordResets, researcherUsers, type Database } from "@lpr/db";
import {
  RESET_TOKEN_BYTES,
  checkPassword,
  evaluateResetToken,
  generateResetToken,
  resetExpiresAt,
} from "@lpr/domain";
import { ApiErrors } from "../../common/api-error.js";
import { generateRandomBytes, hashIp, hashToken } from "../../common/crypto.js";
import { loadEnv } from "../../config/env.js";
import { DATABASE } from "../database/database.module.js";
import { AuditService } from "../audit/audit.service.js";
import { MailService } from "../mail/mail.service.js";
import { resetEmail, type MailLocale } from "../mail/reset-email.js";
import { PasswordService } from "./password.service.js";
import { RateLimitService } from "./rate-limit.service.js";
import { SessionService } from "./session.service.js";
import type { RequestContext } from "./session.service.js";

/**
 * Researcher password reset (PLAN.md Phase 12, FR-06).
 *
 * Deferred from Phase 2, where a forgotten password needed an administrator
 * with database access — not a procedure a research team can run on a Sunday.
 *
 * ── The three properties that matter, and where each is enforced ────────────
 * 1. **No account enumeration.** `request()` returns nothing and behaves
 *    identically for an unknown address. See the note there: it also spends
 *    the same rate-limit budget, because a budget that is only consumed for
 *    real accounts is itself an oracle.
 * 2. **Single use.** Enforced by a conditional UPDATE (`WHERE used_at IS NULL`)
 *    in the same transaction that changes the password, not by a read followed
 *    by a write. Two simultaneous clicks would both pass a read-then-check.
 * 3. **A reset ends every existing session.** If the reset was requested
 *    because an account was compromised, leaving the attacker's session alive
 *    would make the whole exercise pointless.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);
  private readonly env = loadEnv();

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly rateLimit: RateLimitService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Begin a reset. Returns nothing, always.
   *
   * ── Why the work happens even for an address with no account ────────────
   * Not quite: no token is minted, because there is nothing to mint one
   * against. What IS identical is everything observable — the status code, the
   * response body, and the rate-limit budget consumed. An implementation that
   * skipped the budget for unknown addresses would let an attacker distinguish
   * them by making six requests and seeing which ones start returning 429.
   */
  async request(email: string, context: RequestContext, now: Date): Promise<void> {
    this.enforceRateLimit(email, context.ip, now);

    const rows = await this.db
      .select({
        id: researcherUsers.id,
        email: researcherUsers.email,
        // The message and the link are in the ACCOUNT's language, not the
        // browser's: the request may come from a shared machine, and what the
        // person reads is a property of them, not of the computer they used.
        locale: researcherUsers.locale,
      })
      .from(researcherUsers)
      .where(and(eq(researcherUsers.email, email), eq(researcherUsers.isActive, true)))
      .limit(1);

    const user = rows[0];
    if (!user) {
      /**
       * Recorded, deliberately.
       *
       * A reset requested for an address that has no account is either a
       * researcher who mistyped, or somebody probing for valid addresses. The
       * second is worth being able to see afterwards, and the audit trail is
       * where "one IP asked about forty addresses last night" becomes visible.
       */
      await this.audit.recordAuthFailure(email, context, now);
      return;
    }

    /**
     * Any outstanding link for this account stops working now.
     *
     * A researcher who clicks "forgot password" three times should not leave
     * three live account-takeover links in their inbox. The newest one is the
     * one they will use; the others are pure liability.
     */
    await this.db
      .update(researcherPasswordResets)
      .set({ usedAt: now })
      .where(
        and(eq(researcherPasswordResets.userId, user.id), isNull(researcherPasswordResets.usedAt)),
      );

    const token = generateResetToken(generateRandomBytes(RESET_TOKEN_BYTES));

    await this.db.insert(researcherPasswordResets).values({
      // The token itself is never stored — only its SHA-256. A dump of this
      // table must not be a set of account takeovers.
      tokenHash: hashToken(token),
      userId: user.id,
      expiresAt: resetExpiresAt(now),
      requestedIpHash: hashIp(context.ip, this.env.SESSION_SECRET),
    });

    await this.audit.record({
      actorType: "RESEARCHER",
      actorId: user.id,
      actorLabel: user.email,
      studyId: null,
      action: "auth.password_reset.requested",
      entityType: "researcher_user",
      entityId: user.id,
      // Never the token, and never its hash: the audit trail must not become a
      // second place the credential lives.
      metadata: {},
      context,
      occurredAt: now,
    });

    await this.deliver(user.email, user.locale as MailLocale, token);
  }

  /**
   * Spend a token and set the new password.
   *
   * ── Why every rejection is the same error ───────────────────────────────
   * The caller is unauthenticated and holds only a token. Distinguishing
   * "expired" from "already used" from "never existed" tells somebody holding a
   * STOLEN link that it was real, and which of those it is. The domain does
   * make the distinction — `evaluateResetToken` — and it is used for the log,
   * where the operator reading it has already been authenticated by other
   * means.
   */
  async confirm(
    token: string,
    newPassword: string,
    context: RequestContext,
    now: Date,
  ): Promise<void> {
    const tokenHash = hashToken(token);

    const rows = await this.db
      .select({
        id: researcherPasswordResets.id,
        userId: researcherPasswordResets.userId,
        expiresAt: researcherPasswordResets.expiresAt,
        usedAt: researcherPasswordResets.usedAt,
        email: researcherUsers.email,
        isActive: researcherUsers.isActive,
      })
      .from(researcherPasswordResets)
      .innerJoin(researcherUsers, eq(researcherUsers.id, researcherPasswordResets.userId))
      .where(eq(researcherPasswordResets.tokenHash, tokenHash))
      .limit(1);

    const reset = rows[0];
    if (!reset) throw ApiErrors.invalidResetToken();

    const verdict = evaluateResetToken({ expiresAt: reset.expiresAt, usedAt: reset.usedAt }, now);
    if (!verdict.usable) {
      this.logger.warn(`password reset refused: ${verdict.reason}`);
      throw ApiErrors.invalidResetToken();
    }

    // An account deactivated between the request and the click must not be
    // reactivated by a link that was legitimate when it was sent.
    if (!reset.isActive) throw ApiErrors.invalidResetToken();

    const policy = checkPassword(newPassword, reset.email);
    if (!policy.ok) throw ApiErrors.passwordTooWeak(policy.reasons);

    const passwordHash = await this.passwords.hash(newPassword);

    await this.db.transaction(async (tx) => {
      /**
       * Spend the token FIRST, conditionally, and fail if it was already spent.
       *
       * `WHERE used_at IS NULL` is what makes single-use real. Two clicks
       * arriving together both pass the check above — only one can win this
       * UPDATE, and the loser gets zero rows and aborts before touching the
       * password. A read-then-write here would let both through, and the
       * second would silently overwrite the first researcher's new password.
       */
      const spent = await tx
        .update(researcherPasswordResets)
        .set({ usedAt: now })
        .where(
          and(eq(researcherPasswordResets.id, reset.id), isNull(researcherPasswordResets.usedAt)),
        )
        .returning({ id: researcherPasswordResets.id });

      if (spent.length === 0) throw ApiErrors.invalidResetToken();

      await tx
        .update(researcherUsers)
        .set({ passwordHash, passwordChangedAt: now })
        .where(eq(researcherUsers.id, reset.userId));
    });

    /**
     * Every session, with no exception.
     *
     * `changePassword` spares the caller's own session because they are
     * authenticated and working. Here there is no session to spare, and the
     * reason somebody resets a password is often that they believe an attacker
     * has one.
     */
    const revokedSessions = await this.sessions.revokeAllForUser(reset.userId, now);

    await this.audit.record({
      actorType: "RESEARCHER",
      actorId: reset.userId,
      actorLabel: reset.email,
      studyId: null,
      action: "auth.password_reset.completed",
      entityType: "researcher_user",
      entityId: reset.userId,
      metadata: { revokedSessions },
      context,
      occurredAt: now,
    });
  }

  /**
   * Delete tokens that can no longer be used.
   *
   * Not scheduled here: like `SessionService.deleteExpired`, it belongs beside
   * the other sweepers in the worker. Written alongside the code that creates
   * the rows so the cleanup is not remembered later.
   */
  async deleteExpired(now: Date): Promise<number> {
    const deleted = await this.db
      .delete(researcherPasswordResets)
      .where(sql`${researcherPasswordResets.expiresAt} < ${now}`)
      .returning({ id: researcherPasswordResets.id });
    return deleted.length;
  }

  private async deliver(email: string, locale: MailLocale, token: string): Promise<void> {
    /**
     * The link lands on the researcher's own locale.
     *
     * Hard-coding `/en/` sent a Turkish researcher to an English page — found
     * by walking the flow in a browser rather than by any test, because both
     * halves passed on their own.
     */
    const url = `${this.env.RESEARCHER_ORIGIN}/${locale}/reset-password?token=${token}`;
    const message = resetEmail(locale, url);

    /**
     * A mail failure must not fail the request.
     *
     * The response is identical for an unknown address, so throwing here would
     * make a broken relay observably different from a mistyped address — the
     * exact oracle this endpoint is built to avoid. It is logged at error
     * instead, which is where an operator will see that no reset has been
     * delivered for a week.
     */
    try {
      await this.mail.send({ to: email, subject: message.subject, text: message.text });
    } catch (error) {
      this.logger.error(
        `failed to send a password reset email: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private enforceRateLimit(email: string, ip: string | undefined, now: Date): void {
    const windowMs = 60 * 60_000;
    const limit = this.env.PASSWORD_RESET_RATE_LIMIT_MAX;

    // Two budgets, for the two different attacks: flooding one researcher's
    // inbox until they stop reading it, and probing many addresses from one
    // machine to see which exist.
    const keys = [`reset:email:${email}`];
    if (ip !== undefined) keys.push(`reset:ip:${ip}`);

    for (const key of keys) {
      const decision = this.rateLimit.hit(key, limit, windowMs, now.getTime());
      if (!decision.allowed) throw ApiErrors.rateLimited(decision.retryAfterSeconds);
    }
  }
}
