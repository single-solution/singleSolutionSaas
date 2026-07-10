"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Boxes, Globe, KeyRound, Search } from "lucide-react";

import { useAuth } from "@/components/AuthProvider";
import { PageHeader } from "@/components/layout/PageHeader";
import { formatCurrency } from "@/components/products/currency";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { ResourceCard } from "@/components/ui/ResourceCard";
import { DetailSkeleton } from "@/components/ui/Skeleton";
import { platformApi } from "@/lib/api/client";
import type { SiteSummary } from "@/lib/types";

export default function SitesPage() {
  const { user } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [sites, setSites] = useState<SiteSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const search = searchParams.get("search") ?? "";
  const status = searchParams.get("status") ?? "all";

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
      const siteResponses = await Promise.all(
        merchants.items.map((merchant) => platformApi.listSites(merchant.id)),
      );
      setSites(siteResponses.flatMap((response) => response.items));
    } catch {
      setError("Could not load sites.");
    } finally {
      setLoading(false);
    }
  }, [user]);

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

  if (loading) {
    return <DetailSkeleton />;
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
            : "Review the deployments provisioned by your platform administrator."
        }
      />

      <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface-subtle/50 p-3 sm:flex-row sm:items-center">
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint"
            aria-hidden="true"
          />
          <Input
            value={search}
            onChange={(event) => updateQuery("search", event.target.value)}
            className="pl-9"
            aria-label="Search sites"
            placeholder="Search by site, domain, merchant, or slug..."
          />
        </div>
        <select
          value={status}
          onChange={(event) => updateQuery("status", event.target.value)}
          className="h-10 rounded-md border border-line bg-surface px-3 text-sm text-ink focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
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
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {filteredSites.map((site) => (
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
                  <span className="text-xs text-ink-faint">
                    {site.lastActivityAt
                      ? `Active ${new Date(site.lastActivityAt).toLocaleDateString()}`
                      : "No usage yet"}
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
          ))}
        </div>
      )}
    </div>
  );
}
