import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Cryptographic primitives used by authentication and audit.
 *
 * Kept in one small module so the choices are reviewable in one place rather
 * than scattered across services — and so nothing reaches for `Math.random()`
 * because the right call was three files away.
 */

/**
 * A 256-bit CSPRNG token, base64url encoded.
 *
 * Session tokens, CSRF tokens, and (from Phase 5) participant continuity
 * credentials are all drawn from here. 256 bits is far beyond guessable, which
 * is what allows the stored form to be a fast SHA-256 rather than argon2id.
 */
export function generateToken(byteLength = 32): string {
  return randomBytes(byteLength).toString("base64url");
}

/** Raw CSPRNG bytes, for the pure code generators in @lpr/domain. */
export function generateRandomBytes(byteLength: number): Uint8Array {
  return randomBytes(byteLength);
}

/**
 * The stored form of a high-entropy token.
 *
 * SHA-256 is correct here and only here. A password needs a slow hash because
 * it has little entropy; a 256-bit random token has nothing to slow an
 * attacker down about, and every authenticated request would otherwise pay the
 * cost of a deliberately expensive function.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * A keyed, non-reversible IP fingerprint (STRUCTURE.md §11.5).
 *
 * HMAC rather than a plain hash: the IPv4 space is small enough to enumerate
 * completely, so an unkeyed hash of an address is not pseudonymous at all — it
 * is a lookup table away from the address itself. Rotating the key makes
 * historic hashes uncorrelatable with new ones, which is desirable.
 */
export function hashIp(ip: string | undefined, secret: string): string | null {
  if (!ip) return null;
  return createHmac("sha256", secret).update(ip, "utf8").digest("hex").slice(0, 32);
}

/**
 * Constant-time comparison of two hex digests.
 *
 * The CSRF check compares a value supplied by the caller against a stored one.
 * A `===` there leaks, through timing, how many leading characters matched,
 * which is enough to reconstruct the token one character at a time.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  // timingSafeEqual throws on length mismatch, and the throw itself is a
  // timing signal — but only about LENGTH, which is not secret here since both
  // sides are fixed-width digests.
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
