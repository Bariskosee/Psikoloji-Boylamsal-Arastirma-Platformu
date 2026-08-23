"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { Link, useRouter } from "@/i18n/navigation";
import type {
  ProtocolDetail,
  ProtocolPreviewResponse,
  ProtocolStepResponse,
  QuestionnaireListResponse,
  StudyResponse,
} from "@lpr/contracts";
import { ApiError, api } from "@/lib/api";
import { ArrowDown, ArrowUp, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { EmptyState, ErrorBanner, ErrorState, LoadingCards } from "@/components/ui/states";
import { cn } from "@/lib/utils";
import { StepEditor, type QuestionnaireChoice } from "@/components/protocol/StepEditor";
import { TimelinePreview } from "@/components/protocol/TimelinePreview";

/**
 * The protocol builder.
 *
 * Step list and per-step editor on the left, the timeline preview on the right.
 * The preview is refreshed from the server after every mutation, because it is
 * the only surface that shows what the configuration actually *does*, and a
 * stale one is worse than none — it would confirm a schedule the researcher no
 * longer has.
 */
export default function ProtocolBuilderPage() {
  const t = useTranslations("protocols");
  const router = useRouter();
  const params = useParams<{ studyId: string; protocolId: string }>();
  const studyId = params?.studyId ?? "";
  const protocolId = params?.protocolId ?? "";

  const [protocol, setProtocol] = useState<ProtocolDetail | null>(null);
  const [study, setStudy] = useState<StudyResponse | null>(null);
  const [questionnaires, setQuestionnaires] = useState<QuestionnaireChoice[]>([]);
  const [preview, setPreview] = useState<ProtocolPreviewResponse | null>(null);
  const [openStepId, setOpenStepId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [confirmingPublish, setConfirmingPublish] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  const [enrolledAt, setEnrolledAt] = useState(() => new Date().toISOString().slice(0, 16));
  const [participantTimezone, setParticipantTimezone] = useState("");

  const base = `/api/studies/${studyId}/protocols/${protocolId}`;

  const runPreview = useCallback(
    async (timezoneFallback: string) => {
      try {
        const zone = participantTimezone.trim() || timezoneFallback;
        const result = await api.post<ProtocolPreviewResponse>(`${base}/preview`, {
          enrolledAt: new Date(enrolledAt).toISOString(),
          participantTimezone: zone === "" ? null : zone,
          completions: {},
        });
        setPreview(result);
      } catch {
        // A draft mid-edit often cannot be previewed; that is not an error
        // worth interrupting the researcher with.
        setPreview(null);
      }
    },
    [base, enrolledAt, participantTimezone],
  );

  const load = useCallback(async () => {
    try {
      const [detail, loadedStudy, list] = await Promise.all([
        api.get<ProtocolDetail>(base),
        api.get<StudyResponse>(`/api/studies/${studyId}`),
        api.get<QuestionnaireListResponse>(`/api/studies/${studyId}/questionnaires`),
      ]);
      setProtocol(detail);
      setStudy(loadedStudy);
      setQuestionnaires(
        list.questionnaires
          .filter((questionnaire) => questionnaire.latestPublished !== null)
          .map((questionnaire) => ({
            versionId: questionnaire.latestPublished?.id ?? "",
            label: `${questionnaire.name} v${String(questionnaire.latestPublished?.versionNumber ?? "?")}`,
          })),
      );
      setError(null);
      setStatus("ready");
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        router.push("/login");
        return;
      }
      const denied = caught instanceof ApiError && (caught.status === 403 || caught.status === 404);
      setError(denied ? t("errors.forbidden") : t("errors.load"));
      setStatus("error");
    }
  }, [base, router, studyId, t]);

  useEffect(() => {
    if (studyId && protocolId) void load();
  }, [load, studyId, protocolId]);

  /**
   * The preview is its own effect, keyed on the protocol and the hypothetical
   * participant.
   *
   * Folding it into `load` would make the whole protocol refetch on every
   * keystroke in the enrolment field, because `runPreview` changes with those
   * inputs. Separating them lets each run when its own inputs change.
   */
  useEffect(() => {
    if (status !== "ready") return;
    void runPreview(study?.timezone ?? "");
  }, [runPreview, status, study?.timezone]);

  async function mutate(run: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await run();
      const detail = await api.get<ProtocolDetail>(base);
      setProtocol(detail);
      await runPreview(study?.timezone ?? "");
    } catch (caught) {
      setError(messageFor(caught, t));
    } finally {
      setBusy(false);
    }
  }

  async function addStep() {
    const first = questionnaires[0];
    if (!first) {
      setError(t("errors.noPublishedQuestionnaire"));
      return;
    }
    await mutate(() =>
      api.post<ProtocolStepResponse>(`${base}/steps`, {
        stepKey: nextStepKey(protocol?.draft.steps ?? []),
        questionnaireVersionId: first.versionId,
        triggerType: "ENROLLMENT",
        offsetIso: "PT0S",
        windowDurationIso: "P1D",
      }),
    );
  }

  async function move(step: ProtocolStepResponse, delta: number) {
    const steps = protocol?.draft.steps ?? [];
    const from = steps.findIndex((candidate) => candidate.id === step.id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= steps.length) return;

    const order = steps.map((candidate) => candidate.id);
    const [moved] = order.splice(from, 1);
    if (moved !== undefined) order.splice(to, 0, moved);

    await mutate(() => api.put(`${base}/steps/order`, { stepIds: order }));
  }

  async function publish() {
    await mutate(async () => {
      await api.post(`${base}/publish`);
      setConfirmingPublish(false);
      setAcknowledged(false);
    });
  }

  if (status === "error") {
    return (
      <div className="mx-auto max-w-3xl">
        <ErrorState title={error ?? t("errors.save")} />
        <p className="mt-4">
          <Link
            href={`/studies/${studyId}/protocols`}
            className="text-primary text-sm underline-offset-4 hover:underline"
          >
            {t("backToList")}
          </Link>
        </p>
      </div>
    );
  }

  if (protocol === null) {
    return (
      <div className="mx-auto max-w-6xl">
        <LoadingCards count={2} />
      </div>
    );
  }

  const steps = protocol.draft.steps;
  const nextVersion = (protocol.publishedVersions[0]?.versionNumber ?? 0) + 1;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {protocol.name}
            <StatusBadge tone="warning">{t("draft")}</StatusBadge>
          </span>
        }
        description={protocol.description || undefined}
      />

      <ErrorBanner>{error}</ErrorBanner>

      {/*
        `min(…, 100%)` so the two columns can collapse on a phone instead of
        forcing the page to scroll sideways.
      */}
      <div className="grid items-start gap-6 [grid-template-columns:repeat(auto-fit,minmax(min(380px,100%),1fr))]">
        <section aria-labelledby="steps-heading">
          <h2 id="steps-heading" className="mb-3 text-lg font-semibold">
            {t("steps")}
          </h2>

          {steps.length === 0 ? <EmptyState title={t("noSteps")} className="mb-4" /> : null}

          <ol className="mb-4 space-y-2">
            {steps.map((step, index) => (
              <li
                key={step.id}
                className={cn(
                  "bg-card rounded-lg border",
                  openStepId === step.id && "ring-primary/30 ring-2",
                )}
              >
                <div className="flex flex-wrap items-center gap-2 p-2.5">
                  <strong className="flex-1 text-sm">
                    {index + 1}. {step.stepKey}
                  </strong>
                  <span className="text-muted-foreground text-xs whitespace-nowrap">
                    {t(`triggers.${step.triggerType}`)}
                    {step.occurrenceCount > 1 ? ` · ×${String(step.occurrenceCount)}` : ""}
                  </span>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={t("moveUp")}
                      disabled={busy || index === 0}
                      onClick={() => void move(step, -1)}
                    >
                      <ArrowUp />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={t("moveDown")}
                      disabled={busy || index === steps.length - 1}
                      onClick={() => void move(step, 1)}
                    >
                      <ArrowDown />
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setOpenStepId(openStepId === step.id ? null : step.id)}
                    >
                      {openStepId === step.id ? t("close") : t("edit")}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void mutate(() => api.delete(`${base}/steps/${step.id}`))}
                    >
                      {t("remove")}
                    </Button>
                  </div>
                </div>

                {openStepId === step.id ? (
                  <StepEditor
                    step={step}
                    siblings={steps.filter((candidate) => candidate.id !== step.id)}
                    questionnaires={questionnaires}
                    disabled={busy}
                    onPatch={(patch) =>
                      void mutate(() => api.patch(`${base}/steps/${step.id}`, patch))
                    }
                  />
                ) : null}
              </li>
            ))}
          </ol>

          <Button type="button" variant="outline" onClick={() => void addStep()} disabled={busy}>
            <Plus />
            {t("addStep")}
          </Button>

          {confirmingPublish ? (
            /*
              Publishing freezes the protocol permanently, so the confirmation
              is styled as a consequence rather than as a form: destructive
              border, the warning in bold, and an acknowledgement that has to be
              ticked before the button is live.
            */
            <Card
              aria-labelledby="protocol-publish-heading"
              className="border-danger/50 bg-danger-muted/40 mt-6"
            >
              <CardHeader>
                <CardTitle id="protocol-publish-heading" className="text-base">
                  {t("publishHeading", { version: nextVersion })}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm">{t("publishSummary", { count: steps.length })}</p>
                <p className="text-danger-muted-foreground text-sm font-semibold">
                  {t("publishImmutableWarning")}
                </p>
                <Label htmlFor="protocol-ack" className="flex items-start gap-2 font-normal">
                  <Checkbox
                    id="protocol-ack"
                    checked={acknowledged}
                    onCheckedChange={(checked) => setAcknowledged(checked === true)}
                  />
                  <span className="text-sm">{t("publishAcknowledge")}</span>
                </Label>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button
                    type="button"
                    disabled={!acknowledged || busy}
                    onClick={() => void publish()}
                  >
                    {busy ? t("publishing") : t("publishConfirm")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setConfirmingPublish(false);
                      setAcknowledged(false);
                    }}
                  >
                    {t("cancel")}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : (
            <div className="mt-6">
              <Button
                type="button"
                onClick={() => setConfirmingPublish(true)}
                disabled={busy || steps.length === 0}
              >
                {t("publishThisVersion")}
              </Button>
            </div>
          )}

          {protocol.publishedVersions.length > 0 ? (
            <Card className="mt-6">
              <CardHeader>
                <CardTitle className="text-base">{t("publishedVersions")}</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-1 text-sm">
                  {protocol.publishedVersions.map((version) => (
                    <li key={version.id}>
                      {t("versionLine", {
                        version: version.versionNumber ?? 0,
                        count: version.stepCount,
                        at: version.publishedAt ?? "",
                      })}
                    </li>
                  ))}
                </ul>
                <p className="text-muted-foreground mt-3 text-xs">{t("publishedVersionsHint")}</p>
              </CardContent>
            </Card>
          ) : null}
        </section>

        <TimelinePreview
          preview={preview}
          enrolledAt={enrolledAt}
          participantTimezone={participantTimezone}
          busy={busy}
          onEnrolledAtChange={setEnrolledAt}
          onParticipantTimezoneChange={setParticipantTimezone}
          onRefresh={() => void runPreview(study?.timezone ?? "")}
        />
      </div>
    </div>
  );
}

/** `step_1`, `step_2`, … — a placeholder the researcher is expected to rename. */
function nextStepKey(steps: readonly ProtocolStepResponse[]): string {
  const used = new Set(steps.map((step) => step.stepKey));
  for (let index = steps.length + 1; ; index += 1) {
    const candidate = `step_${String(index)}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * Publish refusals get their own message per code.
 *
 * The server sends one code per blocking condition precisely so this can say
 * what to fix in the researcher's language, rather than rendering the API's
 * English `message`.
 */
function messageFor(error: unknown, t: (key: string) => string): string {
  if (!(error instanceof ApiError)) return t("errors.save");

  const known = [
    "PROTOCOL_EMPTY",
    "PROTOCOL_TRIGGER_DANGLING",
    "PROTOCOL_TRIGGER_CYCLE",
    "PROTOCOL_TRIGGER_NEEDS_OCCURRENCE",
    "PROTOCOL_TRIGGER_OCCURRENCE_OUT_OF_RANGE",
    "PROTOCOL_STEP_COMPLETION_OF_RECURRING",
    "PROTOCOL_DUPLICATE_STEP_KEY",
    "QUESTIONNAIRE_VERSION_NOT_PUBLISHED",
  ];

  return known.includes(error.code) ? t(`errors.${error.code}`) : t("errors.save");
}
