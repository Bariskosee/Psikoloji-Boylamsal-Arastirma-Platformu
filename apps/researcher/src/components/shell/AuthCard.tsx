"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { FlaskConical } from "lucide-react";

/**
 * The frame around every signed-out screen: login, forgot password, reset.
 *
 * ── Why they get a frame at all ─────────────────────────────────────────────
 * These three pages were a bare `<h1>` and a form floating at the top-left of
 * a white page. That is the first thing a researcher sees of the platform, and
 * on a shared institutional machine it is also the screen somebody has to
 * trust with a password. Looking unfinished is not a neutral property here.
 *
 * Centred, on the sunken background, with the product named — enough to read
 * as a system rather than as a debug form, and nothing more.
 */
export function AuthCard({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const t = useTranslations("nav");

  return (
    <div className="flex min-h-svh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <div className="bg-primary text-primary-foreground flex size-9 items-center justify-center rounded-lg">
            <FlaskConical className="size-4.5" />
          </div>
          {/*
            The product, not the page — and from the catalogue, not hard-coded.
            It read "Longitudinal Research Platform" in English above a Turkish
            form, and disagreed with the name the signed-in sidebar uses.
          */}
          <span className="text-base font-semibold">{t("workspace")}</span>
        </div>

        <div className="bg-card rounded-xl border p-6 shadow-sm">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {description ? (
            <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">{description}</p>
          ) : null}
          <div className="mt-5">{children}</div>
        </div>

        {footer ? <div className="mt-4 text-center text-sm">{footer}</div> : null}
      </div>
    </div>
  );
}
