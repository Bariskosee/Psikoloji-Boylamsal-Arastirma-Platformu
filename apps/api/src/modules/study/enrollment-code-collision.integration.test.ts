import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ENROLLMENT_CODE_BYTES } from "@lpr/domain";

/**
 * Forces an enrollment-code collision so the retry path actually runs.
 *
 * The first two 6-byte draws return the same value, so the second study's first
 * INSERT is guaranteed to violate `studies_enrollment_code_key`. Later draws are
 * real randomness, so the retry can succeed.
 *
 * `generateRandomBytes` is used only for enrollment codes and entity keys —
 * never for session or CSRF tokens — so pinning it does not weaken the
 * authentication the harness performs.
 */
const FIXED = new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 251));
let codeDraws = 0;

vi.mock("../../common/crypto.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../common/crypto.js")>();
  return {
    ...actual,
    generateRandomBytes: (byteLength: number): Uint8Array => {
      if (byteLength === ENROLLMENT_CODE_BYTES) {
        codeDraws += 1;
        if (codeDraws <= 2) return FIXED.slice(0, byteLength);
      }
      return actual.generateRandomBytes(byteLength);
    },
  };
});

const { Client, VALID_STUDY, createHarness, createUser, resetDatabase } =
  await import("../../testing/harness.js");
type Harness = Awaited<ReturnType<typeof createHarness>>;

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await resetDatabase(harness.db);
  harness.resetRateLimits();
  codeDraws = 0;
});

describe("enrollment code collision", () => {
  /**
   * The retry loop lives inside the caller's transaction. In PostgreSQL the
   * first failed statement aborts the transaction, so a retry issued directly
   * on it fails with 25P02 — which is not a unique violation, so it was
   * rethrown and the researcher got a 500. Each attempt now runs in its own
   * savepoint, which is what makes a second attempt possible at all.
   */
  it("regenerates the code and still creates the study", async () => {
    const owner = await createUser(harness.db);
    const client = await Client.login(harness.app, owner);

    const first = await client.post("/api/studies", VALID_STUDY).expect(201);
    const second = await client.post("/api/studies", VALID_STUDY).expect(201);

    expect(codeDraws).toBeGreaterThanOrEqual(3);
    expect(second.body.enrollmentCode).not.toBe(first.body.enrollmentCode);
  });

  it("leaves the study and its OWNER membership committed together", async () => {
    const owner = await createUser(harness.db);
    const client = await Client.login(harness.app, owner);

    await client.post("/api/studies", VALID_STUDY).expect(201);
    const second = await client.post("/api/studies", VALID_STUDY).expect(201);

    // The savepoint must roll back only the failed INSERT — the surrounding
    // transaction still has to commit the membership that makes the study
    // manageable.
    const members = await client.get(`/api/studies/${second.body.id}/members`).expect(200);
    expect(members.body.members).toHaveLength(1);
    expect(members.body.members[0].role).toBe("OWNER");
  });
});
