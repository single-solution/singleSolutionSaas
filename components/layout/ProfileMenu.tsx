"use client";

import { useState } from "react";
import { ChevronDown, LogOut, Settings } from "lucide-react";

import { DropdownMenu } from "@/components/ui/DropdownMenu";
import { cn } from "@/lib/cn";
import type { UserSummary } from "@/lib/types";

function initials(name: string, email: string): string {
  const source = name.trim() || email;
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}

export function ProfileMenu({
  user,
  settingsHref,
  onSignOut,
  onSignOutEverywhere,
}: {
  user: UserSummary;
  settingsHref: string;
  onSignOut: () => Promise<void>;
  onSignOutEverywhere?: () => Promise<void>;
}) {
  const [signingOut, setSigningOut] = useState(false);
  const [signingOutEverywhere, setSigningOutEverywhere] = useState(false);

  async function handleSignOut(run: () => Promise<void>, setBusy: (value: boolean) => void) {
    setBusy(true);
    try {
      await run();
    } finally {
      setBusy(false);
    }
  }

  return (
    <DropdownMenu
      header={
        <>
          <p className="truncate text-sm font-medium text-ink">{user.name}</p>
          <p className="truncate text-xs text-ink-muted">{user.email}</p>
        </>
      }
      items={[
        { label: "Account settings", href: settingsHref, icon: Settings },
        {
          label: signingOut ? "Signing out..." : "Sign out",
          icon: LogOut,
          disabled: signingOut || signingOutEverywhere,
          onSelect: () => void handleSignOut(onSignOut, setSigningOut),
        },
        ...(onSignOutEverywhere
          ? [
              {
                label: signingOutEverywhere ? "Signing out everywhere..." : "Sign out everywhere",
                icon: LogOut,
                disabled: signingOut || signingOutEverywhere,
                onSelect: () => void handleSignOut(onSignOutEverywhere, setSigningOutEverywhere),
              },
            ]
          : []),
      ]}
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-haspopup="menu"
          aria-expanded={open}
          className="flex items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-surface-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-ink text-xs font-semibold text-white">
            {initials(user.name, user.email)}
          </span>
          <span className="hidden text-sm font-medium leading-none text-ink md:block">
            {user.name}
          </span>
          <ChevronDown
            className={cn(
              "hidden h-4 w-4 text-ink-faint transition-transform md:block",
              open && "rotate-180",
            )}
            aria-hidden="true"
          />
        </button>
      )}
    />
  );
}
