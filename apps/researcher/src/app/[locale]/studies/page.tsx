"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Link, useRouter } from "@/i18n/navigation";
import { ApiError, api } from "@/lib/api";
import { ErrorBanner, StatusBadge, TableScroll, styles } from "@/lib/ui";
import type { StudyListResponse, StudyResponse } from "@lpr/contracts";

/** The researcher's studies — and only the ones they are a member of. */
export default function StudiesPage() {
  const t = useTranslations("studies");
  const router = useRouter();

  const [studies, setStudies] = useState<StudyResponse[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await api.get<StudyListResponse>("/api/studies");
      setStudies(response.studies);
    } catch (caught) {
      // An expired session is not an error to display; it is a redirect.
      if (caught instanceof ApiError && caught.status === 401) {
        router.push("/login");
        return;
      }
      setError(t("errors.load"));
    }
  }, [router, t]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div style={styles.page}>
      <header
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}
      >
        <h1>{t("title")}</h1>
        <Link href="/studies/new" style={{ ...styles.button, textDecoration: "none" }}>
          {t("create")}
        </Link>
      </header>

      <ErrorBanner>{error}</ErrorBanner>

      {studies === null && !error ? <p>{t("loading")}</p> : null}

      {studies?.length === 0 ? <p>{t("empty")}</p> : null}

      {studies && studies.length > 0 ? (
        <TableScroll label={t("title")}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.cell}>{t("name")}</th>
                <th style={styles.cell}>{t("status")}</th>
                <th style={styles.cell}>{t("code")}</th>
                <th style={styles.cell}>{t("yourRole")}</th>
              </tr>
            </thead>
            <tbody>
              {studies.map((study) => (
                <tr key={study.id}>
                  <td style={styles.cell}>
                    <Link href={`/studies/${study.id}`}>{study.name}</Link>
                  </td>
                  <td style={styles.cell}>
                    <StatusBadge status={t(`statuses.${study.status}`)} />
                  </td>
                  <td style={styles.cell}>
                    <code>{study.enrollmentCode}</code>
                  </td>
                  <td style={styles.cell}>{t(`roles.${study.viewerRole}`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      ) : null}
    </div>
  );
}
