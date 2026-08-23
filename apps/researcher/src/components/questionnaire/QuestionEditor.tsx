"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type {
  FreeTextConfig,
  LikertConfig,
  Locale,
  MultiChoiceConfig,
  NumericConfig,
  QuestionOptionResponse,
  QuestionResponse,
} from "@lpr/contracts";
import { tokens } from "@lpr/ui";
import { api } from "@/lib/api";
import { styles } from "@/lib/ui";
import { moveItem } from "@/lib/questionnaire";

/**
 * The editor for one drafted question.
 *
 * Every control writes through to the API and then asks the parent to reload,
 * rather than keeping a local copy of the draft. The builder is a
 * multi-researcher surface and the server owns `display_order`, the normalised
 * `config`, and the option list — a client-side mirror of all three is a
 * source of drift for no gain at this scale.
 *
 * Text inputs are the exception: they hold local state while being typed and
 * commit on blur, because a request per keystroke is neither useful nor kind
 * to the database.
 */
export function QuestionEditor({
  question,
  basePath,
  locales,
  disabled,
  onChanged,
  onError,
}: {
  question: QuestionResponse;
  /** `/api/studies/:studyId/questionnaires/:questionnaireId` */
  basePath: string;
  locales: readonly Locale[];
  disabled: boolean;
  onChanged: () => Promise<void> | void;
  onError: (message: string) => void;
}) {
  const t = useTranslations("questionnaires");
  const [busy, setBusy] = useState(false);

  async function mutate(run: () => Promise<unknown>) {
    setBusy(true);
    try {
      await run();
      await onChanged();
    } catch {
      onError(t("errors.save"));
    } finally {
      setBusy(false);
    }
  }

  const patch = (body: Record<string, unknown>) =>
    mutate(() => api.patch(`${basePath}/questions/${question.id}`, body));

  return (
    <div style={{ padding: tokens.spacing.md, background: "var(--muted)" }}>
      <div style={{ display: "flex", gap: tokens.spacing.md, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--muted-foreground)" }}>
          {t(`types.${question.type}`)}
        </span>
        <code style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
          {question.questionKey}
        </code>
      </div>

      {/* ── Text, one field per supported language ───────────────────────── */}
      {locales.map((locale) => (
        <div key={locale} style={styles.field}>
          <label htmlFor={`${question.id}-${locale}`} style={styles.label}>
            {t("questionText")} ({locale.toUpperCase()})
          </label>
          <TextCommit
            id={`${question.id}-${locale}`}
            value={question.translations[locale] ?? ""}
            disabled={disabled || busy}
            multiline
            onCommit={(value) => {
              // An empty string would fail the contract's min(1); clearing a
              // translation is deletion, which Phase 3 does not offer.
              if (!value.trim() || value === (question.translations[locale] ?? "")) return;
              void patch({ translations: { [locale]: value } });
            }}
          />
        </div>
      ))}

      <div style={{ display: "flex", gap: tokens.spacing.lg, flexWrap: "wrap" }}>
        <label style={{ display: "flex", alignItems: "center", gap: tokens.spacing.sm }}>
          <input
            type="checkbox"
            checked={question.isRequired}
            disabled={disabled || busy}
            onChange={(event) => void patch({ isRequired: event.target.checked })}
          />
          {t("required")}
        </label>

        <label style={{ display: "flex", alignItems: "center", gap: tokens.spacing.sm }}>
          {t("page")}
          <input
            type="number"
            min={1}
            value={question.pageIndex + 1}
            disabled={disabled || busy}
            onChange={(event) => {
              const page = Number(event.target.value);
              if (!Number.isFinite(page) || page < 1) return;
              void patch({ pageIndex: page - 1 });
            }}
            style={{ ...styles.input, width: 80 }}
          />
        </label>
      </div>

      <ConfigPanel
        question={question}
        disabled={disabled || busy}
        onCommit={(config) => void patch({ config })}
      />

      {question.type === "SINGLE_CHOICE" || question.type === "MULTI_CHOICE" ? (
        <OptionEditor
          question={question}
          basePath={basePath}
          locales={locales}
          disabled={disabled || busy}
          onChanged={onChanged}
          onError={onError}
        />
      ) : null}
    </div>
  );
}

// ───────────────────────────── Per-type config ──────────────────────────────

/**
 * The type-specific panel.
 *
 * One branch per question type, and the compiler enforces exhaustiveness —
 * adding a sixth type to the contract makes this fail to build, which is the
 * point. Every commit sends the WHOLE config object: the server re-parses it
 * against the type's schema and rejects a partial one.
 */
function ConfigPanel({
  question,
  disabled,
  onCommit,
}: {
  question: QuestionResponse;
  disabled: boolean;
  onCommit: (config: Record<string, unknown>) => void;
}) {
  const t = useTranslations("questionnaires");

  switch (question.type) {
    case "SINGLE_CHOICE":
      return null;

    case "MULTI_CHOICE": {
      const config = question.config as MultiChoiceConfig;
      return (
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>{t("config.selections")}</legend>
          <NumberField
            label={t("config.minSelections")}
            value={config.minSelections}
            min={0}
            disabled={disabled}
            onCommit={(minSelections) => onCommit({ ...config, minSelections: minSelections ?? 0 })}
          />
          <NumberField
            label={t("config.maxSelections")}
            value={config.maxSelections}
            min={1}
            nullable
            disabled={disabled}
            onCommit={(maxSelections) => onCommit({ ...config, maxSelections })}
          />
        </fieldset>
      );
    }

    case "LIKERT": {
      const config = question.config as LikertConfig;
      return (
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>{t("config.scale")}</legend>
          <NumberField
            label={t("config.minValue")}
            value={config.minValue}
            disabled={disabled}
            onCommit={(minValue) => onCommit({ ...config, minValue: minValue ?? 1 })}
          />
          <NumberField
            label={t("config.maxValue")}
            value={config.maxValue}
            disabled={disabled}
            onCommit={(maxValue) => onCommit({ ...config, maxValue: maxValue ?? 5 })}
          />
          <TextField
            label={t("config.minLabel")}
            value={config.minLabel}
            disabled={disabled}
            onCommit={(minLabel) => onCommit({ ...config, minLabel })}
          />
          <TextField
            label={t("config.maxLabel")}
            value={config.maxLabel}
            disabled={disabled}
            onCommit={(maxLabel) => onCommit({ ...config, maxLabel })}
          />
        </fieldset>
      );
    }

    case "NUMERIC": {
      const config = question.config as NumericConfig;
      return (
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>{t("config.range")}</legend>
          <NumberField
            label={t("config.minValue")}
            value={config.minValue}
            nullable
            disabled={disabled}
            onCommit={(minValue) => onCommit({ ...config, minValue })}
          />
          <NumberField
            label={t("config.maxValue")}
            value={config.maxValue}
            nullable
            disabled={disabled}
            onCommit={(maxValue) => onCommit({ ...config, maxValue })}
          />
          <NumberField
            label={t("config.step")}
            value={config.step}
            nullable
            disabled={disabled}
            onCommit={(step) => onCommit({ ...config, step })}
          />
        </fieldset>
      );
    }

    case "FREE_TEXT": {
      const config = question.config as FreeTextConfig;
      return (
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>{t("config.text")}</legend>
          <NumberField
            label={t("config.maxLength")}
            value={config.maxLength}
            min={1}
            disabled={disabled}
            onCommit={(maxLength) => onCommit({ ...config, maxLength: maxLength ?? 1000 })}
          />
          <label style={{ display: "flex", alignItems: "center", gap: tokens.spacing.sm }}>
            <input
              type="checkbox"
              checked={config.multiline}
              disabled={disabled}
              onChange={(event) => onCommit({ ...config, multiline: event.target.checked })}
            />
            {t("config.multiline")}
          </label>
        </fieldset>
      );
    }
  }
}

// ──────────────────────────────── Options ───────────────────────────────────

function OptionEditor({
  question,
  basePath,
  locales,
  disabled,
  onChanged,
  onError,
}: {
  question: QuestionResponse;
  basePath: string;
  locales: readonly Locale[];
  disabled: boolean;
  onChanged: () => Promise<void> | void;
  onError: (message: string) => void;
}) {
  const t = useTranslations("questionnaires");
  const optionPath = `${basePath}/questions/${question.id}/options`;

  async function mutate(run: () => Promise<unknown>) {
    try {
      await run();
      await onChanged();
    } catch {
      onError(t("errors.save"));
    }
  }

  async function move(option: QuestionOptionResponse, delta: number) {
    const ids = question.options.map((o) => o.id);
    const from = ids.indexOf(option.id);
    const to = from + delta;
    if (to < 0 || to >= ids.length) return;
    await mutate(() => api.put(`${optionPath}/order`, { optionIds: moveItem(ids, from, to) }));
  }

  return (
    <fieldset style={fieldsetStyle}>
      <legend style={legendStyle}>{t("options")}</legend>
      {question.options.length < 2 ? (
        <p
          role="status"
          style={{ fontSize: 13, color: "var(--danger-muted-foreground)", margin: 0 }}
        >
          {t("optionsMinimum")}
        </p>
      ) : null}

      {question.options.map((option, index) => (
        <div
          key={option.id}
          style={{
            display: "flex",
            gap: tokens.spacing.sm,
            alignItems: "flex-start",
            marginBottom: tokens.spacing.sm,
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <button
              type="button"
              aria-label={t("moveUp")}
              disabled={disabled || index === 0}
              onClick={() => void move(option, -1)}
              style={iconButtonStyle}
            >
              ↑
            </button>
            <button
              type="button"
              aria-label={t("moveDown")}
              disabled={disabled || index === question.options.length - 1}
              onClick={() => void move(option, 1)}
              style={iconButtonStyle}
            >
              ↓
            </button>
          </div>

          <div style={{ flex: "1 1 240px", minWidth: 200 }}>
            {locales.map((locale) => (
              <TextCommit
                key={locale}
                id={`${option.id}-${locale}`}
                ariaLabel={`${t("optionLabel")} ${locale.toUpperCase()}`}
                placeholder={`${t("optionLabel")} (${locale.toUpperCase()})`}
                value={option.translations[locale] ?? ""}
                disabled={disabled}
                onCommit={(value) => {
                  if (!value.trim() || value === (option.translations[locale] ?? "")) return;
                  void mutate(() =>
                    api.patch(`${optionPath}/${option.id}`, {
                      translations: { [locale]: value },
                    }),
                  );
                }}
              />
            ))}

            <div
              style={{
                display: "flex",
                gap: tokens.spacing.md,
                alignItems: "center",
                flexWrap: "wrap",
                marginTop: tokens.spacing.xs,
              }}
            >
              {/*
                The numeric coding this option exports as. Nullable on purpose:
                an unset value must stay unset, never become 0 — a 0 that meant
                "not coded" is exactly the missing-as-zero mistake AGENT.md §17
                forbids.
              */}
              <NumberField
                label={t("optionValue")}
                value={option.valueNumber}
                nullable
                disabled={disabled}
                onCommit={(valueNumber) =>
                  void mutate(() => api.patch(`${optionPath}/${option.id}`, { valueNumber }))
                }
              />
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: tokens.spacing.sm,
                  fontSize: 14,
                }}
              >
                <input
                  type="checkbox"
                  checked={option.isExclusive}
                  disabled={disabled || question.type !== "MULTI_CHOICE"}
                  onChange={(event) =>
                    void mutate(() =>
                      api.patch(`${optionPath}/${option.id}`, {
                        isExclusive: event.target.checked,
                      }),
                    )
                  }
                />
                {t("optionExclusive")}
              </label>
            </div>
          </div>

          <button
            type="button"
            disabled={disabled}
            onClick={() => void mutate(() => api.delete(`${optionPath}/${option.id}`))}
            style={styles.secondaryButton}
          >
            {t("remove")}
          </button>
        </div>
      ))}

      <button
        type="button"
        disabled={disabled}
        onClick={() =>
          void mutate(() =>
            api.post(optionPath, {
              translations: Object.fromEntries(locales.map((locale) => [locale, t("newOption")])),
            }),
          )
        }
        style={styles.secondaryButton}
      >
        + {t("addOption")}
      </button>
    </fieldset>
  );
}

// ───────────────────────────── Field primitives ─────────────────────────────

/**
 * A text input that holds its own value while focused and commits on blur.
 *
 * The local draft is seeded once and then owns the field, so a reload
 * triggered by a sibling control cannot yank half-typed text out from under
 * the cursor. The trade-off is that a value changed by a CO-EDITOR mid-edit
 * will not appear until the field is remounted; at builder scale that is the
 * better failure, and the server holds the last write either way.
 */
function TextCommit({
  id,
  value,
  disabled,
  multiline,
  placeholder,
  ariaLabel,
  onCommit,
}: {
  id: string;
  value: string;
  disabled: boolean;
  multiline?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const shared = {
    id,
    value: draft,
    disabled,
    placeholder,
    "aria-label": ariaLabel,
    onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
    onBlur: () => onCommit(draft),
    style: styles.input,
  };

  return multiline ? (
    <textarea {...shared} rows={2} style={{ ...styles.input, minHeight: 60 }} />
  ) : (
    <input type="text" {...shared} />
  );
}

function TextField({
  label,
  value,
  disabled,
  onCommit,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  return (
    <label style={{ display: "block", marginBottom: tokens.spacing.sm, fontSize: 14 }}>
      {label}
      <input
        type="text"
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== value) onCommit(draft);
        }}
        style={styles.input}
      />
    </label>
  );
}

/** A numeric field that distinguishes "empty" from "zero" when `nullable`. */
function NumberField({
  label,
  value,
  min,
  nullable,
  disabled,
  onCommit,
}: {
  label: string;
  value: number | null;
  min?: number;
  nullable?: boolean;
  disabled: boolean;
  onCommit: (value: number | null) => void;
}) {
  const [draft, setDraft] = useState(value === null ? "" : String(value));

  return (
    <label style={{ display: "block", marginBottom: tokens.spacing.sm, fontSize: 14 }}>
      {label}
      <input
        type="number"
        value={draft}
        min={min}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft.trim() === "") {
            if (nullable && value !== null) onCommit(null);
            else setDraft(value === null ? "" : String(value));
            return;
          }
          const parsed = Number(draft);
          if (!Number.isFinite(parsed)) {
            setDraft(value === null ? "" : String(value));
            return;
          }
          if (parsed !== value) onCommit(parsed);
        }}
        style={{ ...styles.input, maxWidth: 160 }}
      />
    </label>
  );
}

const fieldsetStyle = {
  border: "1px solid var(--border)",
  borderRadius: tokens.radiusPx,
  padding: tokens.spacing.sm,
  marginTop: tokens.spacing.md,
} as const;

const legendStyle = { fontSize: 13, fontWeight: 600, color: "var(--muted-foreground)" } as const;

const iconButtonStyle = {
  width: 28,
  height: 24,
  border: "1px solid var(--input)",
  borderRadius: 4,
  background: "var(--card)",
  cursor: "pointer",
  lineHeight: 1,
} as const;
