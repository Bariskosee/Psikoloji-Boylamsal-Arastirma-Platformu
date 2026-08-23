"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { FlaskConical, Plus } from "lucide-react";
import { Link, useRouter } from "@/i18n/navigation";
import { ApiError, api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { StudyStatusBadge } from "@/components/ui/status-badge";
import { EmptyState, ErrorState, LoadingCards } from "@/components/ui/states";
import type { StudyListResponse, StudyResponse } from "@lpr/contracts";

/**
 * The researcher's studies — and only the ones they are a member of.
 *
 * ── Why cards rather than the table this used to be ─────────────────────────
 * A four-column table is the right shape for scanning fifty rows of the same
 * kind. This list is typically three to six studies that a researcher knows by
 * name, and the question they arrive with is "which one, and is it running?"
 * A card gives the name room to be read, the status its own colour, and the
 * enrollment code the monospace it needs to be read aloud over the phone —
 * none of which a 14px table cell was doing.
 */
export default function StudiesPage() {
  const t = useTranslations("studies");
  const router = useRouter();

  const [studies, setStudies] = useState<StudyResponse[] | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const response = await api.get<StudyListResponse>("/api/studies");
      setStudies(response.studies);
      setStatus("ready");
    } catch (caught) {
      // An expired session is not an error to display; it is a redirect.
      if (caught instanceof ApiError && caught.status === 401) {
        router.push("/login");
        return;
      }
      setStatus("error");
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title={t("title")}
        description={t("subtitle")}
        actions={
          <Button asChild>
            <Link href="/studies/new">
              <Plus />
              {t("create")}
            </Link>
          </Button>
        }
      />

      {status === "loading" ? <LoadingCards count={3} /> : null}

      {status === "error" ? (
        <ErrorState title={t("errors.load")} onRetry={() => void load()} retryLabel={t("retry")} />
      ) : null}

      {status === "ready" && studies?.length === 0 ? (
        <EmptyState
          icon={FlaskConical}
          title={t("empty")}
          description={t("emptyHint")}
          action={
            <Button asChild>
              <Link href="/studies/new">
                <Plus />
                {t("create")}
              </Link>
            </Button>
          }
        />
      ) : null}

      {status === "ready" && studies && studies.length > 0 ? (
        <ul className="grid gap-4 sm:grid-cols-2">
          {studies.map((study) => (
            <li key={study.id}>
              {/*
                The whole card is the link, not just the title. A 14px anchor
                inside a 200px card is a target people miss, and every card
                here has exactly one destination.
              */}
              <Card className="hover:border-primary/40 focus-within:ring-ring relative h-full transition-colors focus-within:ring-2">
                <CardHeader className="gap-2">
                  <div className="flex items-start justify-between gap-3">
                    <CardTitle className="text-base leading-snug">
                      <Link
                        href={`/studies/${study.id}`}
                        className="after:absolute after:inset-0 focus-visible:outline-none"
                      >
                        {study.name}
                      </Link>
                    </CardTitle>
                    <StudyStatusBadge status={study.status} />
                  </div>
                  {study.description ? (
                    <p className="text-muted-foreground line-clamp-2 text-sm">
                      {study.description}
                    </p>
                  ) : null}
                </CardHeader>
                <CardContent className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                  <span>
                    {t("code")}:{" "}
                    <code className="text-foreground font-mono text-[0.8rem]">
                      {study.enrollmentCode}
                    </code>
                  </span>
                  <span>
                    {t("yourRole")}: {t(`roles.${study.viewerRole}`)}
                  </span>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
