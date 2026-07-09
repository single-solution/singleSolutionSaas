"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

import { adminApi, type OverviewData } from "@/lib/admin/adminApiClient";
import { NoSiteSelected, PageError, PageHeading } from "@/components/admin/ui";

function formatDuration(ms: number | null): string {
  if (ms === null) {
    return "-";
  }
  if (ms < 60_000) {
    return `${Math.round(ms / 1000)}s`;
  }
  return `${Math.round(ms / 60_000)}m`;
}

export function OverviewClient() {
  const siteId = useSearchParams().get("siteId") ?? "";
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!siteId) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    adminApi
      .overview(siteId)
      .then((result) => {
        if (active) setData(result);
      })
      .catch(() => {
        if (active) setError("Could not load analytics.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [siteId]);

  if (!siteId) {
    return <NoSiteSelected />;
  }
  if (loading) {
    return <p className="text-sm text-slate-500">Loading analytics...</p>;
  }
  if (error || !data) {
    return <PageError message={error ?? "No data."} />;
  }

  const maxVolume = Math.max(1, ...data.volume.map((point) => point.count));

  return (
    <div className="space-y-6">
      <PageHeading title="Overview" subtitle={`Conversation analytics over the last ${data.windowDays} days.`} />

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Total" value={data.totals.total} />
        <Stat label="Open" value={data.totals.open} tone="amber" />
        <Stat label="Awaiting customer" value={data.totals["awaiting-customer"]} tone="sky" />
        <Stat label="Resolved" value={data.totals.resolved} tone="emerald" />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-5 lg:col-span-2">
          <h3 className="text-sm font-semibold text-slate-800">Conversation volume</h3>
          <div className="mt-4 flex h-40 items-end gap-1">
            {data.volume.map((point) => (
              <div key={point.date} className="flex flex-1 flex-col items-center gap-1" title={`${point.date}: ${point.count}`}>
                <div
                  className="w-full rounded-t bg-slate-800"
                  style={{ height: `${Math.max(2, (point.count / maxVolume) * 100)}%` }}
                />
                <span className="text-[9px] text-slate-400">{point.date.slice(5)}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <h3 className="text-sm font-semibold text-slate-800">Avg first response</h3>
          <p className="mt-4 text-4xl font-bold text-slate-900">{formatDuration(data.avgFirstResponseMs)}</p>
          <p className="mt-2 text-sm text-slate-500">Time from a customer&apos;s first message to the first reply.</p>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone = "slate" }: { label: string; value: number; tone?: "slate" | "amber" | "sky" | "emerald" }) {
  const toneClass = {
    slate: "text-slate-900",
    amber: "text-amber-600",
    sky: "text-sky-600",
    emerald: "text-emerald-600",
  }[tone];
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${toneClass}`}>{value}</p>
    </div>
  );
}
