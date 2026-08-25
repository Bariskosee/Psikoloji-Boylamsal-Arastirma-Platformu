import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { consentVersionTranslations, consentVersions } from "@lpr/db";
import {
  Client,
  VALID_STUDY,
  createHarness,
  createUser,
  resetDatabase,
  type Harness,
} from "../../testing/harness.js";

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

async function fixture(supportedLocales: readonly ("en" | "tr")[] = ["en", "tr"]) {
  const owner = await createUser(harness.db);
  const client = await Client.login(harness.app, owner);
  const study = await client
    .post("/api/studies", {
      ...VALID_STUDY,
      defaultLocale: supportedLocales[0],
      supportedLocales,
    })
    .expect(201);
  await client.get(`/api/studies/${study.body.id}/consent/draft`).expect(200);
  return { client, studyId: study.body.id as string };
}

async function save(
  client: Client,
  studyId: string,
  locale: "en" | "tr",
  fields: { title?: string; body?: string } = {},
) {
  return client
    .put(`/api/studies/${studyId}/consent/draft/translations`, {
      locale,
      title: fields.title ?? `Sample ${locale} consent`,
      body: fields.body ?? `Sample ${locale} wording supplied by the research team.`,
    })
    .expect(200);
}

describe("POST /api/studies/:studyId/consent/publish", () => {
  it("requires non-blank title and body for every supported locale", async () => {
    const { client, studyId } = await fixture();
    await save(client, studyId, "tr");
    await save(client, studyId, "en", { body: "   " });

    const response = await client.post(`/api/studies/${studyId}/consent/publish`).expect(409);

    expect(response.body.error.code).toBe("CONSENT_VERSION_INCOMPLETE");
    expect(response.body.error.details).toEqual([
      {
        path: "translations.en",
        message: "Both title and body must contain non-whitespace text",
      },
    ]);

    const [draft] = await harness.db
      .select()
      .from(consentVersions)
      .where(and(eq(consentVersions.studyId, studyId), eq(consentVersions.status, "DRAFT")));
    expect(draft).toBeDefined();
    expect(draft?.versionNumber).toBeNull();
  });

  it("uses the study's current supported locales rather than a draft-time fallback", async () => {
    const { client, studyId } = await fixture(["tr"]);
    await save(client, studyId, "tr");

    await client
      .patch(`/api/studies/${studyId}`, {
        supportedLocales: ["tr", "en"],
        defaultLocale: "tr",
      })
      .expect(200);

    const response = await client.post(`/api/studies/${studyId}/consent/publish`).expect(409);
    expect(response.body.error.code).toBe("CONSENT_VERSION_INCOMPLETE");
    expect(response.body.error.details).toEqual([
      {
        path: "translations.en",
        message: "Both title and body must contain non-whitespace text",
      },
    ]);
  });

  it("publishes only after every current locale is complete", async () => {
    const { client, studyId } = await fixture();
    await save(client, studyId, "en");
    await save(client, studyId, "tr");

    const published = await client.post(`/api/studies/${studyId}/consent/publish`).expect(201);
    expect(published.body.status).toBe("PUBLISHED");
    expect(published.body.versionNumber).toBe(1);

    const rows = await harness.db
      .select()
      .from(consentVersionTranslations)
      .where(eq(consentVersionTranslations.consentVersionId, published.body.id));
    expect(rows.map((row) => row.locale).sort()).toEqual(["en", "tr"]);
  });
});

describe("GET /api/studies/:studyId/consent/draft", () => {
  it("returns one shared draft when two tabs open it concurrently", async () => {
    const owner = await createUser(harness.db);
    const client = await Client.login(harness.app, owner);
    const study = await client.post("/api/studies", VALID_STUDY).expect(201);
    const studyId = study.body.id as string;

    const [first, second] = await Promise.all([
      client.get(`/api/studies/${studyId}/consent/draft`).expect(200),
      client.get(`/api/studies/${studyId}/consent/draft`).expect(200),
    ]);

    expect(second.body.id).toBe(first.body.id);
    const drafts = await harness.db
      .select()
      .from(consentVersions)
      .where(and(eq(consentVersions.studyId, studyId), eq(consentVersions.status, "DRAFT")));
    expect(drafts).toHaveLength(1);
  });
});
