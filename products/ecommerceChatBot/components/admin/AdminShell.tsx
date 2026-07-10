"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  BarChart3,
  Database,
  MessagesSquare,
  Plug,
  Settings2,
} from "lucide-react";

import type { ProductSiteRef } from "@/lib/admin/adminApiClient";
import { cn } from "@/components/admin/cn";

const NAV = [
  { href: "/admin", label: "Overview", icon: BarChart3, exact: true },
  {
    href: "/admin/conversations",
    label: "Conversations",
    icon: MessagesSquare,
    exact: false,
  },
  {
    href: "/admin/assistant",
    label: "Assistant",
    icon: Settings2,
    exact: false,
  },
  { href: "/admin/webhooks", label: "Webhooks", icon: Plug, exact: false },
  { href: "/admin/data", label: "Data", icon: Database, exact: false },
];

export function AdminShell({
  identity,
  sites,
  children,
}: {
  identity: { name: string; productSlug: string };
  sites: ProductSiteRef[];
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const currentSiteId = searchParams.get("siteId") ?? sites[0]?.siteId ?? "";
  const currentSite = sites.find((site) => site.siteId === currentSiteId);

  function withSite(href: string): string {
    return currentSiteId
      ? `${href}?siteId=${encodeURIComponent(currentSiteId)}`
      : href;
  }

  function changeSite(siteId: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("siteId", siteId);
    router.push(`${pathname}?${params.toString()}`);
  }

  function isActive(href: string, exact: boolean): boolean {
    return exact
      ? pathname === href
      : pathname === href || pathname.startsWith(`${href}/`);
  }

  return (
    <div className="admin-app flex h-dvh flex-col overflow-hidden p-2 sm:p-3">
      <a
        href="#admin-main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-6 focus:top-6 focus:z-50 focus:rounded-md focus:bg-[var(--surface)] focus:px-3 focus:py-2 focus:shadow-[var(--shadow-panel)]"
      >
        Skip to main content
      </a>

      <div className="mx-auto flex w-full min-h-0 max-w-[1920px] flex-1 flex-col gap-2 sm:gap-3">
        <header className="z-30 flex shrink-0 flex-col rounded-xl border border-[var(--line)] bg-[var(--surface)] shadow-[var(--shadow-card)]">
          <div className="flex h-14 items-center gap-2 px-3 sm:gap-4 sm:px-4">
            <Link
              href={withSite("/admin")}
              className="flex shrink-0 items-center gap-2.5"
            >
              <div className="admin-glass-shine flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--ink)] text-white shadow-sm">
                <MessagesSquare className="h-3.5 w-3.5" aria-hidden="true" />
              </div>
              <div className="hidden flex-col sm:flex">
                <span className="text-[13px] font-semibold leading-none tracking-tight text-[var(--ink)]">
                  Chatbot admin
                </span>
                <span className="mt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--brand-600)]">
                  {identity.productSlug}
                </span>
              </div>
            </Link>

            <span
              className="hidden h-6 w-px bg-[var(--line)] sm:block"
              aria-hidden="true"
            />

            <nav
              className="admin-no-scrollbar flex flex-1 items-center gap-1 overflow-x-auto"
              aria-label="Admin navigation"
            >
              {NAV.map((item) => {
                const Icon = item.icon;
                const active = isActive(item.href, item.exact);
                return (
                  <Link
                    key={item.href}
                    href={withSite(item.href)}
                    className={cn(
                      "group flex shrink-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors duration-150 motion-reduce:transition-none",
                      active
                        ? "bg-[var(--surface-subtle)] text-[var(--ink)]"
                        : "text-[var(--ink-secondary)] hover:bg-[var(--surface-subtle)] hover:text-[var(--ink)]",
                    )}
                    aria-current={active ? "page" : undefined}
                  >
                    <Icon
                      className={cn(
                        "h-4 w-4 shrink-0 transition-colors motion-reduce:transition-none",
                        active
                          ? "text-[var(--brand-600)]"
                          : "text-[var(--ink-faint)] group-hover:text-[var(--ink-muted)]",
                      )}
                      aria-hidden="true"
                    />
                    {item.label}
                  </Link>
                );
              })}
            </nav>

            <div className="flex shrink-0 items-center gap-2 sm:gap-3">
              {sites.length > 0 ? (
                <div className="flex flex-col items-end gap-0.5">
                  <select
                    value={currentSiteId}
                    onChange={(event) => changeSite(event.target.value)}
                    className="h-9 max-w-[12rem] rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 text-[13px] text-[var(--ink-secondary)] shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-colors hover:border-[var(--line-strong)] focus-visible:border-[var(--brand-600)] focus-visible:shadow-[var(--shadow-focus)] sm:max-w-[16rem]"
                    aria-label="Select site"
                  >
                    {sites.map((site) => (
                      <option key={site.siteId} value={site.siteId}>
                        {site.name} ({site.merchantName})
                      </option>
                    ))}
                  </select>
                  {currentSite ? (
                    <span className="hidden text-[10px] text-[var(--ink-faint)] sm:inline">
                      {currentSite.merchantName}
                    </span>
                  ) : null}
                </div>
              ) : (
                <span className="text-xs text-[var(--ink-faint)]">
                  No sites
                </span>
              )}
              <span className="hidden text-[13px] text-[var(--ink-secondary)] md:inline">
                {identity.name}
              </span>
            </div>
          </div>
        </header>

        <main
          id="admin-main-content"
          className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-[var(--line)] bg-[var(--surface)] shadow-[var(--shadow-card)]"
        >
          <div className="admin-animate-fade-in-up p-4 sm:p-5 lg:p-6">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
