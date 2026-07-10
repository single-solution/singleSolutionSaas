"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import {
  ArrowLeft,
  Copy,
  ExternalLink,
  KeyRound,
  MessagesSquare,
  Play,
} from "lucide-react";

import { useToast } from "@/components/providers/ToastProvider";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Progress } from "@/components/ui/Progress";
import { Select } from "@/components/ui/Select";
import { platformApi } from "@/lib/api/client";
import type {
  ProductAccessTokenCreated,
  ProductAccessTokenSummary,
  ProductUsageSummary,
  SubscriptionSummary,
} from "@/lib/types";

import { formatCurrency } from "./currency";
import { ProductConfigEditor } from "./ProductConfigEditor";

export interface ProductPanelProps {
  siteId: string;
  conversationsBase: string;
  product: SubscriptionSummary;
  usage?: ProductUsageSummary;
  tokens: ProductAccessTokenSummary[];
  canManage: boolean;
  isPlatformAdmin: boolean;
  savingPlan: boolean;
  creatingToken: boolean;
  createdToken: ProductAccessTokenCreated | null;
  tokenName: string;
  tokenDomains: string;
  showBack?: boolean;
  onBack: () => void;
  onPlanChange: (planCode: string) => void;
  onStatusToggle: () => void;
  onTokenNameChange: (value: string) => void;
  onTokenDomainsChange: (value: string) => void;
  onCreateToken: (event: FormEvent) => void;
  onCopyToken: () => void;
  onDismissCreated: () => void;
  onRevoke: (tokenId: string) => void;
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface px-4 py-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">
        {label}
      </p>
      <p className="mt-1 truncate text-sm font-semibold text-ink">{value}</p>
    </div>
  );
}

export function ProductPanel(props: ProductPanelProps) {
  const toast = useToast();
  const [showStatusConfirmation, setShowStatusConfirmation] = useState(false);
  const { product, usage, tokens, isPlatformAdmin } = props;
  const granted = Boolean(product.planCode) && product.status === "active";
  const activeTokens = tokens.filter((token) => !token.revokedAt);
  const totalUsage =
    usage?.metrics.reduce((sum, metric) => sum + metric.used, 0) ?? 0;

  async function handleOpenDashboard() {
    try {
      const response = await platformApi.openProductDashboard(
        product.productSlug,
        props.siteId,
      );
      window.open(response.url, "_blank", "noopener,noreferrer");
    } catch {
      toast.showError(
        "Dashboard unavailable",
        "Check the product connection and try again.",
      );
    }
  }

  async function handlePreview() {
    try {
      const response = await platformApi.previewProduct(
        props.siteId,
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
    <div className="animate-fade-in space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          {props.showBack !== false ? (
            <button
              type="button"
              onClick={props.onBack}
              className="mb-3 inline-flex items-center gap-1.5 text-[13px] font-medium text-ink-muted transition-colors hover:text-ink"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              All products
            </button>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold tracking-tight text-ink">
              {product.displayName}
            </h2>
            {product.planName ? (
              <Badge tone="brand">{product.planName}</Badge>
            ) : (
              <Badge>No plan</Badge>
            )}
            {product.planCode ? (
              <Badge tone={product.status === "active" ? "success" : "danger"}>
                {product.status === "active" ? "Active" : "Suspended"}
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 max-w-2xl text-[13px] text-ink-secondary">
            {product.description || product.productSlug}
          </p>
        </div>
        {granted ? (
          <div className="flex flex-wrap justify-end gap-2">
            <Link
              href={`${props.conversationsBase}/${product.productSlug}/conversations`}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium text-ink transition-colors hover:bg-surface-subtle"
            >
              <MessagesSquare className="h-4 w-4" aria-hidden="true" />
              Conversations
            </Link>
            {isPlatformAdmin ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handlePreview()}
                >
                  <Play className="h-4 w-4" aria-hidden="true" />
                  Test site
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleOpenDashboard()}
                >
                  <ExternalLink className="h-4 w-4" aria-hidden="true" />
                  Advanced dashboard
                </Button>
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line md:grid-cols-5">
        <MiniStat label="Plan" value={product.planName ?? "Unassigned"} />
        <MiniStat
          label="Monthly"
          value={
            product.priceMonthly !== null && product.currency
              ? formatCurrency(product.priceMonthly, product.currency)
              : "-"
          }
        />
        <MiniStat label="Active keys" value={String(activeTokens.length)} />
        <MiniStat label="Scopes" value={String(product.scopes.length)} />
        <MiniStat label="Usage" value={totalUsage.toLocaleString()} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="shadow-sm border-line bg-surface h-fit">
          <CardHeader
            title="Plan & billing"
            description={
              isPlatformAdmin
                ? "Choose a plan and control access."
                : "Your current plan and pricing."
            }
          />
          <div className="space-y-4">
            <div className="flex items-baseline justify-between">
              <span className="text-[13px] text-ink-muted">Current plan</span>
              <span className="text-sm font-medium text-ink">
                {product.planName ?? "Unassigned"}
              </span>
            </div>
            <div className="flex items-baseline justify-between border-b border-line pb-4">
              <span className="text-[13px] text-ink-muted">Price</span>
              <span className="text-sm font-medium text-ink">
                {product.priceMonthly !== null && product.currency
                  ? `${formatCurrency(product.priceMonthly, product.currency)}/mo`
                  : "-"}
              </span>
            </div>

            {isPlatformAdmin ? (
              <div className="flex flex-wrap items-end gap-3">
                <Field
                  label="Plan"
                  htmlFor={`plan-${product.productSlug}`}
                  className="w-full max-w-xs"
                >
                  <Select
                    id={`plan-${product.productSlug}`}
                    value={product.planCode ?? ""}
                    disabled={props.savingPlan}
                    onChange={(event) => props.onPlanChange(event.target.value)}
                  >
                    <option value="">Unassigned</option>
                    {product.availablePlans.map((plan) => (
                      <option key={plan.code} value={plan.code}>
                        {plan.name} -{" "}
                        {formatCurrency(plan.priceMonthly, plan.currency)}/mo
                      </option>
                    ))}
                  </Select>
                </Field>
                {product.planCode ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    loading={props.savingPlan}
                    onClick={() => setShowStatusConfirmation(true)}
                  >
                    {product.status === "active" ? "Suspend" : "Resume"}
                  </Button>
                ) : null}
              </div>
            ) : null}

            {product.scopes.length > 0 ? (
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-faint">
                  Access scopes
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {product.scopes.map((scope) => (
                    <Badge key={scope}>{scope}</Badge>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </Card>

        <Card className="shadow-sm border-line bg-surface h-fit">
          <CardHeader
            title="Usage"
            description={
              usage
                ? `Billing period ${usage.period}`
                : "Current billing period"
            }
          />
          {usage ? (
            <div className="space-y-4">
              <div className="flex items-baseline justify-between border-b border-line pb-4">
                <span className="text-[13px] text-ink-muted">
                  Estimated cost
                </span>
                <span className="text-sm font-medium text-ink">
                  {formatCurrency(usage.estimatedCost, usage.currency)}
                </span>
              </div>
              {usage.metrics.length === 0 ? (
                <p className="text-sm text-ink-muted">No usage recorded yet.</p>
              ) : (
                <ul className="space-y-3">
                  {usage.metrics.map((metric) => {
                    const pct = metric.limit
                      ? Math.min(
                          100,
                          Math.round((metric.used / metric.limit) * 100),
                        )
                      : null;
                    return (
                      <li key={metric.metric}>
                        <div className="flex items-center justify-between text-[13px]">
                          <span className="text-ink-secondary">
                            {metric.metric}
                            {metric.unit ? ` (${metric.unit})` : ""}
                          </span>
                          <span
                            className={
                              metric.withinQuota ? "text-ink" : "text-danger"
                            }
                          >
                            {metric.used.toLocaleString()}
                            {metric.limit !== null
                              ? ` / ${metric.limit.toLocaleString()}`
                              : ""}
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
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          ) : (
            <p className="text-sm text-ink-muted">No usage recorded yet.</p>
          )}
        </Card>
      </div>

      <Card className="shadow-sm border-line bg-surface">
        <CardHeader
          title={`Access keys (${activeTokens.length} active)`}
          description="Publishable keys the product uses to authenticate. Shown once at creation."
        />

        {props.createdToken ? (
          <Alert
            tone="warning"
            title="Copy this access key now"
            className="mb-4"
          >
            <code className="mt-1 block break-all rounded-md bg-white/70 px-2 py-1 text-xs text-ink">
              {props.createdToken.plaintextToken}
            </code>
            <div className="mt-3 flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={props.onCopyToken}
              >
                <Copy className="h-4 w-4" aria-hidden="true" />
                Copy key
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={props.onDismissCreated}
              >
                Dismiss
              </Button>
            </div>
          </Alert>
        ) : null}

        {tokens.length === 0 ? (
          <p className="text-sm text-ink-muted">
            {granted
              ? "No keys yet. Create one to connect the product."
              : "Assign a plan to issue keys."}
          </p>
        ) : (
          <ul className="mb-4 divide-y divide-line rounded-md border border-line">
            {tokens.map((token) => (
              <li
                key={token.id}
                className="flex items-center justify-between gap-4 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-ink">{token.name}</p>
                  <p className="text-sm text-ink-muted">
                    ****{token.tokenPrefix}
                    {token.lastUsedAt
                      ? ` / used ${new Date(token.lastUsedAt).toLocaleDateString()}`
                      : " / never used"}
                  </p>
                  {token.allowedDomains.length > 0 ? (
                    <p className="mt-0.5 truncate text-xs text-ink-faint">
                      {token.allowedDomains.join(", ")}
                    </p>
                  ) : (
                    <p className="mt-0.5 text-xs text-danger">
                      No domains - widget blocked
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <Badge tone={token.revokedAt ? "danger" : "success"}>
                    {token.revokedAt ? "Revoked" : "Active"}
                  </Badge>
                  {isPlatformAdmin && !token.revokedAt ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => props.onRevoke(token.id)}
                    >
                      Revoke
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}

        {isPlatformAdmin && granted ? (
          <form
            className="flex flex-wrap items-end gap-3 border-t border-line pt-4"
            onSubmit={props.onCreateToken}
            noValidate
          >
            <Field
              label="New key name"
              htmlFor={`token-${product.productSlug}`}
              className="w-full max-w-xs"
            >
              <Input
                id={`token-${product.productSlug}`}
                value={props.tokenName}
                placeholder="Production"
                onChange={(event) =>
                  props.onTokenNameChange(event.target.value)
                }
              />
            </Field>
            <Field
              label="Allowed domains"
              htmlFor={`token-domains-${product.productSlug}`}
              hint="Comma-separated. The widget only runs on these. Example: shop.com, *.shop.com"
              className="w-full max-w-sm"
            >
              <Input
                id={`token-domains-${product.productSlug}`}
                value={props.tokenDomains}
                placeholder="shop.com, *.shop.com"
                onChange={(event) =>
                  props.onTokenDomainsChange(event.target.value)
                }
              />
            </Field>
            <Button type="submit" size="sm" loading={props.creatingToken}>
              <KeyRound className="h-4 w-4" aria-hidden="true" />
              Issue key
            </Button>
          </form>
        ) : null}
      </Card>

      {granted && isPlatformAdmin ? (
        <ProductConfigEditor
          scope={{ kind: "site", siteId: props.siteId }}
          productSlug={product.productSlug}
          canManage={isPlatformAdmin}
          isPlatformAdmin={isPlatformAdmin}
        />
      ) : null}
      <ConfirmDialog
        open={showStatusConfirmation}
        title={
          product.status === "active"
            ? "Suspend this subscription?"
            : "Resume this subscription?"
        }
        description={
          product.status === "active"
            ? "Runtime token verification will stop granting access for this site. Existing keys remain recorded but cannot authorize requests."
            : "Existing active keys will authorize the product again for this site."
        }
        confirmLabel={
          product.status === "active"
            ? "Suspend subscription"
            : "Resume subscription"
        }
        loading={props.savingPlan}
        onConfirm={() => {
          props.onStatusToggle();
          setShowStatusConfirmation(false);
        }}
        onCancel={() => setShowStatusConfirmation(false)}
      />
    </div>
  );
}
