"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { tokens } from "@lpr/ui";
import {
  ANCHOR_TIMEZONE_SOURCES,
  QUIET_HOURS_BEHAVIORS,
  STEP_KINDS,
  TRIGGER_TYPES,
  isStepReferencingTrigger,
  type AnchorTimezoneSource,
  type ProtocolStepResponse,
  type QuietHoursBehavior,
  type ReminderPolicyInput,
  type StepKind,
  type TriggerType,
} from "@lpr/contracts";
import { styles } from "@/lib/ui";

export interface QuestionnaireChoice {
  readonly versionId: string;
  readonly label: string;
}

/**
 * The per-step editor.
 *
 * Fields appear only when they mean something: a wall-clock anchor's zone
 * appears once a time is set, an occurrence index once the referenced step
 * repeats, a recurrence interval once the count is above one. The alternative —
 * showing everything always — asks the researcher to know which combinations
 * are legal, and the server's cross-field rules would then read as arbitrary
 * rejections.
 *
 * Each change is committed on blur, as in the questionnaire builder, and the
 * server re-validates the whole merged row rather than the patch.
 */
export function StepEditor({
  step,
  siblings,
  questionnaires,
  disabled,
  onPatch,
}: {
  step: ProtocolStepResponse;
  /** Every other step in the draft, for the trigger's target selector. */
  siblings: readonly ProtocolStepResponse[];
  questionnaires: readonly QuestionnaireChoice[];
  disabled: boolean;
  onPatch: (patch: Record<string, unknown>) => void;
}) {
  const t = useTranslations("protocols");

  const referencesStep = isStepReferencingTrigger(step.triggerType);
  const target = siblings.find((sibling) => sibling.id === step.triggerStepId);
  const targetRepeats = (target?.occurrenceCount ?? 1) > 1;

  return (
    <div style={{ padding: tokens.spacing.md, background: "var(--muted)" }}>
      <Field label={t("stepKey")} hint={t("stepKeyHint")}>
        <TextCommit
          value={step.stepKey}
          disabled={disabled}
          onCommit={(value) => {
            if (value.trim() && value !== step.stepKey) onPatch({ stepKey: value.trim() });
          }}
        />
      </Field>

      <Field label={t("questionnaire")} hint={t("questionnaireHint")}>
        <select
          value={step.questionnaireVersionId}
          disabled={disabled}
          onChange={(event) => onPatch({ questionnaireVersionId: event.target.value })}
          style={styles.input}
        >
          {questionnaires.map((choice) => (
            <option key={choice.versionId} value={choice.versionId}>
              {choice.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label={t("trigger")}>
        <select
          value={step.triggerType}
          disabled={disabled}
          onChange={(event) => onPatch(triggerPatch(event.target.value as TriggerType, siblings))}
          style={styles.input}
        >
          {TRIGGER_TYPES.map((type) => (
            <option key={type} value={type}>
              {t(`triggers.${type}`)}
            </option>
          ))}
        </select>
      </Field>

      {referencesStep ? (
        <Field label={t("triggerStep")}>
          <select
            value={step.triggerStepId ?? ""}
            disabled={disabled}
            onChange={(event) =>
              onPatch({ triggerStepId: event.target.value, triggerOccurrenceIndex: null })
            }
            style={styles.input}
          >
            {siblings.map((sibling) => (
              <option key={sibling.id} value={sibling.id}>
                {sibling.stepKey}
              </option>
            ))}
          </select>
        </Field>
      ) : null}

      {/*
        Shown only when the target repeats, because that is exactly when FR-48a
        makes it required — asking for it otherwise would be asking for a value
        the server refuses.
      */}
      {referencesStep && targetRepeats ? (
        <Field label={t("triggerOccurrence")}>
          <input
            type="number"
            min={0}
            max={(target?.occurrenceCount ?? 1) - 1}
            value={step.triggerOccurrenceIndex ?? 0}
            disabled={disabled}
            onChange={(event) =>
              onPatch({ triggerOccurrenceIndex: Number.parseInt(event.target.value, 10) })
            }
            style={{ ...styles.input, maxWidth: 140 }}
          />
        </Field>
      ) : null}

      {step.triggerType === "FIXED_DATETIME" ? (
        <Field label={t("triggerFixedDate")} hint={t("triggerFixedDateHint")}>
          <input
            type="date"
            value={step.triggerFixedDate ?? ""}
            disabled={disabled}
            onChange={(event) => onPatch({ triggerFixedDate: event.target.value })}
            style={{ ...styles.input, maxWidth: 220 }}
          />
        </Field>
      ) : null}

      <Field label={t("offset")} hint={t("offsetHint")}>
        <TextCommit
          value={step.offsetIso}
          disabled={disabled}
          onCommit={(value) => {
            if (value.trim() && value !== step.offsetIso) onPatch({ offsetIso: value.trim() });
          }}
        />
      </Field>

      <Field label={t("anchorLocalTime")} hint={t("anchorLocalTimeHint")}>
        <input
          type="time"
          value={step.anchorLocalTime ?? ""}
          disabled={disabled}
          onChange={(event) => {
            const value = event.target.value;
            // The zone travels with the time: a local time with nothing to read
            // it in is not an instant, and the server rejects the pair split.
            onPatch(
              value === ""
                ? { anchorLocalTime: null, anchorTimezoneSource: null }
                : {
                    anchorLocalTime: value,
                    anchorTimezoneSource: step.anchorTimezoneSource ?? "PARTICIPANT",
                  },
            );
          }}
          style={{ ...styles.input, maxWidth: 180 }}
        />
      </Field>

      {step.anchorLocalTime !== null ? (
        <Field label={t("anchorTimezoneSource")}>
          <select
            value={step.anchorTimezoneSource ?? "PARTICIPANT"}
            disabled={disabled}
            onChange={(event) =>
              onPatch({ anchorTimezoneSource: event.target.value as AnchorTimezoneSource })
            }
            style={styles.input}
          >
            {ANCHOR_TIMEZONE_SOURCES.map((source) => (
              <option key={source} value={source}>
                {t(`timezoneSources.${source}`)}
              </option>
            ))}
          </select>
        </Field>
      ) : null}

      <Field label={t("window")} hint={t("windowHint")}>
        <TextCommit
          value={step.windowDurationIso}
          disabled={disabled}
          onCommit={(value) => {
            if (value.trim() && value !== step.windowDurationIso) {
              onPatch({ windowDurationIso: value.trim() });
            }
          }}
        />
      </Field>

      <div style={{ display: "flex", gap: tokens.spacing.md, flexWrap: "wrap" }}>
        <Field label={t("occurrenceCount")}>
          <input
            type="number"
            min={1}
            value={step.occurrenceCount}
            disabled={disabled}
            onChange={(event) => {
              const count = Math.max(1, Number.parseInt(event.target.value, 10) || 1);
              onPatch({
                occurrenceCount: count,
                // An interval is required above one and forbidden at one, so it
                // is set and cleared with the count rather than separately.
                recurrenceIntervalIso: count > 1 ? (step.recurrenceIntervalIso ?? "P1D") : null,
              });
            }}
            style={{ ...styles.input, maxWidth: 140 }}
          />
        </Field>

        {step.occurrenceCount > 1 ? (
          <Field label={t("recurrenceInterval")}>
            <TextCommit
              value={step.recurrenceIntervalIso ?? ""}
              disabled={disabled}
              onCommit={(value) => {
                if (value.trim() && value !== step.recurrenceIntervalIso) {
                  onPatch({ recurrenceIntervalIso: value.trim() });
                }
              }}
            />
          </Field>
        ) : null}
      </div>

      <Field label={t("stepKind")}>
        <select
          value={step.stepKind}
          disabled={disabled}
          onChange={(event) => onPatch({ stepKind: event.target.value as StepKind })}
          style={styles.input}
        >
          {STEP_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {t(`stepKinds.${kind}`)}
            </option>
          ))}
        </select>
      </Field>

      <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
        <input
          type="checkbox"
          checked={step.countsTowardCompliance}
          disabled={disabled}
          onChange={(event) => onPatch({ countsTowardCompliance: event.target.checked })}
        />
        <span>{t("countsTowardCompliance")}</span>
      </label>

      <ReminderPolicyEditor
        policy={step.reminderPolicy}
        disabled={disabled}
        onChange={(policy) => onPatch({ reminderPolicy: policy })}
      />
    </div>
  );
}

/**
 * The reminder policy editor (FR-40).
 *
 * `maxReminders` has no default and is always visible, because the cap is the
 * only thing that makes "how many times will this person be contacted?"
 * answerable before the study runs.
 */
function ReminderPolicyEditor({
  policy,
  disabled,
  onChange,
}: {
  policy: ProtocolStepResponse["reminderPolicy"];
  disabled: boolean;
  onChange: (policy: ReminderPolicyInput | null) => void;
}) {
  const t = useTranslations("protocols");

  const patch = (change: Partial<ReminderPolicyInput>): void => {
    if (!policy) return;
    onChange({
      initialDelayIso: policy.initialDelayIso,
      intervalIso: policy.intervalIso,
      maxReminders: policy.maxReminders,
      quietHoursStart: policy.quietHoursStart,
      quietHoursEnd: policy.quietHoursEnd,
      quietHoursBehavior: policy.quietHoursBehavior,
      ...change,
    });
  };

  return (
    <fieldset style={{ ...styles.card, marginTop: tokens.spacing.md }}>
      <legend style={styles.label}>{t("reminders")}</legend>

      <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
        <input
          type="checkbox"
          checked={policy !== null}
          disabled={disabled}
          onChange={(event) =>
            onChange(
              event.target.checked
                ? {
                    // Neutral starting values the researcher is expected to
                    // replace. Nothing here is a platform default: the step
                    // simply has to hold a valid policy the moment it has one.
                    initialDelayIso: "PT1H",
                    intervalIso: "PT4H",
                    maxReminders: 1,
                    quietHoursStart: null,
                    quietHoursEnd: null,
                    quietHoursBehavior: "DEFER",
                  }
                : null,
            )
          }
        />
        <span>{policy === null ? t("remindersNone") : t("remindersEnable")}</span>
      </label>

      {policy === null ? null : (
        <>
          <div style={{ display: "flex", gap: tokens.spacing.md, flexWrap: "wrap" }}>
            <Field label={t("initialDelay")}>
              <TextCommit
                value={policy.initialDelayIso}
                disabled={disabled}
                onCommit={(value) => {
                  if (value.trim()) patch({ initialDelayIso: value.trim() });
                }}
              />
            </Field>
            <Field label={t("reminderInterval")}>
              <TextCommit
                value={policy.intervalIso}
                disabled={disabled}
                onCommit={(value) => {
                  if (value.trim()) patch({ intervalIso: value.trim() });
                }}
              />
            </Field>
            <Field label={t("maxReminders")} hint={t("maxRemindersHint")}>
              <input
                type="number"
                min={0}
                max={20}
                value={policy.maxReminders}
                disabled={disabled}
                onChange={(event) =>
                  patch({ maxReminders: Number.parseInt(event.target.value, 10) || 0 })
                }
                style={{ ...styles.input, maxWidth: 120 }}
              />
            </Field>
          </div>

          <div style={{ display: "flex", gap: tokens.spacing.md, flexWrap: "wrap" }}>
            <Field label={t("quietHoursStart")}>
              <input
                type="time"
                value={policy.quietHoursStart ?? ""}
                disabled={disabled}
                onChange={(event) => {
                  const value = event.target.value === "" ? null : event.target.value;
                  // Both or neither: a start without an end does not describe
                  // an interval, and the sender would have to invent the rest.
                  patch({
                    quietHoursStart: value,
                    quietHoursEnd: value === null ? null : policy.quietHoursEnd,
                  });
                }}
                style={{ ...styles.input, maxWidth: 160 }}
              />
            </Field>
            <Field label={t("quietHoursEnd")}>
              <input
                type="time"
                value={policy.quietHoursEnd ?? ""}
                disabled={disabled || policy.quietHoursStart === null}
                onChange={(event) =>
                  patch({ quietHoursEnd: event.target.value === "" ? null : event.target.value })
                }
                style={{ ...styles.input, maxWidth: 160 }}
              />
            </Field>
            <Field label={t("quietHoursBehavior")}>
              <select
                value={policy.quietHoursBehavior}
                disabled={disabled}
                onChange={(event) =>
                  patch({ quietHoursBehavior: event.target.value as QuietHoursBehavior })
                }
                style={styles.input}
              >
                {QUIET_HOURS_BEHAVIORS.map((behavior) => (
                  <option key={behavior} value={behavior}>
                    {t(`quietBehaviors.${behavior}`)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </>
      )}
    </fieldset>
  );
}

/**
 * Changing the trigger type carries the fields that only make sense for the new
 * one, and clears the rest. Left alone, the server would reject the row for
 * carrying a leftover the new trigger has no use for.
 */
function triggerPatch(
  type: TriggerType,
  siblings: readonly ProtocolStepResponse[],
): Record<string, unknown> {
  const referencesStep = isStepReferencingTrigger(type);
  return {
    triggerType: type,
    triggerStepId: referencesStep ? (siblings[0]?.id ?? null) : null,
    triggerOccurrenceIndex: null,
    triggerFixedDate: type === "FIXED_DATETIME" ? new Date().toISOString().slice(0, 10) : null,
  };
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={styles.field}>
      <span style={styles.label}>{label}</span>
      {children}
      {hint === undefined ? null : (
        <p style={{ fontSize: 13, color: "var(--muted-foreground)", margin: "4px 0 0" }}>{hint}</p>
      )}
    </div>
  );
}

/** Commit on blur, so a half-typed ISO duration is never sent. */
function TextCommit({
  value,
  disabled,
  onCommit,
}: {
  value: string;
  disabled: boolean;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);

  return (
    <input
      type="text"
      value={draft}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => onCommit(draft)}
      style={styles.input}
    />
  );
}
