"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ScrollText } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { MerchantActivitySkeleton } from "@/components/ui/portalSkeletons";
import { platformApi } from "@/lib/api/client";
import type { AuditLogSummary } from "@/lib/types";

const SUMMARY_LIMIT = 5;
const FULL_PAGE_SIZE = 20;

export function MerchantActivity({
  merchantId,
  refreshSignal = 0,
  mode = "full",
}: {
  merchantId: string;
  refreshSignal?: number;
  mode?: "full" | "summary";
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const isSummary = mode === "summary";
  const [entries, setEntries] = useState<AuditLogSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const page = isSummary
    ? 1
    : Math.max(1, Number(searchParams.get("activityPage") ?? "1") || 1);
  const pageSize = isSummary ? SUMMARY_LIMIT : FULL_PAGE_SIZE;

  function setPage(nextPage: number) {
    const next = new URLSearchParams(searchParams.toString());
    if (nextPage <= 1) {
      next.delete("activityPage");
    } else {
      next.set("activityPage", String(nextPage));
    }
    router.replace(`${pathname}${next.size ? `?${next.toString()}` : ""}`, {
      scroll: false,
    });
  }

  useEffect(() => {
    let active = true;
    setError(null);
    setLoading(true);
    void platformApi
      .listAuditLogs(merchantId, page, pageSize)
      .then((response) => {
        if (!active) {
          return;
        }
        setEntries(response.items);
        setTotal(response.total);
      })
      .catch(() => {
        if (active) {
          setError("Could not load activity.");
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [merchantId, page, pageSize, refreshSignal, reloadNonce]);

  if (loading) {
    return <MerchantActivitySkeleton compact={isSummary} />;
  }

  if (error) {
    return (
      <div
        className={
          isSummary
            ? "rounded-md border border-danger-border bg-danger-soft px-3 py-3 text-sm"
            : "rounded-xl border border-line bg-surface p-5 shadow-sm"
        }
        role="alert"
      >
        <p className="font-medium text-danger">{error}</p>
        <Button
          variant="outline"
          size="sm"
          className="mt-2 min-h-11"
          onClick={() => setReloadNonce((value) => value + 1)}
        >
          Retry
        </Button>
      </div>
    );
  }

  if (isSummary) {
    if (entries.length === 0) {
      return (
        <p className="rounded-md border border-dashed border-line bg-surface px-3 py-3 text-[13px] text-ink-muted">
          No recent activity for this merchant.
        </p>
      );
    }

    return (
      <div className="space-y-1">
        <ul className="divide-y divide-line rounded-md border border-line bg-surface">
          {entries.map((entry) => (
            <li key={entry.id} className="px-3 py-2">
              <p className="truncate text-[13px] font-medium text-ink">
                {humanizeAction(entry.action)}
              </p>
              <time
                dateTime={entry.createdAt}
                className="text-[11px] text-ink-faint"
              >
                {new Date(entry.createdAt).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </time>
            </li>
          ))}
        </ul>
        {total > SUMMARY_LIMIT ? (
          <Link
            href={`/merchants/${merchantId}?tab=activity`}
            className="inline-flex min-h-11 items-center text-[13px] font-medium text-brand-700 hover:text-brand-800"
          >
            View all activity
          </Link>
        ) : null}
      </div>
    );
  }

  return (
    <Card className="shadow-sm border-line bg-surface h-fit">
      <CardHeader
        title="Activity"
        description="Recent actions across your sites and products."
      />
      {entries.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title="No activity yet"
          description="Actions will appear here as changes are made."
        />
      ) : (
        <ul className="space-y-3">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="rounded-md border border-line px-4 py-3"
            >
              <p className="font-medium text-ink">
                {humanizeAction(entry.action)}
              </p>
              <p className="text-sm text-ink-muted">
                {new Date(entry.createdAt).toLocaleString()}
              </p>
            </li>
          ))}
        </ul>
      )}
      {total > pageSize ? (
        <div className="mt-4 flex items-center justify-between border-t border-line pt-4">
          <span className="text-sm text-ink-muted">
            Page {page} of {Math.ceil(total / pageSize)}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page * pageSize >= total}
              onClick={() => setPage(page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function humanizeAction(action: string): string {
  return action
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
