"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { BarChart3, Database, MessagesSquare, Plug, Settings2 } from "lucide-react";

import type { ProductSiteRef } from "@/lib/admin/adminApiClient";

const NAV = [
  { href: "/admin", label: "Overview", icon: BarChart3, exact: true },
  { href: "/admin/conversations", label: "Conversations", icon: MessagesSquare, exact: false },
  { href: "/admin/assistant", label: "Assistant", icon: Settings2, exact: false },
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

  function withSite(href: string): string {
    return currentSiteId ? `${href}?siteId=${encodeURIComponent(currentSiteId)}` : href;
  }

  function changeSite(siteId: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("siteId", siteId);
    router.push(`${pathname}?${params.toString()}`);
  }

  function isActive(href: string, exact: boolean): boolean {
    return exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
  }

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
          <Link href={withSite("/admin")} className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-slate-900 text-xs font-bold text-white">
              CB
            </span>
            <span className="text-sm font-semibold tracking-tight">Chatbot admin</span>
          </Link>
          <span className="hidden text-xs text-slate-400 sm:inline">{identity.productSlug}</span>
          <div className="ml-auto flex items-center gap-3">
            {sites.length > 0 ? (
              <select
                value={currentSiteId}
                onChange={(event) => changeSite(event.target.value)}
                className="h-9 rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-700 focus:border-slate-500 focus:outline-none"
                aria-label="Select site"
              >
                {sites.map((site) => (
                  <option key={site.siteId} value={site.siteId}>
                    {site.name} ({site.merchantName})
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-xs text-slate-400">No sites</span>
            )}
            <span className="hidden text-sm text-slate-600 md:inline">{identity.name}</span>
          </div>
        </div>
        <nav className="mx-auto flex max-w-6xl items-center gap-1 overflow-x-auto px-4">
          {NAV.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.href, item.exact);
            return (
              <Link
                key={item.href}
                href={withSite(item.href)}
                className={`flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors ${
                  active
                    ? "border-slate-900 text-slate-900"
                    : "border-transparent text-slate-500 hover:text-slate-800"
                }`}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
