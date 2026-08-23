"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { Check, Copy, LineChart } from "lucide-react";
import { toast } from "sonner";
import { Link, useRouter } from "@/i18n/navigation";
import type { StudyOverviewResponse, StudyResponse, StudyStatus } from "@lpr/contracts";
import { ApiError, api, apiUrl } from "@/lib/api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader, StatCard } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { StudyStatusBadge } from "@/components/ui/status-badge";
import { ErrorBanner, ErrorState } from "@/components/ui/states";
import { Textarea } from "@/components/ui/textarea";

/**
 * Study overview: what this study is, whether it is collecting, and how it is
 * going.
 *
 * ── What changed, and why ───────────────────────────────────────────────────
 * This page used to be a settings form with eight text links stapled to the
 * bottom — it was the only route to every other screen, so it had to be, and
 * as a result the first thing a researcher saw on opening a study was a
 * "Name" input. The sidebar now carries navigation, which frees this screen to
 * answer the question people actually arrive with: is it running, and is
 * anybody responding?
 *
 * The compliance snapshot is fetched here for that reason. It is the same
 * endpoint the monitoring screen uses, readable by every role, and three
 * numbers at the top are worth more than a link promising them elsewhere.
 *
 * What the screen OFFERS is still driven by `viewerRole`, and that is
 * presentation only — the server re-checks every operation (NFR-04).
 */
export default function StudyPage() {
  const t = useTranslations("studies");
  const tAnalytics = useTranslations("analytics");
  const router = useRouter();
  const params = useParams<{ studyId: string }>();
  const studyId = params?.studyId ?? "";

  const [study, setStudy] = useState<StudyResponse | null>(null);
  const [overview, setOverview] = useState<StudyOverviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const loaded = await api.get<StudyResponse>(`/api/studies/${studyId}`);
      setStudy(loaded);
      setName(loaded.name);
      setDescription(loaded.description);
      setError(null);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        router.push("/login");
        return;
      }
      // A study the caller cannot see returns the same 404 as one that does
      // not exist, so the interface says the same thing for both.
      setError(t("errors.notFound"));
    }
  }, [router, studyId, t]);

  useEffect(() => {
    if (studyId) void load();
  }, [load, studyId]);

  useEffect(() => {
    if (!studyId) return;
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await api.get<StudyOverviewResponse>(
          `/api/studies/${studyId}/analytics/overview`,
        );
        if (!cancelled) setOverview(loaded);
      } catch {
        // The snapshot is an enhancement. A study whose analytics are
        // unavailable still has settings and an enrollment code, and a second
        // red banner for the same underlying failure is noise.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [studyId]);

  async function copy(value: string, what: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      toast.success(t("copied"));
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      // Clipboard access can be refused; the value is on screen and selectable.
    }
  }

  async function save() {
    setSaving(true);
    setFormError(null);
    try {
      const updated = await api.patch<StudyResponse>(`/api/studies/${studyId}`, {
        name,
        description,
      });
      setStudy(updated);
      // Said out loud. A form that saves silently invites a second click.
      toast.success(t("saved"));
    } catch {
      setFormError(t("errors.save"));
    } finally {
      setSaving(false);
    }
  }

  async function changeStatus(status: StudyStatus) {
    setFormError(null);
    try {
      const updated = await api.put<StudyResponse>(`/api/studies/${studyId}/status`, { status });
      setStudy(updated);
      toast.success(t("statusChanged", { status: t(`statuses.${status}`) }));
    } catch (caught) {
      setFormError(
        caught instanceof ApiError && caught.code === "INVALID_STUDY_TRANSITION"
          ? t("errors.transition")
          : t("errors.save"),
      );
    }
  }

  if (error && !study) {
    return (
      <div className="mx-auto max-w-4xl">
        <ErrorState title={t("errors.notFound")} onRetry={() => void load()} />
        <p className="mt-4">
          <Link href="/studies" className="text-primary text-sm underline-offset-4 hover:underline">
            {t("backToList")}
          </Link>
        </p>
      </div>
    );
  }

  if (!study) {
    return (
      <div className="mx-auto max-w-4xl space-y-6">
        <Skeleton className="h-9 w-72" />
        <div className="grid gap-4 sm:grid-cols-3">
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
        </div>
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  const canEdit = study.viewerRole === "OWNER" || study.viewerRole === "EDITOR";
  const canAdminister = study.viewerRole === "OWNER";
  const transitions = nextStatuses(study.status);

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {study.name}
            <StudyStatusBadge status={study.status} />
          </span>
        }
        description={study.description || undefined}
        actions={
          <Button asChild variant="outline">
            <Link href={`/studies/${studyId}/monitoring`}>
              <LineChart />
              {t("openMonitoring")}
            </Link>
          </Button>
        }
      />

      <ErrorBanner>{formError}</ErrorBanner>

      {!canEdit ? <p className="text-muted-foreground mb-6 text-sm">{t("readOnlyRole")}</p> : null}

      {/*
        The snapshot first. "Is anybody responding?" is the question a
        researcher opens a running study with, and it used to be two clicks and
        a scroll away.
      */}
      <section aria-labelledby="at-a-glance" className="mb-8">
        <h2 id="at-a-glance" className="mb-3 text-sm font-medium">
          {t("atAGlance")}
        </h2>
        {overview ? (
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard
              label={tAnalytics("totalParticipants")}
              value={overview.participants.total}
              hint={`${String(overview.participants.active)} ${tAnalytics("active").toLowerCase()}`}
            />
            <StatCard
              label={tAnalytics("averageCompliance")}
              /*
                Never a zero when there is no denominator. `null` means "not
                applicable yet", and printing 0% for a study whose first
                session has not closed is the single most misleading thing this
                screen could do (docs/compliance-formula.md §5).
              */
              value={
                overview.averageCompliancePercent === null
                  ? tAnalytics("notApplicable")
                  : `${overview.averageCompliancePercent.toFixed(1)}%`
              }
              hint={tAnalytics("averageOver", { count: overview.averageOverParticipants })}
            />
            <StatCard
              label={tAnalytics("sessionsCompleted")}
              value={overview.sessions.completed}
              hint={`${String(overview.sessions.missed)} ${tAnalytics("sessionsMissed").toLowerCase()}`}
            />
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-3">
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-24 rounded-xl" />
          </div>
        )}
      </section>

      {/*
        One card, two columns — not two cards.

        The QR used to live in a card of its own beside this one. In a grid
        row it stretched to the taller of the two and floated in the middle of
        its own white space, and on a phone it collapsed to a small square
        orphaned against the left margin. It belongs to the enrollment
        instructions, so it sits inside them.
      */}
      <Card>
        <CardHeader>
          <CardTitle>{t("enrollment")}</CardTitle>
          <CardDescription>{t("enrollmentHint")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-start justify-between gap-6">
          <div className="min-w-56 flex-1 space-y-4">
            <div>
              <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                {t("code")}
              </p>
              <div className="mt-1 flex items-center gap-2">
                {/*
                  Large and monospaced: this string gets read aloud to
                  participants over the phone, where `l`/`1` and `O`/`0` in a
                  proportional face are a genuine hazard.
                */}
                <code className="font-mono text-2xl font-semibold tracking-widest">
                  {study.enrollmentCode}
                </code>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t("copyCode")}
                  onClick={() => void copy(study.enrollmentCode, "code")}
                >
                  {copied === "code" ? <Check className="text-success" /> : <Copy />}
                </Button>
              </div>
            </div>
            <div className="min-w-0">
              <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                URL
              </p>
              <div className="mt-1 flex items-center gap-2">
                <a
                  href={study.enrollmentUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary min-w-0 truncate text-sm underline-offset-4 hover:underline"
                >
                  {study.enrollmentUrl}
                </a>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t("copyLink")}
                  onClick={() => void copy(study.enrollmentUrl, "url")}
                >
                  {copied === "url" ? <Check className="text-success" /> : <Copy />}
                </Button>
              </div>
            </div>
          </div>

          {/* Fetched by the browser with the session cookie attached. */}
          <img
            src={apiUrl(`/api/studies/${studyId}/qr`)}
            alt={t("qrAlt")}
            width={160}
            height={160}
            className="shrink-0 rounded-md border bg-white p-2"
          />
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>{t("settings")}</CardTitle>
          <CardDescription>{t("settingsHint")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-2">
            <Label htmlFor="name">{t("name")}</Label>
            <Input
              id="name"
              value={name}
              disabled={!canEdit}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="description">{t("description")}</Label>
            <Textarea
              id="description"
              rows={3}
              value={description}
              disabled={!canEdit}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>

          {/*
            The immutable facts, as a definition list rather than as disabled
            inputs. A greyed-out field looks like something you failed to earn
            the right to edit; these were fixed at creation and cannot change
            for anybody, and saying so is kinder than implying a permission
            problem.
          */}
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground text-xs tracking-wide uppercase">
                {t("timezone")}
              </dt>
              <dd className="mt-0.5 font-medium">{study.timezone}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs tracking-wide uppercase">
                {t("locales")}
              </dt>
              <dd className="mt-0.5 font-medium">
                {study.supportedLocales.join(", ")}{" "}
                <span className="text-muted-foreground font-normal">
                  ({t("defaultLocale")}: {study.defaultLocale})
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs tracking-wide uppercase">
                {t("capacity")}
              </dt>
              <dd className="mt-0.5 font-medium">{study.enrollmentCapacity ?? t("uncapped")}</dd>
            </div>
          </dl>
          <p className="text-muted-foreground text-xs">{t("fixedAtCreation")}</p>

          {canEdit ? (
            <Button type="button" onClick={() => void save()} disabled={saving}>
              {saving ? t("saving") : t("save")}
            </Button>
          ) : null}
        </CardContent>
      </Card>

      {canAdminister ? (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>{t("lifecycle")}</CardTitle>
            <CardDescription>{t("lifecycleHint")}</CardDescription>
          </CardHeader>
          <CardContent>
            {transitions.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t("lifecycleTerminal")}</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {transitions.map((status) => (
                  /*
                    Confirmed, every one of them. Closing and archiving are
                    irreversible, activating starts sending notifications to
                    real people, and pausing silently stops a study's data
                    collection. None of those should be one stray click.
                  */
                  <AlertDialog key={status}>
                    <AlertDialogTrigger asChild>
                      {/*
                        All outline, deliberately.

                        A filled button reads as "this is what you came here to
                        do". Pausing a running study is not that, and it was
                        drawn as the most prominent control on the screen.
                        None of these is a default action; a researcher arrives
                        already knowing which one they want.
                      */}
                      <Button type="button" variant="outline">
                        {t(`transitions.${status}`)}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          {t("confirmTransition", { status: t(`statuses.${status}`) })}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          {t("confirmTransitionBody")}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                        <AlertDialogAction onClick={() => void changeStatus(status)}>
                          {t("confirm")}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

/**
 * The transitions to offer.
 *
 * Mirrors `nextStudyStatuses` in @lpr/domain, which the server enforces. This
 * copy decides only which buttons appear; an out-of-date copy produces a
 * rejected request, never an illegal transition.
 */
function nextStatuses(status: StudyStatus): StudyStatus[] {
  switch (status) {
    case "DRAFT":
      return ["ACTIVE", "ARCHIVED"];
    case "ACTIVE":
      return ["PAUSED", "CLOSED"];
    case "PAUSED":
      return ["ACTIVE", "CLOSED"];
    case "CLOSED":
      return ["ARCHIVED"];
    case "ARCHIVED":
      return [];
  }
}
