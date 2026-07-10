"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

import { adminApi, type OverviewData } from "@/lib/admin/adminApiClient";
import {
  Card,
  DetailSkeleton,
  NoSiteSelected,
  PageError,
  PageHeading,
  StatCard,
} from "@/components/admin/ui";

function formatDuration(milliseconds: number | null): string {
  if (milliseconds === null) {
    return "-";
  }
  if (milliseconds < 60_000) {
    return `${Math.round(milliseconds / 1000)}s`;
  }
  return `${Math.round(milliseconds / 60_000)}m`;
}

export function OverviewClient() {
  const siteId = useSearchParams().get("siteId") ?? "";
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!siteId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    adminApi
      .overview(siteId)
      .then((result) => setData(result))
      .catch(() => setError("Could not load analytics."))
      .finally(() => setLoading(false));
  }, [siteId]);

  useEffect(() => {
    load();
  }, [load]);

  if (!siteId) {
    return <NoSiteSelected />;
  }
  if (loading) {
    return <DetailSkeleton />;
  }
  if (error || !data) {
    return <PageError message={error ?? "No data."} onRetry={load} />;
  }

  const maxVolume = Math.max(1, ...data.volume.map((point) => point.count));

  return (
    <div className="admin-page-stack">
      <PageHeading
        title="Overview"
        subtitle={`Conversation analytics over the last ${data.windowDays} days.`}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Total" value={data.totals.total} />
        <StatCard label="Open" value={data.totals.open} tone="warning" />
        <StatCard
          label="Awaiting customer"
          value={data.totals["awaiting-customer"]}
          tone="brand"
        />
        <StatCard
          label="Resolved"
          value={data.totals.resolved}
          tone="success"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <h3 className="text-[13px] font-semibold text-[var(--ink)]">
            Conversation volume
          </h3>
          <div
            className="mt-4 flex h-40 items-end gap-1"
            role="img"
            aria-label="Conversation volume chart"
          >
            {data.volume.map((point) => (
              <div
                key={point.date}
                className="flex flex-1 flex-col items-center gap-1"
                title={`${point.date}: ${point.count}`}
              >
                <div
                  className="w-full rounded-t bg-[var(--brand-800)]"
                  style={{
                    height: `${Math.max(2, (point.count / maxVolume) * 100)}%`,
                  }}
                />
                <span className="text-[9px] text-[var(--ink-faint)]">
                  {point.date.slice(5)}
                </span>
              </div>
            ))}
          </div>
        </Card>
        <Card>
          <h3 className="text-[13px] font-semibold text-[var(--ink)]">
            Avg first response
          </h3>
          <p className="mt-4 text-4xl font-bold text-[var(--ink)]">
            {formatDuration(data.avgFirstResponseMs)}
          </p>
          <p className="mt-2 text-[13px] text-[var(--ink-muted)]">
            Time from a customer&apos;s first message to the first reply.
          </p>
        </Card>
      </div>
    </div>
  );
}
