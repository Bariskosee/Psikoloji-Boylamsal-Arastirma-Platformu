"use client";

import { use } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { tokens } from "@lpr/ui";
import { apiUrl } from "@/lib/api";
import { styles } from "@/lib/ui";

/**
 * Export (PLAN.md Phase 11, `docs/export-codebook.md`).
 *
 * ── Why the missingness explanation is on this page, in plain language ──────
 * PLAN.md asks for it, and §1 explains the stake: the most damaging failure
 * this platform can produce is a missing value exported as `0`, averaged into a
 * mean, and published. The files themselves are careful — a value appears only
 * where the status says `ANSWERED` — but a researcher who does not know the
 * status columns exist may open `wide.csv`, see empty cells, and fill them in.
 *
 * The explanation therefore sits where the download button is, not in a
 * document they would have to go and find.
 *
 * ── Why these are plain links rather than fetch-and-save ────────────────────
 * The API streams the file, and a plain `<a download>` lets the browser handle
 * a response of unknown length with a progress indicator and a real save
 * dialog. Fetching it into memory first would defeat the streaming the export
 * service is built around, in the client this time.
 */
export default function ExportPage({ params }: { params: Promise<{ studyId: string }> }) {
  const { studyId } = use(params);
  const t = useTranslations("analytics");

  const files = [
    { name: "long.csv", title: t("exportLong"), hint: t("exportLongHint") },
    { name: "wide.csv", title: t("exportWide"), hint: t("exportWideHint") },
    { name: "codebook.csv", title: t("exportCodebook"), hint: t("exportCodebookHint") },
    { name: "steps.csv", title: t("exportSteps"), hint: t("exportStepsHint") },
  ];

  return (
    <div style={styles.page}>
      <h1>{t("exportTitle")}</h1>

      {/*
        Before the download buttons, deliberately. A researcher who reads this
        first knows to look at the status columns; one who reads it afterwards
        has already opened the file.
      */}
      <section style={{ ...styles.card, borderColor: "#b54708", background: "#fffaeb" }}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>{t("missingnessTitle")}</h2>
        <p style={{ lineHeight: 1.7, margin: 0 }}>{t("missingnessBody")}</p>
        <p style={{ lineHeight: 1.7, marginBottom: 0, fontWeight: 600 }}>
          {t("missingnessWarning")}
        </p>
      </section>

      {files.map((file) => (
        <section key={file.name} style={styles.card}>
          <h2 style={{ marginTop: 0, fontSize: 17 }}>{file.title}</h2>
          <p style={{ color: "#5b6472", fontSize: 14 }}>{file.hint}</p>
          <a
            href={apiUrl(`/api/studies/${studyId}/exports/${file.name}`)}
            download={file.name}
            style={{ ...styles.secondaryButton, display: "inline-block", textDecoration: "none" }}
          >
            {t("download")}
          </a>
        </section>
      ))}

      <p style={{ fontSize: 13, color: "#5b6472", marginTop: tokens.spacing.md }}>
        {/*
          Every download is audited with its format and row count (§6.2). Said
          out loud rather than buried in a policy: a researcher should know
          their downloads are recorded, and knowing it is part of what makes the
          record fair.
        */}
        {t("exportCodebookHint")}
      </p>

      <Link href={`/studies/${studyId}/analytics`} style={styles.secondaryButton}>
        {t("analyticsTitle")}
      </Link>
    </div>
  );
}
