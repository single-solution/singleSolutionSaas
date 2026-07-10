"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Boxes, ChevronRight, Globe, KeyRound, Search } from "lucide-react";

import { useAuth } from "@/components/AuthProvider";
import { PageHeader } from "@/components/layout/PageHeader";
import { formatCurrency } from "@/components/products/currency";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { ResourceCard } from "@/components/ui/ResourceCard";
import {
  DETAIL_FIRST_MAX_COUNT,
  SiteDirectorySkeleton,
} from "@/components/ui/portalSkeletons";
import { platformApi } from "@/lib/api/client";
import { useDebounce } from "@/hooks/useDebounce";
import type { SiteSummary } from "@/lib/types";

export default function SitesPage() {
  const { user } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [sites, setSites] = useState<SiteSummary[]>([]);
  const [merchants, setMerchants] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState(searchParams.get("search") ?? "");
  const search = searchParams.get("search") ?? "";
  const debouncedSearchInput = useDebounce(searchInput, 300);
  const status = searchParams.get("status") ?? "all";
  const merchantFilter = searchParams.get("merchantId") ?? "";

  const filteredSites = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return sites.filter((site) => {
      const matchesSearch =
        !normalizedSearch ||
        [site.name, site.primaryDomain, site.merchantName, site.slug].some(
          (value) => value?.toLowerCase().includes(normalizedSearch),
        );
      const matchesStatus =
        status === "all" ||
        (status === "attention" &&
          (!site.primaryDomain || (site.suspendedProducts ?? 0) > 0)) ||
        (status === "active" &&
          Boolean(site.primaryDomain) &&
          (site.suspendedProducts ?? 0) === 0);
      return matchesSearch && matchesStatus;
    });
  }, [search, sites, status]);

  const load = useCallback(async () => {
    if (!user) {
      return;
    }

    setError(null);
    setLoading(true);
    try {
      if (user.isPlatformAdmin) {
        const response = await platformApi.listAllSitesAdmin();
        setSites(response.items);
        return;
      }
      const merchants = await platformApi.listMerchants();
      setMerchants(merchants.items.map((merchant) => ({
        id: merchant.id,
        name: merchant.name,
      })));
      const scopedMerchants =
        merchantFilter &&
        merchants.items.some((merchant) => merchant.id === merchantFilter)
          ? merchants.items.filter((merchant) => merchant.id === merchantFilter)
          : merchants.items;
      const siteResponses = await Promise.all(
        scopedMerchants.map((merchant) => platformApi.listSites(merchant.id)),
      );
      setSites(siteResponses.flatMap((response) => response.items));
    } catch {
      setError("Could not load sites.");
    } finally {
      setLoading(false);
    }
  }, [user, merchantFilter]);

  function updateQuery(key: "search" | "status", value: string) {
    const next = new URLSearchParams(searchParams.toString());
    if (!value || value === "all") {
      next.delete(key);
    } else {
      next.set(key, value);
    }
    router.replace(`${pathname}${next.size ? `?${next.toString()}` : ""}`, {
      scroll: false,
    });
  }

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (user?.isPlatformAdmin || merchants.length <= 1) {
      return;
    }
    if (merchantFilter) {
      return;
    }
    const next = new URLSearchParams(searchParams.toString());
    next.set("merchantId", merchants[0].id);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }, [
    merchantFilter,
    merchants,
    pathname,
    router,
    searchParams,
    user?.isPlatformAdmin,
  ]);

  useEffect(() => {
    const next = new URLSearchParams(searchParams.toString());
    const normalized = debouncedSearchInput.trim();
    if (!normalized) {
      next.delete("search");
    } else {
      next.set("search", normalized);
    }
    const current = searchParams.get("search") ?? "";
    if (normalized === current) {
      return;
    }
    router.replace(`${pathname}${next.size ? `?${next.toString()}` : ""}`, {
      scroll: false,
    });
  }, [debouncedSearchInput, pathname, router, searchParams]);

  if (loading) {
    return <SiteDirectorySkeleton />;
  }

  if (error) {
    return (
      <Alert tone="danger" title="Could not load sites">
        {error}
        <div className="mt-3">
          <Button variant="outline" size="sm" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      </Alert>
    );
  }

  return (
    <div className="page-stack">
      <PageHeader
        title="Sites"
        description={
          user?.isPlatformAdmin
            ? "Manage every merchant deployment, subscription, key, and domain."
            : merchants.length > 1
              ? "Deployments for your selected workspace."
              : "Review the deployments provisioned by your platform administrator."
        }
      />

      {!user?.isPlatformAdmin && merchants.length > 1 ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <label htmlFor="sites-merchant-filter" className="text-sm font-medium text-ink">
            Workspace
          </label>
          <select
            id="sites-merchant-filter"
            value={merchantFilter || merchants[0]?.id || ""}
            onChange={(event) => {
              const next = new URLSearchParams(searchParams.toString());
              if (event.target.value) {
                next.set("merchantId", event.target.value);
              } else {
                next.delete("merchantId");
              }
              router.replace(`${pathname}${next.size ? `?${next.toString()}` : ""}`, {
                scroll: false,
              });
            }}
            className="min-h-11 max-w-md flex-1 rounded-md border border-line bg-surface px-3 text-sm text-ink focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          >
            {merchants.map((merchant) => (
              <option key={merchant.id} value={merchant.id}>
                {merchant.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface-subtle/50 p-3 sm:flex-row sm:items-center">
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint"
            aria-hidden="true"
          />
          <Input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            className="min-h-11 pl-9"
            aria-label="Search sites"
            placeholder="Search by site, domain, merchant, or slug..."
          />
        </div>
        <select
          value={status}
          onChange={(event) => updateQuery("status", event.target.value)}
          className="min-h-11 rounded-md border border-line bg-surface px-3 text-sm text-ink focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          aria-label="Filter site status"
        >
          <option value="all">All sites</option>
          <option value="active">Healthy</option>
          <option value="attention">Needs attention</option>
        </select>
        <span className="text-sm text-ink-muted">
          {filteredSites.length} results
        </span>
      </div>

      {sites.length === 0 ? (
        <EmptyState
          icon={Globe}
          title="No sites yet"
          description="A platform administrator must provision the first site."
        />
      ) : filteredSites.length === 0 ? (
        <EmptyState
          icon={Search}
          title="No matching sites"
          description="Clear the search or change the status filter."
        />
      ) : (
        <div
          className={
            filteredSites.length <= DETAIL_FIRST_MAX_COUNT
              ? "space-y-3"
              : "grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
          }
        >
          {filteredSites.map((site) =>
            filteredSites.length <= DETAIL_FIRST_MAX_COUNT ? (
              <Link
                key={site.id}
                href={`/sites/${site.id}`}
                className="group flex flex-col gap-4 rounded-xl border border-line bg-surface p-5 shadow-card transition-shadow hover:shadow-panel focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 lg:flex-row lg:items-center"
              >
                <div className="flex min-w-0 items-start justify-between gap-3 lg:w-72 lg:shrink-0">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700">
                      <Globe className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <div className="min-w-0">
                      <h3 className="truncate font-semibold text-ink transition-colors group-hover:text-brand-700">
                        {site.name}
                      </h3>
                      <p className="truncate text-sm text-ink-muted">
                        {site.primaryDomain || "Domain not configured"}
                      </p>
                      {user?.isPlatformAdmin && site.merchantName ? (
                        <p className="truncate text-[13px] text-ink-secondary">
                          {site.merchantName}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  <Badge tone={site.primaryDomain ? "success" : "danger"}>
                    {site.primaryDomain ? "Ready" : "Attention"}
                  </Badge>
                </div>

                <div className="grid flex-1 grid-cols-3 gap-px overflow-hidden rounded-lg border border-line bg-line text-center">
                  <div className="bg-surface px-2 py-3">
                    <Boxes
                      className="mx-auto h-4 w-4 text-ink-faint"
                      aria-hidden="true"
                    />
                    <p className="mt-1 font-semibold text-ink">
                      {site.activeProducts ?? 0}
                    </p>
                    <p className="text-xs text-ink-faint">Products</p>
                  </div>
                  <div className="bg-surface px-2 py-3">
                    <KeyRound
                      className="mx-auto h-4 w-4 text-ink-faint"
                      aria-hidden="true"
                    />
                    <p className="mt-1 font-semibold text-ink">
                      {site.activeTokens ?? 0}
                    </p>
                    <p className="text-xs text-ink-faint">Keys</p>
                  </div>
                  <div className="bg-surface px-2 py-3">
                    <p className="font-semibold text-ink">
                      {site.monthlySpend && site.currency
                        ? formatCurrency(site.monthlySpend, site.currency)
                        : "-"}
                    </p>
                    <p className="mt-1 text-xs text-ink-faint">Monthly</p>
                  </div>
                </div>

                <span className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 lg:shrink-0">
                  Manage
                  <ChevronRight
                    className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
                    aria-hidden="true"
                  />
                </span>
              </Link>
            ) : (
              <ResourceCard
                key={site.id}
                title={site.name}
                subtitle={site.primaryDomain || "Domain not configured"}
                href={`/sites/${site.id}`}
                icon={Globe}
                badge={
                  <Badge tone={site.primaryDomain ? "success" : "danger"}>
                    {site.primaryDomain ? "Ready" : "Attention"}
                  </Badge>
                }
                footer={
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-ink-muted">
                      {(site.suspendedProducts ?? 0) > 0
                        ? `${site.suspendedProducts} suspended`
                        : "Subscriptions healthy"}
                    </span>
                    <Link
                      href={`/sites/${site.id}`}
                      className="text-sm font-medium text-brand-700 hover:text-brand-800"
                    >
                      Manage
                    </Link>
                  </div>
                }
              >
                {user?.isPlatformAdmin && site.merchantName ? (
                  <p className="mt-3 truncate text-sm text-ink-secondary">
                    {site.merchantName}
                  </p>
                ) : null}

                <div className="mt-4 grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-line bg-line text-center">
                  <div className="bg-surface px-2 py-3">
                    <Boxes
                      className="mx-auto h-4 w-4 text-ink-faint"
                      aria-hidden="true"
                    />
                    <p className="mt-1 font-semibold text-ink">
                      {site.activeProducts ?? 0}
                    </p>
                    <p className="text-xs text-ink-faint">Products</p>
                  </div>
                  <div className="bg-surface px-2 py-3">
                    <KeyRound
                      className="mx-auto h-4 w-4 text-ink-faint"
                      aria-hidden="true"
                    />
                    <p className="mt-1 font-semibold text-ink">
                      {site.activeTokens ?? 0}
                    </p>
                    <p className="text-xs text-ink-faint">Keys</p>
                  </div>
                  <div className="bg-surface px-2 py-3">
                    <p className="font-semibold text-ink">
                      {site.monthlySpend && site.currency
                        ? formatCurrency(site.monthlySpend, site.currency)
                        : "-"}
                    </p>
                    <p className="mt-1 text-xs text-ink-faint">Monthly</p>
                  </div>
                </div>
              </ResourceCard>
            ),
          )}
        </div>
      )}
    </div>
  );
}
