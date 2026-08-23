"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useRouter } from "@/i18n/navigation";
import type { ResearcherProfile, StudyResponse } from "@lpr/contracts";
import { api } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Everything a signed-in screen needs, wherever it lives in the route tree.
 *
 * Extracted from the studies layout because `/ops` is a sibling of `/studies`,
 * not a child — so the sidebar that links to it did not exist on it, and an
 * admin who clicked "Operations" arrived at a page with no way back except the
 * browser button.
 *
 * Three responsibilities:
 *
 * 1. **The session gate.** Authentication used to be enforced only as a side
 *    effect of each page's first data fetch returning 401. A screen that
 *    fetches nothing on mount — `/studies/new` is the whole form — therefore
 *    rendered in full to a signed-out visitor. Nothing leaked, because every
 *    write is refused server-side, but the visitor got a working-looking form
 *    that could only fail on submit.
 *
 * 2. **Sign out**, which no screen used to offer (PLAN.md Phase 2).
 *
 * 3. **The study in context**, so the sidebar can name it, show its status and
 *    offer exactly the sections the viewer's role permits.
 *
 * It renders a skeleton, not the dashboard, until the session resolves.
 * Flashing an authenticated screen and then redirecting is worse than a blank:
 * on a shared machine the flash is exactly the frame nobody should see.
 */
export function AuthenticatedShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();

  const [user, setUser] = useState<ResearcherProfile | null>(null);
  const [study, setStudy] = useState<StudyResponse | null>(null);
  const [studyLoading, setStudyLoading] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  /**
   * The study id out of the path.
   *
   * Read from the pathname rather than from `useParams`, because this shell
   * also renders `/studies`, `/studies/new` and `/ops`, where there is no
   * study and `new` is not an id.
   */
  const match = /\/studies\/([0-9a-fA-F-]{36})(?:\/|$)/.exec(pathname);
  const studyId = match?.[1] ?? null;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await api.get<{ user: ResearcherProfile }>("/api/auth/me");
        if (!cancelled) setUser(response.user);
      } catch {
        // A network error is indistinguishable from an expired cookie here,
        // and login is where both are recoverable.
        if (!cancelled) router.replace("/login");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  useEffect(() => {
    if (studyId === null) {
      setStudy(null);
      return;
    }
    let cancelled = false;
    setStudyLoading(true);
    void (async () => {
      try {
        const loaded = await api.get<StudyResponse>(`/api/studies/${studyId}`);
        if (!cancelled) setStudy(loaded);
      } catch {
        // The page itself reports a study it cannot load; the sidebar simply
        // falls back to the study-less shell rather than showing a broken
        // section list. Two error messages for one failure is noise.
        if (!cancelled) setStudy(null);
      } finally {
        if (!cancelled) setStudyLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [studyId]);

  const signOut = useCallback(async () => {
    setSigningOut(true);
    try {
      await api.post("/api/auth/logout");
    } finally {
      // Leave regardless. If the call failed the cookie may still be live, but
      // staying on an authenticated screen after the user asked to leave is
      // the worse of the two outcomes.
      router.replace("/login");
    }
  }, [router]);

  if (!user) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-8">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <AppShell
      user={user}
      study={study}
      studyLoading={studyLoading && study === null}
      onSignOut={() => void signOut()}
      signingOut={signingOut}
    >
      {children}
    </AppShell>
  );
}
