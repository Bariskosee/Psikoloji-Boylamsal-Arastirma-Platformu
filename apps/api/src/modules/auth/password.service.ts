import { Injectable } from "@nestjs/common";
import { hash, verify, Algorithm } from "@node-rs/argon2";

/**
 * argon2id password hashing.
 *
 * argon2id rather than bcrypt or PBKDF2 because it is memory-hard: a GPU or
 * ASIC attacker cannot trade memory for parallelism the way they can against
 * an iteration-only function. These parameters are the OWASP baseline
 * (19 MiB, t=2, p=1); the cost lives in the PHC-format hash string itself, so
 * raising it later is a rehash-on-next-login, not a migration.
 */
const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456, // KiB
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * A hash of a fixed dummy password, computed once at startup.
 *
 * Used to burn the same CPU on a login for an email that does not exist as one
 * that does. Without it, "no such user" returns in microseconds while a real
 * account takes ~50ms, and that difference IS an account-enumeration oracle
 * regardless of how carefully the response bodies are made identical
 * (STRUCTURE.md §11.5).
 */
@Injectable()
export class PasswordService {
  private dummyHash: string | null = null;

  async hash(password: string): Promise<string> {
    return hash(password, ARGON2_OPTIONS);
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password, ARGON2_OPTIONS);
    } catch {
      // A malformed or truncated hash in the database must fail the login,
      // not crash the request with a 500 that reveals the row is corrupt.
      return false;
    }
  }

  /**
   * Spend the cost of a verification without having a user to verify.
   * Called on the "no such account" path so both paths take the same time.
   */
  async verifyDummy(password: string): Promise<void> {
    this.dummyHash ??= await this.hash("timing-equalisation-placeholder");
    await this.verify(this.dummyHash, password);
  }
}
