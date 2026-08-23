import request from "supertest";
import { PARTICIPANT_COOKIE_NAME } from "@lpr/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Client,
  VALID_STUDY,
  createHarness,
  createUser,
  resetDatabase,
  type Harness,
} from "../testing/harness.js";

/**
 * Load test at the target cohort size (PLAN.md Phase 12).
 *
 * ── What this measures, and what it does not ────────────────────────────────
 * Requests go through supertest, which drives the real Nest application
 * in-process against a real PostgreSQL. Everything the server does is real —
 * guards, validation, transactions, every query and every index. What is NOT
 * real is the network, TLS, the load balancer, and the fact that production
 * runs more than one process.
 *
 * That makes the absolute numbers a LOWER BOUND and not a production figure,
 * and PLAN.md's "95th percentile under 300 ms" cannot honestly be signed off
 * from here. What it does measure faithfully is server-side work per request,
 * which is exactly what "add indexes where measured" needs: a query that scans
 * a table scans it in-process too, and a missing index shows up as a curve that
 * bends upward with the cohort size rather than staying flat.
 *
 * Run it deliberately — `pnpm --filter=@lpr/api test:load` — never in CI. It
 * takes minutes, it is a throughput measurement rather than an assertion about
 * behaviour, and a timing test in a shared CI runner is a flaky test with extra
 * steps.
 *
 * ── Why the cohort size is configurable ─────────────────────────────────────
 * `LOAD_PARTICIPANTS` defaults to 500, matching PLAN.md. A developer checking
 * that the harness still works wants 25, and waiting four minutes to find out
 * they had a typo is how a load test stops being run at all.
 */
const PARTICIPANTS = Number(process.env["LOAD_PARTICIPANTS"] ?? 500);
/** Requests in flight at once. Above this, the measurement is of the queue. */
const CONCURRENCY = Number(process.env["LOAD_CONCURRENCY"] ?? 50);

let harness: Harness;
/**
 * One real listener for the whole run.
 *
 * `request(app.getHttpServer())` starts an ephemeral listener PER CALL, which
 * is fine for a handful of assertions and falls over at fifty in flight —
 * the first attempt at this file died with ECONNRESET before it measured
 * anything. Binding once and addressing it by URL is both closer to production
 * and the only way the numbers mean anything.
 */
let base: string;

beforeAll(async () => {
  harness = await createHarness();
  await resetDatabase(harness.db);
  await harness.app.listen(0);
  const address = harness.app.getHttpServer().address() as { port: number };
  base = `http://127.0.0.1:${String(address.port)}`;
}, 120_000);

afterAll(async () => {
  await harness.close();
});

const PARTICIPANT_ORIGIN = process.env["PARTICIPANT_ORIGIN"] ?? "http://localhost:3000";

function server(): string {
  return base;
}

interface Timing {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly count: number;
}

function summarise(samples: number[]): Timing {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
  return {
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[sorted.length - 1] ?? 0,
    count: sorted.length,
  };
}

function report(name: string, timing: Timing): void {
  // The output IS the deliverable of this lane.
  console.log(
    `${name.padEnd(28)} n=${String(timing.count).padStart(5)}  ` +
      `p50=${timing.p50.toFixed(1).padStart(7)}ms  ` +
      `p95=${timing.p95.toFixed(1).padStart(7)}ms  ` +
      `p99=${timing.p99.toFixed(1).padStart(7)}ms  ` +
      `max=${timing.max.toFixed(1).padStart(7)}ms`,
  );
}

/**
 * Run `task` over `items` with a bounded number in flight.
 *
 * Bounded rather than `Promise.all` over five hundred: an unbounded fan-out
 * measures how long the event loop takes to drain a queue, which is a number
 * about this script rather than about the platform.
 */
async function pooled<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await task(items[index] as T, index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function timed<R>(samples: number[], run: () => Promise<R>): Promise<R> {
  const started = performance.now();
  try {
    return await run();
  } finally {
    samples.push(performance.now() - started);
  }
}

interface Cohort {
  readonly studyId: string;
  readonly researcher: Client;
  readonly participants: { cookie: string; sessionId: string; questionIds: string[] }[];
}

describe(`load — ${String(PARTICIPANTS)} participants`, () => {
  let cohort: Cohort;

  it("enrols the cohort and opens a session for each", async () => {
    const owner = await createUser(harness.db);
    const researcher = await Client.login(harness.app, owner);

    const study = await researcher
      .post("/api/studies", { ...VALID_STUDY, name: "Load study" })
      .expect(201);
    const studyId: string = study.body.id;

    await researcher.get(`/api/studies/${studyId}/consent/draft`).expect(200);
    for (const locale of ["en", "tr"]) {
      await researcher
        .put(`/api/studies/${studyId}/consent/draft/translations`, {
          locale,
          title: "Sample consent title",
          body: "Sample consent body supplied by the research team.",
        })
        .expect(200);
    }
    const consent = await researcher.post(`/api/studies/${studyId}/consent/publish`).expect(201);

    const questionnaire = await researcher
      .post(`/api/studies/${studyId}/questionnaires`, { name: "core", description: "" })
      .expect(201);

    /**
     * Ten questions, not one.
     *
     * An autosave writes every answer on the page, so a one-question
     * questionnaire measures a workload no study has. Ten is a realistic
     * ESM page and makes the per-answer cost visible.
     */
    for (let index = 0; index < 10; index += 1) {
      await researcher
        .post(`/api/studies/${studyId}/questionnaires/${questionnaire.body.id}/questions`, {
          type: "FREE_TEXT",
          translations: { en: `Question ${String(index)}`, tr: `Soru ${String(index)}` },
        })
        .expect(201);
    }
    const version = await researcher
      .post(`/api/studies/${studyId}/questionnaires/${questionnaire.body.id}/publish`)
      .expect(201);

    const protocol = await researcher
      .post(`/api/studies/${studyId}/protocols`, { name: "main", description: "" })
      .expect(201);
    await researcher
      .post(`/api/studies/${studyId}/protocols/${protocol.body.id}/steps`, {
        stepKey: "baseline",
        questionnaireVersionId: version.body.id,
        triggerType: "ENROLLMENT",
        windowDurationIso: "P3D",
      })
      .expect(201);
    await researcher
      .post(`/api/studies/${studyId}/protocols/${protocol.body.id}/publish`)
      .expect(201);
    await researcher.put(`/api/studies/${studyId}/status`, { status: "ACTIVE" }).expect(200);

    const detail = await researcher.get(`/api/studies/${studyId}`).expect(200);
    const code: string = detail.body.enrollmentCode;

    const enrolTimings: number[] = [];
    const participants = await pooled(
      Array.from({ length: PARTICIPANTS }, (_, i) => i),
      CONCURRENCY,
      async () => {
        const enrolled = await timed(enrolTimings, () =>
          request(server())
            .post(`/api/participant/studies/${code}/enroll`)
            .set("Origin", PARTICIPANT_ORIGIN)
            .send({
              consentVersionId: consent.body.id,
              consented: true,
              consentLocale: "en",
              locale: "en",
              timezone: "Europe/Istanbul",
            })
            .expect(201),
        );

        const raw = enrolled.headers["set-cookie"] as unknown as string[] | undefined;
        const cookie = (raw ?? [])
          .find((value) => value.startsWith(`${PARTICIPANT_COOKIE_NAME}=`))
          ?.split(";")[0];
        if (cookie === undefined) throw new Error("enrollment set no participant cookie");

        const sessions = await request(server())
          .get("/api/participant/sessions")
          .set("Cookie", cookie)
          .expect(200);
        const sessionId: string = sessions.body.sessions[0].id;

        const session = await request(server())
          .get(`/api/participant/sessions/${sessionId}`)
          .set("Cookie", cookie)
          .expect(200);
        const questionIds: string[] = session.body.questions.map(
          (question: { id: string }) => question.id,
        );

        return { cookie, sessionId, questionIds };
      },
    );

    report("enroll", summarise(enrolTimings));
    cohort = { studyId, researcher, participants };
    expect(participants).toHaveLength(PARTICIPANTS);
  }, 900_000);

  /**
   * The number PLAN.md names: simultaneous autosave across the cohort.
   *
   * Three rounds, because the first write into a session is an INSERT and the
   * later ones are updates with a revision bump — a difference an index either
   * covers or does not, and a one-round measurement would hide it.
   */
  it("sustains simultaneous autosave across the cohort", async () => {
    const timings: number[] = [];

    for (let round = 0; round < 3; round += 1) {
      await pooled(cohort.participants, CONCURRENCY, async (participant) => {
        await timed(timings, () =>
          request(server())
            .post(`/api/participant/sessions/${participant.sessionId}/answers`)
            .set("Cookie", participant.cookie)
            .set("Origin", PARTICIPANT_ORIGIN)
            .send({
              answers: participant.questionIds.map((questionVersionId) => ({
                questionVersionId,
                // The revision advances each round: an autosave is an
                // optimistic write, and replaying the same revision is
                // deliberately treated as a duplicate rather than an error.
                clientRevision: round + 1,
                valueText: `round ${String(round)} answer`,
              })),
            })
            .expect(200),
        );
      });
    }

    const timing = summarise(timings);
    report("autosave (10 answers)", timing);

    // Not asserted against PLAN.md's 300 ms: see the note at the top of this
    // file. Recorded so a regression is visible against the last run.
    expect(timing.count).toBe(cohort.participants.length * 3);
  }, 900_000);

  /**
   * Dashboard queries while the writes are still landing.
   *
   * Measured DURING the storm rather than after it, because the question a
   * researcher actually has — "does monitoring stay usable during a reminder
   * wave?" — is about contention, and a quiet-system measurement answers a
   * different one.
   */
  it("keeps dashboard queries usable under concurrent writes", async () => {
    const writes: number[] = [];
    const reads: number[] = [];

    const storm = pooled(cohort.participants, CONCURRENCY, async (participant) => {
      await timed(writes, () =>
        request(server())
          .post(`/api/participant/sessions/${participant.sessionId}/answers`)
          .set("Cookie", participant.cookie)
          .set("Origin", PARTICIPANT_ORIGIN)
          .send({
            answers: participant.questionIds.slice(0, 3).map((questionVersionId) => ({
              questionVersionId,
              // After three rounds above, so revision four.
              clientRevision: 4,
              valueText: "under load",
            })),
          })
          .expect(200),
      );
    });

    const dashboards = (async () => {
      for (let round = 0; round < 20; round += 1) {
        await timed(reads, () =>
          cohort.researcher.get(`/api/studies/${cohort.studyId}/analytics/overview`).expect(200),
        );
        await timed(reads, () =>
          cohort.researcher.get(`/api/studies/${cohort.studyId}/participants`).expect(200),
        );
      }
    })();

    await Promise.all([storm, dashboards]);

    report("autosave (during reads)", summarise(writes));
    report("dashboard (during writes)", summarise(reads));
    expect(reads.length).toBeGreaterThan(0);
  }, 900_000);

  /**
   * Concurrent exports, which PLAN.md lists and which is the heaviest thing a
   * researcher can ask for.
   *
   * Three at once: more than one researcher on a team clicking download is
   * ordinary, and the export streams from a cursor precisely so that it does
   * not buffer the study into memory. This is where that either holds or does
   * not.
   */
  it("streams concurrent exports", async () => {
    const timings: number[] = [];

    await Promise.all(
      ["long.csv", "wide.csv", "long.csv"].map((file) =>
        timed(timings, () =>
          cohort.researcher.get(`/api/studies/${cohort.studyId}/exports/${file}`).expect(200),
        ),
      ),
    );

    report("export (3 concurrent)", summarise(timings));
    expect(timings).toHaveLength(3);
  }, 900_000);
});
