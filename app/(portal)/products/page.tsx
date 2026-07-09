"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Boxes, Layers, Pencil, PowerOff, Settings, Zap } from "lucide-react";

import { PageHeader } from "@/components/layout/PageHeader";
import { ProductForm, type ProductFormValues } from "@/components/products/ProductForm";
import { useToast } from "@/components/providers/ToastProvider";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { StatCard } from "@/components/ui/StatCard";
import { PlatformApiError, platformApi } from "@/lib/api/client";
import type { ProductSummary } from "@/lib/types";

export default function AdminProductsPage() {
  const router = useRouter();
  const toast = useToast();
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [togglingSlug, setTogglingSlug] = useState<string | null>(null);
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [createFormKey, setCreateFormKey] = useState(0);

  async function load() {
    setError(null);
    setLoading(true);
    try {
      const response = await platformApi.listAdminProducts();
      setProducts(response.items);
    } catch {
      setError("Could not load products.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleRegister(values: ProductFormValues) {
    if (!values.name || !values.slug) {
      toast.showError("Name required", "Give the product a name.");
      return;
    }
    setSubmitting(true);
    try {
      await platformApi.registerProduct({
        slug: values.slug,
        name: values.name,
        description: values.description,
        baseUrl: values.baseUrl,
        availableScopes: values.availableScopes,
        plans: values.plans,
      });
      toast.showSuccess("Product registered", `${values.name} is now available to merchants.`);
      setCreateFormKey((current) => current + 1);
      await load();
    } catch (caughtError) {
      const message = caughtError instanceof PlatformApiError ? caughtError.message : "Check the fields and try again.";
      toast.showError("Could not register product", message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleUpdate(slug: string, values: ProductFormValues) {
    setSubmitting(true);
    try {
      await platformApi.updateProduct(slug, {
        name: values.name,
        description: values.description,
        baseUrl: values.baseUrl,
        availableScopes: values.availableScopes,
        plans: values.plans,
      });
      toast.showSuccess("Product updated");
      setEditingSlug(null);
      await load();
    } catch (caughtError) {
      const message = caughtError instanceof PlatformApiError ? caughtError.message : "Try again in a moment.";
      toast.showError("Could not update product", message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleToggleStatus(product: ProductSummary) {
    setTogglingSlug(product.slug);
    const nextStatus = product.status === "active" ? "inactive" : "active";
    try {
      await platformApi.updateProduct(product.slug, { status: nextStatus });
      toast.showSuccess(nextStatus === "active" ? "Product activated" : "Product deactivated");
      await load();
    } catch {
      toast.showError("Could not update product", "Try again in a moment.");
    } finally {
      setTogglingSlug(null);
    }
  }

  const activeCount = products.filter((product) => product.status === "active").length;
  const totalPlans = products.reduce((sum, product) => sum + product.plans.length, 0);

  return (
    <div className="page-stack">
      <PageHeader
        title="Products"
        description="Register isolated SaaS products and set their plans. Merchants subscribe per site and receive access tokens."
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Products" value={String(products.length)} hint="In catalog" icon={Boxes} accent />
        <StatCard label="Active" value={String(activeCount)} hint="Available to assign" icon={Zap} />
        <StatCard label="Inactive" value={String(products.length - activeCount)} hint="Hidden from merchants" icon={PowerOff} />
        <StatCard label="Plans" value={String(totalPlans)} hint="Across all products" icon={Layers} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="shadow-sm border-line bg-surface h-fit">
          <CardHeader title="Catalog" description={`${products.length} registered`} />
          {error ? (
            <Alert tone="danger" title="Load failed">
              {error}
              <div className="mt-3">
                <Button variant="outline" size="sm" onClick={() => void load()}>
                  Retry
                </Button>
              </div>
            </Alert>
          ) : null}
          {loading ? (
            <p className="text-sm text-ink-muted" aria-live="polite">
              Loading products...
            </p>
          ) : products.length === 0 ? (
            <EmptyState icon={Boxes} title="No products yet" description="Register your first product to make it available." />
          ) : (
            <ul className="space-y-3">
              {products.map((product) => (
                <li key={product.slug} className="rounded-md border border-line">
                  <div className="flex items-center justify-between gap-4 px-4 py-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link href={`/products/${product.slug}`} className="truncate font-medium text-ink hover:text-brand-700">
                          {product.name}
                        </Link>
                        <Badge tone={product.status === "active" ? "success" : "neutral"}>{product.status}</Badge>
                      </div>
                      <p className="truncate text-sm text-ink-muted">
                        {product.slug} · {product.plans.length} plan{product.plans.length === 1 ? "" : "s"}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button type="button" variant="ghost" size="sm" onClick={() => router.push(`/products/${product.slug}`)}>
                        <Settings className="h-4 w-4" aria-hidden="true" />
                        Manage
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditingSlug(editingSlug === product.slug ? null : product.slug)}
                      >
                        <Pencil className="h-4 w-4" aria-hidden="true" />
                        {editingSlug === product.slug ? "Close" : "Edit"}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        loading={togglingSlug === product.slug}
                        onClick={() => void handleToggleStatus(product)}
                      >
                        {product.status === "active" ? "Deactivate" : "Activate"}
                      </Button>
                    </div>
                  </div>
                  {editingSlug === product.slug ? (
                    <div className="border-t border-line bg-surface-subtle/40 p-4">
                      <ProductForm
                        mode="edit"
                        initial={product}
                        submitting={submitting}
                        submitLabel="Save changes"
                        onSubmit={(values) => handleUpdate(product.slug, values)}
                        onCancel={() => setEditingSlug(null)}
                      />
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="shadow-sm border-line bg-surface">
          <CardHeader title="Register product" description="Just a name to start. Add plans and scopes as needed." />
          <ProductForm key={createFormKey} mode="create" submitting={submitting} submitLabel="Register product" onSubmit={handleRegister} />
        </Card>
      </div>
    </div>
  );
}
