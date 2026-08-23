"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { Link } from "@/i18n/navigation";
import { tokens } from "@lpr/ui";
import type { CompleteSessionResponse, RuntimeQuestion, SessionDetail } from "@lpr/contracts";
import { ApiError, api } from "@/lib/api";
import { useAutosave } from "@/lib/autosave";
import { ErrorBanner, styles } from "@/lib/ui";
import { EMPTY_ANSWER, QuestionInput, type AnswerValue } from "@/components/QuestionInput";

/**
 * The questionnaire runtime.
 *
 * One page of questions at a time, a progress indicator across all pages, and
 * an autosave engine that persists every answer durably before sending it.
 *
 * Required-question validation runs here for immediate feedback and again on
 * the server, which is the authority. A participant who gets past this check by
 * any means is still refused at completion.
 */
export default function SessionPage() {
  const t = useTranslations("runtime");
  const params = useParams<{ sessionId: string }>();
  const sessionId = params?.sessionId ?? "";

  const [session, setSession] = useState<SessionDetail | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "closed" | "missing">("loading");
  const [closedReason, setClosedReason] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, AnswerValue>>({});
  const [revisions, setRevisions] = useState<Record<string, number>>({});
  const [page, setPage] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const autosave = useAutosave(sessionId);

  useEffect(() => {
    if (!sessionId) return;
    void (async () => {
      try {
        const detail = await api.get<SessionDetail>(`/api/participant/sessions/${sessionId}`);
        setSession(detail);

        // Restore exactly what the server acknowledged. Nothing about the
        // restore depends on client state surviving.
        const restored: Record<string, AnswerValue> = {};
        const restoredRevisions: Record<string, number> = {};
        for (const answer of detail.answers) {
          restored[answer.questionVersionId] = {
            valueNumber: answer.valueNumber,
            valueText: answer.valueText,
            selectedOptionIds: answer.selectedOptionIds,
          };
          restoredRevisions[answer.questionVersionId] = answer.clientRevision;
        }
        setValues(restored);
        setRevisions(restoredRevisions);

        if (detail.status === "COMPLETED") setDone(true);
        setStatus("ready");
      } catch (caught) {
        if (caught instanceof ApiError && caught.status === 409) {
          setClosedReason(caught.code);
          setStatus("closed");
        } else {
          setStatus("missing");
        }
      }
    })();
  }, [sessionId]);

  const questions = session?.questions ?? [];
  const pages = useMemo(() => groupByPage(questions), [questions]);
  const current = pages[page] ?? [];

  const answeredCount = questions.filter((question) =>
    hasAnswer(question, values[question.id] ?? EMPTY_ANSWER),
  ).length;

  const change = useCallback(
    (question: RuntimeQuestion, value: AnswerValue) => {
      setValues((previous) => ({ ...previous, [question.id]: value }));
      const revision = (revisions[question.id] ?? 0) + 1;
      setRevisions((previous) => ({ ...previous, [question.id]: revision }));

      void autosave.save({
        questionVersionId: question.id,
        clientRevision: revision,
        valueNumber: value.valueNumber,
        valueText: value.valueText,
        selectedOptionIds: value.selectedOptionIds,
      });
    },
    [autosave, revisions],
  );

  const missingOnPage = current.filter(
    (question) => question.isRequired && !hasAnswer(question, values[question.id] ?? EMPTY_ANSWER),
  );

  async function goNext() {
    if (missingOnPage.length > 0) {
      setError(t("missingRequired"));
      return;
    }
    setError(null);
    // Flush before leaving the page, so an answer given seconds ago is not
    // sitting in a debounce when the participant closes the app.
    await autosave.flush();
    setPage((value) => Math.min(value + 1, pages.length - 1));
  }

  async function submit() {
    if (missingOnPage.length > 0) {
      setError(t("missingRequired"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await autosave.flush();
      await api.post<CompleteSessionResponse>(`/api/participant/sessions/${sessionId}/complete`);
      setDone(true);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "REQUIRED_QUESTIONS_UNANSWERED") {
        setError(t("missingRequiredOnSubmit"));
      } else if (caught instanceof ApiError && caught.status === 409) {
        setClosedReason(caught.code);
        setStatus("closed");
      } else {
        setError(t("saveError"));
      }
      setSubmitting(false);
    }
  }

  if (status === "loading") return <p style={styles.page}>{t("loading")}</p>;

  if (status === "missing") {
    return (
      <div style={styles.page}>
        <ErrorBanner>{t("notFound")}</ErrorBanner>
        <Link href="/home" style={backLink}>
          {t("done.back")}
        </Link>
      </div>
    );
  }

  if (status === "closed") {
    return (
      <div style={styles.page}>
        <ErrorBanner>{messageForClosed(closedReason, t)}</ErrorBanner>
        <Link href="/home" style={backLink}>
          {t("done.back")}
        </Link>
      </div>
    );
  }

  if (done) {
    return (
      <div style={styles.page}>
        <h1>{t("done.title")}</h1>
        <p style={styles.prose}>{t("done.body")}</p>
        <Link href="/home" style={backLink}>
          {t("done.back")}
        </Link>
      </div>
    );
  }

  const lastPage = page >= pages.length - 1;

  return (
    <div style={styles.page}>
      <header style={{ marginBottom: tokens.spacing.md }}>
        <p style={{ margin: 0, color: "#5b6472" }}>
          {t("pageOf", { page: page + 1, total: Math.max(pages.length, 1) })}
        </p>
        <p style={{ margin: "4px 0 8px", fontWeight: 600 }}>
          {t("progress", { answered: answeredCount, total: questions.length })}
        </p>
        <div
          role="progressbar"
          aria-valuenow={answeredCount}
          aria-valuemin={0}
          aria-valuemax={questions.length}
          style={{ height: 6, background: "#e6e8eb", borderRadius: 999 }}
        >
          <div
            style={{
              height: "100%",
              width: `${String(questions.length === 0 ? 0 : (answeredCount / questions.length) * 100)}%`,
              background: "#1f2a37",
              borderRadius: 999,
            }}
          />
        </div>
        <p aria-live="polite" style={{ fontSize: 13, color: "#5b6472", marginBottom: 0 }}>
          {t(`saveState.${autosave.state}`)}
        </p>
      </header>

      <ErrorBanner>{error}</ErrorBanner>
      {autosave.failed ? <ErrorBanner>{t("saveError")}</ErrorBanner> : null}

      <ol style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {current.map((question) => (
          <li key={question.id} style={styles.card}>
            {/*
              The id is what names the controls below (NFR-15). Without it a
              free-text box announces as "edit text, blank" and a radio option
              announces without its question.
            */}
            <p id={`${question.id}-label`} style={{ marginTop: 0, fontSize: 17, lineHeight: 1.5 }}>
              {question.text}
              {question.isRequired ? (
                <span style={{ color: "#b42318" }} aria-label={t("required")}>
                  {" *"}
                </span>
              ) : null}
            </p>
            <QuestionInput
              question={question}
              labelledBy={`${question.id}-label`}
              value={values[question.id] ?? EMPTY_ANSWER}
              disabled={submitting}
              onChange={(value) => change(question, value)}
            />
          </li>
        ))}
      </ol>

      <div style={{ display: "flex", flexDirection: "column", gap: tokens.spacing.sm }}>
        {lastPage ? (
          <button
            type="button"
            onClick={() => void submit()}
            disabled={submitting}
            style={styles.button}
          >
            {submitting ? t("submitting") : t("submit")}
          </button>
        ) : (
          <button type="button" onClick={() => void goNext()} style={styles.button}>
            {t("next")}
          </button>
        )}

        {page > 0 ? (
          <button
            type="button"
            onClick={() => {
              setError(null);
              setPage((value) => Math.max(value - 1, 0));
            }}
            style={styles.secondaryButton}
          >
            {t("back")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

const backLink = {
  ...styles.secondaryButton,
  textAlign: "center" as const,
  textDecoration: "none",
  marginTop: 16,
};

/** Pages, in order, with empty pages collapsed rather than rendered blank. */
function groupByPage(questions: readonly RuntimeQuestion[]): RuntimeQuestion[][] {
  const byPage = new Map<number, RuntimeQuestion[]>();
  for (const question of questions) {
    const list = byPage.get(question.pageIndex) ?? [];
    list.push(question);
    byPage.set(question.pageIndex, list);
  }
  return [...byPage.entries()].sort(([a], [b]) => a - b).map(([, list]) => list);
}

/**
 * Whether a question counts as answered.
 *
 * Deliberately the same rule the server applies: a blank string and an empty
 * selection are valid values but not answers. Diverging would let the client
 * enable a submit button the server then refuses.
 */
function hasAnswer(question: RuntimeQuestion, value: AnswerValue): boolean {
  switch (question.type) {
    case "SINGLE_CHOICE":
    case "MULTI_CHOICE":
      return value.selectedOptionIds.length > 0;
    case "LIKERT":
    case "NUMERIC":
      return typeof value.valueNumber === "number";
    case "FREE_TEXT":
      return (value.valueText ?? "").trim().length > 0;
  }
}

function messageForClosed(code: string | null, t: (key: string) => string): string {
  switch (code) {
    case "SESSION_NOT_AVAILABLE":
      return t("notAvailable");
    case "SESSION_ALREADY_COMPLETED":
      return t("alreadyCompleted");
    case "SESSION_CANCELLED":
      return t("cancelled");
    default:
      return t("windowClosed");
  }
}
