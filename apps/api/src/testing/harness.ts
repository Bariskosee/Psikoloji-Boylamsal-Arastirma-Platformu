import "reflect-metadata";
import cookieParser from "cookie-parser";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { CSRF_HEADER, CSRF_COOKIE_NAME, SESSION_COOKIE_NAME, type StudyRole } from "@lpr/contracts";
import { createDatabase, createPool, researcherUsers, studyMembers, type Database } from "@lpr/db";
import { hash, Algorithm } from "@node-rs/argon2";
import { AppModule } from "../app.module.js";
import { ApiExceptionFilter } from "../common/api-exception.filter.js";
import { RateLimitService } from "../modules/auth/rate-limit.service.js";

/**
 * The integration harness.
 *
 * Boots the real application against a real PostgreSQL. Guards, the exception
 * filter, cookie parsing, and every constraint are the production ones —
 * because the properties these tests assert (a member of study A cannot touch
 * study B; a revoked session dies on the next request) are properties of the
 * whole stack, and a mocked database would let all of them pass while being
 * false in production.
 */
export interface Harness {
  app: INestApplication;
  db: Database;
  /**
   * Clears the login rate limiter.
   *
   * Every request in this suite arrives from the same loopback address, so the
   * per-IP budget — five attempts per fifteen minutes in production — would be
   * spent partway through the file and every later login would fail with 429.
   * Called from `beforeEach` alongside the database reset.
   */
  resetRateLimits(): void;
  close(): Promise<void>;
}

const connectionString = process.env["DATABASE_URL"];
if (!connectionString) {
  throw new Error(
    "DATABASE_URL is required for API integration tests.\n" +
      "  Local: pnpm db:up && pnpm --filter=@lpr/db migrate:up",
  );
}

export const RESEARCHER_ORIGIN = process.env["RESEARCHER_ORIGIN"] ?? "http://localhost:3002";

export async function createHarness(): Promise<Harness> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.use(cookieParser());
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.init();

  const pool = createPool({ connectionString: connectionString!, max: 4 });
  const db = createDatabase(pool);

  return {
    app,
    db,
    resetRateLimits: () => app.get(RateLimitService).clear(),
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}

/**
 * Wipes every table Phase 2 owns.
 *
 * TRUNCATE rather than DELETE, because `research.audit_events` carries a row
 * trigger that rejects DELETE — the append-only guarantee the production code
 * relies on. TRUNCATE fires statement-level triggers only, which is the
 * standard, deliberate escape hatch for test setup and is unavailable to the
 * application role in any case.
 */
export async function resetDatabase(db: Database): Promise<void> {
  await db.execute(
    // The identity participant tables are listed EXPLICITLY. They carry no
    // foreign key into `research` — that separation is deliberate (see
    // `participant-credentials.ts`) — so CASCADE from a research table does not
    // reach them, and a credential left behind would let one test's participant
    // authenticate in the next.
    `TRUNCATE research.audit_events, research.session_submissions,
             research.response_history, research.response_option_selections,
             research.responses, research.participant_sessions,
             research.question_option_translations,
             research.question_options, research.question_version_translations,
             research.question_versions, research.questionnaire_versions,
             research.questionnaires, research.enrollments, research.participants,
             research.consent_version_translations, research.consent_versions,
             research.protocol_steps, research.reminder_policies,
             research.protocol_versions, research.protocols,
             research.study_groups, research.study_members, research.studies,
             identity.participant_recovery_codes, identity.participant_credentials,
             identity.researcher_sessions, identity.researcher_users
     RESTART IDENTITY CASCADE` as never,
  );
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
}

let userCounter = 0;

export async function createUser(
  db: Database,
  overrides: { email?: string; password?: string; isActive?: boolean; isAdmin?: boolean } = {},
): Promise<TestUser> {
  userCounter += 1;
  const email = overrides.email ?? `researcher-${userCounter}-${Date.now()}@example.org`;
  // Weak by policy standards but never checked on login — and deliberately
  // cheap to hash, because these tests create dozens of accounts.
  const password = overrides.password ?? "a quiet forest of pines";

  const passwordHash = await hash(password, {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });

  const inserted = await db
    .insert(researcherUsers)
    .values({
      email,
      passwordHash,
      displayName: `Researcher ${userCounter}`,
      isActive: overrides.isActive ?? true,
      isAdmin: overrides.isAdmin ?? false,
    })
    .returning({ id: researcherUsers.id });

  return { id: inserted[0]!.id, email, password };
}

export async function addMember(
  db: Database,
  studyId: string,
  userId: string,
  role: StudyRole,
): Promise<void> {
  await db.insert(studyMembers).values({ studyId, userId, role });
}

/**
 * An authenticated client.
 *
 * Carries the session cookie and the CSRF token exactly as a browser would, so
 * a test cannot accidentally bypass the double-submit check that production
 * traffic must satisfy.
 */
export class Client {
  private constructor(
    private readonly app: INestApplication,
    /** Exposed so CSRF tests can vary one header while keeping a VALID session. */
    readonly cookies: string[],
    readonly csrfToken: string,
    readonly user: { id: string; email: string },
  ) {}

  static async login(app: INestApplication, user: TestUser): Promise<Client> {
    const response = await request(app.getHttpServer())
      .post("/api/auth/login")
      .set("Origin", RESEARCHER_ORIGIN)
      .send({ email: user.email, password: user.password })
      .expect(200);

    const cookies = extractCookies(response);
    return new Client(app, cookies, response.body.csrfToken, {
      id: response.body.user.id,
      email: response.body.user.email,
    });
  }

  get(path: string) {
    return request(this.app.getHttpServer())
      .get(path)
      .set("Cookie", this.cookies)
      .set("Origin", RESEARCHER_ORIGIN);
  }

  post(path: string, body?: unknown) {
    return this.mutate("post", path, body);
  }

  patch(path: string, body?: unknown) {
    return this.mutate("patch", path, body);
  }

  put(path: string, body?: unknown) {
    return this.mutate("put", path, body);
  }

  delete(path: string) {
    return this.mutate("delete", path);
  }

  /** A request with the session but WITHOUT the CSRF header, for CSRF tests. */
  postWithoutCsrf(path: string, body?: unknown) {
    return request(this.app.getHttpServer())
      .post(path)
      .set("Cookie", this.cookies)
      .set("Origin", RESEARCHER_ORIGIN)
      .send(body as object);
  }

  private mutate(method: "post" | "patch" | "put" | "delete", path: string, body?: unknown) {
    const agent = request(this.app.getHttpServer());
    const req = agent[method](path)
      .set("Cookie", this.cookies)
      .set("Origin", RESEARCHER_ORIGIN)
      .set(CSRF_HEADER, this.csrfToken);
    return body === undefined ? req : req.send(body as object);
  }
}

export function extractCookies(response: request.Response): string[] {
  const raw = response.headers["set-cookie"];
  if (!raw) return [];
  return (Array.isArray(raw) ? raw : [raw]).map((cookie) => cookie.split(";")[0] as string);
}

export function cookieValue(response: request.Response, name: string): string | undefined {
  return extractCookies(response)
    .find((cookie) => cookie.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

export { CSRF_COOKIE_NAME, CSRF_HEADER, SESSION_COOKIE_NAME };

export const VALID_STUDY = {
  name: "Sleep and Mood",
  description: "Placeholder study for tests",
  timezone: "Europe/Istanbul",
  defaultLocale: "tr" as const,
  supportedLocales: ["tr", "en"] as const,
  enrollmentCapacity: null,
};
