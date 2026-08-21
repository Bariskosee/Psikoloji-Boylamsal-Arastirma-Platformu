/**
 * The install handoff code (STRUCTURE.md §11.4, ADR-007, FR-41).
 *
 * On iOS, a Home-Screen-installed PWA may hold a different storage container
 * than the Safari tab the participant enrolled in. Their continuity cookie
 * stays in the tab; the installed application opens as a stranger. Nothing
 * about that is visible to either side — the participant simply becomes a
 * second person, and their longitudinal chain ends at the moment they did the
 * thing we asked them to do.
 *
 * The remedy is a code minted in the tab and redeemed inside the installed
 * application, which mints a credential there and binds it to the same
 * participant.
 *
 * ── Why this one secret may live in a URL ───────────────────────────────────
 * The continuity token may never appear in a URL: URLs reach browser history,
 * referrer headers and access logs, and that token is valid for a year. This
 * code is the opposite artefact on every axis — single-use, 24 hours, rate
 * limited, and worth precisely nothing once redeemed. ADR-007 draws the line
 * there, and this file is where the properties that justify it are enforced.
 */

/** 128 bits. Guessing is not a threat model this needs to consider. */
export const HANDOFF_CODE_BYTES = 16;

/** Two hex characters per byte; the shape the API and both clients validate. */
export const HANDOFF_CODE_LENGTH = HANDOFF_CODE_BYTES * 2;

/**
 * How long a minted code stays redeemable.
 *
 * The flow it has to survive is: read the install instructions, add to Home
 * Screen, get distracted, come back later, open the new icon, tap the link.
 * Minutes would break that for ordinary people. A week would leave a live
 * capability sitting in browser history long after it stopped being needed.
 * Twenty-four hours is what ADR-007 fixed.
 */
export const HANDOFF_CODE_TTL_HOURS = 24;

const HOUR_MS = 3_600_000;

/**
 * Hex-encode CSPRNG bytes into a handoff code.
 *
 * Hex rather than the Crockford base-32 the recovery code uses, because nobody
 * types this one — it is a link tapped inside the installed application — so
 * the alphabet only has to be unambiguous in a URL path, and hex encodes the
 * full 128 bits without the padding or bias a 32-character alphabet would need.
 *
 * The randomness is injected. This package does no I/O and imports no crypto,
 * which is what makes every generator here deterministic under test.
 */
export function generateHandoffCode(randomBytes: Uint8Array): string {
  if (randomBytes.length < HANDOFF_CODE_BYTES) {
    throw new Error(
      `generateHandoffCode needs at least ${String(HANDOFF_CODE_BYTES)} random bytes, ` +
        `got ${String(randomBytes.length)}`,
    );
  }

  let code = "";
  for (let index = 0; index < HANDOFF_CODE_BYTES; index += 1) {
    code += (randomBytes[index] as number).toString(16).padStart(2, "0");
  }
  return code;
}

/** When a code minted at `issuedAt` stops being redeemable. */
export function handoffExpiresAt(issuedAt: Date): Date {
  return new Date(issuedAt.getTime() + HANDOFF_CODE_TTL_HOURS * HOUR_MS);
}

export interface HandoffCodeState {
  readonly expiresAt: Date;
  /** Set by the first successful redemption; a second attempt then fails. */
  readonly redeemedAt: Date | null;
}

export type HandoffRejection = "EXPIRED" | "ALREADY_REDEEMED";

export type HandoffVerdict =
  { readonly redeemable: true } | { readonly redeemable: false; readonly reason: HandoffRejection };

/**
 * May this code be redeemed right now?
 *
 * Redemption itself is a conditional UPDATE at the database, not a read
 * followed by a write — two simultaneous taps of the same link would both pass
 * a read-then-check and only one may win. This function is the reason a refusal
 * can be *explained*: "that link has expired, here is how to get another" and
 * "that link has already been used, you are probably fine" are different
 * situations, and a participant told the wrong one takes the wrong action at
 * the single point in the study where being lost is most likely.
 *
 * Both are answered identically to the *caller* over HTTP, for the same
 * enumeration reasons as recovery. The distinction is for the participant we
 * have already authenticated, and for the logs.
 */
export function evaluateHandoffCode(state: HandoffCodeState, now: Date): HandoffVerdict {
  // Redemption beats expiry: a code used ten minutes ago and expired since is
  // "already used", which is the fact that actually explains what happened.
  if (state.redeemedAt !== null) return { redeemable: false, reason: "ALREADY_REDEEMED" };
  if (now.getTime() >= state.expiresAt.getTime()) {
    return { redeemable: false, reason: "EXPIRED" };
  }
  return { redeemable: true };
}
