import type { ReactNode } from "react";
import { AuthenticatedShell } from "@/components/shell/AuthenticatedShell";

/**
 * The operations page is a sibling of `/studies`, not a child, so it needs the
 * shell declared for it — without this the sidebar linked to a screen that had
 * no sidebar, and an admin who followed the link had no way back.
 */
export default function OpsLayout({ children }: { children: ReactNode }) {
  return <AuthenticatedShell>{children}</AuthenticatedShell>;
}
