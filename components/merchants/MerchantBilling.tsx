"use client";

import { useCallback, useEffect, useState } from "react";

import { formatCurrency } from "@/components/products/currency";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { platformApi } from "@/lib/api/client";
import type { MerchantBillingSummary } from "@/lib/types";

export function MerchantBilling({ merchantId }: { merchantId: string }) {
  const [billing, setBilling] = useState<MerchantBillingSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const response = await platformApi.getMerchantBilling(merchantId);
      setBilling(response.billing);
    } catch {
      setError("Could not load billing.");
    } finally {
      setLoading(false);
    }
  }, [merchantId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return <p className="text-sm text-ink-muted" aria-live="polite">Loading billing...</p>;
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

  if (!billing) {
    return null;
  }

  const buckets = billing.totals;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {buckets.length === 0 ? (
          <Card>
            <p className="text-sm text-ink-muted">No paid subscriptions yet.</p>
          </Card>
        ) : (
          buckets.map((bucket) => (
            <Card key={bucket.currency}>
              <p className="text-sm text-ink-muted">{bucket.currency} monthly</p>
              <p className="mt-1 text-2xl font-semibold text-ink">
                {formatCurrency(bucket.amount, bucket.currency)}
              </p>
            </Card>
          ))
        )}
      </div>

      {billing.lineItems.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-line bg-surface-subtle/60 text-xs uppercase tracking-wide text-ink-faint">
              <tr>
                <th className="px-4 py-3">Site</th>
                <th className="px-4 py-3">Product</th>
                <th className="px-4 py-3">Plan</th>
                <th className="px-4 py-3 text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {billing.lineItems.map((lineItem) => (
                <tr key={`${lineItem.siteId}-${lineItem.productSlug}`}>
                  <td className="px-4 py-3 font-medium text-ink">{lineItem.siteName}</td>
                  <td className="px-4 py-3 text-ink-secondary">{lineItem.productName}</td>
                  <td className="px-4 py-3 text-ink-secondary">{lineItem.planName}</td>
                  <td className="px-4 py-3 text-right font-medium text-ink">
                    {formatCurrency(lineItem.amount, lineItem.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
