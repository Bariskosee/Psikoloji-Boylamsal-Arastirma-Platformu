import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Database } from "@lpr/db";
import {
  compliancePercent,
  participantCompliance,
  studyAverageCompliance,
  summariseDay,
  type ComplianceRatio,
  type ComplianceSession,
  type StepCompliance,
} from "@lpr/domain";
import type {
  ComplianceFigure,
  DailyComplianceResponse,
  ParticipantDetailResponse,
  ParticipantListResponse,
  ParticipantRow,
  StepComplianceSummary,
  StudyOverviewResponse,
  TimelineEntry,
} from "@lpr/contracts";
import type { SessionStatus } from "@lpr/domain";
import { ApiErrors } from "../../common/api-error.js";
import { ANALYTICS_DATABASE } from "../database/database.module.js";

/**
 * Monitoring and compliance (PLAN.md Phase 10, FR-27, FR-28, FR-44).
 *
 * ── Two rules govern every line in this file ────────────────────────────────
 *
 * **1. It runs on the analytics role.** `ANALYTICS_DATABASE`'s connections have
 * dropped to `app_analytics`, which holds SELECT on `research` and nothing at
 * all on `identity`. A query here that reached for a push endpoint or a
 * password hash does not return it and does not get caught in review — it
 * fails, at the database, in CI. That is the whole of NFR-03, and there is an
 * integration test that proves it by trying.
 *
 * **2. No formula is computed here.** Every ratio comes from
 * `packages/domain/src/compliance`, which `docs/compliance-formula.md` names as
 * the single implementation. SQL counts rows; the domain decides what they
 * mean. The temptation to write `count(*) FILTER (WHERE status = 'COMPLETED')
 * / count(*)` directly in a query is exactly how a dashboard and an export come
 * to disagree about a number that has already been published.
 *
 * ── Why nothing is precomputed ──────────────────────────────────────────────
 * PLAN.md Phase 10 is explicit: all metrics are computed dynamically. Several
 * hundred participants does not justify precomputation, and a cached aggregate
 * is a correctness risk in a research context — a stale compliance figure is
 * worse than a slow one, because it is wrong without looking wrong.
 */
@Injectable()
export class AnalyticsService {
  constructor(@Inject(ANALYTICS_DATABASE) private readonly db: Database) {}

  /**
   * The study's protocol steps, in order.
   *
   * Read from the PUBLISHED protocol version participants are actually bound
   * to, not the draft. A dashboard computed against a draft would report
   * per-step figures for steps nobody was ever enrolled on.
   */
  private async steps(studyId: string): Promise<
    {
      stepKey: string;
      stepIndex: number;
      occurrenceCount: number;
      countsTowardCompliance: boolean;
    }[]
  > {
    const rows = await this.db.execute<{
      step_key: string;
      step_index: number;
      occurrence_count: number;
      counts_toward_compliance: boolean;
    }>(sql`
      SELECT DISTINCT ON (ps.step_key)
             ps.step_key, ps.step_index, ps.occurrence_count, ps.counts_toward_compliance
        FROM research.protocol_steps ps
        JOIN research.protocol_versions pv ON pv.id = ps.protocol_version_id
        JOIN research.protocols p          ON p.id  = pv.protocol_id
       WHERE p.study_id = ${studyId} AND pv.status = 'PUBLISHED'
       ORDER BY ps.step_key, pv.version_number DESC, ps.step_index
    `);

    return [...rows.rows]
      .map((row) => ({
        stepKey: row.step_key,
        stepIndex: row.step_index,
        occurrenceCount: row.occurrence_count,
        countsTowardCompliance: row.counts_toward_compliance,
      }))
      .sort((a, b) => a.stepIndex - b.stepIndex);
  }

  /**
   * Every session in the study, reduced to what a compliance figure needs.
   *
   * One query for the whole study rather than one per participant. A study of
   * three hundred people on the reference protocol is under ten thousand rows —
   * a single indexed scan, and far cheaper than three hundred round trips.
   */
  private async sessionsByParticipant(studyId: string): Promise<Map<string, ComplianceSession[]>> {
    const rows = await this.db.execute<{
      participant_id: string;
      step_key: string;
      status: string;
      counts_toward_compliance: boolean;
    }>(sql`
      SELECT s.participant_id, ps.step_key, s.status, ps.counts_toward_compliance
        FROM research.participant_sessions s
        JOIN research.protocol_steps ps ON ps.id = s.protocol_step_id
       WHERE s.study_id = ${studyId}
    `);

    const grouped = new Map<string, ComplianceSession[]>();
    for (const row of rows.rows) {
      const list = grouped.get(row.participant_id) ?? [];
      list.push({
        stepKey: row.step_key,
        status: row.status as SessionStatus,
        countsTowardCompliance: row.counts_toward_compliance,
      });
      grouped.set(row.participant_id, list);
    }
    return grouped;
  }

  async overview(studyId: string): Promise<StudyOverviewResponse> {
    const participants = await this.db.execute<{
      id: string;
      status: string;
    }>(sql`
      SELECT id, status FROM research.participants WHERE study_id = ${studyId}
    `);

    const sessions = await this.sessionsByParticipant(studyId);

    const perParticipant = participants.rows.map((row) => ({
      withdrawn: row.status === "WITHDRAWN",
      elapsed: participantCompliance(sessions.get(row.id) ?? [], []).elapsed,
    }));

    const average = studyAverageCompliance(perParticipant);

    const counts = await this.db.execute<{ status: string; count: string }>(sql`
      SELECT s.status, count(*)::text AS count
        FROM research.participant_sessions s
       WHERE s.study_id = ${studyId}
       GROUP BY s.status
    `);
    const byStatus = new Map(counts.rows.map((row) => [row.status, Number(row.count)]));
    const of = (...statuses: string[]): number =>
      statuses.reduce((total, status) => total + (byStatus.get(status) ?? 0), 0);

    return {
      participants: {
        total: participants.rows.length,
        active: participants.rows.filter((r) => r.status === "ACTIVE").length,
        withdrawn: average.withdrawnCount,
        completed: participants.rows.filter((r) => r.status === "COMPLETED").length,
      },
      averageCompliancePercent: average.mean === null ? null : Math.round(average.mean * 1000) / 10,
      averageOverParticipants: average.participantCount,
      notYetApplicableParticipants: average.notYetApplicableCount,
      sessions: {
        completed: of("COMPLETED"),
        missed: of("EXPIRED_UNSTARTED", "EXPIRED_PARTIAL"),
        open: of("AVAILABLE", "STARTED"),
        notYetDue: of("PENDING_TRIGGER", "SCHEDULED"),
        cancelled: of("CANCELLED"),
      },
    };
  }

  /**
   * The daily breakdown for the last `days` days (§8, FR-28).
   *
   * Dates are computed in the STUDY's timezone, not the reader's and not UTC.
   * A researcher in Berlin monitoring an Istanbul cohort must see the
   * participants' days, otherwise every window near midnight lands on the wrong
   * row and the totals stop matching what anyone experienced.
   */
  async daily(studyId: string, days = 14): Promise<DailyComplianceResponse> {
    const bounded = Math.min(Math.max(Math.trunc(days), 1), 90);

    const study = await this.db.execute<{ timezone: string }>(sql`
      SELECT timezone FROM research.studies WHERE id = ${studyId}
    `);
    const timezone = study.rows[0]?.timezone;
    if (timezone === undefined) throw ApiErrors.studyNotFound();

    /**
     * One row per (session, day) where the session's window closed on that day,
     * plus every currently-open session against today.
     *
     * `hasResponses` distinguishes "opened it" from "opened it and typed
     * something", which is the difference between the two open categories.
     */
    const rows = await this.db.execute<{
      day: string;
      status: string;
      window_closed_on_date: boolean;
      has_responses: boolean;
    }>(sql`
      WITH bounds AS (
        SELECT (now() AT TIME ZONE ${timezone})::date AS today
      ),
      closed AS (
        SELECT (s.available_until AT TIME ZONE ${timezone})::date::text AS day,
               s.status,
               true AS window_closed_on_date,
               EXISTS (SELECT 1 FROM research.responses r WHERE r.session_id = s.id) AS has_responses
          FROM research.participant_sessions s, bounds b
         WHERE s.study_id = ${studyId}
           AND s.available_until IS NOT NULL
           -- A session that is still OPEN has not closed, whatever its
           -- available_until says: either the window ends later today, or the
           -- expiry sweeper has not reached it yet. Without this filter it
           -- appears in BOTH this CTE and the still_open one below and is
           -- counted twice -- exactly the apparent double-count that
           -- docs/compliance-formula.md section 8 says must not happen.
           AND s.status NOT IN ('AVAILABLE', 'STARTED')
           AND (s.available_until AT TIME ZONE ${timezone})::date
               BETWEEN b.today - ${bounded - 1}::int AND b.today
      ),
      still_open AS (
        SELECT b.today::text AS day,
               s.status,
               false AS window_closed_on_date,
               EXISTS (SELECT 1 FROM research.responses r WHERE r.session_id = s.id) AS has_responses
          FROM research.participant_sessions s, bounds b
         WHERE s.study_id = ${studyId} AND s.status IN ('AVAILABLE', 'STARTED')
      )
      SELECT * FROM closed UNION ALL SELECT * FROM still_open
    `);

    const byDay = new Map<
      string,
      { status: SessionStatus; windowClosedOnDate: boolean; hasResponses: boolean }[]
    >();
    for (const row of rows.rows) {
      const list = byDay.get(row.day) ?? [];
      list.push({
        status: row.status as SessionStatus,
        windowClosedOnDate: row.window_closed_on_date,
        hasResponses: row.has_responses,
      });
      byDay.set(row.day, list);
    }

    // Newest first: a researcher opening this page is asking about today and
    // yesterday, not about a fortnight ago.
    const ordered = [...byDay.keys()].sort().reverse();

    return {
      timezone,
      days: ordered.map((date) => ({
        date,
        ...summariseDay(byDay.get(date) ?? []),
      })),
    };
  }

  /**
   * The participant list, cursor-paginated.
   *
   * Keyset on `(enrolled_at, id)` rather than an offset. A dashboard paging
   * through participants while enrollment continues would otherwise show one
   * person twice and skip another, because an offset shifts under inserts.
   */
  async participants(
    studyId: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<ParticipantListResponse> {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 200);
    const cursor = decodeCursor(options.cursor);

    const rows = await this.db.execute<{
      id: string;
      public_code: string;
      status: string;
      enrolled_at: Date | string;
      group_key: string | null;
    }>(sql`
      SELECT p.id, p.public_code, p.status, p.enrolled_at, g.key AS group_key
        FROM research.participants p
        LEFT JOIN research.enrollments e ON e.participant_id = p.id
        LEFT JOIN research.study_groups g ON g.id = e.group_id
       WHERE p.study_id = ${studyId}
         ${
           cursor === null
             ? sql``
             : sql`AND (p.enrolled_at, p.id) > (${cursor.enrolledAt}::timestamptz, ${cursor.id}::uuid)`
         }
       ORDER BY p.enrolled_at, p.id
       LIMIT ${limit + 1}
    `);

    const page = rows.rows.slice(0, limit);
    const hasMore = rows.rows.length > limit;

    const steps = await this.steps(studyId);
    const sessions = await this.sessionsByParticipant(studyId);

    const participants: ParticipantRow[] = page.map((row) => {
      const compliance = participantCompliance(sessions.get(row.id) ?? [], steps);
      return {
        participantId: row.id,
        publicCode: row.public_code,
        status: row.status as ParticipantRow["status"],
        enrolledAt: iso(row.enrolled_at),
        groupKey: row.group_key,
        elapsed: figure(compliance.elapsed),
        strict: figure(compliance.strict),
        perStep: compliance.perStep.map(stepSummary),
      };
    });

    const last = page.at(-1);
    return {
      participants,
      nextCursor:
        hasMore && last !== undefined
          ? encodeCursor({ enrolledAt: iso(last.enrolled_at), id: last.id })
          : null,
    };
  }

  /**
   * One participant, with every session the protocol implies.
   *
   * The timeline includes sessions no state has been reached for and sessions
   * cancelled by a late enrollment. Omitting either would make a
   * thirty-occurrence block look shorter than it is, and would silently turn
   * "never offered" into "absent" — which a reader would fill in as "missed".
   */
  async participantDetail(
    studyId: string,
    participantId: string,
  ): Promise<ParticipantDetailResponse> {
    const found = await this.db.execute<{
      id: string;
      public_code: string;
      status: string;
      enrolled_at: Date | string;
      withdrawn_at: Date | string | null;
      timezone: string | null;
      locale: string;
      group_key: string | null;
    }>(sql`
      SELECT p.id, p.public_code, p.status, p.enrolled_at, p.withdrawn_at,
             p.timezone, p.locale, g.key AS group_key
        FROM research.participants p
        LEFT JOIN research.enrollments e ON e.participant_id = p.id
        LEFT JOIN research.study_groups g ON g.id = e.group_id
       WHERE p.id = ${participantId} AND p.study_id = ${studyId}
    `);
    const participant = found.rows[0];
    if (participant === undefined) throw ApiErrors.participantNotFound();

    const timelineRows = await this.db.execute<{
      id: string;
      step_key: string;
      step_index: number;
      occurrence_index: number;
      status: string;
      cancellation_reason: string | null;
      available_from: Date | string | null;
      available_until: Date | string | null;
      completed_at: Date | string | null;
      counts_toward_compliance: boolean;
      response_count: string;
    }>(sql`
      SELECT s.id, ps.step_key, ps.step_index, s.occurrence_index, s.status,
             s.cancellation_reason, s.available_from, s.available_until, s.completed_at,
             ps.counts_toward_compliance,
             (SELECT count(*) FROM research.responses r WHERE r.session_id = s.id)::text
               AS response_count
        FROM research.participant_sessions s
        JOIN research.protocol_steps ps ON ps.id = s.protocol_step_id
       WHERE s.participant_id = ${participantId}
       ORDER BY ps.step_index, s.occurrence_index
    `);

    const timeline: TimelineEntry[] = timelineRows.rows.map((row) => ({
      sessionId: row.id,
      stepKey: row.step_key,
      stepIndex: row.step_index,
      occurrenceIndex: row.occurrence_index,
      status: row.status as SessionStatus,
      cancellationReason: row.cancellation_reason,
      availableFrom: isoOrNull(row.available_from),
      availableUntil: isoOrNull(row.available_until),
      completedAt: isoOrNull(row.completed_at),
      countsTowardCompliance: row.counts_toward_compliance,
      responseCount: Number(row.response_count),
    }));

    const steps = await this.steps(studyId);
    const compliance = participantCompliance(
      timelineRows.rows.map((row) => ({
        stepKey: row.step_key,
        status: row.status as SessionStatus,
        countsTowardCompliance: row.counts_toward_compliance,
      })),
      steps,
    );

    return {
      participantId: participant.id,
      publicCode: participant.public_code,
      status: participant.status as ParticipantDetailResponse["status"],
      enrolledAt: iso(participant.enrolled_at),
      withdrawnAt: isoOrNull(participant.withdrawn_at),
      groupKey: participant.group_key,
      timezone: participant.timezone,
      locale: participant.locale,
      elapsed: figure(compliance.elapsed),
      strict: figure(compliance.strict),
      perStep: compliance.perStep.map(stepSummary),
      timeline,
    };
  }
}

/**
 * An ISO instant from whatever the driver handed back.
 *
 * Drizzle's `execute()` returns raw driver rows, and a `timestamptz` arrives as
 * a string on that path rather than the `Date` the query-builder API produces.
 * Calling `.toISOString()` on it throws — which is how this helper came to
 * exist, from a 500 on every participant row.
 *
 * Accepting both is deliberate rather than defensive: the alternative is
 * formatting every timestamp in SQL, which spreads the same decision across a
 * dozen queries where one of them will eventually be written differently.
 */
function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  throw new TypeError(`expected a timestamp, got ${typeof value}`);
}

function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

/**
 * A domain ratio, shaped for the wire.
 *
 * The denominator travels with the percentage because PLAN.md Phase 10 requires
 * it displayed rather than hidden, and `percent` is null rather than 0 for the
 * not-applicable case, so a client is forced to decide what to render.
 */
function figure(value: ComplianceRatio): ComplianceFigure {
  return {
    numerator: value.numerator,
    denominator: value.denominator,
    percent: compliancePercent(value),
  };
}

function stepSummary(step: StepCompliance): StepComplianceSummary {
  return {
    stepKey: step.stepKey,
    occurrenceCount: step.occurrenceCount,
    kind: step.kind,
    compliance: figure(step.compliance),
    state: step.state,
    countsTowardCompliance: step.countsTowardCompliance,
  };
}

/**
 * Opaque cursors.
 *
 * Base64 of the keyset, so a client cannot construct one that reorders the page
 * or reaches into another study — and so the shape can change without breaking
 * a client that stored one.
 */
function encodeCursor(value: { enrolledAt: string; id: string }): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): { enrolledAt: string; id: string } | null {
  if (cursor === undefined || cursor === "") return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { enrolledAt?: unknown }).enrolledAt === "string" &&
      typeof (parsed as { id?: unknown }).id === "string"
    ) {
      return parsed as { enrolledAt: string; id: string };
    }
  } catch {
    // A malformed cursor is a client bug, not an attack surface. Starting from
    // the beginning is the safe reading — the alternative, a 400, would break a
    // dashboard on a stale bookmark.
  }
  return null;
}
