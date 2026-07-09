"use client";

import Link from "next/link";
import { Boxes, Globe, Plus, Wallet } from "lucide-react";

import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { DetailSkeleton } from "@/components/ui/Skeleton";
import { StatCard } from "@/components/ui/StatCard";

import { MerchantActivity } from "./MerchantActivity";
import { SitesOverview } from "./SitesOverview";
import { SpendBreakdown } from "./SpendBreakdown";
import { formatCurrency } from "./currency";
import { useMerchantOverview } from "./useMerchantOverview";

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) {
    return "Good morning";
  }
  if (hour < 18) {
    return "Good afternoon";
  }
  return "Good evening";
}

function currentPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}

export function MerchantDashboard({
  merchantId,
  merchantName,
  userName,
}: {
  merchantId: string;
  merchantName: string;
  userName: string;
}) {
  const overview = useMerchantOverview(merchantId);
  const firstName = userName.trim().split(/\s+/)[0] || "there";

  if (overview.loading) {
    return <DetailSkeleton />;
  }

  if (overview.error) {
    return (
      <Alert tone="danger" title="Load failed">
        {overview.error}
        <div className="mt-3">
          <Button variant="outline" size="sm" onClick={() => void overview.reload()}>
            Retry
          </Button>
        </div>
      </Alert>
    );
  }

  const totalSpend = overview.sites.reduce((sum, entry) => sum + entry.monthlySpend, 0);
  const spendCurrency = overview.sites.find((entry) => entry.monthlySpend > 0)?.currency ?? "USD";
  const activeProducts = overview.sites.reduce((sum, entry) => sum + entry.activeProducts, 0);
  const period = currentPeriod();

  return (
    <div className="page-stack">
      <div className="flex flex-wrap items-start justify-between gap-3 animate-fade-in-up">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold tracking-tight text-ink">
              {greeting()}, {firstName}
            </h1>
            <Badge tone="brand">{merchantName}</Badge>
          </div>
          <p className="mt-1 text-[13px] text-ink-muted">Here is what is happening across your sites today.</p>
        </div>
        <Link href="/sites">
          <Button size="sm" variant="outline">
            <Plus className="h-4 w-4" aria-hidden="true" />
            Manage sites
          </Button>
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatCard label="Monthly spend" value={formatCurrency(totalSpend, spendCurrency)} hint={`Estimated · ${period}`} icon={Wallet} accent />
        <StatCard label="Sites" value={String(overview.sites.length)} hint="Deployments" icon={Globe} />
        <StatCard label="Active products" value={String(activeProducts)} hint="Across all sites" icon={Boxes} />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <SpendBreakdown
            title="Spend by site"
            period={period}
            entries={overview.sites.map((entry) => ({
              id: entry.site.id,
              label: entry.site.name,
              amount: entry.monthlySpend,
              currency: entry.currency,
            }))}
          />
        </div>
        <MerchantActivity merchantId={merchantId} />
      </div>

      <div>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold tracking-tight text-ink">Your sites</h2>
          <span className="text-[12.5px] text-ink-muted">{overview.sites.length} total</span>
        </div>
        <SitesOverview sites={overview.sites} hrefBase="/sites" />
      </div>
    </div>
  );
}
