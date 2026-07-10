"use client";

import { Boxes, ChevronRight, KeyRound, Play } from "lucide-react";

import { useToast } from "@/components/providers/ToastProvider";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Progress } from "@/components/ui/Progress";
import { DETAIL_FIRST_MAX_COUNT } from "@/components/ui/portalSkeletons";
import { platformApi } from "@/lib/api/client";
import type {
  ProductAccessTokenSummary,
  ProductUsageSummary,
  SubscriptionSummary,
} from "@/lib/types";

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
  const metric =
    usage?.metrics.find((entry) => entry.limit !== null) ?? usage?.metrics[0];
  if (!usage || !metric) {
    return <p className="text-[13px] text-ink-faint">No usage recorded yet.</p>;
  }
  const pct = metric.limit
    ? Math.min(100, Math.round((metric.used / metric.limit) * 100))
    : null;
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
        <Progress
          value={metric.used}
          max={metric.limit ?? 100}
          label={`${metric.metric} usage`}
          tone={metric.withinQuota ? "brand" : "danger"}
          className="mt-1.5"
        />
      ) : null}
    </div>
  );
}

function ProductActions({
  product,
  siteId,
  isPlatformAdmin,
  togglingSlug,
  onSelect,
  onToggleStatus,
}: {
  product: SubscriptionSummary;
  siteId: string;
  isPlatformAdmin: boolean;
  togglingSlug: string | null;
  onSelect: (productSlug: string) => void;
  onToggleStatus: (product: SubscriptionSummary) => void;
}) {
  const toast = useToast();
  const canToggle = isPlatformAdmin && Boolean(product.planCode);
  const canTest =
    isPlatformAdmin && Boolean(product.planCode) && product.status === "active";

  async function handleTestSite() {
    try {
      const response = await platformApi.previewProduct(
        siteId,
        product.productSlug,
      );
      window.open(response.embedUrl, "_blank", "noopener,noreferrer");
    } catch {
      toast.showError(
        "Preview unavailable",
        "Save the configuration and verify the product connection.",
      );
    }
  }

  return (
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
      {canTest ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void handleTestSite()}
        >
          <Play className="h-4 w-4" aria-hidden="true" />
          Test site
        </Button>
      ) : null}
      {canToggle ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          loading={togglingSlug === product.productSlug}
          onClick={() => onToggleStatus(product)}
        >
          {product.status === "active" ? "Suspend" : "Resume"}
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => onSelect(product.productSlug)}
      >
        Manage
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </Button>
    </div>
  );
}

function ProductDetailRow({
  product,
  usage,
  activeTokens,
  siteId,
  isPlatformAdmin,
  togglingSlug,
  index,
  onSelect,
  onToggleStatus,
}: {
  product: SubscriptionSummary;
  usage?: ProductUsageSummary;
  activeTokens: number;
  siteId: string;
  isPlatformAdmin: boolean;
  togglingSlug: string | null;
  index: number;
  onSelect: (productSlug: string) => void;
  onToggleStatus: (product: SubscriptionSummary) => void;
}) {
  return (
    <div
      style={{ animationDelay: `${index * 0.04}s` }}
      className="animate-fade-in-up rounded-xl border border-line bg-surface p-5 shadow-sm"
    >
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="flex min-w-0 items-start gap-3 xl:w-72 xl:shrink-0">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700">
            <Boxes className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate font-semibold tracking-tight text-ink">
                {product.displayName}
              </h3>
              <StatusBadge product={product} />
            </div>
            <p className="mt-1 truncate text-[13px] text-ink-muted">
              {product.planName ?? "Unassigned plan"}
            </p>
          </div>
        </div>

        <div className="grid flex-1 grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-lg border border-line bg-surface-subtle/40 px-3 py-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">
              Monthly
            </p>
            <p className="mt-1 text-sm font-semibold text-ink">
              {product.priceMonthly !== null && product.currency
                ? formatCurrency(product.priceMonthly, product.currency)
                : "-"}
            </p>
          </div>
          <div className="rounded-lg border border-line bg-surface-subtle/40 px-3 py-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">
              Keys
            </p>
            <p className="mt-1 inline-flex items-center gap-1.5 text-sm font-semibold text-ink">
              <KeyRound
                className="h-3.5 w-3.5 text-ink-faint"
                aria-hidden="true"
              />
              {activeTokens}
            </p>
          </div>
          <div className="col-span-2 rounded-lg border border-line bg-surface-subtle/40 px-3 py-3 sm:col-span-2">
            <p className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">
              Usage
            </p>
            <div className="mt-1">
              <UsagePreview usage={usage} />
            </div>
          </div>
        </div>

        <ProductActions
          product={product}
          siteId={siteId}
          isPlatformAdmin={isPlatformAdmin}
          togglingSlug={togglingSlug}
          onSelect={onSelect}
          onToggleStatus={onToggleStatus}
        />
      </div>
    </div>
  );
}

function ProductGridCard({
  product,
  usage,
  activeTokens,
  siteId,
  isPlatformAdmin,
  togglingSlug,
  index,
  onSelect,
  onToggleStatus,
}: {
  product: SubscriptionSummary;
  usage?: ProductUsageSummary;
  activeTokens: number;
  siteId: string;
  isPlatformAdmin: boolean;
  togglingSlug: string | null;
  index: number;
  onSelect: (productSlug: string) => void;
  onToggleStatus: (product: SubscriptionSummary) => void;
}) {
  return (
    <div
      style={{ animationDelay: `${index * 0.04}s` }}
      className="flex animate-fade-in-up flex-col rounded-xl border border-line bg-surface p-5 shadow-sm transition-all hover:border-brand-300 hover:shadow-md"
    >
      <button
        type="button"
        onClick={() => onSelect(product.productSlug)}
        className="group flex flex-col text-left focus:outline-none"
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
              <p className="truncate text-[13px] text-ink-muted">
                {product.planName ?? "Unassigned plan"}
              </p>
            </div>
          </div>
          <StatusBadge product={product} />
        </div>

        <div className="mt-4 w-full border-t border-line pt-4">
          <UsagePreview usage={usage} />
        </div>
      </button>

      <div className="mt-4 flex items-center justify-between gap-2 border-t border-line pt-4">
        <span className="inline-flex items-center gap-3 text-[13px] text-ink-muted">
          <span className="inline-flex items-center gap-1.5">
            <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
            {activeTokens} {activeTokens === 1 ? "key" : "keys"}
          </span>
          {product.priceMonthly !== null && product.currency ? (
            <span className="font-medium text-ink">
              {formatCurrency(product.priceMonthly, product.currency)}/mo
            </span>
          ) : null}
        </span>

        <ProductActions
          product={product}
          siteId={siteId}
          isPlatformAdmin={isPlatformAdmin}
          togglingSlug={togglingSlug}
          onSelect={onSelect}
          onToggleStatus={onToggleStatus}
        />
      </div>
    </div>
  );
}

export function ProductsOverview({
  products,
  usageBySlug,
  tokensBySlug,
  siteId,
  isPlatformAdmin,
  togglingSlug,
  onSelect,
  onToggleStatus,
}: {
  products: SubscriptionSummary[];
  usageBySlug: Record<string, ProductUsageSummary>;
  tokensBySlug: Record<string, ProductAccessTokenSummary[]>;
  siteId: string;
  isPlatformAdmin: boolean;
  togglingSlug: string | null;
  onSelect: (productSlug: string) => void;
  onToggleStatus: (product: SubscriptionSummary) => void;
}) {
  if (products.length === 0) {
    return (
      <Card className="shadow-sm border-line bg-surface">
        <CardHeader
          title="Products"
          description="Isolated SaaS products managed through this platform."
        />
        <EmptyState
          icon={Boxes}
          title="No products available"
          description="A platform admin registers products in the catalog before they appear here."
        />
      </Card>
    );
  }

  const detailFirst = products.length <= DETAIL_FIRST_MAX_COUNT;

  if (detailFirst) {
    return (
      <div className="space-y-3">
        {products.map((product, index) => {
          const usage = usageBySlug[product.productSlug];
          const activeTokens = (tokensBySlug[product.productSlug] ?? []).filter(
            (token) => !token.revokedAt,
          ).length;

          return (
            <ProductDetailRow
              key={product.productSlug}
              product={product}
              usage={usage}
              activeTokens={activeTokens}
              siteId={siteId}
              isPlatformAdmin={isPlatformAdmin}
              togglingSlug={togglingSlug}
              index={index}
              onSelect={onSelect}
              onToggleStatus={onToggleStatus}
            />
          );
        })}
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {products.map((product, index) => {
        const usage = usageBySlug[product.productSlug];
        const activeTokens = (tokensBySlug[product.productSlug] ?? []).filter(
          (token) => !token.revokedAt,
        ).length;

        return (
          <ProductGridCard
            key={product.productSlug}
            product={product}
            usage={usage}
            activeTokens={activeTokens}
            siteId={siteId}
            isPlatformAdmin={isPlatformAdmin}
            togglingSlug={togglingSlug}
            index={index}
            onSelect={onSelect}
            onToggleStatus={onToggleStatus}
          />
        );
      })}
    </div>
  );
}
