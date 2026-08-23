"use client";

import { use, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import type { DistributionsResponse, OptionDistribution } from "@lpr/contracts";
import { api } from "@/lib/api";
import { ErrorBanner, styles } from "@/lib/ui";

/**
 * Descriptive analytics (PLAN.md Phase 11).
 *
 * ── Why the bars are hand-drawn SVG ─────────────────────────────────────────
 * No charting library. These are ordinary bar charts over a handful of
 * categories, and a library would add a dependency, a bundle, and a licence to
 * the participant-adjacent side of a privacy-sensitive platform to draw
 * rectangles. When Phase 12 or a real research need calls for something a
 * rectangle cannot express, that is the moment to reconsider.
 *
 * ── Why every chart states its denominator ──────────────────────────────────
 * A bar chart that silently omits non-responses shows a cleaner study than the
 * one that was run. Percentages here are over ANSWERED cells, and the count
 * that were not answered sits beside them — a reader can always see what the
 * bars are a proportion of.
 */
export default function AnalyticsPage({ params }: { params: Promise<{ studyId: string }> }) {
  const { studyId } = use(params);
  const t = useTranslations("analytics");

  const [data, setData] = useState<DistributionsResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    void (async () => {
      try {
        setData(
          await api.get<DistributionsResponse>(`/api/studies/${studyId}/analytics/distributions`),
        );
        setStatus("ready");
      } catch {
        setStatus("error");
      }
    })();
  }, [studyId]);

  if (status === "loading") return <p style={styles.page}>…</p>;
  if (status === "error" || data === null) {
    return (
      <div style={styles.page}>
        <ErrorBanner>{t("loadFailed")}</ErrorBanner>
      </div>
    );
  }

  const peak = Math.max(1, ...data.completionOverTime.map((point) => point.completed));

  return (
    <div style={styles.page}>
      <h1>{t("analyticsTitle")}</h1>

      <section style={styles.card}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>{t("completionOverTime")}</h2>
        {data.completionOverTime.length === 0 ? (
          <p style={{ color: "#5b6472" }}>{t("noDistributions")}</p>
        ) : (
          <div style={{ display: "flex", gap: 4, alignItems: "flex-end", height: 140 }}>
            {data.completionOverTime.map((point) => (
              <div key={point.date} style={{ flex: 1, textAlign: "center" }} title={point.date}>
                <div
                  style={{
                    height: `${String((point.completed / peak) * 110)}px`,
                    background: "#1f2a37",
                    borderRadius: 2,
                  }}
                />
                <span style={{ fontSize: 10, color: "#5b6472" }}>{point.completed}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section style={styles.card}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>{t("distributions")}</h2>
        {data.options.length === 0 ? (
          <p style={{ color: "#5b6472" }}>{t("noDistributions")}</p>
        ) : (
          data.options.map((distribution) => (
            <OptionChart
              key={`${distribution.stepKey}:${distribution.questionKey}`}
              distribution={distribution}
            />
          ))
        )}
      </section>

      <section style={styles.card}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>{t("numericSummary")}</h2>
        {data.numerics.length === 0 ? (
          <p style={{ color: "#5b6472" }}>{t("noNumeric")}</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.cell}>{t("question")}</th>
                  <th style={styles.cell}>{t("min")}</th>
                  <th style={styles.cell}>{t("max")}</th>
                  <th style={styles.cell}>{t("mean")}</th>
                  <th style={styles.cell}>{t("median")}</th>
                  <th style={styles.cell} />
                </tr>
              </thead>
              <tbody>
                {data.numerics.map((numeric) => (
                  <tr key={`${numeric.stepKey}:${numeric.questionKey}`}>
                    <td style={styles.cell}>
                      {numeric.stepKey} · {numeric.questionKey}
                    </td>
                    {/*
                      An em-dash where there is nothing, never 0. A mean of zero
                      over no data is a claim; an absence is not.
                    */}
                    <td style={styles.cell}>{numeric.min ?? "—"}</td>
                    <td style={styles.cell}>{numeric.max ?? "—"}</td>
                    <td style={styles.cell}>{numeric.mean ?? "—"}</td>
                    <td style={styles.cell}>{numeric.median ?? "—"}</td>
                    <td style={{ ...styles.cell, fontSize: 12, color: "#5b6472" }}>
                      {t("answeredOf", {
                        answered: numeric.answered,
                        missing: numeric.missing,
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Link href={`/studies/${studyId}/export`} style={styles.secondaryButton}>
        {t("exportTitle")}
      </Link>
    </div>
  );
}

function OptionChart({ distribution }: { distribution: OptionDistribution }) {
  const t = useTranslations("analytics");
  const peak = Math.max(1, ...distribution.categories.map((c) => c.count));

  return (
    <div style={{ marginBottom: 20 }}>
      <p style={{ margin: "0 0 2px", fontWeight: 600 }}>
        {distribution.questionText || distribution.questionKey}
      </p>
      {/* The denominator, always visible beside the bars. */}
      <p style={{ margin: "0 0 8px", fontSize: 12, color: "#5b6472" }}>
        {distribution.stepKey} ·{" "}
        {t("answeredOf", { answered: distribution.answered, missing: distribution.missing })}
      </p>

      {distribution.categories.map((category) => (
        <div
          key={category.optionKey}
          style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}
        >
          <span style={{ width: 160, fontSize: 13 }}>{category.label}</span>
          <div
            style={{
              width: `${String((category.count / peak) * 60)}%`,
              minWidth: category.count > 0 ? 2 : 0,
              height: 14,
              background: "#175cd3",
              borderRadius: 2,
            }}
          />
          <span style={{ fontSize: 12, color: "#5b6472" }}>
            {category.count}
            {/* Null, not 0%, when nothing was answered — the same rule the
                compliance figures follow. */}
            {category.percent === null ? "" : ` (${String(category.percent)}%)`}
          </span>
        </div>
      ))}
    </div>
  );
}
