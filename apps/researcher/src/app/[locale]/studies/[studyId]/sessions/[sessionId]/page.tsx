"use client";

import { use, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import type { InspectedAnswer, SessionInspectionResponse } from "@lpr/contracts";
import { api } from "@/lib/api";
import { ErrorBanner, styles } from "@/lib/ui";

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
 *
 * ANALYST and above, and the read is audited server-side (NFR-05).
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

  useEffect(() => {
    void (async () => {
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
    })();
  }, [studyId, sessionId]);

  if (status === "loading") return <p style={styles.page}>…</p>;
  if (status === "error" || inspection === null) {
    return (
      <div style={styles.page}>
        <ErrorBanner>{t("loadFailed")}</ErrorBanner>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <h1>{t("inspectorTitle")}</h1>
      <p style={{ color: "#5b6472" }}>
        <span style={{ fontFamily: "ui-monospace, monospace" }}>{inspection.publicCode}</span> ·{" "}
        {inspection.stepKey} #{inspection.occurrenceIndex} · {inspection.questionnaireName}
      </p>

      <div style={{ overflowX: "auto" }}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.cell}>{t("question")}</th>
              <th style={styles.cell}>{t("value")}</th>
              <th style={styles.cell}>{t("answerStatus")}</th>
            </tr>
          </thead>
          <tbody>
            {inspection.answers.map((answer) => (
              <AnswerRow key={answer.questionKey} answer={answer} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * The seven statuses, each with its own colour AND its own words.
 *
 * Colour alone would fail anyone who cannot distinguish these hues, and on a
 * missingness table that is not a cosmetic failure — it is the difference
 * between reading "skipped an optional item" and "never opened the session".
 */
const STATUS_COLOURS: Record<InspectedAnswer["status"], string> = {
  ANSWERED: "#067647",
  SKIPPED_OPTIONAL: "#b54708",
  MISSED_ITEM_PARTIAL: "#b42318",
  MISSED_SESSION: "#912018",
  IN_PROGRESS: "#175cd3",
  NOT_YET_DUE: "#5b6472",
  NOT_APPLICABLE: "#98a2b3",
};

function AnswerRow({ answer }: { answer: InspectedAnswer }) {
  const t = useTranslations("analytics");
  const answered = answer.status === "ANSWERED";

  return (
    <tr>
      <td style={styles.cell}>
        <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, color: "#5b6472" }}>
          {answer.questionKey}
        </span>
        <br />
        {/* Researcher-entered text, rendered as TEXT. No markup path exists. */}
        {answer.questionText}
      </td>
      <td style={styles.cell}>
        {answered && answer.value !== null ? (
          answer.value
        ) : (
          /*
            An em-dash with a title, never an empty cell and never a zero. A
            blank is ambiguous on a printed table; a dash is visibly "nothing
            here", and the title says why in words.
          */
          <span style={{ color: "#98a2b3" }} title={t("noValueHint")}>
            {t("noValue")}
          </span>
        )}
      </td>
      <td style={{ ...styles.cell, color: STATUS_COLOURS[answer.status], fontSize: 13 }}>
        {t(`status${answer.status}`)}
      </td>
    </tr>
  );
}
