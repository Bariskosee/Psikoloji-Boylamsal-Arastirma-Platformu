"use client";

import { use, useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronRight, Users } from "lucide-react";
import { Link } from "@/i18n/navigation";
import type { ParticipantListResponse, ParticipantRow } from "@lpr/contracts";
import { api } from "@/lib/api";
import { ComplianceFigureView, StepFigureView } from "@/components/analytics/ComplianceFigure";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollAreaX } from "@/components/ui/scroll-area-x";
import { PageHeader } from "@/components/ui/page-header";
import { ParticipantStatusBadge } from "@/components/ui/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState, ErrorState, LoadingTable } from "@/components/ui/states";

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
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(
    async (from: string | null) => {
      if (from !== null) setLoadingMore(true);
      try {
        const query = from === null ? "" : `?cursor=${encodeURIComponent(from)}`;
        const page = await api.get<ParticipantListResponse>(
          `/api/studies/${studyId}/participants${query}`,
        );
        setRows((existing) =>
          from === null ? page.participants : [...existing, ...page.participants],
        );
        setCursor(page.nextCursor);
        setStatus("ready");
      } catch {
        setStatus("error");
      } finally {
        setLoadingMore(false);
      }
    },
    [studyId],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  // The step columns come from the data rather than from a constant: a protocol
  // is researcher-defined, and hard-coding "baseline / daily / endline" would
  // bake the reference design into the platform (AGENT.md §3.4).
  const stepKeys = rows[0]?.perStep.map((step) => step.stepKey) ?? [];

  /**
   * The group column appears only when the study allocates groups.
   *
   * Most studies do not, and an entire column of em-dashes is a column that
   * costs horizontal room — the thing this table has least of — to say
   * nothing.
   */
  const hasGroups = rows.some((row) => row.groupKey !== null);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title={t("participants")}
        description={t("participantsSubtitle")}
        actions={
          rows.length > 0 ? (
            <span className="text-muted-foreground self-center text-sm tabular-nums">
              {t("showingCount", { count: rows.length })}
            </span>
          ) : undefined
        }
      />

      {status === "loading" ? <LoadingTable rows={6} columns={5} /> : null}
      {status === "error" ? (
        <ErrorState
          title={t("loadFailed")}
          onRetry={() => void load(null)}
          retryLabel={t("retry")}
        />
      ) : null}

      {status === "ready" && rows.length === 0 ? (
        <EmptyState
          icon={Users}
          title={t("noParticipants")}
          description={t("noParticipantsHint")}
        />
      ) : null}

      {status === "ready" && rows.length > 0 ? (
        <>
          <Card className="overflow-hidden py-0">
            <CardContent className="px-0">
              <ScrollAreaX label={t("participants")}>
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>{t("publicCode")}</TableHead>
                      <TableHead>{t("status")}</TableHead>
                      <TableHead>{t("elapsed")}</TableHead>
                      {stepKeys.map((key) => (
                        /*
                          A step key is the RESEARCHER's own identifier, not one
                          of our labels — it is whatever they typed in the
                          protocol builder, so it is never translated. Setting
                          it in the mono face says that: a lowercase English
                          word beside translated headers otherwise reads as a
                          string somebody forgot to localise.
                        */
                        <TableHead key={key} className="font-mono text-xs whitespace-nowrap">
                          {key}
                        </TableHead>
                      ))}
                      {hasGroups ? <TableHead>{t("group")}</TableHead> : null}
                      <TableHead className="w-10" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => (
                      /*
                        The whole row is the link target rather than a small
                        anchor in the last column — the previous design put a
                        13px "Open" at the far right of a horizontally
                        scrolling table, which on a laptop was frequently off
                        screen entirely.
                      */
                      <TableRow
                        key={row.participantId}
                        className="focus-within:bg-muted/60 group relative"
                      >
                        <TableCell className="font-mono text-sm">
                          <Link
                            href={`/studies/${studyId}/participants/${row.participantId}`}
                            className="after:absolute after:inset-0 focus-visible:outline-none"
                          >
                            {row.publicCode}
                          </Link>
                        </TableCell>
                        <TableCell>
                          <ParticipantStatusBadge status={row.status} />
                        </TableCell>
                        <TableCell>
                          <ComplianceFigureView figure={row.elapsed} showBar />
                        </TableCell>
                        {row.perStep.map((step) => (
                          <TableCell key={step.stepKey}>
                            <StepFigureView step={step} />
                          </TableCell>
                        ))}
                        {hasGroups ? (
                          <TableCell className="text-muted-foreground">
                            {row.groupKey ?? "—"}
                          </TableCell>
                        ) : null}
                        <TableCell>
                          <ChevronRight className="text-muted-foreground size-4" aria-hidden />
                          <span className="sr-only">{t("openParticipant")}</span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ScrollAreaX>
            </CardContent>
          </Card>

          {cursor !== null ? (
            <div className="mt-4 flex justify-center">
              <Button
                type="button"
                variant="outline"
                onClick={() => void load(cursor)}
                disabled={loadingMore}
              >
                {t("loadMore")}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
