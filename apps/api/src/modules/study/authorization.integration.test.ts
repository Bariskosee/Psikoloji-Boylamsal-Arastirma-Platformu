import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { StudyRole } from "@lpr/contracts";
import {
  Client,
  VALID_STUDY,
  addMember,
  createHarness,
  createUser,
  resetDatabase,
  type Harness,
} from "../../testing/harness.js";

/**
 * The role × endpoint authorization matrix (PLAN.md Phase 2, NFR-04).
 *
 * Two questions, asked exhaustively:
 *
 *   1. Does each role get exactly the operations its permissions allow, and
 *      nothing more?
 *   2. Can a member of study A reach ANY operation on study B?
 *
 * The second is the one that matters most. A leak there is not a bug in a
 * feature; it is one research group reading another's data, and it is the
 * reason NFR-04 insists the study filter live in the query rather than in a
 * check the handler performed earlier.
 */

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
});

/** Every study-scoped operation, with the minimum role that may perform it. */
interface OperationContext {
  studyId: string;
  /** An existing member the OWNER-only member operations can target. */
  memberUserId: string;
  /** A researcher who exists but is NOT yet a member, so "add" can succeed. */
  addableEmail: string;
}

interface Operation {
  name: string;
  minimumRole: StudyRole;
  run: (client: Client, context: OperationContext) => Promise<{ status: number }>;
}

const OPERATIONS: Operation[] = [
  {
    name: "GET /studies/:id",
    minimumRole: "VIEWER",
    run: (client, { studyId }) => client.get(`/api/studies/${studyId}`),
  },
  {
    name: "GET /studies/:id/qr",
    minimumRole: "VIEWER",
    run: (client, { studyId }) => client.get(`/api/studies/${studyId}/qr`),
  },
  {
    name: "PATCH /studies/:id",
    minimumRole: "EDITOR",
    run: (client, { studyId }) => client.patch(`/api/studies/${studyId}`, { name: "Renamed" }),
  },
  {
    name: "PUT /studies/:id/status",
    minimumRole: "OWNER",
    run: (client, { studyId }) =>
      client.put(`/api/studies/${studyId}/status`, { status: "ACTIVE" }),
  },
  {
    name: "GET /studies/:id/members",
    minimumRole: "OWNER",
    run: (client, { studyId }) => client.get(`/api/studies/${studyId}/members`),
  },
  {
    name: "POST /studies/:id/members",
    minimumRole: "OWNER",
    run: (client, { studyId, addableEmail }) =>
      client.post(`/api/studies/${studyId}/members`, { email: addableEmail, role: "VIEWER" }),
  },
  {
    name: "PATCH /studies/:id/members/:userId",
    minimumRole: "OWNER",
    run: (client, { studyId, memberUserId }) =>
      client.patch(`/api/studies/${studyId}/members/${memberUserId}`, { role: "VIEWER" }),
  },
  {
    name: "DELETE /studies/:id/members/:userId",
    minimumRole: "OWNER",
    run: (client, { studyId, memberUserId }) =>
      client.delete(`/api/studies/${studyId}/members/${memberUserId}`),
  },
  {
    name: "GET /studies/:id/audit",
    minimumRole: "OWNER",
    run: (client, { studyId }) => client.get(`/api/studies/${studyId}/audit`),
  },
];

const RANK: Record<StudyRole, number> = { VIEWER: 0, ANALYST: 1, EDITOR: 2, OWNER: 3 };
const ALL_ROLES: StudyRole[] = ["VIEWER", "ANALYST", "EDITOR", "OWNER"];

async function seedStudy(): Promise<{ studyId: string; ownerId: string }> {
  const owner = await createUser(harness.db);
  const client = await Client.login(harness.app, owner);
  const created = await client.post("/api/studies", VALID_STUDY).expect(201);
  return { studyId: created.body.id, ownerId: owner.id };
}

describe("role × endpoint matrix within a study", () => {
  for (const role of ALL_ROLES) {
    for (const operation of OPERATIONS) {
      const permitted = RANK[role] >= RANK[operation.minimumRole];

      it(`${role} ${permitted ? "may" : "may NOT"} ${operation.name}`, async () => {
        const { studyId, ownerId } = await seedStudy();

        // A second member the OWNER-only member operations can target, so
        // "change a role" does not accidentally test the last-owner rule.
        const target = await createUser(harness.db);
        await addMember(harness.db, studyId, target.id, "VIEWER");
        const addable = await createUser(harness.db);

        const actor = await createUser(harness.db);
        if (role === "OWNER") {
          await addMember(harness.db, studyId, actor.id, "OWNER");
        } else {
          await addMember(harness.db, studyId, actor.id, role);
        }
        const client = await Client.login(harness.app, actor);

        const response = await operation.run(client, {
          studyId,
          memberUserId: target.id,
          addableEmail: addable.email,
        });

        if (permitted) {
          expect(response.status, `${role} ${operation.name}`).toBeLessThan(400);
        } else {
          // 403 with STUDY_ROLE_REQUIRED: the caller demonstrably belongs to
          // this study, so naming the required role tells them nothing new and
          // makes the failure actionable.
          expect(response.status, `${role} ${operation.name}`).toBe(403);
        }

        expect(ownerId).toBeTruthy();
      });
    }
  }
});

describe("cross-study isolation", () => {
  /**
   * A member of study A attempts every operation on study B, in each of the
   * four roles. Every attempt must look exactly like "no such study".
   */
  for (const role of ALL_ROLES) {
    it(`an ${role} of another study cannot reach any operation, and cannot tell the study exists`, async () => {
      const { studyId: theirStudyId } = await seedStudy();

      const outsider = await createUser(harness.db);
      const ownStudyOwner = await Client.login(harness.app, outsider);
      const ownStudy = await ownStudyOwner.post("/api/studies", VALID_STUDY).expect(201);
      // Give the outsider a real role in a DIFFERENT study, so this tests
      // cross-study isolation rather than "a user with no memberships".
      if (role !== "OWNER") {
        await harness.db.execute(
          `UPDATE research.study_members SET role = '${role}'
           WHERE study_id = '${ownStudy.body.id}' AND user_id = '${outsider.id}'` as never,
        );
      }

      const client = await Client.login(harness.app, outsider);
      const target = await createUser(harness.db);
      const addable = await createUser(harness.db);

      for (const operation of OPERATIONS) {
        const response = await operation.run(client, {
          studyId: theirStudyId,
          memberUserId: target.id,
          addableEmail: addable.email,
        });

        expect(response.status, `${role} → ${operation.name}`).toBe(404);
        expect(
          (response as unknown as { body: { error: { code: string } } }).body.error.code,
          `${role} → ${operation.name}`,
        ).toBe("STUDY_NOT_FOUND");
      }
    });
  }

  it("hides other researchers' studies from the study list", async () => {
    const { studyId } = await seedStudy();

    const outsider = await createUser(harness.db);
    const client = await Client.login(harness.app, outsider);
    const listed = await client.get("/api/studies").expect(200);

    expect(listed.body.studies).toEqual([]);
    expect(JSON.stringify(listed.body)).not.toContain(studyId);
  });

  it("returns the same 404 for a study id that does not exist at all", async () => {
    // "Forbidden" for a real study and "not found" for a fabricated one would
    // turn this endpoint into an oracle that maps every study on the platform.
    const outsider = await createUser(harness.db);
    const client = await Client.login(harness.app, outsider);

    const { studyId } = await seedStudy();
    const real = await client.get(`/api/studies/${studyId}`);
    const fake = await client.get("/api/studies/2a1f0c9e-0000-4000-8000-000000000000");

    expect(real.status).toBe(fake.status);
    expect(real.body.error.code).toBe(fake.body.error.code);
  });

  it("rejects a malformed study id as not-found rather than failing in the query", async () => {
    const user = await createUser(harness.db);
    const client = await Client.login(harness.app, user);

    const response = await client.get("/api/studies/not-a-uuid").expect(404);
    expect(response.body.error.code).toBe("STUDY_NOT_FOUND");
  });
});

describe("unauthenticated access", () => {
  it("is refused on every study endpoint", async () => {
    const { studyId } = await seedStudy();
    const anonymous = await createUser(harness.db);
    const client = await Client.login(harness.app, anonymous);
    await client.post("/api/auth/logout").expect(204);

    for (const operation of OPERATIONS) {
      const response = await operation.run(client, {
        studyId,
        memberUserId: anonymous.id,
        addableEmail: anonymous.email,
      });
      expect(response.status, operation.name).toBe(401);
    }
  });
});
