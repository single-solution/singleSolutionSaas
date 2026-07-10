"use client";

import { useCallback, useEffect, useState } from "react";

import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { platformApi } from "@/lib/api/client";
import type { SubscriptionHistoryEntry } from "@/lib/types";

function humanizeStatus(status: string): string {
  if (status === "awaiting-customer") {
    return "Waiting on customer";
  }
  if (status === "deletion_scheduled") {
    return "Deletion scheduled";
  }
  return status
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function SubscriptionHistory({ merchantId }: { merchantId: string }) {
  const [entries, setEntries] = useState<SubscriptionHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const response = await platformApi.listSubscriptionHistory(merchantId, 1, 50);
      setEntries(response.items);
    } catch {
      setError("Could not load subscription history.");
    } finally {
      setLoading(false);
    }
  }, [merchantId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return <p className="text-sm text-ink-muted" aria-live="polite">Loading history...</p>;
  }

  if (error) {
    return (
      <Alert tone="danger" title="Load failed">
        {error}
        <div className="mt-3">
          <Button variant="outline" size="sm" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      </Alert>
    );
  }

  if (entries.length === 0) {
    return (
      <p className="text-sm text-ink-muted">
        No subscription lifecycle changes recorded yet.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-surface">
      <table className="min-w-full text-left text-sm">
        <thead className="border-b border-line bg-surface-subtle/60 text-xs uppercase tracking-wide text-ink-faint">
          <tr>
            <th className="px-4 py-3">When</th>
            <th className="px-4 py-3">Site</th>
            <th className="px-4 py-3">Product</th>
            <th className="px-4 py-3">Change</th>
            <th className="px-4 py-3">Reason</th>
            <th className="px-4 py-3">Actor</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td className="px-4 py-3 text-ink-secondary">
                {new Date(entry.at).toLocaleString()}
              </td>
              <td className="px-4 py-3 font-medium text-ink">{entry.siteName}</td>
              <td className="px-4 py-3 text-ink-secondary">{entry.productName}</td>
              <td className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  {entry.fromStatus ? (
                    <Badge tone="neutral">{humanizeStatus(entry.fromStatus)}</Badge>
                  ) : (
                    <Badge tone="neutral">Created</Badge>
                  )}
                  <span className="text-ink-faint">→</span>
                  <Badge tone="brand">{humanizeStatus(entry.toStatus)}</Badge>
                </div>
              </td>
              <td className="px-4 py-3 text-ink-secondary">{entry.reason || "-"}</td>
              <td className="px-4 py-3 font-mono text-xs text-ink-muted">
                {entry.actorUserId ? entry.actorUserId.slice(-8) : "System"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
