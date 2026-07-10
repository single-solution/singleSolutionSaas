"use client";

import Link from "next/link";
import { Boxes, ChevronRight, Globe } from "lucide-react";

import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { DETAIL_FIRST_MAX_COUNT } from "@/components/ui/portalSkeletons";
import type { SiteOverview } from "./useMerchantOverview";
import { formatCurrency } from "./currency";

function SiteMetrics({ entry }: { entry: SiteOverview }) {
  return (
    <div className="grid flex-1 grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3">
      <div className="bg-surface px-3 py-3 text-center sm:text-left">
        <p className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">
          Products
        </p>
        <p className="mt-1 text-sm font-semibold text-ink">
          {entry.activeProducts}
        </p>
      </div>
      <div className="bg-surface px-3 py-3 text-center sm:text-left">
        <p className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">
          Monthly
        </p>
        <p className="mt-1 text-sm font-semibold text-ink">
          {formatCurrency(entry.monthlySpend, entry.currency)}
        </p>
      </div>
      <div className="col-span-2 bg-surface px-3 py-3 text-center sm:col-span-1 sm:text-left">
        <p className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">
          Domain
        </p>
        <p className="mt-1 truncate text-sm font-semibold text-ink">
          {entry.site.primaryDomain || "Not set"}
        </p>
      </div>
    </div>
  );
}

function SiteDetailRow({
  entry,
  hrefBase,
  index,
}: {
  entry: SiteOverview;
  hrefBase: string;
  index: number;
}) {
  return (
    <Link
      href={`${hrefBase}/${entry.site.id}`}
      style={{ animationDelay: `${index * 0.04}s` }}
      className="group flex animate-fade-in-up flex-col gap-4 rounded-xl border border-line bg-surface p-5 shadow-sm transition-all hover:border-brand-300 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 lg:flex-row lg:items-center"
    >
      <div className="flex min-w-0 items-center gap-3 lg:w-64 lg:shrink-0">
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700">
          <Globe className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h3 className="truncate font-semibold tracking-tight text-ink transition-colors group-hover:text-brand-700">
            {entry.site.name}
          </h3>
          <p className="truncate text-[13px] text-ink-muted">
            {entry.site.primaryDomain || "No domain set"}
          </p>
        </div>
      </div>

      <SiteMetrics entry={entry} />

      <div className="flex items-center justify-between gap-3 border-t border-line pt-4 lg:w-auto lg:shrink-0 lg:border-t-0 lg:pt-0">
        <span className="inline-flex items-center gap-1.5 text-[13px] text-ink-muted lg:hidden">
          <Boxes className="h-3.5 w-3.5" aria-hidden="true" />
          {entry.activeProducts}{" "}
          {entry.activeProducts === 1 ? "product" : "products"}
        </span>
        <span className="inline-flex items-center gap-1 text-[13px] font-medium text-brand-700">
          Manage site
          <ChevronRight
            className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
            aria-hidden="true"
          />
        </span>
      </div>
    </Link>
  );
}

function SiteGridCard({
  entry,
  hrefBase,
  index,
}: {
  entry: SiteOverview;
  hrefBase: string;
  index: number;
}) {
  return (
    <Link
      href={`${hrefBase}/${entry.site.id}`}
      style={{ animationDelay: `${index * 0.04}s` }}
      className="group flex animate-fade-in-up flex-col rounded-xl border border-line bg-surface p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700">
            <Globe className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h3 className="truncate font-semibold tracking-tight text-ink transition-colors group-hover:text-brand-700">
              {entry.site.name}
            </h3>
            <p className="truncate text-[13px] text-ink-muted">
              {entry.site.primaryDomain || "No domain set"}
            </p>
          </div>
        </div>
        <ChevronRight
          className="h-4 w-4 shrink-0 text-ink-faint transition-transform group-hover:translate-x-0.5"
          aria-hidden="true"
        />
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-line pt-4 text-[13px]">
        <span className="inline-flex items-center gap-1.5 text-ink-muted">
          <Boxes className="h-3.5 w-3.5" aria-hidden="true" />
          {entry.activeProducts}{" "}
          {entry.activeProducts === 1 ? "product" : "products"}
        </span>
        <span className="font-medium text-ink">
          {formatCurrency(entry.monthlySpend, entry.currency)}/mo
        </span>
      </div>
    </Link>
  );
}

export function SitesOverview({
  sites,
  hrefBase,
}: {
  sites: SiteOverview[];
  hrefBase: string;
}) {
  if (sites.length === 0) {
    return (
      <Card className="shadow-sm border-line bg-surface">
        <CardHeader
          title="Sites"
          description="Deployments where your products run."
        />
        <EmptyState
          icon={Globe}
          title="No sites yet"
          description="Add a site to subscribe products and issue widget keys."
        />
      </Card>
    );
  }

  const detailFirst = sites.length <= DETAIL_FIRST_MAX_COUNT;

  if (detailFirst) {
    return (
      <div className="space-y-3">
        {sites.map((entry, index) => (
          <SiteDetailRow
            key={entry.site.id}
            entry={entry}
            hrefBase={hrefBase}
            index={index}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {sites.map((entry, index) => (
        <SiteGridCard
          key={entry.site.id}
          entry={entry}
          hrefBase={hrefBase}
          index={index}
        />
      ))}
    </div>
  );
}
