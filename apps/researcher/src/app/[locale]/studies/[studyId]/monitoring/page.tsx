"use client";

import { use, useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { CalendarClock } from "lucide-react";
import type { DailyComplianceResponse, StudyOverviewResponse } from "@lpr/contracts";
import { api } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollAreaX } from "@/components/ui/scroll-area-x";
import { PageHeader, StatCard } from "@/components/ui/page-header";
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
 * The study overview and daily breakdown (PLAN.md Phase 10, FR-27, FR-28).
 *
 * Two things this page refuses to do, and the redesign keeps both:
 *
 * **It never shows an average without the count behind it.**
 * `docs/compliance-formula.md` §7 requires it, because "68%" over three people
 * and over three hundred are different claims and only one belongs in a
 * methods section.
 *
 * **It never presents the daily categories as four independent numbers.** §8
 * is explicit that they overlap by construction. The table now says so
 * structurally: two grouped column headers, each spanning its own parts, with
 * the group total first. A reader adding a group up gets the group's sessions,
 * and cannot accidentally add across the two.
 */
export default function MonitoringPage({ params }: { params: Promise<{ studyId: string }> }) {
  const { studyId } = use(params);
  const t = useTranslations("analytics");

  const [overview, setOverview] = useState<StudyOverviewResponse | null>(null);
  const [daily, setDaily] = useState<DailyComplianceResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  const load = useCallback(async () => {
    setStatus("loading");
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
  }, [studyId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title={t("title")} description={t("monitoringSubtitle")} />

      {status === "loading" ? <LoadingCards count={4} /> : null}
      {status === "error" ? (
        <ErrorState title={t("loadFailed")} onRetry={() => void load()} retryLabel={t("retry")} />
      ) : null}

      {status === "ready" && overview && daily ? (
        <div className="space-y-8">
          <section aria-labelledby="headline">
            <h2 id="headline" className="sr-only">
              {t("averageCompliance")}
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard
                label={t("averageCompliance")}
                value={
                  overview.averageCompliancePercent === null
                    ? t("notApplicable")
                    : `${String(overview.averageCompliancePercent)}%`
                }
                /*
                  §7: the count behind the average, and the people excluded
                  from it, travel WITH the number rather than in a footnote —
                  a study of forty showing "mean over 12" is otherwise
                  unexplainable.
                */
                hint={`${t("averageOver", { count: overview.averageOverParticipants })} · ${t(
                  "averageExcluded",
                  {
                    count: overview.notYetApplicableParticipants,
                    withdrawn: overview.participants.withdrawn,
                  },
                )}`}
              />
              <StatCard
                label={t("totalParticipants")}
                value={overview.participants.total}
                hint={`${String(overview.participants.active)} ${t("active").toLowerCase()} · ${String(
                  overview.participants.withdrawn,
                )} ${t("withdrawn").toLowerCase()}`}
              />
              <StatCard
                label={t("sessionsCompleted")}
                value={overview.sessions.completed}
                tone={overview.sessions.completed > 0 ? "success" : "default"}
              />
              <StatCard
                label={t("sessionsMissed")}
                value={overview.sessions.missed}
                /*
                  Amber only when there is something to be amber about. Zero
                  missed sessions is the best number on this page, and painting
                  it as a warning taught the opposite of what it means.

                  Amber rather than red when it IS non-zero: a missed session
                  is ordinary in longitudinal research and is data, and red
                  would train a researcher to read normal attrition as a fault.
                */
                tone={overview.sessions.missed > 0 ? "warning" : "default"}
              />
            </div>
          </section>

          <section aria-labelledby="sessions">
            <Card>
              <CardHeader>
                <CardTitle id="sessions">{t("sessionsHeading")}</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
                  <Figure label={t("sessionsCompleted")} value={overview.sessions.completed} />
                  <Figure label={t("sessionsMissed")} value={overview.sessions.missed} />
                  <Figure label={t("sessionsOpen")} value={overview.sessions.open} />
                  <Figure label={t("sessionsNotYetDue")} value={overview.sessions.notYetDue} />
                  {/* Cancelled reads as "not applicable", never as missed:
                      those measurements were never offered (§5). */}
                  <Figure label={t("sessionsCancelled")} value={overview.sessions.cancelled} />
                </dl>
              </CardContent>
            </Card>
          </section>

          <section aria-labelledby="daily">
            <Card>
              <CardHeader>
                <CardTitle id="daily">{t("daily")}</CardTitle>
                <CardDescription>{t("timezoneNote", { timezone: daily.timezone })}</CardDescription>
              </CardHeader>
              <CardContent>
                {daily.days.length === 0 ? (
                  <EmptyState icon={CalendarClock} title={t("noDays")} />
                ) : (
                  <ScrollAreaX label={t("daily")}>
                    <Table>
                      <TableHeader>
                        {/*
                          Two grouped headers, because §8's categories overlap
                          by construction. Rendered flat, a reader sums seven
                          columns and gets more sessions than exist.
                        */}
                        <TableRow className="hover:bg-transparent">
                          <TableHead />
                          <TableHead colSpan={3} className="border-l text-center">
                            {t("dailyGroupClosed")}
                          </TableHead>
                          <TableHead colSpan={3} className="border-l text-center">
                            {t("dailyGroupOpen")}
                          </TableHead>
                        </TableRow>
                        {/*
                          Headers wrap. shadcn keeps them on one line, and
                          seven Turkish column names on one line ran the table
                          past 1280px — so the rightmost column was sliced
                          mid-word on an ordinary laptop. Wrapping costs one
                          row of height and makes the whole table fit.
                        */}
                        <TableRow className="hover:bg-transparent [&>th]:whitespace-normal">
                          <TableHead>{t("date")}</TableHead>
                          <TableHead className="border-l text-right">{t("dayClosed")}</TableHead>
                          <TableHead className="text-right">{t("dayCompleted")}</TableHead>
                          <TableHead className="text-right">
                            {t("dayMissedUnstarted")} / {t("dayMissedPartial")}
                          </TableHead>
                          <TableHead className="border-l text-right">{t("dayOpen")}</TableHead>
                          <TableHead className="text-right">{t("dayNotStarted")}</TableHead>
                          <TableHead className="text-right">{t("dayInProgress")}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {daily.days.map((day) => (
                          <TableRow key={day.date}>
                            <TableCell className="font-medium whitespace-nowrap">
                              {day.date}
                            </TableCell>
                            {/* The group total sits first in its group, so the
                                sum is checkable on the page rather than taken
                                on trust. */}
                            <TableCell className="border-l text-right font-semibold tabular-nums">
                              {day.closed}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {day.completed}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {day.missedUnstarted} / {day.missedPartial}
                            </TableCell>
                            <TableCell className="border-l text-right font-semibold tabular-nums">
                              {day.open}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {day.notStarted}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {day.inProgress}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </ScrollAreaX>
                )}
              </CardContent>
            </Card>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs tracking-wide uppercase">{label}</dt>
      <dd className="mt-0.5 text-xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
