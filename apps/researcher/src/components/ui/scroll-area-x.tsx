"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A horizontally scrollable region that admits it scrolls.
 *
 * ── Why the fade is not decoration ──────────────────────────────────────────
 * A wide table clipped at the container edge reads as broken, not as
 * scrollable: the last column is sliced mid-word and nothing suggests there is
 * more. On a trackpad people discover it by accident; on a desktop mouse with
 * no horizontal wheel they often never do — and the columns they never see are
 * the ones on the right, which on the monitoring table are the open sessions.
 *
 * The fade appears only on the side that has content beyond the edge, so a
 * table that fits shows nothing at all.
 *
 * `tabIndex={0}` and the role make the region reachable by keyboard, which is
 * the only way to scroll it without a pointer.
 */
export function ScrollAreaX({
  children,
  label,
  className,
}: {
  children: ReactNode;
  label?: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    const max = node.scrollWidth - node.clientWidth;
    setEdges({ left: node.scrollLeft > 1, right: max > 1 && node.scrollLeft < max - 1 });
  }, []);

  useEffect(() => {
    measure();
    const node = ref.current;
    if (!node) return;
    // Re-measured on resize as well as on scroll: a table that fits at 1280
    // and not at 900 must gain the hint when the window narrows.
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [measure]);

  return (
    <div className={cn("relative", className)}>
      <div
        ref={ref}
        onScroll={measure}
        tabIndex={0}
        role="region"
        aria-label={label}
        className="overflow-x-auto"
      >
        {children}
      </div>
      {edges.left ? (
        <div
          aria-hidden
          className="from-background pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r to-transparent"
        />
      ) : null}
      {edges.right ? (
        <div
          aria-hidden
          className="from-background pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l to-transparent"
        />
      ) : null}
    </div>
  );
}
