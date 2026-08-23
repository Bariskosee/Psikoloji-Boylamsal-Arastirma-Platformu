import type { ReactNode } from "react";
import { AuthenticatedShell } from "@/components/shell/AuthenticatedShell";

/** Every `/studies/**` screen runs inside the signed-in shell. */
export default function StudiesLayout({ children }: { children: ReactNode }) {
  return <AuthenticatedShell>{children}</AuthenticatedShell>;
}
