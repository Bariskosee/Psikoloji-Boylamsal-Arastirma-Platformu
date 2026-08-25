"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { FileCheck2, FileLock2, Save } from "lucide-react";
import { toast } from "sonner";
import type {
  ConsentVersionListResponse,
  ConsentVersionResponse,
  Locale,
  StudyResponse,
} from "@lpr/contracts";
import { useRouter } from "@/i18n/navigation";
import { ApiError, api } from "@/lib/api";
import { ConsentPublishDialog } from "@/components/consent/ConsentPublishDialog";
import {
  missingConsentLocales,
  reconcileSavedConsentTranslation,
} from "@/components/consent/consent-draft";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { ErrorBanner, ErrorState } from "@/components/ui/states";
import { Textarea } from "@/components/ui/textarea";

interface TranslationFields {
  title: string;
  body: string;
}

function emptyTranslations(): Record<Locale, TranslationFields> {
  return {
    en: { title: "", body: "" },
    tr: { title: "", body: "" },
  };
}

/**
 * Researcher consent editor (FR-03/FR-04).
 *
 * The API owns versioning and immutability. This surface deliberately saves
 * one locale at a time, matching the supported PUT contract, so a failed
 * Turkish save can never make an English save look successful (or vice versa).
 */
export default function ConsentPage() {
  const t = useTranslations("consent");
  const dashboardLocale = useLocale();
  const router = useRouter();
  const params = useParams<{ studyId: string }>();
  const studyId = params?.studyId ?? "";

  const [study, setStudy] = useState<StudyResponse | null>(null);
  const [draft, setDraft] = useState<ConsentVersionResponse | null>(null);
  const [versions, setVersions] = useState<ConsentVersionResponse[]>([]);
  const [translations, setTranslations] =
    useState<Record<Locale, TranslationFields>>(emptyTranslations);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [savingLocale, setSavingLocale] = useState<Locale | null>(null);
  const [publishing, setPublishing] = useState(false);

  const load = useCallback(
    async (showLoading = true) => {
      if (showLoading) setStatus("loading");
      try {
        // The dashboard is cross-origin from the API, so these authenticated
        // reads must happen in the browser (apps/researcher/src/lib/api.ts).
        const [loadedStudy, loadedDraft, loadedVersions] = await Promise.all([
          api.get<StudyResponse>(`/api/studies/${studyId}`),
          api.get<ConsentVersionResponse>(`/api/studies/${studyId}/consent/draft`),
          api.get<ConsentVersionListResponse>(`/api/studies/${studyId}/consent`),
        ]);

        const fields = emptyTranslations();
        for (const translation of loadedDraft.translations) {
          fields[translation.locale] = { title: translation.title, body: translation.body };
        }

        setStudy(loadedStudy);
        setDraft(loadedDraft);
        setVersions(loadedVersions.versions);
        setTranslations(fields);
        setError(null);
        setStatus("ready");
        return true;
      } catch (caught) {
        if (caught instanceof ApiError && caught.status === 401) {
          router.push("/login");
          return false;
        }
        const denied =
          caught instanceof ApiError && (caught.status === 403 || caught.status === 404);
        setError(denied ? t("errors.forbidden") : t("errors.load"));
        setStatus("error");
        return false;
      }
    },
    [router, studyId, t],
  );

  useEffect(() => {
    if (studyId) void load();
  }, [load, studyId]);

  function updateTranslation(locale: Locale, field: keyof TranslationFields, value: string) {
    setTranslations((current) => ({
      ...current,
      [locale]: { ...current[locale], [field]: value },
    }));
  }

  function isDirty(locale: Locale): boolean {
    const saved = draft?.translations.find((translation) => translation.locale === locale);
    return (
      translations[locale].title !== (saved?.title ?? "") ||
      translations[locale].body !== (saved?.body ?? "")
    );
  }

  async function saveTranslation(locale: Locale) {
    const submitted = translations[locale];
    const title = submitted.title.trim();
    const body = submitted.body.trim();
    if (!title || !body) {
      setError(t("errors.required", { language: t(`localeNames.${locale}`) }));
      return;
    }

    setSavingLocale(locale);
    setError(null);
    try {
      const updated = await api.put<ConsentVersionResponse>(
        `/api/studies/${studyId}/consent/draft/translations`,
        { locale, title, body },
      );
      setDraft(updated);
      setTranslations((current) => ({
        ...current,
        [locale]: reconcileSavedConsentTranslation(current[locale], submitted, { title, body }),
      }));
      toast.success(t("saved", { language: t(`localeNames.${locale}`) }));
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        router.push("/login");
        return;
      }
      setError(t("errors.save", { language: t(`localeNames.${locale}`) }));
    } finally {
      setSavingLocale(null);
    }
  }

  async function publish(): Promise<boolean> {
    setPublishing(true);
    setError(null);
    let published: ConsentVersionResponse;
    try {
      published = await api.post<ConsentVersionResponse>(`/api/studies/${studyId}/consent/publish`);
    } catch (caught) {
      setPublishing(false);
      if (caught instanceof ApiError && caught.status === 401) {
        router.push("/login");
        return false;
      }
      setError(t("errors.publish"));
      return false;
    }

    // The irreversible POST is already committed. A subsequent refresh
    // failure must never relabel that success as a failed publish or invite a
    // retry; load() reports its own read error and always resolves.
    toast.success(t("published", { version: published.versionNumber ?? "?" }));
    await load(false);
    setPublishing(false);
    return true;
  }

  if (status === "loading") {
    return (
      <div className="mx-auto max-w-4xl space-y-6" aria-busy="true" aria-live="polite">
        <span className="sr-only">{t("loading")}</span>
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }

  if (status === "error" || !study || !draft) {
    return (
      <div className="mx-auto max-w-4xl">
        <ErrorState
          title={error ?? t("errors.load")}
          onRetry={() => void load()}
          retryLabel={t("retry")}
        />
      </div>
    );
  }

  const supportedLocales = study.supportedLocales as readonly Locale[];
  const dirtyLocales = supportedLocales.filter((locale) => isDirty(locale));
  const publishedVersions = versions
    .filter((version) => version.status === "PUBLISHED")
    .toSorted((left, right) => (right.versionNumber ?? 0) - (left.versionNumber ?? 0));
  const nextVersionNumber = (publishedVersions[0]?.versionNumber ?? 0) + 1;
  const missingLocales = missingConsentLocales(supportedLocales, draft.translations);
  const hasAllSupportedContent = missingLocales.length === 0;
  const publishDisabled =
    !hasAllSupportedContent || dirtyLocales.length > 0 || savingLocale !== null || publishing;
  const dateFormatter = new Intl.DateTimeFormat(dashboardLocale, {
    dateStyle: "medium",
    timeStyle: "short",
  });

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title={t("title")}
        description={t("subtitle")}
        actions={
          <ConsentPublishDialog
            nextVersionNumber={nextVersionNumber}
            disabled={publishDisabled}
            publishing={publishing}
            onPublish={publish}
          />
        }
      />

      <ErrorBanner>{error}</ErrorBanner>

      <Alert className="mb-6">
        <FileLock2 />
        <AlertTitle>{t("immutableTitle")}</AlertTitle>
        <AlertDescription>{t("immutableDescription")}</AlertDescription>
      </Alert>

      <section aria-labelledby="draft-consent-heading" className="space-y-4">
        <div>
          <h2 id="draft-consent-heading" className="text-lg font-semibold">
            {t("draftTitle")}
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">{t("draftDescription")}</p>
        </div>

        {supportedLocales.map((locale) => {
          const fields = translations[locale];
          const dirty = isDirty(locale);
          const saving = savingLocale === locale;
          const language = t(`localeNames.${locale}`);
          const titleId = `consent-${locale}-title`;
          const bodyId = `consent-${locale}-body`;

          return (
            <Card key={locale}>
              <CardHeader className="flex-row items-start justify-between gap-3">
                <div>
                  <CardTitle className="flex flex-wrap items-center gap-2">
                    {language}
                    {locale === study.defaultLocale ? (
                      <StatusBadge tone="info">{t("defaultLocale")}</StatusBadge>
                    ) : null}
                    {dirty ? <StatusBadge tone="warning">{t("unsaved")}</StatusBadge> : null}
                  </CardTitle>
                  <CardDescription>{t("localeDescription", { language })}</CardDescription>
                </div>
                <span className="text-muted-foreground font-mono text-xs uppercase">{locale}</span>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="grid gap-2">
                  <Label htmlFor={titleId}>{t("documentTitle")}</Label>
                  <Input
                    id={titleId}
                    value={fields.title}
                    maxLength={300}
                    onChange={(event) => updateTranslation(locale, "title", event.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <div className="flex items-end justify-between gap-3">
                    <Label htmlFor={bodyId}>{t("documentBody")}</Label>
                    <span className="text-muted-foreground text-xs">
                      {t("characterCount", { count: fields.body.length, maximum: 50000 })}
                    </span>
                  </div>
                  <Textarea
                    id={bodyId}
                    rows={10}
                    value={fields.body}
                    maxLength={50000}
                    onChange={(event) => updateTranslation(locale, "body", event.target.value)}
                  />
                  <p className="text-muted-foreground text-xs">{t("plainTextHint")}</p>
                </div>
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={
                      savingLocale !== null || !dirty || !fields.title.trim() || !fields.body.trim()
                    }
                    onClick={() => void saveTranslation(locale)}
                  >
                    <Save />
                    {saving ? t("saving") : t("save", { language })}
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </section>

      <p className="text-muted-foreground mt-4 text-sm" aria-live="polite">
        {!hasAllSupportedContent
          ? t("publishBlockedEmpty")
          : dirtyLocales.length > 0
            ? t("publishBlockedUnsaved")
            : t("readyToPublish", { version: nextVersionNumber })}
      </p>

      <section aria-labelledby="published-consent-heading" className="mt-8">
        <Card>
          <CardHeader>
            <CardTitle id="published-consent-heading" className="flex items-center gap-2">
              <FileCheck2 />
              {t("publishedTitle")}
            </CardTitle>
            <CardDescription>{t("publishedDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            {publishedVersions.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t("neverPublished")}</p>
            ) : (
              <ul className="divide-y">
                {publishedVersions.map((version) => (
                  <li
                    key={version.id}
                    className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge tone="success">
                        {t("version", { version: version.versionNumber ?? "?" })}
                      </StatusBadge>
                      <span className="text-sm">
                        {version.translations
                          .map((translation) => t(`localeNames.${translation.locale}`))
                          .join(", ")}
                      </span>
                    </div>
                    {version.publishedAt ? (
                      <time
                        dateTime={version.publishedAt}
                        className="text-muted-foreground text-sm"
                      >
                        {dateFormatter.format(new Date(version.publishedAt))}
                      </time>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
