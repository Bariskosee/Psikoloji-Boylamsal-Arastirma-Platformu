"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { ListChecks, Plus } from "lucide-react";
import { Link, useRouter } from "@/i18n/navigation";
import type {
  ProtocolDetail,
  ProtocolListResponse,
  ProtocolSummary,
  StudyResponse,
} from "@lpr/contracts";
import { ApiError, api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { EmptyState, ErrorBanner, ErrorState, LoadingTable } from "@/components/ui/states";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * The study's protocols.
 *
 * A protocol is a stable label; what a participant is bound to at enrollment is
 * one of its versions. The list therefore shows the draft's step count and the
 * highest published version, because "is this schedule live yet" is the
 * question a researcher actually has when scanning it.
 */
export default function ProtocolsPage() {
  const t = useTranslations("protocols");
  const router = useRouter();
  const params = useParams<{ studyId: string }>();
  const studyId = params?.studyId ?? "";

  const [protocols, setProtocols] = useState<ProtocolSummary[] | null>(null);
  const [study, setStudy] = useState<StudyResponse | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  const load = useCallback(async () => {
    try {
      const [list, loadedStudy] = await Promise.all([
        api.get<ProtocolListResponse>(`/api/studies/${studyId}/protocols`),
        api.get<StudyResponse>(`/api/studies/${studyId}`),
      ]);
      setProtocols(list.protocols);
      setStudy(loadedStudy);
      setError(null);
      setStatus("ready");
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        router.push("/login");
        return;
      }
      const denied = caught instanceof ApiError && (caught.status === 403 || caught.status === 404);
      setError(denied ? t("errors.forbidden") : t("errors.load"));
      setStatus("error");
    }
  }, [router, studyId, t]);

  useEffect(() => {
    if (studyId) void load();
  }, [load, studyId]);

  async function create() {
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const created = await api.post<ProtocolDetail>(`/api/studies/${studyId}/protocols`, {
        name: name.trim(),
        description: description.trim(),
      });
      router.push(`/studies/${studyId}/protocols/${created.id}`);
    } catch {
      setError(t("errors.create"));
      setCreating(false);
    }
  }

  const canEdit = study?.viewerRole === "OWNER" || study?.viewerRole === "EDITOR";

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title={t("title")} description={t("subtitle")} />

      <ErrorBanner>{error}</ErrorBanner>

      {canEdit ? (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>{t("create")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-end gap-3">
              <div className="grid min-w-56 flex-1 gap-2">
                <Label htmlFor="protocol-name">{t("name")}</Label>
                <Input
                  id="protocol-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <div className="grid min-w-56 flex-1 gap-2">
                <Label htmlFor="protocol-description">{t("description")}</Label>
                <Textarea
                  id="protocol-description"
                  rows={1}
                  className="min-h-9"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </div>
              <Button type="button" onClick={create} disabled={creating || !name.trim()}>
                <Plus />
                {creating ? t("creating") : t("create")}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {status === "loading" ? <LoadingTable rows={3} columns={3} /> : null}

      {status === "error" ? (
        <ErrorState
          title={error ?? t("errors.load")}
          onRetry={() => void load()}
          retryLabel={t("retry")}
        />
      ) : null}

      {status === "ready" && protocols?.length === 0 ? (
        <EmptyState icon={ListChecks} title={t("empty")} description={t("emptyHint")} />
      ) : null}

      {status === "ready" && protocols && protocols.length > 0 ? (
        <Card className="overflow-hidden py-0">
          <CardContent className="px-0">
            <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={t("title")}>
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>{t("name")}</TableHead>
                    <TableHead>{t("draft")}</TableHead>
                    <TableHead>{t("published")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {protocols.map((protocol) => (
                    <TableRow key={protocol.id} className="relative">
                      <TableCell className="font-medium">
                        <Link
                          href={`/studies/${studyId}/protocols/${protocol.id}`}
                          className="after:absolute after:inset-0 focus-visible:outline-none"
                        >
                          {protocol.name}
                        </Link>
                        {protocol.description ? (
                          <p className="text-muted-foreground mt-0.5 text-xs">
                            {protocol.description}
                          </p>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {t("stepCount", { count: protocol.draft.stepCount })}
                      </TableCell>
                      <TableCell>
                        {protocol.latestPublished ? (
                          <StatusBadge tone="success">
                            v{String(protocol.latestPublished.versionNumber ?? "?")}
                          </StatusBadge>
                        ) : (
                          <span className="text-muted-foreground text-sm">
                            {t("neverPublished")}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
