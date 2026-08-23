"use client";

import { useTranslations } from "next-intl";
import { tokens } from "@lpr/ui";
import type { RuntimeQuestion } from "@lpr/contracts";
import { styles } from "@/lib/ui";

export interface AnswerValue {
  valueNumber: number | null;
  valueText: string | null;
  selectedOptionIds: string[];
}

export const EMPTY_ANSWER: AnswerValue = {
  valueNumber: null,
  valueText: null,
  selectedOptionIds: [],
};

/**
 * The five question types, rendered for a phone.
 *
 * Native controls throughout — radio, checkbox, number, textarea. A custom
 * control would have to reimplement focus, keyboard, and screen-reader
 * behaviour that participants' assistive technology already knows (NFR-15),
 * and this is the surface where getting that wrong costs a response.
 *
 * Every option is a full-width label wrapping its input, so the tap target is
 * the whole row rather than a 20px circle.
 *
 * ── Why the question text is passed in as an ID (Phase 12, NFR-15) ──────────
 * The question itself is rendered by the page, above this component. Without a
 * link back to it, none of these controls carries the question in its
 * accessible name: a free-text box announces as "edit text, blank", and a
 * participant arrowing onto the third radio hears "Somewhat" with no idea which
 * item it belongs to. They can answer the wrong question, and nothing
 * downstream can tell that it happened.
 *
 * `labelledBy` is the id of the element holding the question text. Text inputs
 * point at it directly; choice questions expose a labelled group, so the
 * question is announced once on entry rather than repeated on every option.
 */
export function QuestionInput({
  question,
  labelledBy,
  value,
  disabled,
  onChange,
}: {
  question: RuntimeQuestion;
  /** Id of the element rendering the question text. */
  labelledBy: string;
  value: AnswerValue;
  disabled: boolean;
  onChange: (value: AnswerValue) => void;
}) {
  const t = useTranslations("runtime");

  switch (question.type) {
    case "SINGLE_CHOICE":
      return (
        <div role="radiogroup" aria-labelledby={labelledBy}>
          {question.options.map((option) => (
            <Row key={option.id}>
              <input
                type="radio"
                name={question.id}
                checked={value.selectedOptionIds[0] === option.id}
                disabled={disabled}
                onChange={() => onChange({ ...EMPTY_ANSWER, selectedOptionIds: [option.id] })}
                style={CONTROL}
              />
              <span>{option.label}</span>
            </Row>
          ))}
          {/*
            A radio group cannot be un-set by clicking, so an optional question
            needs an explicit way back to "no answer".
          */}
          {question.isRequired || value.selectedOptionIds.length === 0 ? null : (
            <button
              type="button"
              onClick={() => onChange(EMPTY_ANSWER)}
              disabled={disabled}
              style={{ ...styles.secondaryButton, marginTop: tokens.spacing.sm }}
            >
              {t("clear")}
            </button>
          )}
        </div>
      );

    case "MULTI_CHOICE":
      return (
        /*
         * `group`, not `radiogroup`: checkboxes are independent, and announcing
         * them as a radio group would tell a screen-reader user that choosing
         * one clears the others — the opposite of what this control does.
         */
        <div role="group" aria-labelledby={labelledBy}>
          {question.options.map((option) => {
            const checked = value.selectedOptionIds.includes(option.id);
            return (
              <Row key={option.id}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => {
                    // An exclusive option clears the rest and is cleared by
                    // any other — "none of the above" alongside three answers
                    // is not something a researcher can interpret.
                    if (option.isExclusive) {
                      onChange({
                        ...EMPTY_ANSWER,
                        selectedOptionIds: checked ? [] : [option.id],
                      });
                      return;
                    }
                    const exclusiveIds = new Set(
                      question.options.filter((o) => o.isExclusive).map((o) => o.id),
                    );
                    const kept = value.selectedOptionIds.filter((id) => !exclusiveIds.has(id));
                    onChange({
                      ...EMPTY_ANSWER,
                      selectedOptionIds: checked
                        ? kept.filter((id) => id !== option.id)
                        : [...kept, option.id],
                    });
                  }}
                  style={CONTROL}
                />
                <span>{option.label}</span>
              </Row>
            );
          })}
        </div>
      );

    case "LIKERT": {
      const min = numberFrom(question.config, "minValue") ?? 1;
      const max = numberFrom(question.config, "maxValue") ?? 5;
      const minLabel = textFrom(question.config, "minLabel");
      const maxLabel = textFrom(question.config, "maxLabel");
      const points = Array.from({ length: max - min + 1 }, (_, index) => min + index);

      return (
        <div role="radiogroup" aria-labelledby={labelledBy}>
          <div style={{ display: "flex", gap: tokens.spacing.xs, flexWrap: "wrap" }}>
            {points.map((point) => (
              <label
                key={point}
                style={{
                  flex: "1 1 56px",
                  minWidth: 56,
                  minHeight: tokens.touchTargetMinPx,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 4,
                  border: `1px solid ${value.valueNumber === point ? "#1f2a37" : "#858c96"}`,
                  background: value.valueNumber === point ? "#1f2a37" : "#fff",
                  color: value.valueNumber === point ? "#fff" : "#1f2a37",
                  borderRadius: tokens.radiusPx,
                  padding: tokens.spacing.xs,
                  cursor: "pointer",
                }}
              >
                <input
                  type="radio"
                  name={question.id}
                  checked={value.valueNumber === point}
                  disabled={disabled}
                  /*
                   * The end points carry their anchor text in the accessible
                   * name. A scale announced as "1, 2, 3, 4, 5" tells a
                   * screen-reader user nothing about which end means what, and
                   * the anchors below are rendered as sighted-only text.
                   */
                  aria-label={
                    point === min && minLabel !== ""
                      ? `${String(point)} — ${minLabel}`
                      : point === max && maxLabel !== ""
                        ? `${String(point)} — ${maxLabel}`
                        : String(point)
                  }
                  onChange={() => onChange({ ...EMPTY_ANSWER, valueNumber: point })}
                  // Visually hidden, not removed: the radio is what a screen
                  // reader announces and what the keyboard drives.
                  style={{ position: "absolute", opacity: 0, width: 1, height: 1 }}
                />
                <span style={{ fontSize: 18, fontWeight: 600 }}>{point}</span>
              </label>
            ))}
          </div>
          {minLabel || maxLabel ? (
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 14,
                color: "#5b6472",
                marginTop: 4,
              }}
            >
              <span>{minLabel}</span>
              <span>{maxLabel}</span>
            </div>
          ) : null}
        </div>
      );
    }

    case "NUMERIC": {
      const min = numberFrom(question.config, "minValue");
      const max = numberFrom(question.config, "maxValue");
      const step = numberFrom(question.config, "step");

      return (
        <input
          type="number"
          value={value.valueNumber ?? ""}
          disabled={disabled}
          // The question, not the placeholder. A placeholder vanishes the
          // moment the participant types and is not an accessible name.
          aria-labelledby={labelledBy}
          placeholder={t("numberPlaceholder")}
          // `decimal` rather than `numeric`: it brings up a keypad that has a
          // separator, which a step of 0.5 needs.
          inputMode={step !== null && !Number.isInteger(step) ? "decimal" : "numeric"}
          min={min ?? undefined}
          max={max ?? undefined}
          step={step ?? undefined}
          onChange={(event) =>
            onChange({
              ...EMPTY_ANSWER,
              valueNumber: event.target.value === "" ? null : Number(event.target.value),
            })
          }
          style={styles.input}
        />
      );
    }

    case "FREE_TEXT": {
      const maxLength = numberFrom(question.config, "maxLength") ?? 1000;
      const multiline = question.config["multiline"] !== false;
      const shared = {
        value: value.valueText ?? "",
        disabled,
        "aria-labelledby": labelledBy,
        maxLength,
        placeholder: t("textPlaceholder"),
        onChange: (event: { target: { value: string } }) =>
          onChange({ ...EMPTY_ANSWER, valueText: event.target.value }),
        style: styles.input,
      };

      return multiline ? (
        <textarea {...shared} rows={4} style={{ ...styles.input, minHeight: 110 }} />
      ) : (
        <input type="text" {...shared} />
      );
    }
  }
}

const CONTROL = { width: 24, height: 24, flex: "0 0 auto" } as const;

function Row({ children }: { children: React.ReactNode }) {
  return (
    <label
      style={{
        display: "flex",
        gap: tokens.spacing.sm,
        alignItems: "center",
        // The whole row is the tap target, not the 24px control inside it.
        minHeight: tokens.touchTargetMinPx,
        padding: `${String(tokens.spacing.xs)}px 0`,
        fontSize: 16,
        cursor: "pointer",
      }}
    >
      {children}
    </label>
  );
}

function numberFrom(config: Record<string, unknown>, key: string): number | null {
  const value = config[key];
  return typeof value === "number" ? value : null;
}

function textFrom(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  return typeof value === "string" ? value : "";
}
