"use client";

import type {
  Locale,
  LikertConfig,
  MultiChoiceConfig,
  NumericConfig,
  FreeTextConfig,
  QuestionResponse,
} from "@lpr/contracts";
import { tokens } from "@lpr/ui";
import { localizedText } from "@/lib/questionnaire";

/**
 * One question, rendered as the participant will see it.
 *
 * ── Why this is inert ────────────────────────────────────────────────────────
 * Every control is `disabled`. This is a preview of a form, not a form: a
 * researcher clicking a radio here must not create the impression that
 * anything was answered or saved, and Phase 3 explicitly builds no participant
 * runtime (PLAN.md "What NOT to build yet"). The participant renderer in a
 * later phase will re-implement these controls as live inputs; what must match
 * is the LAYOUT and the labels, which is what a researcher is checking.
 *
 * ── Why researcher-entered text is safe here ─────────────────────────────────
 * Question text and option labels are stored and rendered as PLAIN TEXT. They
 * are interpolated as JSX children, which React escapes, and nothing in this
 * file uses `dangerouslySetInnerHTML`. A researcher who types
 * `<script>alert(1)</script>` as a question sees those characters on screen —
 * asserted in `QuestionPreview.test.tsx`, because "we just won't do that" is
 * not a control.
 */
export function QuestionPreview({
  question,
  locale,
  index,
  requiredLabel,
  untranslatedLabel,
  exclusiveLabel,
}: {
  question: QuestionResponse;
  locale: Locale;
  /** 1-based position within the page, as the participant will see it. */
  index: number;
  requiredLabel: string;
  untranslatedLabel: string;
  /** Marks an option flagged mutually exclusive, e.g. "Prefer not to say". */
  exclusiveLabel: string;
}) {
  const text = localizedText(question.translations, locale);

  return (
    <li
      style={{
        listStyle: "none",
        padding: tokens.spacing.md,
        borderBottom: "1px solid #e6e8eb",
      }}
    >
      <p style={{ margin: `0 0 ${tokens.spacing.sm}px`, fontWeight: 600 }}>
        <span style={{ color: "#5b6472", fontWeight: 400 }}>{index}. </span>
        {text ? text.text : <em style={{ color: "#912018" }}>{untranslatedLabel}</em>}
        {question.isRequired ? (
          <span aria-label={requiredLabel} style={{ color: "#b42318" }}>
            {" *"}
          </span>
        ) : null}
      </p>
      <QuestionControl
        question={question}
        locale={locale}
        untranslatedLabel={untranslatedLabel}
        exclusiveLabel={exclusiveLabel}
      />
    </li>
  );
}

function QuestionControl({
  question,
  locale,
  untranslatedLabel,
  exclusiveLabel,
}: {
  question: QuestionResponse;
  locale: Locale;
  untranslatedLabel: string;
  exclusiveLabel: string;
}) {
  switch (question.type) {
    case "SINGLE_CHOICE":
    case "MULTI_CHOICE": {
      const hint =
        question.type === "MULTI_CHOICE"
          ? selectionHint(question.config as MultiChoiceConfig)
          : null;
      return (
        <div>
          {hint ? (
            <p style={{ margin: `0 0 ${tokens.spacing.xs}px`, fontSize: 13, color: "#5b6472" }}>
              {hint.max === null ? `≥ ${hint.min}` : `${hint.min}–${hint.max}`}
            </p>
          ) : null}
          {question.options.map((option) => {
            const label = localizedText(option.translations, locale);
            return (
              <label
                key={option.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: tokens.spacing.sm,
                  minHeight: tokens.touchTargetMinPx,
                }}
              >
                <input
                  type={question.type === "SINGLE_CHOICE" ? "radio" : "checkbox"}
                  name={question.id}
                  disabled
                />
                <span>{label ? label.text : <em>{untranslatedLabel}</em>}</span>
                {/*
                  Marked so the researcher can see which options they flagged as
                  mutually exclusive. Enforcing that at answer time belongs to
                  the participant runtime, which Phase 3 does not build.
                */}
                {option.isExclusive && question.type === "MULTI_CHOICE" ? (
                  <span style={{ fontSize: 12, color: "#5b6472" }}>({exclusiveLabel})</span>
                ) : null}
              </label>
            );
          })}
        </div>
      );
    }

    case "LIKERT": {
      const config = question.config as LikertConfig;
      const points = likertPoints(config);
      return (
        <div>
          <div style={{ display: "flex", gap: tokens.spacing.xs, flexWrap: "wrap" }}>
            {points.map((value) => (
              <label
                key={value}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  minWidth: tokens.touchTargetMinPx,
                  minHeight: tokens.touchTargetMinPx,
                  fontSize: 14,
                }}
              >
                <input type="radio" name={question.id} disabled />
                <span>{value}</span>
              </label>
            ))}
          </div>
          {config.minLabel || config.maxLabel ? (
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 12,
                color: "#5b6472",
              }}
            >
              <span>{config.minLabel}</span>
              <span>{config.maxLabel}</span>
            </div>
          ) : null}
        </div>
      );
    }

    case "NUMERIC": {
      const config = question.config as NumericConfig;
      return (
        <input
          type="number"
          disabled
          min={config.minValue ?? undefined}
          max={config.maxValue ?? undefined}
          step={config.step ?? undefined}
          style={previewInputStyle}
        />
      );
    }

    case "FREE_TEXT": {
      const config = question.config as FreeTextConfig;
      return config.multiline ? (
        <textarea
          disabled
          rows={3}
          maxLength={config.maxLength}
          style={{ ...previewInputStyle, minHeight: 80 }}
        />
      ) : (
        <input type="text" disabled maxLength={config.maxLength} style={previewInputStyle} />
      );
    }
  }
}

const previewInputStyle = {
  width: "100%",
  padding: tokens.spacing.sm,
  fontSize: 16,
  minHeight: tokens.touchTargetMinPx,
  borderRadius: tokens.radiusPx,
  border: "1px solid #b6bcc4",
  background: "#f4f5f7",
  boxSizing: "border-box",
} as const;

/**
 * The scale points, inclusive of both bounds.
 *
 * Capped at 21 points, which is `-10..10` — the widest scale the config schema
 * can express that still fits a phone. A researcher who somehow gets a wider
 * range past validation sees a truncated preview rather than a page that
 * renders two hundred radio buttons.
 */
export function likertPoints(config: Pick<LikertConfig, "minValue" | "maxValue">): number[] {
  const span = Math.min(config.maxValue - config.minValue, 20);
  return Array.from({ length: span + 1 }, (_, offset) => config.minValue + offset);
}

/** Selection-count hint for a multi-choice question, or null when unbounded. */
export function selectionHint(
  config: MultiChoiceConfig,
): { min: number; max: number | null } | null {
  if (config.minSelections === 0 && config.maxSelections === null) return null;
  return { min: config.minSelections, max: config.maxSelections };
}
