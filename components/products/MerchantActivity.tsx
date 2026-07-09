"use client";

import { useEffect, useState } from "react";
import { ScrollText } from "lucide-react";

import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { platformApi } from "@/lib/api/client";
import type { AuditLogSummary } from "@/lib/types";

export function MerchantActivity({ merchantId, refreshSignal = 0 }: { merchantId: string; refreshSignal?: number }) {
  const [entries, setEntries] = useState<AuditLogSummary[]>([]);

  useEffect(() => {
    let active = true;
    void platformApi
      .listAuditLogs(merchantId)
      .then((response) => {
        if (active) {
          setEntries(response.items);
        }
      })
      .catch(() => {
        // Activity is best-effort; product actions surface their own toasts.
      });
    return () => {
      active = false;
    };
  }, [merchantId, refreshSignal]);

  return (
    <Card className="shadow-sm border-line bg-surface h-fit">
      <CardHeader title="Activity" description="Recent actions across your sites and products." />
      {entries.length === 0 ? (
        <EmptyState icon={ScrollText} title="No activity yet" description="Actions will appear here as changes are made." />
      ) : (
        <ul className="space-y-3">
          {entries.map((entry) => (
            <li key={entry.id} className="rounded-md border border-line px-4 py-3">
              <p className="font-medium text-ink">{entry.action}</p>
              <p className="text-sm text-ink-muted">{new Date(entry.createdAt).toLocaleString()}</p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
