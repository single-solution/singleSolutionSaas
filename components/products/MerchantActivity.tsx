"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ScrollText } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { MerchantActivitySkeleton } from "@/components/ui/portalSkeletons";
import { platformApi } from "@/lib/api/client";
import type { AuditLogSummary } from "@/lib/types";

export function MerchantActivity({
  merchantId,
  refreshSignal = 0,
}: {
  merchantId: string;
  refreshSignal?: number;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [entries, setEntries] = useState<AuditLogSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const page = Math.max(
    1,
    Number(searchParams.get("activityPage") ?? "1") || 1,
  );
  const pageSize = 20;

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
    setLoading(true);
    void platformApi
      .listAuditLogs(merchantId, page, pageSize)
      .then((response) => {
        if (active) {
          setEntries(response.items);
          setTotal(response.total);
        }
      })
      .catch(() => {
        // Activity is best-effort; product actions surface their own toasts.
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [merchantId, page, refreshSignal]);

  if (loading) {
    return <MerchantActivitySkeleton />;
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
