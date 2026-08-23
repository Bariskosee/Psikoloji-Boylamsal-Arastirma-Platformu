"use client";

import { use, useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ArrowLeft, Search } from "lucide-react";
import { Link } from "@/i18n/navigation";
import type { ParticipantDetailResponse, TimelineEntry } from "@lpr/contracts";
import { api } from "@/lib/api";
import { ComplianceFigureView, StepFigureView } from "@/components/analytics/ComplianceFigure";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollAreaX } from "@/components/ui/scroll-area-x";
import { PageHeader } from "@/components/ui/page-header";
import { SessionStatusBadge, StatusBadge } from "@/components/ui/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ErrorState, LoadingTable } from "@/components/ui/states";
import { cn } from "@/lib/utils";

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
  // The interface's locale, not the device's — see the participant home screen.
  const locale = useLocale();

  const [detail, setDetail] = useState<ParticipantDetailResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  const load = useCallback(async () => {
    setStatus("loading");
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
  }, [studyId, participantId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (status === "loading") {
    return (
      <div className="mx-auto max-w-5xl">
        <LoadingTable rows={8} columns={5} />
      </div>
    );
  }

  if (status === "error" || detail === null) {
    return (
      <div className="mx-auto max-w-5xl">
        <ErrorState title={t("loadFailed")} onRetry={() => void load()} retryLabel={t("retry")} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title={<span className="font-mono">{detail.publicCode}</span>}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <StatusBadge tone={detail.status === "ACTIVE" ? "success" : "neutral"}>
              {detail.status}
            </StatusBadge>
            <span>
              {t("enrolled")} {new Date(detail.enrolledAt).toLocaleDateString(locale)}
            </span>
            {detail.groupKey === null ? null : (
              <span>
                {t("group")} {detail.groupKey}
              </span>
            )}
          </span>
        }
        actions={
          <Button asChild variant="outline">
            <Link href={`/studies/${studyId}/participants`}>
              <ArrowLeft />
              {t("backToParticipants")}
            </Link>
          </Button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("elapsed")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="text-lg">
              <ComplianceFigureView figure={detail.elapsed} showBar />
            </div>
            {/*
              Labelled "strict" wherever it appears, as §4 requires. Mid-study
              it reads as damningly low for someone doing everything asked of
              them, which is why it is never the headline figure — here it is
              deliberately smaller and second.
            */}
            <p className="text-muted-foreground text-sm" title={t("strictHint")}>
              {t("strict")}: <ComplianceFigureView figure={detail.strict} />
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("stepsHeading")}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="space-y-2.5">
              {detail.perStep.map((step) => (
                <div key={step.stepKey} className="flex items-center justify-between gap-4">
                  <dt className="min-w-0 truncate text-sm">
                    {step.stepKey}
                    {step.occurrenceCount > 1 ? (
                      <span className="text-muted-foreground"> ×{step.occurrenceCount}</span>
                    ) : null}
                  </dt>
                  <dd className="shrink-0 text-sm">
                    <StepFigureView step={step} />
                  </dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6 overflow-hidden py-0">
        <CardHeader className="pt-6">
          <CardTitle>{t("timeline")}</CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <ScrollAreaX label={t("timeline")}>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t("step")}</TableHead>
                  <TableHead className="text-right">{t("occurrence")}</TableHead>
                  <TableHead>{t("status")}</TableHead>
                  <TableHead>{t("window")}</TableHead>
                  <TableHead className="text-right">{t("responses")}</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.timeline.map((entry) => (
                  <TimelineRow key={entry.sessionId} entry={entry} studyId={studyId} />
                ))}
              </TableBody>
            </Table>
          </ScrollAreaX>
        </CardContent>
      </Card>
    </div>
  );
}

function TimelineRow({ entry, studyId }: { entry: TimelineEntry; studyId: string }) {
  const t = useTranslations("analytics");
  const locale = useLocale();

  return (
    /*
      A session excluded from compliance is dimmed rather than hidden or
      recoloured. It happened — or rather, it deliberately did not — and a
      reader needs to see the row to understand the shape of the protocol.
    */
    <TableRow className={cn(!entry.countsTowardCompliance && "opacity-60")}>
      <TableCell className="font-medium whitespace-nowrap">{entry.stepKey}</TableCell>
      <TableCell className="text-right tabular-nums">{entry.occurrenceIndex}</TableCell>
      <TableCell>
        {/*
          `CANCELLED` reads as "not applicable" and is neutral, not red. They
          did not fail it: it was never offered.
        */}
        {entry.status === "CANCELLED" ? (
          <StatusBadge tone="neutral">{t("stateEXCLUDED")}</StatusBadge>
        ) : (
          <SessionStatusBadge status={entry.status} />
        )}
        {entry.cancellationReason === null ? null : (
          <span className="text-muted-foreground ml-1.5 text-xs">({entry.cancellationReason})</span>
        )}
      </TableCell>
      <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
        {entry.availableFrom === null
          ? "—"
          : new Date(entry.availableFrom).toLocaleString(locale, {
              dateStyle: "short",
              timeStyle: "short",
            })}
      </TableCell>
      <TableCell className="text-right tabular-nums">{entry.responseCount}</TableCell>
      <TableCell>
        {/*
          Inspection is offered only where there is something to inspect. A link
          on a scheduled session would lead to a page of seven "not yet due"
          rows, which teaches a reader the link is broken.
        */}
        {entry.responseCount > 0 || entry.status === "COMPLETED" ? (
          <Button asChild variant="ghost" size="sm">
            <Link href={`/studies/${studyId}/sessions/${entry.sessionId}`}>
              <Search />
              {t("inspect")}
            </Link>
          </Button>
        ) : null}
      </TableCell>
    </TableRow>
  );
}
