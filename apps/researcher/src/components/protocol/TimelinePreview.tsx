"use client";

import { useTranslations } from "next-intl";
import { tokens } from "@lpr/ui";
import type { ProtocolPreviewResponse, PreviewStep } from "@lpr/contracts";
import { styles } from "@/lib/ui";

/** Occurrences shown in full before collapsing; a thirty-day block is common. */
const OCCURRENCES_SHOWN = 4;

/**
 * The timeline preview.
 *
 * PLAN.md Phase 4 calls this "the researcher's only defence against
 * misconfiguring a study", which is why it renders what the SERVER computed
 * with the scheduler's own functions rather than anything derived here. A
 * second implementation in the browser could agree with the builder and
 * disagree with what participants receive.
 *
 * The dependency label is FR-48b. It is informational, never a refusal —
 * conditioning a follow-up on a baseline is legitimate — but a researcher
 * should be able to see, before publishing, which measurements a participant
 * can lose by not completing something earlier.
 */
export function TimelinePreview({
  preview,
  enrolledAt,
  participantTimezone,
  busy,
  onEnrolledAtChange,
  onParticipantTimezoneChange,
  onRefresh,
}: {
  preview: ProtocolPreviewResponse | null;
  enrolledAt: string;
  participantTimezone: string;
  busy: boolean;
  onEnrolledAtChange: (value: string) => void;
  onParticipantTimezoneChange: (value: string) => void;
  onRefresh: () => void;
}) {
  const t = useTranslations("protocols");

  return (
    <section style={styles.card}>
      <h2 style={{ marginTop: 0 }}>{t("preview.title")}</h2>
      <p style={{ fontSize: 14, color: "var(--muted-foreground)", marginTop: 0 }}>
        {t("preview.hint")}
      </p>

      <div style={{ display: "flex", gap: tokens.spacing.md, flexWrap: "wrap" }}>
        <div style={styles.field}>
          <label htmlFor="preview-enrolled" style={styles.label}>
            {t("preview.enrolledAt")}
          </label>
          <input
            id="preview-enrolled"
            type="datetime-local"
            value={enrolledAt}
            onChange={(event) => onEnrolledAtChange(event.target.value)}
            style={{ ...styles.input, maxWidth: 260 }}
          />
        </div>
        <div style={styles.field}>
          <label htmlFor="preview-timezone" style={styles.label}>
            {t("preview.participantTimezone")}
          </label>
          <input
            id="preview-timezone"
            type="text"
            value={participantTimezone}
            onChange={(event) => onParticipantTimezoneChange(event.target.value)}
            style={{ ...styles.input, maxWidth: 260 }}
          />
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={busy}
          style={{
            ...styles.secondaryButton,
            alignSelf: "flex-end",
            marginBottom: tokens.spacing.md,
          }}
        >
          {t("preview.refresh")}
        </button>
      </div>

      {preview === null ? null : (
        <>
          <p style={{ fontWeight: 600 }}>
            {t("preview.totalSessions", { count: preview.totalOccurrences })}
          </p>
          <ol style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {preview.steps.map((step) => (
              <PreviewedStep key={step.stepId} step={step} />
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

function PreviewedStep({ step }: { step: PreviewStep }) {
  const t = useTranslations("protocols");
  const conditional = step.dependency === "CONDITIONAL";
  const dependsOn = step.dependsOnCompletionOf.join(", ");

  return (
    <li
      style={{
        border: "1px solid var(--border)",
        borderRadius: tokens.radiusPx,
        padding: tokens.spacing.sm,
        marginBottom: tokens.spacing.sm,
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <strong>{step.stepKey}</strong>
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            padding: "2px 8px",
            borderRadius: 999,
            border: `1px solid ${conditional ? "var(--warning-muted-foreground)" : "var(--input)"}`,
            background: conditional ? "var(--warning-muted)" : "var(--muted)",
            color: conditional ? "var(--warning-muted-foreground)" : "var(--foreground)",
          }}
        >
          {conditional
            ? t("preview.conditional", { steps: dependsOn })
            : t("preview.unconditional")}
        </span>
      </div>

      {conditional ? (
        <p style={{ fontSize: 13, color: "var(--warning-muted-foreground)", margin: "6px 0 0" }}>
          {t("preview.conditionalHint", { steps: dependsOn })}
        </p>
      ) : null}

      {step.occurrences === null ? (
        <p style={{ fontSize: 14, color: "var(--muted-foreground)", margin: "6px 0 0" }}>
          {step.unresolvedReason === null ? null : t(`preview.unresolved.${step.unresolvedReason}`)}
        </p>
      ) : (
        <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 14 }}>
          {step.occurrences.slice(0, OCCURRENCES_SHOWN).map((occurrence) => (
            <li key={occurrence.occurrenceIndex}>
              {t("preview.occurrenceLine", {
                index: occurrence.occurrenceIndex,
                from: formatInstant(occurrence.availableFrom),
                until: formatInstant(occurrence.availableUntil),
              })}
              {occurrence.adjustment === "NONE" ? null : (
                // Surfaced rather than silently handled: a schedule that lands
                // on a clock change is something the researcher should see.
                <span style={{ color: "var(--warning-muted-foreground)" }}>
                  {" "}
                  {t(`preview.adjustment.${occurrence.adjustment}`)}
                </span>
              )}
            </li>
          ))}
          {step.occurrences.length > OCCURRENCES_SHOWN ? (
            <li style={{ color: "var(--muted-foreground)" }}>
              {t("preview.andMore", { count: step.occurrences.length - OCCURRENCES_SHOWN })}
            </li>
          ) : null}
        </ul>
      )}
    </li>
  );
}

/**
 * Rendered in UTC with the offset shown.
 *
 * The researcher is reasoning about a participant in another zone, so silently
 * formatting in the browser's would answer a question nobody asked.
 */
function formatInstant(iso: string): string {
  return new Date(iso).toISOString().replace("T", " ").replace(".000Z", "Z");
}
