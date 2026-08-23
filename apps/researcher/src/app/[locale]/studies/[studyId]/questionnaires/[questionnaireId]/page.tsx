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
import { ApiError, api } from "@/lib/api";
import { ArrowDown, ArrowUp, GripVertical, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusBadge } from "@/components/ui/status-badge";
import { EmptyState, ErrorBanner, ErrorState, LoadingCards } from "@/components/ui/states";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
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
      <div className="mx-auto max-w-3xl">
        <ErrorState title={error} onRetry={() => void load()} retryLabel={t("retry")} />
        <p className="mt-4">
          <Link
            href={`/studies/${studyId}/questionnaires`}
            className="text-primary text-sm underline-offset-4 hover:underline"
          >
            {t("backToList")}
          </Link>
        </p>
      </div>
    );
  }
  if (!questionnaire || !study) {
    return (
      <div className="mx-auto max-w-6xl">
        <LoadingCards count={2} />
      </div>
    );
  }

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
   * Edits the questionnaire's own label and description — not its content.
   *
   * Allowed even after versions are published, because neither is part of what
   * a participant is shown; the published VERSIONS stay untouched.
   */
  async function editQuestionnaire(fields: { name?: string; description?: string }) {
    setError(null);
    try {
      await api.patch(basePath, fields);
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
      setError(publishErrorMessage(caught, t));
      setShowPublish(false);
    } finally {
      setPublishing(false);
    }
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {questionnaire.name}
            <StatusBadge tone="warning">{t("draftBadge")}</StatusBadge>
          </span>
        }
        description={questionnaire.description || undefined}
        actions={
          canEdit ? (
            showPublish ? null : (
              <Button
                type="button"
                onClick={() => setShowPublish(true)}
                disabled={draft.questions.length === 0}
              >
                {t("publish")}
              </Button>
            )
          ) : undefined
        }
      />

      <ErrorBanner>{error}</ErrorBanner>

      {publishedNotice ? (
        <div
          role="status"
          className="border-success/40 bg-success-muted text-success-muted-foreground mb-4 rounded-lg border px-4 py-3 text-sm"
        >
          {publishedNotice}
        </div>
      ) : null}

      {canEdit && showPublish ? (
        <div className="mb-6">
          <PublishDialog
            questionCount={draft.questions.length}
            nextVersionNumber={nextVersion}
            publishing={publishing}
            onPublish={publish}
            onCancel={() => setShowPublish(false)}
          />
        </div>
      ) : null}

      {/*
        Two panes on a wide screen, stacked on a narrow one.

        `min(340px, 100%)`, not a bare 340px: a bare minimum is a hard floor, so
        on a 320px phone the track stays 340px wide and the whole page scrolls
        sideways. Phase 3 requires previewing the builder at phone width, which
        is exactly where the bare value fails.
      */}
      <div className="grid items-start gap-6 [grid-template-columns:repeat(auto-fit,minmax(min(340px,100%),1fr))]">
        {/* ── Builder ─────────────────────────────────────────────────────── */}
        <section aria-labelledby="questions-heading">
          <h2 id="questions-heading" className="mb-3 text-lg font-semibold">
            {t("questions")}
          </h2>

          {draft.questions.length === 0 ? (
            <EmptyState title={t("noQuestions")} className="mb-4" />
          ) : null}

          <ol className="mb-4 space-y-2">
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
                className={cn(
                  "bg-card rounded-lg border transition-opacity",
                  dragIndex === index && "opacity-50",
                  expanded === question.id && "ring-primary/30 ring-2",
                )}
              >
                <div className="flex flex-wrap items-center gap-2 p-2.5">
                  <GripVertical
                    aria-hidden
                    className={cn(
                      "text-muted-foreground size-4 shrink-0",
                      canEdit ? "cursor-grab" : "cursor-default",
                    )}
                  />
                  <span className="min-w-40 flex-1 text-sm font-medium">
                    {index + 1}. {question.translations[previewLocale] ?? t("untranslated")}
                  </span>
                  <span className="text-muted-foreground text-xs whitespace-nowrap">
                    {t(`types.${question.type}`)} · {t("page")} {question.pageIndex + 1}
                  </span>

                  <div className="flex items-center gap-1">
                    {/* Keyboard-reachable equivalents of the drag handle —
                        drag-and-drop alone is not operable without a pointer. */}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={t("moveUp")}
                      disabled={!canEdit || index === 0}
                      onClick={() => void reorder(index, index - 1)}
                    >
                      <ArrowUp />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={t("moveDown")}
                      disabled={!canEdit || index === draft.questions.length - 1}
                      onClick={() => void reorder(index, index + 1)}
                    >
                      <ArrowDown />
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-expanded={expanded === question.id}
                      onClick={() => setExpanded(expanded === question.id ? null : question.id)}
                    >
                      {expanded === question.id ? t("collapse") : t("edit")}
                    </Button>
                    {canEdit ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => void removeQuestion(question.id)}
                      >
                        {t("remove")}
                      </Button>
                    ) : null}
                  </div>
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
            <Card>
              <CardContent className="flex flex-wrap items-end gap-3 pt-6">
                <div className="grid min-w-52 flex-1 gap-2">
                  <Label htmlFor="new-question-type">{t("addQuestion")}</Label>
                  <Select
                    value={newType}
                    onValueChange={(value) => setNewType(value as QuestionType)}
                  >
                    <SelectTrigger id="new-question-type" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {QUESTION_TYPES.map((type) => (
                        <SelectItem key={type} value={type}>
                          {t(`types.${type}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button type="button" onClick={addQuestion}>
                  <Plus />
                  {t("add")}
                </Button>
              </CardContent>
            </Card>
          ) : null}

          {questionnaire.publishedVersions.length > 0 ? (
            <Card className="mt-6">
              <CardHeader>
                <CardTitle className="text-base">{t("publishedVersions")}</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-1.5 text-sm">
                  {questionnaire.publishedVersions.map((version) => (
                    <li key={version.id} className="flex flex-wrap items-center gap-2">
                      <StatusBadge tone="success">v{version.versionNumber}</StatusBadge>
                      <span className="text-muted-foreground">
                        {t("questionCount", { count: version.questionCount })}
                        {version.publishedAt
                          ? ` — ${new Date(version.publishedAt).toLocaleString(uiLocale)}`
                          : ""}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="text-muted-foreground mt-3 text-xs">{t("publishedImmutableHint")}</p>
              </CardContent>
            </Card>
          ) : null}

          {canEdit ? (
            <Card className="mt-6">
              <CardHeader>
                <CardTitle className="text-base">{t("name")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-2">
                  <Label htmlFor="questionnaire-name">{t("name")}</Label>
                  <Input
                    id="questionnaire-name"
                    defaultValue={questionnaire.name}
                    onBlur={(event) => {
                      const value = event.target.value.trim();
                      if (value && value !== questionnaire.name) {
                        void editQuestionnaire({ name: value });
                      }
                    }}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="questionnaire-description">{t("description")}</Label>
                  <Textarea
                    id="questionnaire-description"
                    rows={2}
                    defaultValue={questionnaire.description}
                    onBlur={(event) => {
                      // Unlike the name, an empty description is a legitimate
                      // value — the contract allows "" and clearing it is a
                      // real intent.
                      const value = event.target.value.trim();
                      if (value !== questionnaire.description) {
                        void editQuestionnaire({ description: value });
                      }
                    }}
                  />
                </div>
                <p className="text-muted-foreground text-xs">{t("nameHint")}</p>
              </CardContent>
            </Card>
          ) : null}
        </section>

        {/* ── Preview ─────────────────────────────────────────────────────── */}
        <section aria-labelledby="preview-heading">
          <div className="mb-1 flex flex-wrap items-end justify-between gap-3">
            <h2 id="preview-heading" className="text-lg font-semibold">
              {t("preview")}
            </h2>
            <div className="flex items-center gap-2">
              <Label htmlFor="preview-locale" className="text-sm font-normal">
                {t("previewLanguage")}
              </Label>
              <Select
                value={previewLocale}
                onValueChange={(value) => setPreviewLocale(value as Locale)}
              >
                <SelectTrigger id="preview-locale" size="sm" className="w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {locales.map((locale) => (
                    <SelectItem key={locale} value={locale}>
                      {locale.toUpperCase()}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="text-muted-foreground mb-3 text-xs">{t("previewHint")}</p>

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
              exclusive: t("optionExclusive"),
              submit: t("previewSubmit"),
            }}
          />
        </section>
      </div>
    </div>
  );
}

/**
 * Turns a failed publish into a sentence in the researcher's own language.
 *
 * The server's `message` is deliberately NOT used. `api-error.ts` is explicit
 * that it is developer-facing English for logs — rendering it here would put an
 * English sentence in a Turkish interface. Every publish refusal therefore has
 * its own code, and the position of the offending question rides along in
 * `details` so the text can name it.
 */
function publishErrorMessage(
  caught: unknown,
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  if (!(caught instanceof ApiError)) return t("errors.publish");

  switch (caught.code) {
    case "QUESTIONNAIRE_EMPTY":
      return t("errors.publishEmpty");
    case "QUESTION_OPTIONS_REQUIRED":
      return t("errors.publishNeedsOptions", { position: questionPosition(caught) });
    case "QUESTION_SELECTION_BOUNDS_UNSATISFIABLE":
      return t("errors.publishSelectionBounds", { position: questionPosition(caught) });
    default:
      return t("errors.publish");
  }
}

/** The 1-based question position the server put in `details`, or 0 if absent. */
function questionPosition(error: ApiError): number {
  const path = error.details?.[0]?.path ?? "";
  const parsed = Number(path.split(".")[1]);
  return Number.isFinite(parsed) ? parsed : 0;
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
