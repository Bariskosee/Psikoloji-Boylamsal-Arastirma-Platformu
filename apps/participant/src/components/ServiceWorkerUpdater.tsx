"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { tokens } from "@lpr/ui";
import { registerServiceWorker } from "@/lib/push";

/**
 * Registers the service worker, and asks before letting a new one take over
 * (STRUCTURE.md §14: "Service worker updates never activate silently
 * mid-questionnaire — the user is prompted").
 *
 * ── Why this is a prompt and not an automatic reload ────────────────────────
 * The obvious implementation calls `skipWaiting()` on install and reloads. Do
 * that here and a participant on question 60 of a hundred-item baseline has
 * their page replaced under them the moment a deploy lands. Their answers
 * survive — the autosave outbox sees to that — but the interruption does not,
 * and in a study measured in weeks of voluntary attention, that is a real cost
 * paid for a deploy nobody was waiting for.
 *
 * So the new worker installs and waits. This component notices and offers. The
 * participant decides.
 *
 * ── Why it renders nothing most of the time ─────────────────────────────────
 * Mounted in the root layout so registration happens once, on every page,
 * without any screen having to remember to do it. Registration is idempotent
 * and cheap; the banner only exists when there is genuinely a waiting worker.
 */
export function ServiceWorkerUpdater() {
  const t = useTranslations("updatePrompt");
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const registration = await registerServiceWorker();
      // Null on a browser that will not register one — a private window, a
      // policy, an insecure origin. The application works without it; only
      // push and the install prompt do not (STRUCTURE.md §14).
      if (registration === null || cancelled) return;

      // A worker already waiting when this page loaded: the update landed while
      // the participant was on a previous screen.
      if (registration.waiting) setWaiting(registration.waiting);

      registration.addEventListener("updatefound", () => {
        const installing = registration.installing;
        if (!installing) return;

        installing.addEventListener("statechange", () => {
          // `installed` WITH an existing controller means "a new version is
          // ready and an old one is running". Without a controller it is the
          // very first install, which needs no prompt — there is nothing to
          // interrupt.
          if (installing.state === "installed" && navigator.serviceWorker.controller) {
            setWaiting(installing);
          }
        });
      });
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  function update(): void {
    if (!waiting) return;

    // Reload only once the new worker has actually taken control. Reloading
    // immediately would race it: the page would come back under the OLD worker
    // and the banner would reappear, which reads as a button that does nothing.
    navigator.serviceWorker.addEventListener("controllerchange", () => window.location.reload(), {
      once: true,
    });
    waiting.postMessage({ type: "SKIP_WAITING" });
  }

  if (!waiting || dismissed) return null;

  return (
    <div
      role="status"
      style={{
        position: "fixed",
        left: tokens.spacing.md,
        right: tokens.spacing.md,
        bottom: tokens.spacing.md,
        maxWidth: tokens.contentMaxWidthPx,
        margin: "0 auto",
        padding: tokens.spacing.md,
        borderRadius: tokens.radiusPx,
        background: "var(--foreground)",
        color: "var(--card)",
        display: "flex",
        flexWrap: "wrap",
        gap: tokens.spacing.sm,
        alignItems: "center",
        justifyContent: "space-between",
        boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
      }}
    >
      <span style={{ fontSize: 15 }}>{t("message")}</span>
      <span style={{ display: "flex", gap: tokens.spacing.sm }}>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          style={{
            minHeight: tokens.touchTargetMinPx,
            padding: `0 ${String(tokens.spacing.md)}px`,
            borderRadius: tokens.radiusPx,
            border: "1px solid var(--input)",
            background: "transparent",
            color: "var(--card)",
            fontSize: 15,
            cursor: "pointer",
          }}
        >
          {t("dismiss")}
        </button>
        <button
          type="button"
          onClick={update}
          style={{
            minHeight: tokens.touchTargetMinPx,
            padding: `0 ${String(tokens.spacing.md)}px`,
            borderRadius: tokens.radiusPx,
            border: "1px solid var(--primary-foreground)",
            background: "var(--card)",
            color: "var(--foreground)",
            fontSize: 15,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {t("action")}
        </button>
      </span>
    </div>
  );
}
