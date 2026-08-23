"use client";

import { use, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import type { ParticipantDetailResponse, TimelineEntry } from "@lpr/contracts";
import { api } from "@/lib/api";
import { ComplianceFigureView, StepFigureView } from "@/components/analytics/ComplianceFigure";
import { ErrorBanner, styles } from "@/lib/ui";

/**
 * One participant's timeline (PLAN.md Phase 10).
 *
 * ── Why every session is listed, including the ones with no state ───────────
 * A thirty-occurrence block shows thirty rows even when twenty-eight of them
 * are still scheduled. Omitting them would make the block look shorter than it
 * is, and a researcher counting rows would reach the wrong conclusion about how
 * much of the protocol remains.
 *
 * ── Why cancelled reads as "not applicable" ─────────────────────────────────
 * The commonest cancellation is a late enrollment into a fixed-date block: the
 * occurrence closed before the participant joined, and it was never offered to
 * them. Rendering it as missed — or omitting it, which a reader fills in as
 * missed — would blame someone for a measurement nobody showed them.
 */
export default function ParticipantDetailPage({
  params,
}: {
  params: Promise<{ studyId: string; participantId: string }>;
}) {
  const { studyId, participantId } = use(params);
  const t = useTranslations("analytics");

  const [detail, setDetail] = useState<ParticipantDetailResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    void (async () => {
      try {
        setDetail(
          await api.get<ParticipantDetailResponse>(
            `/api/studies/${studyId}/participants/${participantId}`,
          ),
        );
        setStatus("ready");
      } catch {
        setStatus("error");
      }
    })();
  }, [studyId, participantId]);

  if (status === "loading") return <p style={styles.page}>…</p>;
  if (status === "error" || detail === null) {
    return (
      <div style={styles.page}>
        <ErrorBanner>{t("loadFailed")}</ErrorBanner>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <h1 style={{ fontFamily: "ui-monospace, monospace" }}>{detail.publicCode}</h1>
      <p style={{ color: "#5b6472" }}>
        {detail.status} · {t("enrolled")} {new Date(detail.enrolledAt).toLocaleDateString()}
        {detail.groupKey === null ? "" : ` · ${t("group")} ${detail.groupKey}`}
      </p>

      <section style={styles.card}>
        <p style={{ marginTop: 0 }}>
          {t("elapsed")}: <ComplianceFigureView figure={detail.elapsed} />
        </p>
        {/*
          Labelled "strict" wherever it appears, as §4 requires. Mid-study it
          reads as damningly low for someone doing everything asked of them,
          which is why it is never the headline figure.
        */}
        <p title={t("strictHint")} style={{ color: "#5b6472", marginBottom: 0 }}>
          {t("strict")}: <ComplianceFigureView figure={detail.strict} />
        </p>
      </section>

      <section style={styles.card}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>{t("step")}</h2>
        {detail.perStep.map((step) => (
          <p
            key={step.stepKey}
            style={{ display: "flex", justifyContent: "space-between", margin: "6px 0" }}
          >
            <span>
              {step.stepKey}
              {step.occurrenceCount > 1 ? (
                <span style={{ color: "#5b6472" }}> ×{step.occurrenceCount}</span>
              ) : null}
            </span>
            <StepFigureView step={step} />
          </p>
        ))}
      </section>

      <section style={styles.card}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>{t("timeline")}</h2>
        <div style={{ overflowX: "auto" }}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.cell}>{t("step")}</th>
                <th style={styles.cell}>{t("occurrence")}</th>
                <th style={styles.cell}>{t("status")}</th>
                <th style={styles.cell}>{t("window")}</th>
                <th style={styles.cell}>{t("responses")}</th>
                <th style={styles.cell} />
              </tr>
            </thead>
            <tbody>
              {detail.timeline.map((entry) => (
                <TimelineRow key={entry.sessionId} entry={entry} studyId={studyId} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <Link href={`/studies/${studyId}/participants`} style={styles.secondaryButton}>
        {t("backToParticipants")}
      </Link>
    </div>
  );
}

function TimelineRow({ entry, studyId }: { entry: TimelineEntry; studyId: string }) {
  const t = useTranslations("analytics");

  /**
   * `CANCELLED` reads as "not applicable" and is greyed, not reddened.
   *
   * Colour carries meaning on a table this dense, and red would tell a reader
   * at a glance that the participant failed something. They did not: it was
   * never offered.
   */
  const colour =
    entry.status === "COMPLETED"
      ? "#067647"
      : entry.status.startsWith("EXPIRED")
        ? "#b42318"
        : "#5b6472";

  const label =
    entry.status === "CANCELLED"
      ? t("stateEXCLUDED")
      : entry.status.startsWith("EXPIRED")
        ? t("stateMISSED")
        : entry.status;

  return (
    <tr style={{ opacity: entry.countsTowardCompliance ? 1 : 0.6 }}>
      <td style={styles.cell}>{entry.stepKey}</td>
      <td style={styles.cell}>{entry.occurrenceIndex}</td>
      <td style={{ ...styles.cell, color: colour }}>
        {label}
        {entry.cancellationReason === null ? null : (
          <span style={{ color: "#5b6472", fontSize: 12 }}> ({entry.cancellationReason})</span>
        )}
      </td>
      <td style={{ ...styles.cell, fontSize: 12, color: "#5b6472" }}>
        {entry.availableFrom === null
          ? "—"
          : new Date(entry.availableFrom).toLocaleString(undefined, {
              dateStyle: "short",
              timeStyle: "short",
            })}
      </td>
      <td style={styles.cell}>{entry.responseCount}</td>
      <td style={styles.cell}>
        {/*
          Inspection is offered only where there is something to inspect. A link
          on a scheduled session would lead to a page of seven "not yet due"
          rows, which teaches a reader the link is broken.
        */}
        {entry.responseCount > 0 || entry.status === "COMPLETED" ? (
          <Link href={`/studies/${studyId}/sessions/${entry.sessionId}`}>{t("inspect")}</Link>
        ) : null}
      </td>
    </tr>
  );
}
