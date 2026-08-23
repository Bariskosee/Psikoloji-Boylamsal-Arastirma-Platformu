"use client";

import { use, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { tokens } from "@lpr/ui";
import type { DailyComplianceResponse, StudyOverviewResponse } from "@lpr/contracts";
import { api } from "@/lib/api";
import { ErrorBanner, styles } from "@/lib/ui";

/**
 * The study overview and daily breakdown (PLAN.md Phase 10, FR-27, FR-28).
 *
 * Two things this page refuses to do:
 *
 * **It never shows an average without the count behind it.**
 * `docs/compliance-formula.md` §7 requires it, because "68%" over three people
 * and over three hundred are different claims and only one belongs in a methods
 * section.
 *
 * **It never presents the daily categories as four independent numbers.** §8 is
 * explicit that they overlap by construction, so they are rendered as two
 * groups whose parts sum to their own totals — a reader adding them up gets the
 * number of sessions, not more.
 */
export default function MonitoringPage({ params }: { params: Promise<{ studyId: string }> }) {
  const { studyId } = use(params);
  const t = useTranslations("analytics");

  const [overview, setOverview] = useState<StudyOverviewResponse | null>(null);
  const [daily, setDaily] = useState<DailyComplianceResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    void (async () => {
      try {
        const [o, d] = await Promise.all([
          api.get<StudyOverviewResponse>(`/api/studies/${studyId}/analytics/overview`),
          api.get<DailyComplianceResponse>(`/api/studies/${studyId}/analytics/daily`),
        ]);
        setOverview(o);
        setDaily(d);
        setStatus("ready");
      } catch {
        // An explicit error state rather than one inferred from `null`, which
        // renders a permanent spinner beside the error banner.
        setStatus("error");
      }
    })();
  }, [studyId]);

  if (status === "loading") return <p style={styles.page}>…</p>;
  if (status === "error" || overview === null || daily === null) {
    return (
      <div style={styles.page}>
        <ErrorBanner>{t("loadFailed")}</ErrorBanner>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <h1>{t("title")}</h1>

      <section style={styles.card}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>{t("averageCompliance")}</h2>
        <p style={{ fontSize: 32, margin: 0 }}>
          {overview.averageCompliancePercent === null
            ? t("notApplicable")
            : `${String(overview.averageCompliancePercent)}%`}
        </p>
        {/*
          §7: the participant count behind any average must be displayed, and
          the people excluded from it must be accounted for — otherwise a study
          with forty participants showing "mean over 12" is unexplainable.
        */}
        <p style={{ color: "#5b6472", margin: `${String(tokens.spacing.sm)}px 0 0` }}>
          {t("averageOver", { count: overview.averageOverParticipants })} ·{" "}
          {t("averageExcluded", {
            count: overview.notYetApplicableParticipants,
            withdrawn: overview.participants.withdrawn,
          })}
        </p>
      </section>

      <section style={styles.card}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>{t("totalParticipants")}</h2>
        <Row label={t("active")} value={overview.participants.active} />
        <Row label={t("completedParticipants")} value={overview.participants.completed} />
        <Row label={t("withdrawn")} value={overview.participants.withdrawn} />
      </section>

      <section style={styles.card}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>{t("sessionsHeading")}</h2>
        <Row label={t("sessionsCompleted")} value={overview.sessions.completed} />
        <Row label={t("sessionsMissed")} value={overview.sessions.missed} />
        <Row label={t("sessionsOpen")} value={overview.sessions.open} />
        <Row label={t("sessionsNotYetDue")} value={overview.sessions.notYetDue} />
        {/* Cancelled reads as "not applicable", never as missed: those
            measurements were never offered (§5). */}
        <Row label={t("sessionsCancelled")} value={overview.sessions.cancelled} />
      </section>

      <section style={styles.card}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>{t("daily")}</h2>
        <p style={{ color: "#5b6472", fontSize: 13 }}>
          {t("timezoneNote", { timezone: daily.timezone })}
        </p>

        {daily.days.length === 0 ? (
          <p>{t("noDays")}</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.cell}>{t("daily")}</th>
                  <th style={styles.cell}>{t("dayClosed")}</th>
                  <th style={styles.cell}>{t("dayCompleted")}</th>
                  <th style={styles.cell}>{t("dayMissedUnstarted")}</th>
                  <th style={styles.cell}>{t("dayMissedPartial")}</th>
                  <th style={styles.cell}>{t("dayOpen")}</th>
                  <th style={styles.cell}>{t("dayNotStarted")}</th>
                  <th style={styles.cell}>{t("dayInProgress")}</th>
                </tr>
              </thead>
              <tbody>
                {daily.days.map((day) => (
                  <tr key={day.date}>
                    <td style={styles.cell}>{day.date}</td>
                    {/* The group totals sit beside their parts, so the sum is
                        checkable on the page rather than taken on trust. */}
                    <td style={{ ...styles.cell, fontWeight: 600 }}>{day.closed}</td>
                    <td style={styles.cell}>{day.completed}</td>
                    <td style={styles.cell}>{day.missedUnstarted}</td>
                    <td style={styles.cell}>{day.missedPartial}</td>
                    <td style={{ ...styles.cell, fontWeight: 600 }}>{day.open}</td>
                    <td style={styles.cell}>{day.notStarted}</td>
                    <td style={styles.cell}>{day.inProgress}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Link href={`/studies/${studyId}/participants`} style={styles.secondaryButton}>
        {t("participants")}
      </Link>
    </div>
  );
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <p style={{ display: "flex", justifyContent: "space-between", margin: "4px 0" }}>
      <span style={{ color: "#5b6472" }}>{label}</span>
      <strong>{value}</strong>
    </p>
  );
}
