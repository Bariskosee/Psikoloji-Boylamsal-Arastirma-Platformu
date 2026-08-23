/**
 * The researcher password-reset policy (PLAN.md Phase 12, FR-06).
 *
 * Deferred from Phase 2, where the note read "no password reset email — that is
 * Phase 12". Until now a researcher who forgot their password needed an
 * administrator with database access, which is not a procedure a research team
 * can run on a Sunday.
 *
 * ── What makes this dangerous, and therefore what this file is for ──────────
 * A reset link is a bearer credential for an entire account: whoever holds it
 * can take over a researcher who may be the OWNER of a study, and an owner can
 * read every psychological response in it. The properties below are what keep
 * that link from being worth stealing for long — and each of them is a decision
 * that is easy to get wrong in a way nothing later would detect.
 *
 * Everything here is pure. The randomness is injected, the clock is injected,
 * and the token is never hashed here — hashing is I/O-adjacent and lives in the
 * API, which is also where the single-use guarantee is enforced by a conditional
 * UPDATE rather than by a read-then-write.
 */

/** 256 bits. This is a URL-borne credential for a whole account. */
export const RESET_TOKEN_BYTES = 32;

/** Two hex characters per byte; the shape the API and the frontend validate. */
export const RESET_TOKEN_LENGTH = RESET_TOKEN_BYTES * 2;

/**
 * How long a reset link stays usable.
 *
 * ── Why one hour and not a day ──────────────────────────────────────────────
 * The flow this has to survive is: request the reset, switch to the mail
 * client, open the link. That is minutes for almost everybody, and an hour is
 * generous for the person who gets interrupted.
 *
 * The cost of longer is not theoretical. A reset link sits in an inbox, and
 * inboxes are shared, synced to devices that get lost, and left open on
 * institutional machines. Every extra hour is another hour in which a link
 * that grants an entire study's data is lying around. A participant-facing
 * recovery code is generous because losing access ends someone's participation;
 * a researcher can ask for another link in ten seconds.
 */
export const RESET_TOKEN_TTL_MINUTES = 60;

/**
 * How many resets one account may request per window.
 *
 * Limited per ACCOUNT rather than only per IP: an attacker who wants to bury a
 * legitimate reset link under forty others, or simply to flood a researcher's
 * inbox until they stop reading it, will not helpfully do so from one address.
 */
export const RESET_REQUEST_MAX = 5;
export const RESET_REQUEST_WINDOW_MINUTES = 60;

const MINUTE_MS = 60_000;

/**
 * Hex-encode CSPRNG bytes into a reset token.
 *
 * Hex, not a human alphabet: nobody types this one — it arrives as a link — so
 * the only requirement is that it survives a URL and an email client's
 * line-wrapping intact.
 */
export function generateResetToken(randomBytes: Uint8Array): string {
  if (randomBytes.length < RESET_TOKEN_BYTES) {
    throw new Error(
      `generateResetToken needs at least ${String(RESET_TOKEN_BYTES)} random bytes, ` +
        `got ${String(randomBytes.length)}`,
    );
  }

  let token = "";
  for (let index = 0; index < RESET_TOKEN_BYTES; index += 1) {
    token += (randomBytes[index] as number).toString(16).padStart(2, "0");
  }
  return token;
}

/** Is this string shaped like a reset token at all? */
export function isResetTokenShape(value: string): boolean {
  return value.length === RESET_TOKEN_LENGTH && /^[0-9a-f]+$/.test(value);
}

/** When a token issued at `issuedAt` stops working. */
export function resetExpiresAt(issuedAt: Date): Date {
  return new Date(issuedAt.getTime() + RESET_TOKEN_TTL_MINUTES * MINUTE_MS);
}

export interface ResetTokenState {
  readonly expiresAt: Date;
  /** Set by the first successful use; a second attempt then fails. */
  readonly usedAt: Date | null;
}

export type ResetRejection = "EXPIRED" | "ALREADY_USED";

export type ResetVerdict =
  { readonly usable: true } | { readonly usable: false; readonly reason: ResetRejection };

/**
 * May this token be spent right now?
 *
 * ── Why the caller must still not trust this alone ──────────────────────────
 * Spending is a conditional UPDATE at the database — `WHERE used_at IS NULL` —
 * because two simultaneous clicks of the same link would both pass a
 * read-then-check and only one may win. This function exists so that a refusal
 * can be EXPLAINED: "that link has expired, request another" is actionable,
 * where a bare failure sends the researcher to their administrator.
 *
 * The distinction is deliberately NOT surfaced to an unauthenticated caller in
 * the API — see the controller — because "already used" tells an attacker
 * holding a stolen link that it was real.
 */
export function evaluateResetToken(state: ResetTokenState, now: Date): ResetVerdict {
  // Order matters: a token that is both expired and used reports EXPIRED,
  // because that is the reason the researcher can act on.
  if (state.expiresAt.getTime() <= now.getTime()) {
    return { usable: false, reason: "EXPIRED" };
  }
  if (state.usedAt !== null) {
    return { usable: false, reason: "ALREADY_USED" };
  }
  return { usable: true };
}
