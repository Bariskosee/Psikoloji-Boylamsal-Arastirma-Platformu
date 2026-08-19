"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { Link, useRouter } from "@/i18n/navigation";
import {
  QUESTION_TYPES,
  type Locale,
  type QuestionType,
  type QuestionnaireDetail,
  type QuestionnaireVersionDetail,
  type StudyResponse,
} from "@lpr/contracts";
import { tokens } from "@lpr/ui";
import { ApiError, api } from "@/lib/api";
import { ErrorBanner, StatusBadge, styles } from "@/lib/ui";
import { defaultConfigFor, groupByPage, moveItem } from "@/lib/questionnaire";
import { PreviewPane } from "@/components/questionnaire/PreviewPane";
import { PublishDialog } from "@/components/questionnaire/PublishDialog";
import { QuestionEditor } from "@/components/questionnaire/QuestionEditor";

/**
 * The questionnaire builder.
 *
 * Left: the draft's questions, reorderable by drag or by keyboard. Right: the
 * participant preview at phone width. Both read the same loaded draft, so what
 * the preview shows is what the server currently holds — there is no separate
 * "preview state" that could drift from the saved draft and reassure a
 * researcher about a form that was never saved.
 *
 * Reload-after-write, rather than optimistic local edits: `display_order`,
 * `config` defaults, and the option list are all normalised server-side, and
 * the version being edited is a shared object that a co-editor may have moved
 * underneath. One extra GET per change is cheap at builder scale.
 */
export default function QuestionnaireBuilderPage() {
  const t = useTranslations("questionnaires");
  const uiLocale = useLocale() as Locale;
  const router = useRouter();
  const params = useParams<{ studyId: string; questionnaireId: string }>();
  const studyId = params?.studyId ?? "";
  const questionnaireId = params?.questionnaireId ?? "";
  const basePath = `/api/studies/${studyId}/questionnaires/${questionnaireId}`;

  const [questionnaire, setQuestionnaire] = useState<QuestionnaireDetail | null>(null);
  const [study, setStudy] = useState<StudyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [showPublish, setShowPublish] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishedNotice, setPublishedNotice] = useState<string | null>(null);
  const [previewLocale, setPreviewLocale] = useState<Locale>(uiLocale);
  const [newType, setNewType] = useState<QuestionType>("SINGLE_CHOICE");

  const load = useCallback(async () => {
    try {
      const [detail, loadedStudy] = await Promise.all([
        api.get<QuestionnaireDetail>(basePath),
        api.get<StudyResponse>(`/api/studies/${studyId}`),
      ]);
      setQuestionnaire(detail);
      setStudy(loadedStudy);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        router.push("/login");
        return;
      }
      setError(t("errors.notFound"));
    }
  }, [basePath, router, studyId, t]);

  useEffect(() => {
    if (studyId && questionnaireId) void load();
  }, [load, questionnaireId, studyId]);

  useEffect(() => {
    // Follow the study's languages, not the dashboard's: a Turkish-only study
    // has nothing to preview in English.
    if (study && !study.supportedLocales.includes(previewLocale)) {
      setPreviewLocale(study.defaultLocale);
    }
  }, [previewLocale, study]);

  if (error && !questionnaire) {
    return (
      <div style={styles.page}>
        <ErrorBanner>{error}</ErrorBanner>
        <Link href={`/studies/${studyId}/questionnaires`}>{t("backToList")}</Link>
      </div>
    );
  }
  if (!questionnaire || !study) return <p>{t("loading")}</p>;

  const draft = questionnaire.draft;
  const locales = study.supportedLocales as readonly Locale[];
  const canEdit = study.viewerRole === "OWNER" || study.viewerRole === "EDITOR";
  const nextVersion = (questionnaire.publishedVersions[0]?.versionNumber ?? 0) + 1;

  async function addQuestion() {
    setError(null);
    try {
      const created = await api.post<{ id: string }>(`${basePath}/questions`, {
        type: newType,
        // Placeholder text, never a real instrument item (AGENT.md §16). The
        // researcher replaces it; it exists so the row is valid on creation.
        translations: Object.fromEntries(locales.map((locale) => [locale, t("newQuestion")])),
        pageIndex: lastPageIndex(draft),
        config: defaultConfigFor(newType),
      });
      await load();
      setExpanded(created.id);
    } catch {
      setError(t("errors.save"));
    }
  }

  /**
   * Renames the questionnaire — the researcher-facing label, not content.
   *
   * Allowed even after versions are published, because the name is never part
   * of what a participant is shown; the published VERSIONS stay untouched.
   */
  async function rename(name: string) {
    setError(null);
    try {
      await api.patch(basePath, { name });
      await load();
    } catch {
      setError(t("errors.save"));
    }
  }

  async function removeQuestion(questionId: string) {
    setError(null);
    try {
      await api.delete(`${basePath}/questions/${questionId}`);
      await load();
    } catch {
      setError(t("errors.save"));
    }
  }

  async function reorder(from: number, to: number) {
    const ids = draft.questions.map((question) => question.id);
    const next = moveItem(ids, from, to);
    if (next.join() === ids.join()) return;
    setError(null);
    try {
      await api.put(`${basePath}/questions/order`, { questionIds: next });
      await load();
    } catch {
      setError(t("errors.reorder"));
    }
  }

  async function publish() {
    setPublishing(true);
    setError(null);
    try {
      const published = await api.post<QuestionnaireVersionDetail>(`${basePath}/publish`);
      setShowPublish(false);
      setPublishedNotice(t("publishedNotice", { version: published.versionNumber ?? 0 }));
      await load();
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.code === "CONFLICT"
          ? caught.message
          : t("errors.publish"),
      );
      setShowPublish(false);
    } finally {
      setPublishing(false);
    }
  }

  return (
    <div style={styles.page}>
      <p>
        <Link href={`/studies/${studyId}/questionnaires`}>← {t("backToList")}</Link>
      </p>

      <header style={{ display: "flex", alignItems: "center", gap: tokens.spacing.sm }}>
        <h1 style={{ margin: 0 }}>{questionnaire.name}</h1>
        <StatusBadge status={t("draftBadge")} />
      </header>

      {canEdit ? (
        <section style={styles.card}>
          <label htmlFor="questionnaire-name" style={styles.label}>
            {t("name")}
          </label>
          <div style={{ display: "flex", gap: tokens.spacing.sm, flexWrap: "wrap" }}>
            <input
              id="questionnaire-name"
              defaultValue={questionnaire.name}
              onBlur={(event) => {
                const value = event.target.value.trim();
                if (value && value !== questionnaire.name) void rename(value);
              }}
              style={{ ...styles.input, flex: "1 1 240px" }}
            />
          </div>
          <p style={{ fontSize: 13, color: "#5b6472", margin: `${tokens.spacing.xs}px 0 0` }}>
            {t("nameHint")}
          </p>
        </section>
      ) : null}

      <ErrorBanner>{error}</ErrorBanner>
      {publishedNotice ? (
        <p
          role="status"
          style={{
            padding: tokens.spacing.sm,
            border: "1px solid #1a7f37",
            background: "#f0fdf4",
            borderRadius: tokens.radiusPx,
          }}
        >
          {publishedNotice}
        </p>
      ) : null}

      {questionnaire.publishedVersions.length > 0 ? (
        <section style={styles.card}>
          <h2 style={{ marginTop: 0 }}>{t("publishedVersions")}</h2>
          <ul style={{ margin: 0, paddingLeft: tokens.spacing.lg }}>
            {questionnaire.publishedVersions.map((version) => (
              <li key={version.id}>
                v{version.versionNumber} — {t("questionCount", { count: version.questionCount })}
                {version.publishedAt
                  ? ` — ${new Date(version.publishedAt).toLocaleString(uiLocale)}`
                  : ""}
              </li>
            ))}
          </ul>
          <p style={{ fontSize: 13, color: "#5b6472", marginBottom: 0 }}>
            {t("publishedImmutableHint")}
          </p>
        </section>
      ) : null}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
          gap: tokens.spacing.lg,
          alignItems: "start",
        }}
      >
        {/* ── Builder ─────────────────────────────────────────────────────── */}
        <section>
          <h2>{t("questions")}</h2>

          {draft.questions.length === 0 ? <p>{t("noQuestions")}</p> : null}

          <ol style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {draft.questions.map((question, index) => (
              <li
                key={question.id}
                draggable={canEdit}
                onDragStart={() => setDragIndex(index)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => {
                  if (dragIndex !== null) void reorder(dragIndex, index);
                  setDragIndex(null);
                }}
                style={{
                  ...styles.card,
                  padding: 0,
                  marginBottom: tokens.spacing.sm,
                  opacity: dragIndex === index ? 0.5 : 1,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: tokens.spacing.sm,
                    padding: tokens.spacing.sm,
                    flexWrap: "wrap",
                  }}
                >
                  <span aria-hidden="true" style={{ cursor: canEdit ? "grab" : "default" }}>
                    ⠿
                  </span>
                  <span style={{ fontWeight: 600, flex: "1 1 160px" }}>
                    {index + 1}. {question.translations[previewLocale] ?? t("untranslated")}
                  </span>
                  <span style={{ fontSize: 12, color: "#5b6472" }}>
                    {t(`types.${question.type}`)} · {t("page")} {question.pageIndex + 1}
                  </span>

                  {/* Keyboard-reachable equivalents of the drag handle —
                      drag-and-drop alone is not operable without a pointer. */}
                  <button
                    type="button"
                    aria-label={t("moveUp")}
                    disabled={!canEdit || index === 0}
                    onClick={() => void reorder(index, index - 1)}
                    style={styles.secondaryButton}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={t("moveDown")}
                    disabled={!canEdit || index === draft.questions.length - 1}
                    onClick={() => void reorder(index, index + 1)}
                    style={styles.secondaryButton}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    aria-expanded={expanded === question.id}
                    onClick={() => setExpanded(expanded === question.id ? null : question.id)}
                    style={styles.secondaryButton}
                  >
                    {expanded === question.id ? t("collapse") : t("edit")}
                  </button>
                  {canEdit ? (
                    <button
                      type="button"
                      onClick={() => void removeQuestion(question.id)}
                      style={styles.secondaryButton}
                    >
                      {t("remove")}
                    </button>
                  ) : null}
                </div>

                {expanded === question.id ? (
                  <QuestionEditor
                    question={question}
                    basePath={basePath}
                    locales={locales}
                    disabled={!canEdit}
                    onChanged={load}
                    onError={setError}
                  />
                ) : null}
              </li>
            ))}
          </ol>

          {canEdit ? (
            <div
              style={{ ...styles.card, display: "flex", gap: tokens.spacing.sm, flexWrap: "wrap" }}
            >
              <label htmlFor="new-question-type" style={{ ...styles.label, marginBottom: 0 }}>
                {t("addQuestion")}
              </label>
              <select
                id="new-question-type"
                value={newType}
                onChange={(event) => setNewType(event.target.value as QuestionType)}
                style={{ ...styles.input, maxWidth: 220 }}
              >
                {QUESTION_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {t(`types.${type}`)}
                  </option>
                ))}
              </select>
              <button type="button" onClick={addQuestion} style={styles.button}>
                + {t("add")}
              </button>
            </div>
          ) : null}

          {canEdit ? (
            showPublish ? (
              <PublishDialog
                questionCount={draft.questions.length}
                nextVersionNumber={nextVersion}
                publishing={publishing}
                onPublish={publish}
                onCancel={() => setShowPublish(false)}
              />
            ) : (
              <button
                type="button"
                onClick={() => setShowPublish(true)}
                disabled={draft.questions.length === 0}
                style={styles.button}
              >
                {t("publish")}
              </button>
            )
          ) : null}
        </section>

        {/* ── Preview ─────────────────────────────────────────────────────── */}
        <section>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: tokens.spacing.sm,
              flexWrap: "wrap",
            }}
          >
            <h2 style={{ margin: 0 }}>{t("preview")}</h2>
            <label htmlFor="preview-locale" style={{ fontSize: 14 }}>
              {t("previewLanguage")}
            </label>
            <select
              id="preview-locale"
              value={previewLocale}
              onChange={(event) => setPreviewLocale(event.target.value as Locale)}
              style={{ ...styles.input, maxWidth: 120 }}
            >
              {locales.map((locale) => (
                <option key={locale} value={locale}>
                  {locale.toUpperCase()}
                </option>
              ))}
            </select>
          </div>
          <p style={{ fontSize: 13, color: "#5b6472" }}>{t("previewHint")}</p>

          <PreviewPane
            version={draft}
            locale={previewLocale}
            labels={{
              empty: t("noQuestions"),
              page: t("page"),
              of: t("of"),
              previous: t("previousPage"),
              next: t("nextPage"),
              required: t("required"),
              untranslated: t("untranslated"),
              submit: t("previewSubmit"),
            }}
          />
        </section>
      </div>
    </div>
  );
}

/**
 * The page a newly added question lands on: the last one in use.
 *
 * Appending to the final page is the behaviour a researcher expects from an
 * "add question" button. Moving it elsewhere is one field in the editor.
 */
function lastPageIndex(draft: QuestionnaireVersionDetail): number {
  const pages = groupByPage(draft.questions);
  return pages.length === 0 ? 0 : (pages[pages.length - 1]?.pageIndex ?? 0);
}
