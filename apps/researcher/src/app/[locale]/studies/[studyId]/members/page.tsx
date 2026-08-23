"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { UserPlus, Users } from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "@/i18n/navigation";
import {
  STUDY_ROLES,
  type StudyMemberListResponse,
  type StudyMemberResponse,
  type StudyRole,
} from "@lpr/contracts";
import { ApiError, api } from "@/lib/api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollAreaX } from "@/components/ui/scroll-area-x";
import { PageHeader } from "@/components/ui/page-header";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState, ErrorBanner, LoadingTable } from "@/components/ui/states";

/**
 * Study membership — OWNER only, enforced server-side.
 *
 * There is no invitation email, so a colleague must already hold an account.
 * The API says so explicitly rather than creating a shell account, and this
 * screen surfaces that as its own message rather than as a bare "not found".
 *
 * ── Why each role carries a sentence ────────────────────────────────────────
 * "Analyst" and "Editor" do not explain themselves, and the person choosing
 * between them is deciding who can export every psychological answer in the
 * study. The distinction that matters — ANALYST can export, VIEWER cannot —
 * is invisible from the word alone, so the picker spells it out at the moment
 * of choosing rather than in documentation.
 */
export default function MembersPage() {
  const t = useTranslations("members");
  // Role labels live under `studies` because the study list renders them too.
  const tStudies = useTranslations("studies");
  const router = useRouter();
  const params = useParams<{ studyId: string }>();
  const studyId = params?.studyId ?? "";

  const [members, setMembers] = useState<StudyMemberResponse[] | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<StudyRole>("VIEWER");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await api.get<StudyMemberListResponse>(`/api/studies/${studyId}/members`);
      setMembers(response.members);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        router.push("/login");
        return;
      }
      setError(t("errors.load"));
    }
  }, [router, studyId, t]);

  useEffect(() => {
    if (studyId) void load();
  }, [load, studyId]);

  async function add(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await api.post(`/api/studies/${studyId}/members`, { email, role });
      toast.success(t("added", { email }));
      setEmail("");
      await load();
    } catch (caught) {
      setError(messageFor(caught, t));
    } finally {
      setPending(false);
    }
  }

  async function changeRole(userId: string, next: StudyRole) {
    setError(null);
    try {
      await api.patch(`/api/studies/${studyId}/members/${userId}`, { role: next });
      toast.success(t("roleChanged"));
      await load();
    } catch (caught) {
      setError(messageFor(caught, t));
    }
  }

  async function remove(userId: string) {
    setError(null);
    try {
      await api.delete(`/api/studies/${studyId}/members/${userId}`);
      toast.success(t("removed"));
      await load();
    } catch (caught) {
      setError(messageFor(caught, t));
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title={t("title")} description={t("subtitle")} />

      <ErrorBanner>{error}</ErrorBanner>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>{t("add")}</CardTitle>
          <CardDescription>{t("accountRequired")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={add} noValidate className="flex flex-wrap items-end gap-3">
            <div className="grid min-w-56 flex-1 gap-2">
              <Label htmlFor="member-email">{t("email")}</Label>
              <Input
                id="member-email"
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <div className="grid w-56 gap-2">
              <Label htmlFor="member-role">{t("role")}</Label>
              <Select value={role} onValueChange={(value) => setRole(value as StudyRole)}>
                <SelectTrigger id="member-role" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STUDY_ROLES.map((option) => (
                    <SelectItem key={option} value={option}>
                      <span className="flex flex-col items-start">
                        <span>{tStudies(`roles.${option}`)}</span>
                        {/* The sentence that makes the choice decidable. */}
                        <span className="text-muted-foreground text-xs">
                          {t(`roleHelp.${option}`)}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={pending}>
              <UserPlus />
              {t("add")}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle>{t("current")}</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          {members === null ? (
            <div className="px-6">
              <LoadingTable rows={3} columns={4} />
            </div>
          ) : members.length === 0 ? (
            <div className="px-6">
              <EmptyState icon={Users} title={t("noMembers")} />
            </div>
          ) : (
            <ScrollAreaX label={t("current")}>
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>{t("name")}</TableHead>
                    <TableHead>{t("email")}</TableHead>
                    <TableHead className="w-48">{t("role")}</TableHead>
                    <TableHead className="w-28" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {members.map((member) => (
                    <TableRow key={member.userId}>
                      <TableCell className="font-medium">{member.displayName}</TableCell>
                      <TableCell className="text-muted-foreground">{member.email}</TableCell>
                      <TableCell>
                        <Select
                          value={member.role}
                          onValueChange={(value) =>
                            void changeRole(member.userId, value as StudyRole)
                          }
                        >
                          <SelectTrigger aria-label={t("role")} className="w-full" size="sm">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {STUDY_ROLES.map((option) => (
                              <SelectItem key={option} value={option}>
                                {tStudies(`roles.${option}`)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        {/*
                          Confirmed. Removing a member is instant and silent
                          from their side — they simply stop being able to open
                          the study — and the button sat one row away from a
                          role picker people use often.
                        */}
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button type="button" variant="ghost" size="sm">
                              {t("remove")}
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>
                                {t("confirmRemove", { name: member.displayName })}
                              </AlertDialogTitle>
                              <AlertDialogDescription>
                                {t("confirmRemoveBody")}
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                              <AlertDialogAction onClick={() => void remove(member.userId)}>
                                {t("confirmRemoveAction")}
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollAreaX>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function messageFor(error: unknown, t: (key: string) => string): string {
  if (!(error instanceof ApiError)) return t("errors.unknown");
  switch (error.code) {
    case "NOT_FOUND":
      return t("errors.noAccount");
    case "CONFLICT":
      return t("errors.alreadyMember");
    case "LAST_OWNER_REQUIRED":
      // The rule exists so a study can never end up with nobody able to
      // administer it — worth saying plainly rather than as a generic failure.
      return t("errors.lastOwner");
    case "STUDY_ROLE_REQUIRED":
      return t("errors.forbidden");
    default:
      return t("errors.unknown");
  }
}
