"use client";

import type { ComponentType, ReactNode } from "react";
import { AlertCircle, Inbox, RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * The four states every data screen has, as components rather than as an
 * afterthought.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * Loading was the string "…" on some screens and "Loading…" on others. Empty
 * was a bare sentence. An error was a red box with no way to retry, so a
 * researcher whose connection blipped had to know to reload the page. None of
 * these are cosmetic problems: an empty study and a failed request looked
 * nearly identical, and the difference between "there are no participants yet"
 * and "we could not find out whether there are participants" is the difference
 * between waiting and investigating.
 */

/**
 * A skeleton in the SHAPE of what is coming.
 *
 * A spinner says only that something is happening. A skeleton the size of the
 * eventual table also says how much is coming and stops the page jumping when
 * it arrives — and layout shift on a dashboard is what makes someone click the
 * wrong row.
 */
export function LoadingTable({ rows = 5, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div className="space-y-3" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>
      <div className="flex gap-4">
        {Array.from({ length: columns }, (_, index) => (
          <Skeleton key={index} className="h-4 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="flex gap-4">
          {Array.from({ length: columns }, (_, column) => (
            <Skeleton key={column} className="h-9 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

export function LoadingCards({ count = 3 }: { count?: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>
      {Array.from({ length: count }, (_, index) => (
        <Skeleton key={index} className="h-28 w-full rounded-xl" />
      ))}
    </div>
  );
}

/**
 * Empty, with the next action attached.
 *
 * An empty state is the only screen guaranteed to be seen by somebody who has
 * never used the platform — it is what a new study shows on every page. Saying
 * only "No questionnaires" leaves them to guess; the whole point is to hand
 * them the button.
 */
export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  className,
}: {
  icon?: ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "border-border flex flex-col items-center justify-center rounded-xl border border-dashed px-6 py-12 text-center",
        className,
      )}
    >
      <div className="bg-muted text-muted-foreground mb-4 flex size-11 items-center justify-center rounded-full">
        <Icon className="size-5" />
      </div>
      <p className="text-base font-medium">{title}</p>
      {description ? (
        <p className="text-muted-foreground mt-1 max-w-md text-sm">{description}</p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

/**
 * An error the reader can act on.
 *
 * `role="alert"` so it is announced rather than found, and a retry button
 * because the most common cause is transient and the alternative is teaching
 * people to reload the whole application.
 */
export function ErrorState({
  title,
  description,
  onRetry,
  retryLabel,
}: {
  title: string;
  description?: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <Alert variant="destructive" role="alert">
      <AlertCircle />
      <AlertTitle>{title}</AlertTitle>
      {description ? <AlertDescription>{description}</AlertDescription> : null}
      {onRetry ? (
        <div className="mt-3">
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw className="size-3.5" />
            {retryLabel ?? "Retry"}
          </Button>
        </div>
      ) : null}
    </Alert>
  );
}

/** An inline error banner, for a form that failed rather than a screen that did. */
export function ErrorBanner({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <Alert variant="destructive" role="alert" className="mb-4">
      <AlertCircle />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}
