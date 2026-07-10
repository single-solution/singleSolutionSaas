"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Search } from "lucide-react";

import { MerchantActivity } from "@/components/products/MerchantActivity";
import { cn } from "@/lib/cn";
import { openCommandSearch } from "@/lib/portal/commandSearch";
import type { UserSummary } from "@/lib/types";

import {
  getMerchantTabHref,
  getWorkspaceNavigation,
  merchantContextLinks,
  type PortalNavigationItem,
} from "./portalNavigation";

export function PortalUtilities({ user }: { user: UserSummary }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const merchantId = resolveMerchantId(pathname, searchParams);
  const workspaceNavigation = getWorkspaceNavigation(user.isPlatformAdmin);
  const activeTab = searchParams.get("tab") ?? "overview";

  return (
    <aside
      aria-label="Portal utilities"
      className="shrink-0 border-t border-line bg-surface-subtle/40 lg:min-h-0 lg:w-72 lg:border-l lg:border-t-0"
    >
      <div className="space-y-5 p-3 sm:p-4 lg:max-h-full lg:overflow-y-auto">
        <UtilityCategory title="Quick actions">
          <button
            type="button"
            onClick={openCommandSearch}
            className="flex min-h-11 w-full items-center gap-2.5 rounded-md border border-line bg-surface px-2.5 py-2 text-left text-[13px] font-medium text-ink-secondary transition-colors hover:border-brand-300 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>Search portal</span>
            <kbd className="ml-auto hidden rounded border border-line bg-surface-subtle px-1.5 py-0.5 text-[10px] text-ink-faint lg:inline">
              Cmd K
            </kbd>
          </button>
        </UtilityCategory>

        <UtilityCategory title="Workspace">
          <nav className="space-y-0.5" aria-label="Workspace shortcuts">
            {workspaceNavigation.map((item) => (
              <UtilityLink
                key={item.href}
                href={item.href}
                label={item.label}
                icon={item.icon}
                active={isNavigationActive(pathname, item.href)}
              />
            ))}
          </nav>
        </UtilityCategory>

        {merchantId ? (
          <UtilityCategory title="Merchant">
            <nav className="space-y-0.5" aria-label="Merchant shortcuts">
              {merchantContextLinks.map((link) => (
                <UtilityLink
                  key={link.tabId}
                  href={getMerchantTabHref(merchantId, link.tabId)}
                  label={link.label}
                  icon={link.icon}
                  active={
                    pathname.startsWith(`/merchants/${merchantId}`) &&
                    activeTab === link.tabId
                  }
                />
              ))}
            </nav>
          </UtilityCategory>
        ) : null}

        <UtilityCategory title="Recent activity">
          {merchantId ? (
            <MerchantActivity merchantId={merchantId} mode="summary" />
          ) : (
            <p className="rounded-md border border-dashed border-line bg-surface px-3 py-4 text-[13px] leading-relaxed text-ink-muted">
              Activity appears here after you open or select a merchant workspace.
            </p>
          )}
        </UtilityCategory>
      </div>
    </aside>
  );
}

function UtilityLink({
  href,
  label,
  icon: Icon,
  active,
}: {
  href: string;
  label: string;
  icon: PortalNavigationItem["icon"];
  active?: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "flex min-h-11 items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
        active
          ? "bg-brand-50 text-brand-800"
          : "text-ink-secondary hover:bg-surface-subtle hover:text-ink",
      )}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </Link>
  );
}

function UtilityCategory({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h2 className="px-2.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
        {title}
      </h2>
      {children}
    </section>
  );
}

function resolveMerchantId(
  pathname: string,
  searchParams: URLSearchParams,
): string | null {
  const pathMatch = pathname.match(/^\/merchants\/([^/]+)/);
  if (pathMatch?.[1]) {
    return pathMatch[1];
  }

  const queryMerchantId = searchParams.get("merchantId")?.trim();

  return queryMerchantId || null;
}

function isNavigationActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
