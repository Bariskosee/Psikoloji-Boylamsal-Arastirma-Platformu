"use client";

import { use, useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import type { ParticipantListResponse, ParticipantRow } from "@lpr/contracts";
import { api } from "@/lib/api";
import { ComplianceFigureView, StepFigureView } from "@/components/analytics/ComplianceFigure";
import { ErrorBanner, styles } from "@/lib/ui";

/**
 * The participant list (PLAN.md Phase 10, FR-44).
 *
 * Per-step columns sit beside the overall figure, because one number hides the
 * one that matters. `docs/compliance-formula.md` §6 gives the case: two
 * participants both at 50% overall, one of whom completed the baseline and the
 * endline and is usable for the primary analysis, and one of whom did not. A
 * table showing only "50%" cannot tell a researcher which is which.
 *
 * Cursor pagination, not pages. Enrollment continues while a researcher reads,
 * and an offset would show one person twice and skip another.
 */
export default function ParticipantsPage({ params }: { params: Promise<{ studyId: string }> }) {
  const { studyId } = use(params);
  const t = useTranslations("analytics");

  const [rows, setRows] = useState<ParticipantRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  const load = useCallback(
    async (from: string | null) => {
      try {
        const query = from === null ? "" : `?cursor=${encodeURIComponent(from)}`;
        const page = await api.get<ParticipantListResponse>(
          `/api/studies/${studyId}/participants${query}`,
        );
        setRows((existing) => [...existing, ...page.participants]);
        setCursor(page.nextCursor);
        setStatus("ready");
      } catch {
        setStatus("error");
      }
    },
    [studyId],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  if (status === "loading") return <p style={styles.page}>…</p>;
  if (status === "error") {
    return (
      <div style={styles.page}>
        <ErrorBanner>{t("loadFailed")}</ErrorBanner>
      </div>
    );
  }

  // The step columns come from the data rather than from a constant: a protocol
  // is researcher-defined, and hard-coding "baseline / daily / endline" would
  // bake the reference design into the platform (AGENT.md §3.4).
  const stepKeys = rows[0]?.perStep.map((step) => step.stepKey) ?? [];

  return (
    <div style={styles.page}>
      <h1>{t("participants")}</h1>

      {rows.length === 0 ? (
        <p>{t("noParticipants")}</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.cell}>{t("publicCode")}</th>
                <th style={styles.cell}>{t("status")}</th>
                <th style={styles.cell}>{t("elapsed")}</th>
                {stepKeys.map((key) => (
                  <th key={key} style={styles.cell}>
                    {key}
                  </th>
                ))}
                <th style={styles.cell}>{t("group")}</th>
                <th style={styles.cell} />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.participantId}>
                  <td style={{ ...styles.cell, fontFamily: "ui-monospace, monospace" }}>
                    {row.publicCode}
                  </td>
                  <td style={styles.cell}>{row.status}</td>
                  <td style={styles.cell}>
                    <ComplianceFigureView figure={row.elapsed} />
                  </td>
                  {row.perStep.map((step) => (
                    <td key={step.stepKey} style={styles.cell}>
                      <StepFigureView step={step} />
                    </td>
                  ))}
                  <td style={styles.cell}>{row.groupKey ?? "—"}</td>
                  <td style={styles.cell}>
                    <Link href={`/studies/${studyId}/participants/${row.participantId}`}>
                      {t("openParticipant")}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {cursor !== null ? (
        <button type="button" onClick={() => void load(cursor)} style={styles.secondaryButton}>
          {t("loadMore")}
        </button>
      ) : null}

      <Link href={`/studies/${studyId}/monitoring`} style={styles.secondaryButton}>
        {t("overview")}
      </Link>
    </div>
  );
}
