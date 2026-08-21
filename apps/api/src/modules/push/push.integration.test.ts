import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  participantCredentials,
  participantHandoffCodes,
  participants,
  pushSubscriptions,
} from "@lpr/db";
import { PARTICIPANT_COOKIE_NAME } from "@lpr/contracts";
import {
  Client,
  VALID_STUDY,
  createHarness,
  createUser,
  resetDatabase,
  type Harness,
} from "../../testing/harness.js";

/**
 * Phase 8's acceptance criteria, against a real PostgreSQL.
 *
 * Two properties carry the weight, and both are ones a mocked database would
 * happily let pass while being false in production:
 *
 *  1. **Re-registering the same endpoint updates rather than duplicates.** The
 *     browser re-subscribes routinely, and a duplicate row is a participant
 *     whose phone buzzes twice for every reminder from Phase 9 onward.
 *
 *  2. **The handoff code redeems exactly once, and binds to the same
 *     participant.** It is the whole of the iOS install remedy; a second
 *     redemption is a second identity, which is the failure the flow exists to
 *     prevent.
 *
 * Plus the one this phase must never get wrong: the VAPID private key is not
 * reachable from any response.
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

const server = () => harness.app.getHttpServer();
const PARTICIPANT_ORIGIN = process.env["PARTICIPANT_ORIGIN"] ?? "http://localhost:3000";

/** A study that is ready to enrol: ACTIVE, with published consent and protocol. */
async function enrollableStudy(): Promise<{ code: string; consentVersionId: string }> {
  const owner = await createUser(harness.db);
  const client = await Client.login(harness.app, owner);

  const study = await client.post("/api/studies", VALID_STUDY).expect(201);
  const studyId: string = study.body.id;

  await client.get(`/api/studies/${studyId}/consent/draft`).expect(200);
  for (const locale of ["en", "tr"]) {
    await client
      .put(`/api/studies/${studyId}/consent/draft/translations`, {
        locale,
        title: "Sample consent title",
        body: "Sample consent body supplied by the research team.",
      })
      .expect(200);
  }
  const consent = await client.post(`/api/studies/${studyId}/consent/publish`).expect(201);

  const questionnaire = await client
    .post(`/api/studies/${studyId}/questionnaires`, { name: "core", description: "" })
    .expect(201);
  await client
    .post(`/api/studies/${studyId}/questionnaires/${questionnaire.body.id}/questions`, {
      type: "FREE_TEXT",
      translations: { en: "Sample question", tr: "Örnek soru" },
      isRequired: false,
    })
    .expect(201);
  const publishedQuestionnaire = await client
    .post(`/api/studies/${studyId}/questionnaires/${questionnaire.body.id}/publish`)
    .expect(201);

  const protocol = await client
    .post(`/api/studies/${studyId}/protocols`, { name: "main", description: "" })
    .expect(201);
  await client
    .post(`/api/studies/${studyId}/protocols/${protocol.body.id}/steps`, {
      stepKey: "baseline",
      questionnaireVersionId: publishedQuestionnaire.body.id,
      triggerType: "ENROLLMENT",
      windowDurationIso: "P3D",
    })
    .expect(201);
  await client.post(`/api/studies/${studyId}/protocols/${protocol.body.id}/publish`).expect(201);

  await client.put(`/api/studies/${studyId}/status`, { status: "ACTIVE" }).expect(200);

  const detail = await client.get(`/api/studies/${studyId}`).expect(200);
  return { code: detail.body.enrollmentCode, consentVersionId: consent.body.id };
}

function participantCookie(response: request.Response): string {
  const raw = response.headers["set-cookie"] as unknown as string[] | undefined;
  const cookie = (raw ?? []).find((value) => value.startsWith(`${PARTICIPANT_COOKIE_NAME}=`));
  if (!cookie) throw new Error("no participant cookie was set");
  return cookie.split(";")[0] ?? "";
}

/** Enrol and return the credential cookie a browser would then be sending. */
async function enrol(): Promise<{ cookie: string; participantId: string }> {
  const { code, consentVersionId } = await enrollableStudy();

  const response = await request(server())
    .post(`/api/participant/studies/${code}/enroll`)
    .set("Origin", PARTICIPANT_ORIGIN)
    .send({
      consentVersionId,
      consented: true,
      consentLocale: "en",
      locale: "en",
      timezone: "Europe/Istanbul",
    })
    .expect(201);

  const cookie = participantCookie(response);

  const me = await request(server())
    .get("/api/participant/me")
    .set("Cookie", cookie)
    .set("Origin", PARTICIPANT_ORIGIN)
    .expect(200);

  // Resolved through THIS participant's public code. Reading the first
  // credential row instead would return whoever enrolled first, which is only
  // correct in the tests that enrol exactly one person.
  const row = (
    await harness.db
      .select({ id: participants.id })
      .from(participants)
      .where(eq(participants.publicCode, me.body.publicCode))
      .limit(1)
  )[0];
  if (!row) throw new Error("enrolled participant not found by public code");

  return { cookie, participantId: row.id };
}

const SUBSCRIPTION = {
  endpoint: "https://push.example.org/subscriptions/device-a",
  keys: {
    /**
     * Deliberately low-entropy and self-describing.
     *
     * These satisfy the base64url schema and nothing else. An earlier version
     * used the shape of a real ECDH key pair, and the secret scanner flagged it
     * — correctly, on the shape alone, since a scanner cannot know that nothing
     * in this phase encrypts anything. Silencing the rule would have blunted it
     * for the next finding, which might be real. A fixture that could never be
     * mistaken for a key is the better answer, and it tests exactly as much.
     */
    p256dh: "not-a-real-p256dh-key",
    auth: "not-a-real-auth-key",
  },
  expirationTime: null,
};

const participant = (cookie: string) => ({
  get: (path: string) =>
    request(server()).get(path).set("Cookie", cookie).set("Origin", PARTICIPANT_ORIGIN),
  post: (path: string, body?: unknown) =>
    request(server())
      .post(path)
      .set("Cookie", cookie)
      .set("Origin", PARTICIPANT_ORIGIN)
      .send(body as object),
  delete: (path: string, body?: unknown) =>
    request(server())
      .delete(path)
      .set("Cookie", cookie)
      .set("Origin", PARTICIPANT_ORIGIN)
      .send(body as object),
});

describe("the VAPID key boundary", () => {
  it("serves the public key and never the private one", async () => {
    const { cookie } = await enrol();

    const response = await participant(cookie).get("/api/participant/push/config").expect(200);

    /**
     * The whole of ADR-006's secret handling, asserted structurally.
     *
     * Exactly one property, and its value is exactly the PUBLIC key. Together
     * those say more than scanning the body for the private key would: they
     * leave no room for anything else at all — not a second field, not a whole
     * env object serialised by accident.
     *
     * A substring scan was the first instinct and is the weaker test, because
     * it degenerates precisely where it is most likely to be run. A developer
     * who copied `.env.example` may have both keys set to the same placeholder,
     * and "the response does not contain the private key" is then unsatisfiable
     * for a response that correctly contains the public one.
     */
    expect(Object.keys(response.body)).toEqual(["vapidPublicKey"]);
    expect(response.body.vapidPublicKey).toBe(process.env["VAPID_PUBLIC_KEY"]);
  });

  it("needs a credential like every other participant route", async () => {
    await request(server()).get("/api/participant/push/config").expect(401);
  });
});

describe("registering a subscription", () => {
  it("stores one row and returns no endpoint or keys", async () => {
    const { cookie } = await enrol();

    const response = await participant(cookie)
      .post("/api/participant/push/subscriptions", SUBSCRIPTION)
      .expect(201);

    // The endpoint is a capability URL and the keys are secrets. Neither has
    // any business in a response body (AGENT.md §3.2).
    const body = JSON.stringify(response.body);
    expect(body).not.toContain(SUBSCRIPTION.endpoint);
    expect(body).not.toContain(SUBSCRIPTION.keys.p256dh);
    expect(body).not.toContain(SUBSCRIPTION.keys.auth);
    expect(response.body.credentialContext).toBe("BROWSER");

    const rows = await harness.db.select().from(pushSubscriptions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.endpoint).toBe(SUBSCRIPTION.endpoint);
    expect(rows[0]?.isActive).toBe(true);
  });

  it("re-registering the same endpoint updates rather than duplicates", async () => {
    const { cookie } = await enrol();

    await participant(cookie).post("/api/participant/push/subscriptions", SUBSCRIPTION).expect(201);
    await participant(cookie)
      .post("/api/participant/push/subscriptions", {
        ...SUBSCRIPTION,
        // A browser may rotate its keys for an endpoint it keeps. A stale pair
        // is a subscription that accepts sends and delivers nothing.
        keys: { ...SUBSCRIPTION.keys, auth: "rotated_auth_value_aaaa" },
      })
      .expect(201);

    const rows = await harness.db.select().from(pushSubscriptions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.authKey).toBe("rotated_auth_value_aaaa");
  });

  it("moves an endpoint that has changed hands to the new participant", async () => {
    // A shared or handed-on phone. Leaving the row would send one person's
    // reminders to another's device — a privacy incident, not a duplicate.
    const first = await enrol();
    const second = await enrol();

    await participant(first.cookie)
      .post("/api/participant/push/subscriptions", SUBSCRIPTION)
      .expect(201);
    await participant(second.cookie)
      .post("/api/participant/push/subscriptions", SUBSCRIPTION)
      .expect(201);

    const rows = await harness.db.select().from(pushSubscriptions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.participantId).toBe(second.participantId);
    expect(rows[0]?.participantId).not.toBe(first.participantId);
  });

  it("reactivates a subscription the participant turned off and back on", async () => {
    const { cookie } = await enrol();

    await participant(cookie).post("/api/participant/push/subscriptions", SUBSCRIPTION).expect(201);
    await participant(cookie)
      .delete("/api/participant/push/subscriptions", { endpoint: SUBSCRIPTION.endpoint })
      .expect(204);
    await participant(cookie).post("/api/participant/push/subscriptions", SUBSCRIPTION).expect(201);

    const rows = await harness.db.select().from(pushSubscriptions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.isActive).toBe(true);
    // The retention clock must be cleared too, or the prune sweeper deletes a
    // live subscription thirty days after it was briefly turned off.
    expect(rows[0]?.deactivatedAt).toBeNull();
    expect(rows[0]?.deactivationReason).toBeNull();
  });

  it("rejects a plain-http endpoint", async () => {
    const { cookie } = await enrol();

    // A push endpoint is a capability to wake this participant's device, and
    // accepting an http one means handing that capability to the network.
    await participant(cookie)
      .post("/api/participant/push/subscriptions", {
        ...SUBSCRIPTION,
        endpoint: "http://push.example.org/subscriptions/device-a",
      })
      .expect(400);
  });
});

describe("unregistering", () => {
  it("deactivates rather than deletes, keeping the evidence", async () => {
    const { cookie } = await enrol();
    await participant(cookie).post("/api/participant/push/subscriptions", SUBSCRIPTION).expect(201);

    await participant(cookie)
      .delete("/api/participant/push/subscriptions", { endpoint: SUBSCRIPTION.endpoint })
      .expect(204);

    const rows = await harness.db.select().from(pushSubscriptions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.isActive).toBe(false);
    expect(rows[0]?.deactivationReason).toBe("UNSUBSCRIBED");
    expect(rows[0]?.deactivatedAt).not.toBeNull();
  });

  it("cannot silence another participant's device", async () => {
    const first = await enrol();
    const second = await enrol();

    await participant(first.cookie)
      .post("/api/participant/push/subscriptions", SUBSCRIPTION)
      .expect(201);

    // 204, not 404: answering differently would confirm to a caller holding an
    // endpoint that it belongs to somebody in this study.
    await participant(second.cookie)
      .delete("/api/participant/push/subscriptions", { endpoint: SUBSCRIPTION.endpoint })
      .expect(204);

    const rows = await harness.db.select().from(pushSubscriptions);
    expect(rows[0]?.isActive).toBe(true);
  });

  it("lists only the caller's own active subscriptions", async () => {
    const first = await enrol();
    const second = await enrol();

    await participant(first.cookie)
      .post("/api/participant/push/subscriptions", SUBSCRIPTION)
      .expect(201);

    const mine = await participant(first.cookie)
      .get("/api/participant/push/subscriptions")
      .expect(200);
    const theirs = await participant(second.cookie)
      .get("/api/participant/push/subscriptions")
      .expect(200);

    expect(mine.body.subscriptions).toHaveLength(1);
    expect(theirs.body.subscriptions).toHaveLength(0);
  });
});

describe("withdrawal silences every device", () => {
  it("deactivates all subscriptions in the withdrawal transaction (FR-30, FR-18)", async () => {
    const { cookie } = await enrol();

    await participant(cookie).post("/api/participant/push/subscriptions", SUBSCRIPTION).expect(201);
    await participant(cookie)
      .post("/api/participant/push/subscriptions", {
        ...SUBSCRIPTION,
        endpoint: "https://push.example.org/subscriptions/device-b",
      })
      .expect(201);

    await participant(cookie).post("/api/participant/withdraw", {}).expect(204);

    const rows = await harness.db.select().from(pushSubscriptions);
    expect(rows).toHaveLength(2);
    // Of every notification this system could send, a questionnaire reminder to
    // a participant who has left is the one that must be impossible.
    expect(rows.every((row) => !row.isActive)).toBe(true);
    expect(rows.every((row) => row.deactivationReason === "WITHDRAWN")).toBe(true);
  });
});

describe("the install handoff", () => {
  it("mints a code, redeems it once, and binds the same participant", async () => {
    const { cookie, participantId } = await enrol();

    const minted = await participant(cookie).post("/api/participant/handoff").expect(201);
    expect(minted.body.code).toMatch(/^[0-9a-f]{32}$/);

    // Redeemed with NO cookie — that is the whole point. The installed
    // application on iOS opens with an empty store, and this is the request
    // that gives it an identity.
    const redeemed = await request(server())
      .post("/api/participant/handoff/redeem")
      .set("Origin", PARTICIPANT_ORIGIN)
      .send({ code: minted.body.code })
      .expect(200);

    const installedCookie = participantCookie(redeemed);
    expect(installedCookie).not.toBe(cookie);

    const me = await request(server())
      .get("/api/participant/me")
      .set("Cookie", installedCookie)
      .set("Origin", PARTICIPANT_ORIGIN)
      .expect(200);

    const credentials = await harness.db
      .select()
      .from(participantCredentials)
      .where(eq(participantCredentials.participantId, participantId));

    // Same person, two credentials, one of them born in the installed context.
    expect(me.body.publicCode).toMatch(/^P-/);
    expect(credentials).toHaveLength(2);
    expect(credentials.map((row) => row.credentialContext).sort()).toEqual([
      "BROWSER",
      "INSTALLED",
    ]);
  });

  it("leaves the browser's credential working after the handoff", async () => {
    // Deliberately not revoked: the participant may have a questionnaire open
    // in the Safari tab, and signing them out of it mid-answer at the exact
    // moment we asked them to install is how a study loses someone.
    const { cookie } = await enrol();

    const minted = await participant(cookie).post("/api/participant/handoff").expect(201);
    await request(server())
      .post("/api/participant/handoff/redeem")
      .set("Origin", PARTICIPANT_ORIGIN)
      .send({ code: minted.body.code })
      .expect(200);

    await participant(cookie).get("/api/participant/me").expect(200);
  });

  it("refuses a second redemption of the same code", async () => {
    const { cookie } = await enrol();
    const minted = await participant(cookie).post("/api/participant/handoff").expect(201);

    await request(server())
      .post("/api/participant/handoff/redeem")
      .set("Origin", PARTICIPANT_ORIGIN)
      .send({ code: minted.body.code })
      .expect(200);

    await request(server())
      .post("/api/participant/handoff/redeem")
      .set("Origin", PARTICIPANT_ORIGIN)
      .send({ code: minted.body.code })
      .expect(401);
  });

  it("refuses an expired code", async () => {
    const { cookie, participantId } = await enrol();
    const minted = await participant(cookie).post("/api/participant/handoff").expect(201);

    /**
     * Age the whole row, not just its expiry.
     *
     * `participant_handoff_codes_expiry_after_issue` refuses a row that expired
     * before it was issued, and it is right to: such a code was never
     * redeemable, and it would fail silently at the moment a participant is
     * most likely to be lost. So the test moves the code back in time rather
     * than into an impossible state.
     */
    const issuedAt = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await harness.db
      .update(participantHandoffCodes)
      .set({ issuedAt, expiresAt: new Date(issuedAt.getTime() + 1000) })
      .where(eq(participantHandoffCodes.participantId, participantId));

    await request(server())
      .post("/api/participant/handoff/redeem")
      .set("Origin", PARTICIPANT_ORIGIN)
      .send({ code: minted.body.code })
      .expect(401);
  });

  it("answers an unknown code exactly as it answers a spent one", async () => {
    const { cookie } = await enrol();
    const minted = await participant(cookie).post("/api/participant/handoff").expect(201);

    await request(server())
      .post("/api/participant/handoff/redeem")
      .set("Origin", PARTICIPANT_ORIGIN)
      .send({ code: minted.body.code })
      .expect(200);

    const spent = await request(server())
      .post("/api/participant/handoff/redeem")
      .set("Origin", PARTICIPANT_ORIGIN)
      .send({ code: minted.body.code })
      .expect(401);

    const unknown = await request(server())
      .post("/api/participant/handoff/redeem")
      .set("Origin", PARTICIPANT_ORIGIN)
      .send({ code: "0".repeat(32) })
      .expect(401);

    // Identical bodies. Telling them apart would confirm that a code somebody
    // holds once existed.
    expect(unknown.body).toEqual(spent.body);
  });

  it("needs a credential to mint one", async () => {
    await request(server())
      .post("/api/participant/handoff")
      .set("Origin", PARTICIPANT_ORIGIN)
      .expect(401);
  });

  it("stores only the hash of the code", async () => {
    const { cookie } = await enrol();
    const minted = await participant(cookie).post("/api/participant/handoff").expect(201);

    const rows = await harness.db.select().from(participantHandoffCodes);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.codeHash).not.toBe(minted.body.code);
    expect(rows[0]?.codeHash).toHaveLength(64);
  });
});
