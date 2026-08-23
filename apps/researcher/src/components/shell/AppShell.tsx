"use client";

import { useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import {
  BarChart3,
  ClipboardList,
  Download,
  FlaskConical,
  LayoutDashboard,
  LineChart,
  ListChecks,
  LogOut,
  Settings2,
  Users,
  Wrench,
} from "lucide-react";
import type { ResearcherProfile, StudyResponse } from "@lpr/contracts";
import { Link } from "@/i18n/navigation";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { StudyStatusBadge } from "@/components/ui/status-badge";
import { activeSection, sectionsFor, type StudySectionId } from "./study-nav";

const ICONS: Record<StudySectionId, typeof LayoutDashboard> = {
  overview: LayoutDashboard,
  questionnaires: ClipboardList,
  protocols: ListChecks,
  participants: Users,
  monitoring: LineChart,
  analytics: BarChart3,
  export: Download,
  members: Settings2,
};

/**
 * The signed-in shell.
 *
 * ── The problem it solves ───────────────────────────────────────────────────
 * Every screen inside a study used to be reachable only from the study
 * overview, as a list of eight text links at the bottom of a settings form. To
 * move from monitoring to the participant list a researcher went back, scrolled
 * past the QR code and the lifecycle buttons, and found the next link. Nothing
 * on any screen said which study they were in or which section they were
 * looking at.
 *
 * A persistent sidebar fixes all three: the study is named permanently, the
 * current section is visible, and every other section is one click away.
 *
 * ── Why the study loads here ────────────────────────────────────────────────
 * The sidebar needs the study's name, status and the viewer's role — the role
 * decides which sections exist at all. That is one extra GET per study
 * navigation, which is the price of not making every page pass its study up to
 * a layout it does not know about.
 */
export function AppShell({
  user,
  study,
  studyLoading,
  onSignOut,
  signingOut,
  children,
}: {
  user: ResearcherProfile;
  /** The study in context, or null on `/studies` and `/studies/new`. */
  study: StudyResponse | null;
  studyLoading: boolean;
  onSignOut: () => void;
  signingOut: boolean;
  children: ReactNode;
}) {
  const t = useTranslations("nav");
  const tAuth = useTranslations("auth");
  const pathname = usePathname();
  const current = study ? activeSection(pathname, study.id) : null;

  return (
    <SidebarProvider>
      {/*
        A keyboard user should not have to tab through every navigation item on
        every page to reach the content. First focusable element, visible only
        when focused.
      */}
      <a
        href="#main"
        className="bg-primary text-primary-foreground sr-only rounded-md px-4 py-2 focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50"
      >
        {t("skipToContent")}
      </a>

      <Sidebar collapsible="icon">
        <SidebarHeader>
          <div className="flex items-center gap-2 px-2 py-1.5">
            <div className="bg-primary text-primary-foreground flex size-8 shrink-0 items-center justify-center rounded-md">
              <FlaskConical className="size-4" />
            </div>
            <div className="grid min-w-0 flex-1 leading-tight group-data-[collapsible=icon]:hidden">
              <span className="truncate text-sm font-semibold">{t("workspace")}</span>
              <span className="text-muted-foreground truncate text-xs">{user.email}</span>
            </div>
          </div>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild isActive={study === null} tooltip={t("studies")}>
                    <Link href="/studies">
                      <FlaskConical />
                      <span>{t("allStudies")}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                {/*
                  Operations is admin-only on the server. Shown to everybody
                  would be a link that 403s; hidden from an admin would hide
                  the only page that reports a stalled sweeper.
                */}
                {user.isAdmin ? (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      asChild
                      isActive={pathname.endsWith("/ops")}
                      tooltip={t("operations")}
                    >
                      <Link href="/ops">
                        <Wrench />
                        <span>{t("operations")}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ) : null}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          {studyLoading ? (
            <SidebarGroup>
              <SidebarGroupContent className="space-y-2 px-2">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </SidebarGroupContent>
            </SidebarGroup>
          ) : null}

          {study ? (
            <SidebarGroup>
              <SidebarGroupLabel>{t("sectionsFor")}</SidebarGroupLabel>
              <SidebarGroupContent>
                {/*
                  The study's name and status sit at the top of its own section,
                  not in the page body: which study you are editing is the one
                  fact that must never be a scroll away on a platform where two
                  studies can look identical.
                */}
                <div className="mb-2 px-2 group-data-[collapsible=icon]:hidden">
                  <p className="truncate text-sm font-medium" title={study.name}>
                    {study.name}
                  </p>
                  <div className="mt-1">
                    <StudyStatusBadge status={study.status} />
                  </div>
                </div>
                <SidebarMenu>
                  {sectionsFor(study.viewerRole).map((section) => {
                    const Icon = ICONS[section.icon];
                    return (
                      <SidebarMenuItem key={section.id}>
                        <SidebarMenuButton
                          asChild
                          isActive={current === section.id}
                          tooltip={t(section.labelKey)}
                        >
                          <Link href={`/studies/${study.id}${section.segment}`}>
                            <Icon />
                            <span>{t(section.labelKey)}</span>
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ) : null}
        </SidebarContent>

        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={onSignOut}
                disabled={signingOut}
                tooltip={tAuth("signOut")}
              >
                <LogOut />
                <span>{tAuth("signOut")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset>
        {/*
          A sticky bar carrying the trigger, so the sidebar can be reopened on a
          phone from anywhere on a long page rather than only from the top.
        */}
        <header className="bg-background/95 supports-[backdrop-filter]:bg-background/70 sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b px-4 backdrop-blur">
          <SidebarTrigger aria-label={t("openMenu")} />
          <Separator orientation="vertical" className="mr-1 !h-4" />
          <span className="text-muted-foreground truncate text-sm">
            {study ? study.name : t("studies")}
          </span>
        </header>

        <main id="main" className="min-w-0 flex-1 px-4 py-6 md:px-8 md:py-8">
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
