"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  Boxes,
  ExternalLink,
  Layers,
  Pencil,
  Plug,
  Plus,
  PowerOff,
  Search,
  Settings,
  ShieldCheck,
  Users,
  Zap,
} from "lucide-react";

import { PageHeader } from "@/components/layout/PageHeader";
import {
  ProductForm,
  type ProductFormValues,
} from "@/components/products/ProductForm";
import { useToast } from "@/components/providers/ToastProvider";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Modal } from "@/components/ui/Modal";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import {
  DETAIL_FIRST_MAX_COUNT,
  ProductCatalogSkeleton,
} from "@/components/ui/portalSkeletons";
import { StatCard } from "@/components/ui/StatCard";
import { PlatformApiError, platformApi } from "@/lib/api/client";
import type { ProductSummary } from "@/lib/types";

export default function AdminProductsPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const toast = useToast();
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [togglingSlug, setTogglingSlug] = useState<string | null>(null);
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createFormKey, setCreateFormKey] = useState(0);
  const [statusProduct, setStatusProduct] = useState<ProductSummary | null>(
    null,
  );
  const search = searchParams.get("search") ?? "";
  const status = searchParams.get("status") ?? "all";
  const filteredProducts = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    return products.filter(
      (product) =>
        (!normalized ||
          [product.name, product.slug, product.baseUrl].some((value) =>
            value.toLowerCase().includes(normalized),
          )) &&
        (status === "all" || product.status === status),
    );
  }, [products, search, status]);
  const isDetailFirst =
    filteredProducts.length > 0 &&
    filteredProducts.length <= DETAIL_FIRST_MAX_COUNT;

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
      toast.showSuccess(
        "Product registered",
        `${values.name} is now available to merchants.`,
      );
      setCreateFormKey((current) => current + 1);
      setShowCreate(false);
      await load();
    } catch (caughtError) {
      const message =
        caughtError instanceof PlatformApiError
          ? caughtError.message
          : "Check the fields and try again.";
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
      const message =
        caughtError instanceof PlatformApiError
          ? caughtError.message
          : "Try again in a moment.";
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
      toast.showSuccess(
        nextStatus === "active" ? "Product activated" : "Product deactivated",
      );
      await load();
    } catch {
      toast.showError("Could not update product", "Try again in a moment.");
    } finally {
      setTogglingSlug(null);
    }
  }

  function updateQuery(key: "search" | "status", value: string) {
    const next = new URLSearchParams(searchParams.toString());
    if (!value || value === "all") {
      next.delete(key);
    } else {
      next.set(key, value);
    }
    router.replace(`${pathname}${next.size ? `?${next.toString()}` : ""}`, {
      scroll: false,
    });
  }

  const activeCount = products.filter(
    (product) => product.status === "active",
  ).length;
  const totalPlans = products.reduce(
    (sum, product) => sum + product.plans.length,
    0,
  );
  const editingProduct =
    products.find((product) => product.slug === editingSlug) ?? null;

  if (loading) {
    return <ProductCatalogSkeleton />;
  }

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
        <StatCard
          label="Products"
          value={String(products.length)}
          hint="In catalog"
          icon={Boxes}
          accent
        />
        <StatCard
          label="Active"
          value={String(activeCount)}
          hint="Available to assign"
          icon={Zap}
        />
        <StatCard
          label="Inactive"
          value={String(products.length - activeCount)}
          hint="Hidden from merchants"
          icon={PowerOff}
        />
        <StatCard
          label="Plans"
          value={String(totalPlans)}
          hint="Across all products"
          icon={Layers}
        />
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface-subtle/50 p-3 sm:flex-row sm:items-center">
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint"
            aria-hidden="true"
          />
          <Input
            value={search}
            onChange={(event) => updateQuery("search", event.target.value)}
            className="pl-9"
            aria-label="Search products"
            placeholder="Search by product, slug, or base URL..."
          />
        </div>
        <select
          value={status}
          onChange={(event) => updateQuery("status", event.target.value)}
          className="h-10 rounded-md border border-line bg-surface px-3 text-sm text-ink focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          aria-label="Filter product status"
        >
          <option value="all">All products</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
        <span className="text-sm text-ink-muted">
          {filteredProducts.length} results
        </span>
      </div>

      <Modal
        open={showCreate}
        title="Register product"
        description="Just a name to start. Add plans and scopes as needed."
        width="xl"
        onClose={() => setShowCreate(false)}
      >
        <ProductForm
          key={createFormKey}
          mode="create"
          submitting={submitting}
          submitLabel="Register product"
          onSubmit={handleRegister}
        />
      </Modal>

      <ConfirmDialog
        open={Boolean(statusProduct)}
        title={
          statusProduct?.status === "active"
            ? "Deactivate this product?"
            : "Activate this product?"
        }
        description={
          statusProduct?.status === "active"
            ? `New assignments will be blocked. Existing ${statusProduct.activeSubscriberCount ?? 0} active subscriptions remain visible but runtime availability may be affected.`
            : "The product will become available for new site assignments."
        }
        confirmLabel={
          statusProduct?.status === "active"
            ? "Deactivate product"
            : "Activate product"
        }
        loading={Boolean(statusProduct && togglingSlug === statusProduct.slug)}
        onConfirm={() => {
          if (statusProduct) {
            void handleToggleStatus(statusProduct).finally(() =>
              setStatusProduct(null),
            );
          }
        }}
        onCancel={() => setStatusProduct(null)}
      />

      <Modal
        open={Boolean(editingProduct)}
        title={editingProduct ? `Edit ${editingProduct.name}` : "Edit product"}
        description="Update plans, scopes, and connection details."
        width="xl"
        onClose={() => setEditingSlug(null)}
      >
        {editingProduct ? (
          <ProductForm
            mode="edit"
            initial={editingProduct}
            submitting={submitting}
            submitLabel="Save changes"
            onSubmit={(values) => handleUpdate(editingProduct.slug, values)}
            onCancel={() => setEditingSlug(null)}
          />
        ) : null}
      </Modal>

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

      {products.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title="No products yet"
          description="Register your first product to make it available."
        />
      ) : filteredProducts.length === 0 ? (
        <EmptyState
          icon={Search}
          title="No matching products"
          description="Clear the search or change the status filter."
        />
      ) : (
        <div
          className={
            isDetailFirst
              ? "space-y-3"
              : "grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
          }
        >
          {filteredProducts.map((product, index) => (
            <div
              key={product.slug}
              style={{ animationDelay: `${index * 0.04}s` }}
              className={`flex animate-fade-in-up rounded-xl border border-line bg-surface p-5 shadow-sm ${
                isDetailFirst
                  ? "flex-col gap-4 lg:flex-row lg:items-center"
                  : "flex-col"
              }`}
            >
              <div
                className={`flex items-start justify-between gap-3 ${
                  isDetailFirst ? "lg:w-64 lg:shrink-0" : ""
                }`}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700">
                    <Boxes className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <Link
                      href={`/products/${product.slug}`}
                      className="block truncate font-semibold tracking-tight text-ink hover:text-brand-700"
                    >
                      {product.name}
                    </Link>
                    <p className="truncate text-[13px] text-ink-muted">
                      {product.slug} / {product.plans.length} plan
                      {product.plans.length === 1 ? "" : "s"}
                    </p>
                  </div>
                </div>
                <Badge
                  tone={product.status === "active" ? "success" : "neutral"}
                >
                  {product.status}
                </Badge>
              </div>

              <p
                className={`line-clamp-2 text-[13px] leading-5 text-ink-secondary ${
                  isDetailFirst
                    ? "lg:min-w-48 lg:flex-1"
                    : "mt-4 min-h-[2.5rem]"
                }`}
              >
                {product.description || "No description."}
              </p>

              <div
                className={`flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12.5px] text-ink-muted ${
                  isDetailFirst
                    ? "rounded-lg border border-line bg-surface-subtle/40 px-3 py-3 lg:shrink-0"
                    : "mt-4 border-t border-line pt-4"
                }`}
              >
                <span className="inline-flex items-center gap-1.5">
                  <ShieldCheck
                    className="h-3.5 w-3.5 text-ink-faint"
                    aria-hidden="true"
                  />
                  {product.availableScopes.length} scope
                  {product.availableScopes.length === 1 ? "" : "s"}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Plug
                    className="h-3.5 w-3.5 text-ink-faint"
                    aria-hidden="true"
                  />
                  {product.baseUrl
                    ? (() => {
                        try {
                          return new URL(product.baseUrl).host;
                        } catch {
                          return "Connected";
                        }
                      })()
                    : "No base URL"}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Users
                    className="h-3.5 w-3.5 text-ink-faint"
                    aria-hidden="true"
                  />
                  {product.activeSubscriberCount ?? 0} active
                </span>
              </div>

              <div
                className={`flex items-center gap-2 ${
                  isDetailFirst
                    ? "flex-wrap lg:shrink-0"
                    : "mt-3 border-t border-line pt-3"
                }`}
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => router.push(`/products/${product.slug}`)}
                >
                  <Settings className="h-4 w-4" aria-hidden="true" />
                  Manage
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setShowCreate(false);
                    setEditingSlug(
                      editingSlug === product.slug ? null : product.slug,
                    );
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
                  onClick={() => setStatusProduct(product)}
                >
                  {product.status === "active" ? "Deactivate" : "Activate"}
                </Button>
                {product.baseUrl ? (
                  <a
                    href={`${product.baseUrl.replace(/\/$/, "")}/public-demo`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-brand-700 hover:bg-brand-50"
                  >
                    <ExternalLink className="h-4 w-4" aria-hidden="true" />
                    Demo
                  </a>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
