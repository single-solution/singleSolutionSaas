"use client";

import { Boxes, ChevronRight, KeyRound, ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/Badge";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import type { ProductAccessTokenSummary, ProductUsageSummary, SubscriptionSummary } from "@/lib/types";

import { formatCurrency } from "./currency";

function StatusBadge({ product }: { product: SubscriptionSummary }) {
  if (!product.planCode) {
    return <Badge>No plan</Badge>;
  }
  return (
    <Badge tone={product.status === "active" ? "success" : "danger"}>
      {product.status === "active" ? "Active" : "Suspended"}
    </Badge>
  );
}

function UsagePreview({ usage }: { usage?: ProductUsageSummary }) {
  const metric = usage?.metrics.find((entry) => entry.limit !== null) ?? usage?.metrics[0];
  if (!usage || !metric) {
    return <p className="text-[13px] text-ink-faint">No usage recorded yet.</p>;
  }
  const pct = metric.limit ? Math.min(100, Math.round((metric.used / metric.limit) * 100)) : null;
  return (
    <div>
      <div className="flex items-center justify-between text-[13px]">
        <span className="text-ink-secondary">{metric.metric}</span>
        <span className={metric.withinQuota ? "text-ink" : "text-danger"}>
          {metric.used.toLocaleString()}
          {metric.limit !== null ? ` / ${metric.limit.toLocaleString()}` : ""}
        </span>
      </div>
      {pct !== null ? (
        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-subtle">
          <div
            className={metric.withinQuota ? "h-full bg-brand-600" : "h-full bg-danger"}
            style={{ width: `${pct}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}

export function ProductsOverview({
  products,
  usageBySlug,
  tokensBySlug,
  onSelect,
}: {
  products: SubscriptionSummary[];
  usageBySlug: Record<string, ProductUsageSummary>;
  tokensBySlug: Record<string, ProductAccessTokenSummary[]>;
  onSelect: (productSlug: string) => void;
}) {
  if (products.length === 0) {
    return (
      <Card className="shadow-sm border-line bg-surface">
        <CardHeader title="Products" description="Isolated SaaS products managed through this platform." />
        <EmptyState
          icon={Boxes}
          title="No products available"
          description="A platform admin registers products in the catalog before they appear here."
        />
      </Card>
    );
  }

  return (
    <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
      {products.map((product, index) => {
        const usage = usageBySlug[product.productSlug];
        const activeTokens = (tokensBySlug[product.productSlug] ?? []).filter((token) => !token.revokedAt).length;

        return (
          <button
            key={product.productSlug}
            type="button"
            onClick={() => onSelect(product.productSlug)}
            style={{ animationDelay: `${index * 0.04}s` }}
            className="group flex animate-fade-in-up flex-col rounded-xl border border-line bg-surface p-5 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700">
                  <Boxes className="h-5 w-5" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <h3 className="truncate font-semibold tracking-tight text-ink transition-colors group-hover:text-brand-700">
                    {product.displayName}
                  </h3>
                  <p className="truncate text-[13px] text-ink-muted">{product.planName ?? "Unassigned plan"}</p>
                </div>
              </div>
              <StatusBadge product={product} />
            </div>

            <p className="mt-4 line-clamp-2 min-h-[2.5rem] text-[13px] leading-5 text-ink-secondary">
              {product.description || product.productSlug}
            </p>

            <div className="mt-4 border-t border-line pt-4">
              <UsagePreview usage={usage} />
            </div>

            <div className="mt-4 flex items-center justify-between">
              <span className="inline-flex items-center gap-3 text-[13px] text-ink-muted">
                <span className="inline-flex items-center gap-1.5">
                  <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
                  {activeTokens} {activeTokens === 1 ? "key" : "keys"}
                </span>
                {product.scopes.length > 0 ? (
                  <span className="inline-flex items-center gap-1.5">
                    <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                    {product.scopes.length} {product.scopes.length === 1 ? "scope" : "scopes"}
                  </span>
                ) : null}
              </span>
              <span className="inline-flex items-center gap-1 text-[13px] font-medium text-brand-700">
                {product.priceMonthly !== null && product.currency ? (
                  <span className="text-ink">{formatCurrency(product.priceMonthly, product.currency)}/mo</span>
                ) : null}
                <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
