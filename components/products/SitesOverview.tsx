"use client";

import Link from "next/link";
import { Boxes, ChevronRight, Globe } from "lucide-react";

import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import type { SiteOverview } from "./useMerchantOverview";
import { formatCurrency } from "./currency";

export function SitesOverview({ sites, hrefBase }: { sites: SiteOverview[]; hrefBase: string }) {
  if (sites.length === 0) {
    return (
      <Card className="shadow-sm border-line bg-surface">
        <CardHeader title="Sites" description="Deployments where your products run." />
        <EmptyState
          icon={Globe}
          title="No sites yet"
          description="Add a site to subscribe products and issue widget keys."
        />
      </Card>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {sites.map((entry, index) => (
        <Link
          key={entry.site.id}
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
                <p className="truncate text-[13px] text-ink-muted">{entry.site.primaryDomain || "No domain set"}</p>
              </div>
            </div>
            <ChevronRight className="h-4 w-4 shrink-0 text-ink-faint transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
          </div>

          <div className="mt-4 flex items-center justify-between border-t border-line pt-4 text-[13px]">
            <span className="inline-flex items-center gap-1.5 text-ink-muted">
              <Boxes className="h-3.5 w-3.5" aria-hidden="true" />
              {entry.activeProducts} {entry.activeProducts === 1 ? "product" : "products"}
            </span>
            <span className="font-medium text-ink">{formatCurrency(entry.monthlySpend, entry.currency)}/mo</span>
          </div>
        </Link>
      ))}
    </div>
  );
}
