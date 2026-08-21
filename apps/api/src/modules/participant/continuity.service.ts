import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, or, gt } from "drizzle-orm";
import {
  participantCredentials,
  participantHandoffCodes,
  participantRecoveryCodes,
  type Database,
} from "@lpr/db";
import {
  evaluateCredential,
  evaluateHandoffCode,
  generateHandoffCode,
  generateRecoveryCode,
  handoffExpiresAt,
  normalizeRecoveryCode,
  HANDOFF_CODE_BYTES,
  RECOVERY_CODE_BYTES,
  type CredentialRejection,
  type HandoffRejection,
} from "@lpr/domain";
import type { CredentialContext } from "@lpr/contracts";
import {
  generateRandomBytes,
  generateToken,
  hashToken,
  timingSafeEqualHex,
} from "../../common/crypto.js";
import { DATABASE } from "../database/database.module.js";

/**
 * Participant continuity credentials (STRUCTURE.md §11.3).
 *
 * The token is minted here, hashed here, and never leaves here except as the
 * value the controller puts straight into an HttpOnly cookie. It is not
 * returned in a body, not logged, and not stored — only its SHA-256 and a short
 * lookup prefix are written.
 *
 * SHA-256 rather than a slow KDF: unlike a password this is 256 bits of CSPRNG
 * output with no guessable structure, so key stretching buys nothing and would
 * cost a KDF on every single participant request.
 */

/** Enough to narrow a lookup to a handful of rows; identifies nothing alone. */
const LOOKUP_PREFIX_LENGTH = 8;

export interface MintedCredential {
  /** For the cookie, and for nothing else. */
  readonly token: string;
  readonly credentialId: string;
}

export type CredentialResolution =
  | {
      readonly ok: true;
      readonly participantId: string;
      readonly rotate: boolean;
      readonly credentialId: string;
      readonly credentialContext: CredentialContext;
    }
  | { readonly ok: false; readonly reason: CredentialRejection | "UNKNOWN" };

@Injectable()
export class ContinuityService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * `context` records WHERE this credential was minted (STRUCTURE.md §11.4).
   *
   * Enrollment happens in a browser, so that is the default. Only the handoff
   * redemption passes `INSTALLED`, and it can, because the request that
   * redeems arrived from inside the installed application.
   */
  async mint(
    tx: Database,
    participantId: string,
    now: Date,
    context: CredentialContext = "BROWSER",
  ): Promise<MintedCredential> {
    const token = generateToken(32);

    const inserted = (
      await tx
        .insert(participantCredentials)
        .values({
          participantId,
          tokenHash: hashToken(token),
          lookupPrefix: token.slice(0, LOOKUP_PREFIX_LENGTH),
          credentialContext: context,
          issuedAt: now,
          createdAt: now,
        })
        .returning()
    )[0];
    if (!inserted) throw new Error("participant credential insert returned no row");

    return { token, credentialId: inserted.id };
  }

  /**
   * Resolve a cookie value to a participant.
   *
   * The prefix narrows the candidate rows; the hash comparison decides, in
   * constant time. Comparing hashes rather than tokens means a timing signal
   * cannot be used to walk the token character by character.
   */
  async resolve(token: string, now: Date): Promise<CredentialResolution> {
    const prefix = token.slice(0, LOOKUP_PREFIX_LENGTH);
    const candidates = await this.db
      .select()
      .from(participantCredentials)
      .where(eq(participantCredentials.lookupPrefix, prefix));

    const expected = hashToken(token);
    const match = candidates.find((row) => timingSafeEqualHex(row.tokenHash, expected));
    if (!match) return { ok: false, reason: "UNKNOWN" };

    const verdict = evaluateCredential(
      { issuedAt: match.issuedAt, rotatedAt: match.rotatedAt, revokedAt: match.revokedAt },
      now,
    );
    if (!verdict.usable) return { ok: false, reason: verdict.reason };

    return {
      ok: true,
      participantId: match.participantId,
      rotate: verdict.shouldRotate,
      credentialId: match.id,
      credentialContext: match.credentialContext as CredentialContext,
    };
  }

  /**
   * Replace an ageing credential, leaving the old one usable for its grace
   * period.
   *
   * Marking rather than deleting is the whole point: a phone with requests
   * already in flight has sent the old token on some of them, and revoking now
   * would fail those and sign a participant out mid-questionnaire.
   */
  async rotate(credentialId: string, participantId: string, now: Date): Promise<MintedCredential> {
    return this.db.transaction(async (tx) => {
      const superseded = (
        await tx
          .update(participantCredentials)
          .set({ rotatedAt: now })
          .where(
            and(
              eq(participantCredentials.id, credentialId),
              isNull(participantCredentials.rotatedAt),
            ),
          )
          .returning({ context: participantCredentials.credentialContext })
      )[0];

      /**
       * The replacement inherits its predecessor's context.
       *
       * Rotation happens silently, on the thirtieth day, inside whichever
       * request happened to arrive. Defaulting the new row to `BROWSER` would
       * mean every installed participant quietly reverted to looking
       * at-risk a month after installing — and the researcher view that exists
       * to catch losses early would fill with people who are perfectly safe.
       */
      return this.mint(
        tx,
        participantId,
        now,
        (superseded?.context ?? "BROWSER") as CredentialContext,
      );
    });
  }

  async touch(credentialId: string, now: Date): Promise<void> {
    await this.db
      .update(participantCredentials)
      .set({ lastUsedAt: now })
      .where(eq(participantCredentials.id, credentialId));
  }

  /** Withdrawal and recovery both revoke everything the participant holds. */
  async revokeAll(tx: Database, participantId: string, now: Date): Promise<void> {
    await tx
      .update(participantCredentials)
      .set({ revokedAt: now })
      .where(
        and(
          eq(participantCredentials.participantId, participantId),
          isNull(participantCredentials.revokedAt),
        ),
      );
  }

  async issueRecoveryCode(tx: Database, participantId: string, now: Date): Promise<string> {
    const code = generateRecoveryCode(generateRandomBytes(RECOVERY_CODE_BYTES));

    await tx.insert(participantRecoveryCodes).values({
      participantId,
      codeHash: hashToken(code),
      issuedAt: now,
      createdAt: now,
    });

    return code;
  }

  /**
   * Redeem a recovery code, exactly once.
   *
   * The single-use guarantee is the conditional UPDATE, not a read followed by
   * a write: two simultaneous redemptions of the same code would both pass a
   * read-then-check, and only one can be allowed to set `redeemed_at`.
   */
  async redeemRecoveryCode(typed: string, now: Date): Promise<string | null> {
    const hash = hashToken(normalizeRecoveryCode(typed));

    const redeemed = (
      await this.db
        .update(participantRecoveryCodes)
        .set({ redeemedAt: now })
        .where(
          and(
            eq(participantRecoveryCodes.codeHash, hash),
            isNull(participantRecoveryCodes.redeemedAt),
          ),
        )
        .returning()
    )[0];

    return redeemed?.participantId ?? null;
  }

  /**
   * Mint a credential after a successful recovery, revoking every earlier one.
   *
   * Recovery means "I lost my device" as often as it means "I cleared my
   * cookies", so the old credentials must stop working immediately rather than
   * running out their grace period — a lost phone keeping a live session for a
   * week is the case this exists to close.
   */
  async issueAfterRecovery(participantId: string, now: Date): Promise<MintedCredential> {
    return this.db.transaction(async (tx) => {
      await this.revokeAll(tx, participantId, now);
      return this.mint(tx, participantId, now);
    });
  }

  /** Credentials still accepted for a participant — used by tests and ops. */
  async activeCredentialCount(participantId: string, now: Date): Promise<number> {
    const rows = await this.db
      .select({ id: participantCredentials.id })
      .from(participantCredentials)
      .where(
        and(
          eq(participantCredentials.participantId, participantId),
          isNull(participantCredentials.revokedAt),
          or(isNull(participantCredentials.rotatedAt), gt(participantCredentials.rotatedAt, now)),
        ),
      );
    return rows.length;
  }

  /**
   * Mint an install handoff code (STRUCTURE.md §11.4, ADR-007, FR-41).
   *
   * Returned in the body, unlike every other secret this service handles,
   * because its whole purpose is to be shown as a tappable link in the Safari
   * tab. Only the hash is stored — the same discipline as the recovery code,
   * for the same reason.
   */
  async mintHandoffCode(
    participantId: string,
    now: Date,
  ): Promise<{ code: string; expiresAt: Date }> {
    const code = generateHandoffCode(generateRandomBytes(HANDOFF_CODE_BYTES));
    const expiresAt = handoffExpiresAt(now);

    await this.db.insert(participantHandoffCodes).values({
      participantId,
      codeHash: hashToken(code),
      issuedAt: now,
      expiresAt,
      createdAt: now,
    });

    return { code, expiresAt };
  }

  /**
   * Redeem a handoff code, exactly once.
   *
   * The single-use guarantee is the conditional UPDATE, not a read followed by
   * a write: a participant double-tapping the link fires two requests, both
   * would pass a read-then-check, and only one may set `redeemed_at`.
   *
   * The expiry is checked in the same statement for the same reason — a
   * separate read would leave a window in which a code expiring right now is
   * judged live and then redeemed.
   *
   * Returns the rejection reason for the log, never for the caller: the
   * controller answers expired, already-redeemed and never-existed identically.
   */
  async redeemHandoffCode(
    code: string,
    now: Date,
  ): Promise<
    { ok: true; participantId: string } | { ok: false; reason: HandoffRejection | "UNKNOWN" }
  > {
    const hash = hashToken(code);

    const redeemed = (
      await this.db
        .update(participantHandoffCodes)
        .set({ redeemedAt: now })
        .where(
          and(
            eq(participantHandoffCodes.codeHash, hash),
            isNull(participantHandoffCodes.redeemedAt),
            gt(participantHandoffCodes.expiresAt, now),
          ),
        )
        .returning()
    )[0];

    if (redeemed) return { ok: true, participantId: redeemed.participantId };

    // Nothing was updated. Ask the row why, so the failure is explicable in a
    // log even though the caller is told nothing.
    const existing = (
      await this.db
        .select()
        .from(participantHandoffCodes)
        .where(eq(participantHandoffCodes.codeHash, hash))
        .limit(1)
    )[0];
    if (!existing) return { ok: false, reason: "UNKNOWN" };

    const verdict = evaluateHandoffCode(
      { expiresAt: existing.expiresAt, redeemedAt: existing.redeemedAt },
      now,
    );
    return { ok: false, reason: verdict.redeemable ? "UNKNOWN" : verdict.reason };
  }

  /**
   * Mint a credential inside the freshly installed application.
   *
   * Deliberately does NOT revoke the browser's credential, which is the one
   * difference from recovery. Both containers belong to the same person and
   * both are legitimately in use: the participant may finish the questionnaire
   * they already had open in Safari, and revoking would sign them out of it
   * mid-answer — at the exact moment we asked them to install, which is the
   * moment they are most likely to give up.
   */
  async issueAfterHandoff(participantId: string, now: Date): Promise<MintedCredential> {
    return this.db.transaction(async (tx) => this.mint(tx, participantId, now, "INSTALLED"));
  }
}
