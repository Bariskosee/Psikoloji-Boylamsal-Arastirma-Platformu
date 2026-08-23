import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The top of every screen: what this page is, and what you can do here.
 *
 * ── Why the actions live in the header ──────────────────────────────────────
 * They used to sit wherever they were written — "create" above a table on one
 * page, below a form on another, at the bottom of a list on a third. A
 * researcher looking for the primary action had to read the whole screen to
 * find it. One position, on every page, is worth more than any individual
 * placement decision.
 *
 * `description` is not decoration either: several of these screens do
 * something a newcomer cannot infer from the title, and one sentence under the
 * heading is where that belongs rather than in a document nobody opens.
 */
export function PageHeader({
  title,
  description,
  actions,
  breadcrumb,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  breadcrumb?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-6", className)}>
      {breadcrumb ? <div className="mb-3">{breadcrumb}</div> : null}
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
          {description ? (
            <p className="text-muted-foreground mt-1.5 max-w-2xl text-sm text-pretty">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

/**
 * A labelled figure.
 *
 * The monitoring screens are read at a glance during a study, so the NUMBER is
 * the largest thing in the card and the label sits above it in small caps. The
 * optional hint carries the denominator — a compliance figure with no
 * denominator is the single easiest way to publish something untrue.
 */
export function StatCard({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  /**
   * The tone of the VALUE, not of the metric.
   *
   * This was applied per metric — "missed sessions" was always amber — so a
   * study with zero missed sessions painted its best number as a warning. A
   * caller passes the tone the current value deserves; `page.tsx` computes it
   * from the number.
   */
  tone?: "default" | "success" | "warning" | "danger";
}) {
  const toneClass = {
    default: "text-foreground",
    success: "text-success-muted-foreground",
    warning: "text-warning-muted-foreground",
    danger: "text-danger-muted-foreground",
  }[tone];

  return (
    /*
      `flex-col` with the hint pushed down: in a grid the cards stretch to the
      tallest, and without this the ones with no hint ended with a block of
      dead space under the number while their neighbours were full.
    */
    <div className="bg-card flex h-full flex-col rounded-xl border p-4">
      <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{label}</p>
      <p className={cn("mt-1.5 text-2xl font-semibold tabular-nums", toneClass)}>{value}</p>
      {hint ? <p className="text-muted-foreground mt-auto pt-1 text-xs">{hint}</p> : null}
    </div>
  );
}
