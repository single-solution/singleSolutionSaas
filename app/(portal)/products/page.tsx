"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Boxes, Layers, Pencil, Plus, PowerOff, Settings, Zap } from "lucide-react";

import { PageHeader } from "@/components/layout/PageHeader";
import { ProductForm, type ProductFormValues } from "@/components/products/ProductForm";
import { useToast } from "@/components/providers/ToastProvider";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ListSkeleton } from "@/components/ui/Skeleton";
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
  const [showCreate, setShowCreate] = useState(false);
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
      setShowCreate(false);
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
  const editingProduct = products.find((product) => product.slug === editingSlug) ?? null;

  return (
    <div className="page-stack">
      <PageHeader
        title="Products"
        description="Register isolated SaaS products and set their plans. Merchants subscribe per site and receive access tokens."
        action={
          <Button
            onClick={() => {
              setEditingSlug(null);
              setShowCreate((current) => !current);
            }}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            {showCreate ? "Close" : "Register product"}
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Products" value={String(products.length)} hint="In catalog" icon={Boxes} accent />
        <StatCard label="Active" value={String(activeCount)} hint="Available to assign" icon={Zap} />
        <StatCard label="Inactive" value={String(products.length - activeCount)} hint="Hidden from merchants" icon={PowerOff} />
        <StatCard label="Plans" value={String(totalPlans)} hint="Across all products" icon={Layers} />
      </div>

      {showCreate ? (
        <Card className="shadow-sm border-line bg-surface">
          <CardHeader title="Register product" description="Just a name to start. Add plans and scopes as needed." />
          <ProductForm key={createFormKey} mode="create" submitting={submitting} submitLabel="Register product" onSubmit={handleRegister} />
        </Card>
      ) : null}

      {editingProduct ? (
        <Card className="shadow-sm border-line bg-surface">
          <CardHeader title={`Edit ${editingProduct.name}`} description="Update plans, scopes, and connection details." />
          <ProductForm
            mode="edit"
            initial={editingProduct}
            submitting={submitting}
            submitLabel="Save changes"
            onSubmit={(values) => handleUpdate(editingProduct.slug, values)}
            onCancel={() => setEditingSlug(null)}
          />
        </Card>
      ) : null}

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
        <ListSkeleton />
      ) : products.length === 0 ? (
        <EmptyState icon={Boxes} title="No products yet" description="Register your first product to make it available." />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {products.map((product, index) => (
            <div
              key={product.slug}
              style={{ animationDelay: `${index * 0.04}s` }}
              className="flex animate-fade-in-up flex-col rounded-xl border border-line bg-surface p-5 shadow-sm"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700">
                    <Boxes className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <Link href={`/products/${product.slug}`} className="block truncate font-semibold tracking-tight text-ink hover:text-brand-700">
                      {product.name}
                    </Link>
                    <p className="truncate text-[13px] text-ink-muted">
                      {product.slug} · {product.plans.length} plan{product.plans.length === 1 ? "" : "s"}
                    </p>
                  </div>
                </div>
                <Badge tone={product.status === "active" ? "success" : "neutral"}>{product.status}</Badge>
              </div>

              <p className="mt-4 line-clamp-2 min-h-[2.5rem] text-[13px] leading-5 text-ink-secondary">
                {product.description || "No description."}
              </p>

              <div className="mt-4 flex items-center gap-2 border-t border-line pt-4">
                <Button type="button" variant="ghost" size="sm" onClick={() => router.push(`/products/${product.slug}`)}>
                  <Settings className="h-4 w-4" aria-hidden="true" />
                  Manage
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setShowCreate(false);
                    setEditingSlug(editingSlug === product.slug ? null : product.slug);
                  }}
                >
                  <Pencil className="h-4 w-4" aria-hidden="true" />
                  {editingSlug === product.slug ? "Close" : "Edit"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="ml-auto"
                  loading={togglingSlug === product.slug}
                  onClick={() => void handleToggleStatus(product)}
                >
                  {product.status === "active" ? "Deactivate" : "Activate"}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
