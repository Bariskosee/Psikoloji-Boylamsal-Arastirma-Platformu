"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { tokens } from "@lpr/ui";
import { styles } from "@/lib/ui";

/**
 * The publish confirmation.
 *
 * PLAN.md Phase 3 asks for "an explicit 'this becomes immutable' confirmation
 * at publish", and this is deliberately more friction than a browser
 * `confirm()`: the researcher must tick a box that states the consequence in
 * words before the button becomes usable. Publishing is the one operation in
 * the builder that cannot be undone — a published version can never be edited
 * or deleted, by API or by database (migration 0001) — and everything a
 * participant is later shown for that version is decided here.
 *
 * It is not a modal `<dialog>` with a focus trap: an inline panel inside the
 * page is reachable by keyboard and screen reader without any of the focus
 * management a hand-rolled modal usually gets wrong (NFR-15).
 */
export function PublishDialog({
  questionCount,
  nextVersionNumber,
  publishing,
  onPublish,
  onCancel,
}: {
  questionCount: number;
  nextVersionNumber: number;
  publishing: boolean;
  onPublish: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations("questionnaires");
  const [acknowledged, setAcknowledged] = useState(false);

  return (
    <section
      aria-labelledby="publish-heading"
      style={{
        ...styles.card,
        borderColor: "var(--danger)",
        background: "var(--danger-muted)",
      }}
    >
      <h3 id="publish-heading" style={{ marginTop: 0 }}>
        {t("publishHeading", { version: nextVersionNumber })}
      </h3>
      <p style={{ marginTop: 0 }}>{t("publishSummary", { count: questionCount })}</p>
      <p style={{ fontWeight: 600 }}>{t("publishImmutableWarning")}</p>

      <label
        style={{
          display: "flex",
          gap: tokens.spacing.sm,
          alignItems: "flex-start",
          marginBottom: tokens.spacing.md,
        }}
      >
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
        />
        <span>{t("publishAcknowledge")}</span>
      </label>

      <div style={{ display: "flex", gap: tokens.spacing.sm, flexWrap: "wrap" }}>
        <button
          type="button"
          disabled={!acknowledged || publishing}
          onClick={onPublish}
          // `border` in full rather than overriding `borderColor` on top of the
          // shared shorthand — React warns about the mix, and the warning is
          // right: the two do not compose predictably across re-renders.
          style={{
            ...styles.button,
            ...(acknowledged && !publishing
              ? { background: "var(--danger)", border: "1px solid var(--danger)" }
              : { opacity: 0.6, cursor: "not-allowed" }),
          }}
        >
          {publishing ? t("publishing") : t("publishConfirm")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={publishing}
          style={styles.secondaryButton}
        >
          {t("cancel")}
        </button>
      </div>
    </section>
  );
}
