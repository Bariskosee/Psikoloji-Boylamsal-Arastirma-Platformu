"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { Link, useRouter } from "@/i18n/navigation";
import { tokens } from "@lpr/ui";
import type {
  ProtocolDetail,
  ProtocolPreviewResponse,
  ProtocolStepResponse,
  QuestionnaireListResponse,
  StudyResponse,
} from "@lpr/contracts";
import { ApiError, api } from "@/lib/api";
import { ErrorBanner, StatusBadge, styles } from "@/lib/ui";
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
      <div style={styles.page}>
        <p>
          <Link href={`/studies/${studyId}/protocols`}>← {t("backToList")}</Link>
        </p>
        <ErrorBanner>{error}</ErrorBanner>
      </div>
    );
  }

  if (protocol === null) return <p style={styles.page}>{t("loading")}</p>;

  const steps = protocol.draft.steps;
  const nextVersion = (protocol.publishedVersions[0]?.versionNumber ?? 0) + 1;

  return (
    <div style={styles.page}>
      <p>
        <Link href={`/studies/${studyId}/protocols`}>← {t("backToList")}</Link>
      </p>

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <h1 style={{ margin: 0 }}>{protocol.name}</h1>
        <StatusBadge status={t("draft")} />
      </div>

      <ErrorBanner>{error}</ErrorBanner>

      <div
        style={{
          display: "grid",
          // `min(…, 100%)` so the two columns can collapse on a phone instead
          // of forcing the page to scroll sideways.
          gridTemplateColumns: "repeat(auto-fit, minmax(min(380px, 100%), 1fr))",
          gap: tokens.spacing.md,
          marginTop: tokens.spacing.md,
        }}
      >
        <section>
          <h2>{t("steps")}</h2>

          {steps.length === 0 ? <p>{t("noSteps")}</p> : null}

          <ol style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {steps.map((step, index) => (
              <li
                key={step.id}
                style={{
                  border: "1px solid #d8dbe0",
                  borderRadius: tokens.radiusPx,
                  marginBottom: tokens.spacing.sm,
                  background: "#fff",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    flexWrap: "wrap",
                    padding: tokens.spacing.sm,
                  }}
                >
                  <strong style={{ flex: "1 1 auto" }}>
                    {index + 1}. {step.stepKey}
                  </strong>
                  <span style={{ fontSize: 13, color: "#5b6472" }}>
                    {t(`triggers.${step.triggerType}`)}
                    {step.occurrenceCount > 1 ? ` · ×${String(step.occurrenceCount)}` : ""}
                  </span>
                  <button
                    type="button"
                    aria-label={t("moveUp")}
                    disabled={busy || index === 0}
                    onClick={() => void move(step, -1)}
                    style={styles.secondaryButton}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={t("moveDown")}
                    disabled={busy || index === steps.length - 1}
                    onClick={() => void move(step, 1)}
                    style={styles.secondaryButton}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => setOpenStepId(openStepId === step.id ? null : step.id)}
                    style={styles.secondaryButton}
                  >
                    {openStepId === step.id ? t("close") : t("edit")}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void mutate(() => api.delete(`${base}/steps/${step.id}`))}
                    style={styles.secondaryButton}
                  >
                    {t("remove")}
                  </button>
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

          <button
            type="button"
            onClick={() => void addStep()}
            disabled={busy}
            style={styles.button}
          >
            {t("add")} — {t("addStep")}
          </button>

          {confirmingPublish ? (
            <section
              aria-labelledby="protocol-publish-heading"
              style={{ ...styles.card, borderColor: "#b42318", background: "#fffaf9" }}
            >
              <h3 id="protocol-publish-heading" style={{ marginTop: 0 }}>
                {t("publishHeading", { version: nextVersion })}
              </h3>
              <p style={{ marginTop: 0 }}>{t("publishSummary", { count: steps.length })}</p>
              <p style={{ fontWeight: 600 }}>{t("publishImmutableWarning")}</p>
              <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                <span>{t("publishAcknowledge")}</span>
              </label>
              <div style={{ display: "flex", gap: 8, marginTop: tokens.spacing.sm }}>
                <button
                  type="button"
                  disabled={!acknowledged || busy}
                  onClick={() => void publish()}
                  style={styles.button}
                >
                  {busy ? t("publishing") : t("publishConfirm")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmingPublish(false);
                    setAcknowledged(false);
                  }}
                  style={styles.secondaryButton}
                >
                  {t("cancel")}
                </button>
              </div>
            </section>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingPublish(true)}
              disabled={busy || steps.length === 0}
              style={{ ...styles.button, marginTop: tokens.spacing.sm }}
            >
              {t("publishThisVersion")}
            </button>
          )}

          {protocol.publishedVersions.length > 0 ? (
            <section style={styles.card}>
              <h3 style={{ marginTop: 0 }}>{t("publishedVersions")}</h3>
              <ul>
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
              <p style={{ fontSize: 13, color: "#5b6472" }}>{t("publishedVersionsHint")}</p>
            </section>
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
