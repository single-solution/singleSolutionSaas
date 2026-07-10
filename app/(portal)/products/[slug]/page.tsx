"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  ExternalLink,
  Globe,
  Layers,
  Link as LinkIcon,
  Plug,
  RefreshCw,
  Settings,
  Users,
  XCircle,
} from "lucide-react";

import { PageHeader } from "@/components/layout/PageHeader";
import { ProductConfigEditor } from "@/components/products/ProductConfigEditor";
import { useToast } from "@/components/providers/ToastProvider";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { DataTable } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { DetailSkeleton } from "@/components/ui/Skeleton";
import { Tabs } from "@/components/ui/Tabs";
import { PlatformApiError, platformApi } from "@/lib/api/client";
import type {
  ProductConnectionStatus,
  ProductSubscriber,
  ProductSummary,
} from "@/lib/types";

export default function ProductDetailPage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug;
  const toast = useToast();

  const [product, setProduct] = useState<ProductSummary | null>(null);
  const [subscribers, setSubscribers] = useState<ProductSubscriber[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [connection, setConnection] = useState<ProductConnectionStatus | null>(
    null,
  );
  const [openingDashboard, setOpeningDashboard] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const [productResult, subscribersResult] = await Promise.allSettled([
        platformApi.getAdminProduct(slug),
        platformApi.listProductSubscribers(slug),
      ]);
      if (productResult.status === "fulfilled") {
        setProduct(productResult.value.product);
      } else {
        setError("Could not load this product.");
      }
      setSubscribers(
        subscribersResult.status === "fulfilled"
          ? subscribersResult.value.items
          : [],
      );
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleTestConnection() {
    setTesting(true);
    try {
      const { status } = await platformApi.testProductConnection(slug);
      setConnection(status);
      if (status.reachable) {
        toast.showSuccess(
          "Connected",
          `Synced ${status.fieldCount} field(s) and ${status.actionCount} test action(s).`,
        );
        await load();
      } else {
        toast.showError(
          "Not reachable",
          status.error ?? "Check the Base URL and that the product is running.",
        );
      }
    } catch (caughtError) {
      toast.showError(
        "Test failed",
        caughtError instanceof PlatformApiError
          ? caughtError.message
          : "Try again.",
      );
    } finally {
      setTesting(false);
    }
  }

  async function handleOpenDashboard() {
    setOpeningDashboard(true);
    try {
      const { url } = await platformApi.openProductDashboard(slug);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (caughtError) {
      toast.showError(
        "Could not open dashboard",
        caughtError instanceof PlatformApiError
          ? caughtError.message
          : "Check the Base URL and try again.",
      );
    } finally {
      setOpeningDashboard(false);
    }
  }

  if (loading) {
    return (
      <div className="page-stack">
        <DetailSkeleton />
      </div>
    );
  }

  if (error || !product) {
    return (
      <div className="page-stack">
        <PageHeader
          title="Product"
          breadcrumbs={[
            { label: "Products", href: "/products" },
            { label: slug },
          ]}
        />
        <Alert tone="danger" title="Load failed">
          {error ?? "Product not found."}
          <div className="mt-3">
            <Button variant="outline" size="sm" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        </Alert>
      </div>
    );
  }

  const totalFields = product.configSchema.reduce(
    (sum, section) => sum + section.fields.length,
    0,
  );

  return (
    <div className="page-stack">
      <PageHeader
        title={product.name}
        description={
          product.description ||
          "Manage this product's connection, plans, configuration, and subscribers."
        }
        breadcrumbs={[
          { label: "Products", href: "/products" },
          { label: product.name },
        ]}
        action={
          <div className="flex items-center gap-2">
            <Badge tone={product.status === "active" ? "success" : "neutral"}>
              {product.status}
            </Badge>
            <Button
              type="button"
              size="sm"
              variant="outline"
              loading={openingDashboard}
              disabled={!product.baseUrl}
              onClick={() => void handleOpenDashboard()}
            >
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
              Open advanced dashboard
            </Button>
          </div>
        }
      />

      <Tabs
        tabs={[
          {
            id: "overview",
            label: "Overview",
            icon: LinkIcon,
            content: (
              <div className="grid gap-5 lg:grid-cols-2">
                <Card className="shadow-sm border-line bg-surface">
                  <CardHeader
                    title="Connection"
                    description="Link this catalog entry to the running product deployment."
                  />
                  <div className="space-y-4">
                    <div className="flex flex-col gap-1">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
                        Base URL
                      </span>
                      {product.baseUrl ? (
                        <code className="break-all rounded-md border border-line bg-surface-subtle px-3 py-2 text-[12.5px] text-ink">
                          {product.baseUrl}
                        </code>
                      ) : (
                        <p className="text-[13px] text-ink-muted">
                          No Base URL set.{" "}
                          <Link
                            href="/products"
                            className="font-medium text-brand-700 hover:underline"
                          >
                            Edit the product
                          </Link>{" "}
                          to add where it runs.
                        </p>
                      )}
                    </div>

                    {connection ? (
                      connection.reachable ? (
                        <Alert tone="success" title="Reachable">
                          <span className="inline-flex items-center gap-2">
                            <CheckCircle2
                              className="h-4 w-4"
                              aria-hidden="true"
                            />
                            Responded in {connection.latencyMs ?? 0} ms. Synced{" "}
                            {connection.fieldCount} configurable field(s) and{" "}
                            {connection.actionCount} test action(s).
                          </span>
                        </Alert>
                      ) : (
                        <Alert tone="danger" title="Not reachable">
                          <span className="inline-flex items-center gap-2">
                            <XCircle className="h-4 w-4" aria-hidden="true" />
                            {connection.error ?? "The product did not respond."}
                          </span>
                        </Alert>
                      )
                    ) : null}

                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      loading={testing}
                      onClick={() => void handleTestConnection()}
                      disabled={!product.baseUrl}
                    >
                      <Plug className="h-4 w-4" aria-hidden="true" />
                      Test connection & sync config
                    </Button>
                  </div>
                </Card>

                <Card className="shadow-sm border-line bg-surface h-fit">
                  <CardHeader
                    title="Plans"
                    description={`${product.plans.length} plan(s) in the catalog.`}
                  />
                  {product.plans.length === 0 ? (
                    <EmptyState
                      icon={Layers}
                      title="No plans"
                      description="Add plans on the catalog page so merchants can subscribe."
                    />
                  ) : (
                    <ul className="space-y-2">
                      {product.plans.map((plan) => (
                        <li
                          key={plan.code}
                          className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2"
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-[13px] font-medium text-ink">
                              {plan.name}
                            </span>
                            <span className="block truncate text-[12px] text-ink-faint">
                              {plan.scopes.length} scope(s) ·{" "}
                              {plan.quotas.length} quota(s)
                            </span>
                          </span>
                          <span className="shrink-0 text-[13px] text-ink-secondary">
                            {plan.priceMonthly > 0
                              ? `${plan.currency} ${plan.priceMonthly}/mo`
                              : "Free"}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </div>
            ),
          },
          {
            id: "configuration",
            label: "Configuration",
            icon: Settings,
            content: (
              <div className="grid gap-5">
                <Card className="shadow-sm border-line bg-surface h-fit">
                  <CardHeader
                    title="Schema fields"
                    description={
                      totalFields > 0
                        ? `${totalFields} field(s) merchants can customize per site.`
                        : "No fields yet. Run 'Test connection' to sync them from the product."
                    }
                  />
                  {product.configSchema.length === 0 ? (
                    <EmptyState
                      icon={Layers}
                      title="No configuration synced"
                      description="Connect to the running product to pull its config schema."
                    />
                  ) : (
                    <div className="space-y-4">
                      {product.configSchema.map((section) => (
                        <div
                          key={section.key}
                          className="rounded-md border border-line"
                        >
                          <div className="flex items-center justify-between gap-2 border-b border-line bg-surface-subtle/50 px-3 py-2">
                            <span className="text-[13px] font-medium text-ink">
                              {section.title}
                            </span>
                            <Badge
                              tone={
                                section.kind === "connection"
                                  ? "brand"
                                  : "neutral"
                              }
                            >
                              {section.kind}
                            </Badge>
                          </div>
                          <ul className="divide-y divide-line">
                            {section.fields.map((field) => (
                              <li
                                key={field.key}
                                className="flex items-center justify-between gap-3 px-3 py-2"
                              >
                                <span className="min-w-0">
                                  <span className="block truncate text-[13px] text-ink">
                                    {field.label}
                                  </span>
                                  <span className="block truncate text-[12px] text-ink-faint">
                                    {field.key}
                                  </span>
                                </span>
                                <span className="flex shrink-0 items-center gap-1.5">
                                  {field.secret ? (
                                    <Badge tone="danger">secret</Badge>
                                  ) : null}
                                  <Badge tone="neutral">{field.type}</Badge>
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>

                {product.configSchema.length > 0 ? (
                  <ProductConfigEditor
                    scope={{ kind: "product" }}
                    productSlug={product.slug}
                    canManage
                    isPlatformAdmin
                  />
                ) : null}
              </div>
            ),
          },
          {
            id: "subscribers",
            label: "Subscribers",
            icon: Users,
            content: (
              <Card className="shadow-sm border-line bg-surface">
                <CardHeader
                  title="Subscribers"
                  description={`${subscribers.length} site(s) using this product.`}
                />
                {subscribers.length === 0 ? (
                  <EmptyState
                    icon={Users}
                    title="No subscribers yet"
                    description="Assign this product to a merchant's site to see it here."
                  />
                ) : (
                  <DataTable
                    caption={`Sites subscribed to ${product.name}`}
                    rows={subscribers}
                    getRowKey={(subscriber) => subscriber.siteId}
                    columns={[
                      {
                        key: "merchant",
                        header: "Merchant",
                        render: (subscriber) => (
                          <Link
                            href={`/merchants/${subscriber.merchantId}`}
                            className="font-medium text-ink hover:text-brand-700"
                          >
                            {subscriber.merchantName}
                          </Link>
                        ),
                      },
                      {
                        key: "site",
                        header: "Site",
                        render: (subscriber) => (
                          <Link
                            href={`/sites/${subscriber.siteId}`}
                            className="text-ink-secondary hover:text-brand-700"
                          >
                            {subscriber.siteName}
                          </Link>
                        ),
                      },
                      {
                        key: "domain",
                        header: "Domain",
                        render: (subscriber) =>
                          subscriber.primaryDomain ? (
                            <span className="inline-flex items-center gap-1.5">
                              <Globe
                                className="h-3.5 w-3.5"
                                aria-hidden="true"
                              />
                              {subscriber.primaryDomain}
                            </span>
                          ) : (
                            "—"
                          ),
                      },
                      {
                        key: "plan",
                        header: "Plan",
                        render: (subscriber) =>
                          subscriber.planName ?? "Unassigned",
                      },
                      {
                        key: "status",
                        header: "Status",
                        render: (subscriber) => (
                          <Badge
                            tone={
                              subscriber.status === "active"
                                ? "success"
                                : "neutral"
                            }
                          >
                            {subscriber.status}
                          </Badge>
                        ),
                      },
                    ]}
                  />
                )}
              </Card>
            ),
          },
        ]}
      />

      <div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void load()}
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Refresh
        </Button>
      </div>
    </div>
  );
}
