"use client";

import { useRouter } from "next/navigation";

import { useAuth } from "@/components/AuthProvider";
import { PortalShell } from "@/components/layout/PortalShell";
import { useToast } from "@/components/providers/ToastProvider";
import type { UserSummary } from "@/lib/types";

export function PortalLayoutClient({ user, children }: { user: UserSummary; children: React.ReactNode }) {
  const router = useRouter();
  const toast = useToast();
  const { logout } = useAuth();

  return (
    <PortalShell
      user={user}
      onSignOut={async () => {
        try {
          await logout();
          router.replace("/login");
          router.refresh();
        } catch {
          toast.showError("Sign out failed", "Try again in a moment.");
        }
      }}
    >
      {children}
    </PortalShell>
  );
}
