"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Boxes, Building2, Globe, LayoutDashboard, Users } from "lucide-react";

import { CommandSearch } from "@/components/layout/CommandSearch";
import { ProfileMenu } from "@/components/layout/ProfileMenu";
import { cn } from "@/lib/cn";
import type { UserSummary } from "@/lib/types";

interface NavItem {
  href: string;
  label: string;
  icon: typeof Building2;
}

const merchantNav: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/sites", label: "Sites", icon: Globe },
];
const adminNav: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/merchants", label: "Merchants", icon: Users },
  { href: "/sites", label: "Sites", icon: Globe },
  { href: "/products", label: "Products", icon: Boxes },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") {
    return pathname === "/";
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function PortalShell({
  user,
  onSignOut,
  children,
}: {
  user: UserSummary;
  onSignOut: () => Promise<void>;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const navItems = user.isPlatformAdmin ? adminNav : merchantNav;
  const roleLabel = user.isPlatformAdmin ? "Platform admin" : "Merchant portal";

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-surface-muted font-sans p-2 sm:p-3">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-6 focus:top-6 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:shadow-panel"
      >
        Skip to main content
      </a>

      <div className="mx-auto flex w-full min-h-0 max-w-[1920px] flex-1 flex-col gap-2 sm:gap-3">
        <header className="z-sticky flex h-14 shrink-0 items-center gap-2 rounded-xl border border-line bg-surface px-3 shadow-sm sm:gap-4 sm:px-4">
          <Link
            href="/dashboard"
            className="flex shrink-0 items-center gap-2.5"
          >
            <div className="glass-shine flex h-7 w-7 items-center justify-center rounded-lg bg-ink text-white shadow-sm">
              <Building2 className="h-3.5 w-3.5" aria-hidden="true" />
            </div>
            <div className="hidden flex-col sm:flex">
              <span className="text-[13px] font-semibold leading-none tracking-tight text-ink">
                Single Solution
              </span>
              <span className="mt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-brand-600">
                {roleLabel}
              </span>
            </div>
          </Link>

          <span
            className="hidden h-6 w-px bg-line sm:block"
            aria-hidden="true"
          />

          <nav
            className="flex flex-1 items-center gap-1 overflow-x-auto no-scrollbar"
            aria-label="Main navigation"
          >
            {navItems.map((item) => {
              const active = isActive(pathname, item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "group flex shrink-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors duration-150",
                    active
                      ? "bg-surface-subtle text-ink"
                      : "text-ink-secondary hover:bg-surface-subtle hover:text-ink",
                  )}
                >
                  <Icon
                    className={cn(
                      "h-4 w-4 shrink-0 transition-colors",
                      active
                        ? "text-brand-600"
                        : "text-ink-faint group-hover:text-ink-muted",
                    )}
                    aria-hidden="true"
                  />
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="flex shrink-0 items-center gap-2">
            <CommandSearch user={user} />
            <ProfileMenu
              user={user}
              settingsHref="/settings"
              onSignOut={onSignOut}
            />
          </div>
        </header>

        <main
          id="main-content"
          className="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-line bg-surface shadow-sm"
        >
          <div className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-5 lg:p-6">
            <div className="w-full motion-safe:animate-fade-in-up">
              {children}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
