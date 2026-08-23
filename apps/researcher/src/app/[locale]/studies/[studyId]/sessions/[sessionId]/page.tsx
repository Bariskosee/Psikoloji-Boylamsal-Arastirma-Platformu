"use client";

import { use, useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import type { InspectedAnswer, SessionInspectionResponse } from "@lpr/contracts";
import { api } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ErrorState, LoadingTable } from "@/components/ui/states";

/**
 * The longitudinal response inspector (PLAN.md Phase 10, `docs/export-codebook.md` §2).
 *
 * ── The rule this screen exists to obey ─────────────────────────────────────
 * An absent answer is NEVER rendered as `0`, and never as a blank cell that
 * could be read as one. `0` is a real value in every statistical package, and a
 * reader who copies this table into a spreadsheet must not be able to acquire a
 * zero that nobody typed (AGENT.md §17).
 *
 * So every row carries one of seven statuses, each visually distinct, and the
 * value column shows an em-dash with an explanatory title wherever the status
 * is not `ANSWERED`. The seven are distinguished rather than collapsed because
 * each supports a different decision about whether the value is missing at
 * random: "skipped an optional item" and "never opened the session" are not the
 * same fact about a participant.
 */
export default function InspectorPage({
  params,
}: {
  params: Promise<{ studyId: string; sessionId: string }>;
}) {
  const { studyId, sessionId } = use(params);
  const t = useTranslations("analytics");

  const [inspection, setInspection] = useState<SessionInspectionResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      setInspection(
        await api.get<SessionInspectionResponse>(
          `/api/studies/${studyId}/sessions/${sessionId}/responses`,
        ),
      );
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, [studyId, sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (status === "loading") {
    return (
      <div className="mx-auto max-w-4xl">
        <LoadingTable rows={6} columns={3} />
      </div>
    );
  }

  if (status === "error" || inspection === null) {
    return (
      <div className="mx-auto max-w-4xl">
        <ErrorState title={t("loadFailed")} onRetry={() => void load()} retryLabel={t("retry")} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title={t("inspectorTitle")}
        description={
          <span className="flex flex-wrap items-center gap-x-2">
            <span className="font-mono">{inspection.publicCode}</span>
            <span aria-hidden>·</span>
            <span>
              {inspection.stepKey} #{inspection.occurrenceIndex}
            </span>
            <span aria-hidden>·</span>
            <span>{inspection.questionnaireName}</span>
          </span>
        }
      />

      <Card className="overflow-hidden py-0">
        <CardContent className="px-0">
          <div
            className="overflow-x-auto"
            tabIndex={0}
            role="region"
            aria-label={t("inspectorTitle")}
          >
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t("question")}</TableHead>
                  <TableHead>{t("value")}</TableHead>
                  <TableHead className="w-56">{t("answerStatus")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {inspection.answers.map((answer) => (
                  <AnswerRow key={answer.questionKey} answer={answer} />
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * The seven statuses, each with its own tone AND its own words.
 *
 * Colour alone would fail anyone who cannot distinguish these hues, and on a
 * missingness table that is not a cosmetic failure — it is the difference
 * between reading "skipped an optional item" and "never opened the session".
 * Every badge therefore carries the translated status text; the tone only
 * makes the table scannable for readers who can use it.
 */
const STATUS_TONES: Record<InspectedAnswer["status"], StatusTone> = {
  ANSWERED: "success",
  SKIPPED_OPTIONAL: "warning",
  MISSED_ITEM_PARTIAL: "danger",
  MISSED_SESSION: "danger",
  IN_PROGRESS: "info",
  NOT_YET_DUE: "neutral",
  NOT_APPLICABLE: "neutral",
};

function AnswerRow({ answer }: { answer: InspectedAnswer }) {
  const t = useTranslations("analytics");
  const answered = answer.status === "ANSWERED";

  return (
    <TableRow>
      <TableCell className="max-w-sm align-top">
        <span className="text-muted-foreground font-mono text-xs">{answer.questionKey}</span>
        {/* Researcher-entered text, rendered as TEXT. No markup path exists. */}
        <p className="mt-0.5 text-sm">{answer.questionText}</p>
      </TableCell>
      <TableCell className="align-top">
        {answered && answer.value !== null ? (
          <span className="text-sm break-words">{answer.value}</span>
        ) : (
          /*
            An em-dash with a title, never an empty cell and never a zero. A
            blank is ambiguous on a printed table; a dash is visibly "nothing
            here", and the title says why in words.
          */
          <span className="text-muted-foreground" title={t("noValueHint")}>
            {t("noValue")}
          </span>
        )}
      </TableCell>
      <TableCell className="align-top">
        <StatusBadge tone={STATUS_TONES[answer.status]}>{t(`status${answer.status}`)}</StatusBadge>
      </TableCell>
    </TableRow>
  );
}
