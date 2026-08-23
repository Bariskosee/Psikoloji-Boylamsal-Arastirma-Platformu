"use client";

import { use, useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { BarChart3, Download } from "lucide-react";
import { Link } from "@/i18n/navigation";
import type { DistributionsResponse, OptionDistribution } from "@lpr/contracts";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollAreaX } from "@/components/ui/scroll-area-x";
import { PageHeader } from "@/components/ui/page-header";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState, ErrorState, LoadingCards } from "@/components/ui/states";

/**
 * Descriptive analytics (PLAN.md Phase 11).
 *
 * ── Why the bars are hand-drawn ─────────────────────────────────────────────
 * No charting library. These are ordinary bar charts over a handful of
 * categories, and a library would add a dependency, a bundle, and a licence to
 * the participant-adjacent side of a privacy-sensitive platform to draw
 * rectangles. When a real research need calls for something a rectangle cannot
 * express, that is the moment to reconsider.
 *
 * They are now drawn with the shared chart tokens rather than hard-coded hex,
 * so the ramp is the colour-blind-safe one defined once in `@lpr/ui` — red and
 * green as the two ends of a compliance scale is unreadable for roughly one man
 * in twelve, and research output still gets printed in greyscale.
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

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      setData(
        await api.get<DistributionsResponse>(`/api/studies/${studyId}/analytics/distributions`),
      );
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, [studyId]);

  useEffect(() => {
    void load();
  }, [load]);

  const peak = Math.max(1, ...(data?.completionOverTime.map((point) => point.completed) ?? [1]));

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title={t("analyticsTitle")}
        description={t("analyticsSubtitle")}
        actions={
          <Button asChild variant="outline">
            <Link href={`/studies/${studyId}/export`}>
              <Download />
              {t("exportTitle")}
            </Link>
          </Button>
        }
      />

      {status === "loading" ? <LoadingCards count={3} /> : null}
      {status === "error" ? (
        <ErrorState title={t("loadFailed")} onRetry={() => void load()} retryLabel={t("retry")} />
      ) : null}

      {status === "ready" && data ? (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>{t("completionOverTime")}</CardTitle>
            </CardHeader>
            <CardContent>
              {data.completionOverTime.length === 0 ? (
                <EmptyState icon={BarChart3} title={t("noDistributions")} className="py-8" />
              ) : (
                /*
                  Left-aligned with a per-bar width cap.

                  Bars stretched to fill the card, so a study with one day of
                  data drew a single teal slab a thousand pixels wide — which
                  reads as a rendering fault rather than as one data point. A
                  cap keeps a sparse chart looking like a chart and lets a
                  dense one still use the full width.
                */
                <div className="flex h-36 items-end justify-start gap-1.5">
                  {data.completionOverTime.map((point) => (
                    <div
                      key={point.date}
                      /*
                        `h-full` is load-bearing. The bar's height is a
                        percentage, and a percentage resolves against the
                        PARENT's height — which was auto, so every bar
                        collapsed to nothing and the chart rendered as a row of
                        floating numbers.
                      */
                      className="flex h-full max-w-14 min-w-2 flex-1 flex-col items-center justify-end gap-1"
                      /*
                        The date and the value are both in the title, because a
                        bar 6px wide cannot carry a readable label and a chart
                        whose x-axis is unreadable is decoration.
                      */
                      title={`${point.date}: ${String(point.completed)}`}
                    >
                      <span className="text-muted-foreground text-[10px] tabular-nums">
                        {point.completed}
                      </span>
                      <div
                        // A bar for a real value is never invisible: a study
                        // with one completion on a day and none on the next
                        // must show the difference, not two empty columns.
                        className="bg-chart-1 w-full rounded-sm"
                        style={{
                          height: `${String((point.completed / peak) * 100)}%`,
                          minHeight: point.completed > 0 ? 3 : 0,
                        }}
                      />
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("distributions")}</CardTitle>
            </CardHeader>
            <CardContent>
              {data.options.length === 0 ? (
                <EmptyState
                  icon={BarChart3}
                  title={t("noDistributions")}
                  description={t("noDistributionsHint")}
                />
              ) : (
                <div className="space-y-8">
                  {data.options.map((distribution) => (
                    <OptionChart
                      key={`${distribution.stepKey}:${distribution.questionKey}`}
                      distribution={distribution}
                    />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle>{t("numericSummary")}</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              {data.numerics.length === 0 ? (
                <div className="px-6">
                  <EmptyState icon={BarChart3} title={t("noNumeric")} className="py-8" />
                </div>
              ) : (
                <ScrollAreaX label={t("numericSummary")}>
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>{t("question")}</TableHead>
                        <TableHead className="text-right">{t("min")}</TableHead>
                        <TableHead className="text-right">{t("max")}</TableHead>
                        <TableHead className="text-right">{t("mean")}</TableHead>
                        <TableHead className="text-right">{t("median")}</TableHead>
                        <TableHead />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.numerics.map((numeric) => (
                        <TableRow key={`${numeric.stepKey}:${numeric.questionKey}`}>
                          <TableCell>
                            <span className="font-medium">{numeric.stepKey}</span>{" "}
                            <span className="text-muted-foreground font-mono text-xs">
                              {numeric.questionKey}
                            </span>
                          </TableCell>
                          {/*
                            An em-dash where there is nothing, never 0. A mean
                            of zero over no data is a claim; an absence is not.
                          */}
                          <TableCell className="text-right tabular-nums">
                            {numeric.min ?? "—"}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {numeric.max ?? "—"}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {numeric.mean ?? "—"}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {numeric.median ?? "—"}
                          </TableCell>
                          <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                            {t("answeredOf", {
                              answered: numeric.answered,
                              missing: numeric.missing,
                            })}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </ScrollAreaX>
              )}
            </CardContent>
          </Card>
        </div>
      ) : null}
    </div>
  );
}

function OptionChart({ distribution }: { distribution: OptionDistribution }) {
  const t = useTranslations("analytics");
  const peak = Math.max(1, ...distribution.categories.map((c) => c.count));

  return (
    <div>
      <p className="font-medium">{distribution.questionText || distribution.questionKey}</p>
      {/* The denominator, always visible beside the bars. */}
      <p className="text-muted-foreground mb-3 text-xs">
        {distribution.stepKey} ·{" "}
        {t("answeredOf", { answered: distribution.answered, missing: distribution.missing })}
      </p>

      <div className="space-y-1.5">
        {distribution.categories.map((category) => (
          <div key={category.optionKey} className="flex items-center gap-3">
            <span className="w-40 shrink-0 truncate text-sm" title={category.label}>
              {category.label}
            </span>
            <div className="bg-muted h-4 min-w-0 flex-1 overflow-hidden rounded-sm">
              <div
                className="bg-chart-2 h-full rounded-sm"
                style={{ width: `${String((category.count / peak) * 100)}%` }}
              />
            </div>
            <span className="text-muted-foreground w-24 shrink-0 text-right text-xs tabular-nums">
              {category.count}
              {/* Null, not 0%, when nothing was answered — the same rule the
                  compliance figures follow. */}
              {category.percent === null ? "" : ` (${String(category.percent)}%)`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
