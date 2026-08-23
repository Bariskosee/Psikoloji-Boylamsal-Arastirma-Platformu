"use client";

import { use } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle, Download, FileSpreadsheet } from "lucide-react";
import { apiUrl } from "@/lib/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";

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
 * document they would have to go and find, and it is styled as a warning
 * rather than as body copy: this is the one thing on the screen that must be
 * read before the button is pressed.
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
    { name: "long.csv", title: t("exportLong"), hint: t("exportLongHint"), primary: true },
    { name: "wide.csv", title: t("exportWide"), hint: t("exportWideHint"), primary: false },
    {
      name: "codebook.csv",
      title: t("exportCodebook"),
      hint: t("exportCodebookHint"),
      primary: false,
    },
    { name: "steps.csv", title: t("exportSteps"), hint: t("exportStepsHint"), primary: false },
  ];

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={t("exportTitle")} description={t("exportSubtitle")} />

      {/*
        Before the download buttons, deliberately. A researcher who reads this
        first knows to look at the status columns; one who reads it afterwards
        has already opened the file.
      */}
      <Alert className="border-warning/40 bg-warning-muted text-warning-muted-foreground mb-6">
        <AlertTriangle />
        <AlertTitle>{t("missingnessTitle")}</AlertTitle>
        <AlertDescription className="text-warning-muted-foreground">
          <p>{t("missingnessBody")}</p>
          <p className="font-semibold">{t("missingnessWarning")}</p>
        </AlertDescription>
      </Alert>

      <ul className="space-y-4">
        {files.map((file) => (
          <li key={file.name}>
            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <FileSpreadsheet className="text-muted-foreground size-4 shrink-0" />
                      {file.title}
                      <code className="text-muted-foreground font-mono text-xs font-normal">
                        {file.name}
                      </code>
                    </CardTitle>
                    <CardDescription className="mt-1.5">{file.hint}</CardDescription>
                  </div>
                  <Button asChild variant={file.primary ? "default" : "outline"}>
                    <a
                      href={apiUrl(`/api/studies/${studyId}/exports/${file.name}`)}
                      download={file.name}
                    >
                      <Download />
                      {t("download")}
                    </a>
                  </Button>
                </div>
              </CardHeader>
            </Card>
          </li>
        ))}
      </ul>

      {/*
        Said out loud rather than buried in a policy: a researcher should know
        their downloads are recorded, and knowing it is part of what makes the
        record fair.
      */}
      <p className="text-muted-foreground mt-6 text-sm">{t("exportAudited")}</p>
    </div>
  );
}
