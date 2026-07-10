"use client";

import { useState } from "react";

import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  DETAIL_FIRST_MAX_COUNT,
  ProductsViewSkeleton,
} from "@/components/ui/portalSkeletons";

import { ProductPanel } from "./ProductPanel";
import { ProductsOverview } from "./ProductsOverview";
import { useSiteProducts } from "./useSiteProducts";

export function ProductsView({
  siteId,
  canManage,
  isPlatformAdmin,
  conversationsBase,
  onChanged,
}: {
  siteId: string;
  canManage: boolean;
  isPlatformAdmin: boolean;
  conversationsBase: string;
  onChanged?: () => void;
}) {
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const products = useSiteProducts(siteId, onChanged);

  if (products.loading) {
    return <ProductsViewSkeleton detailFirst />;
  }

  if (products.error) {
    return (
      <Card className="shadow-sm border-line bg-surface">
        <CardHeader title="Products" />
        <Alert tone="danger" title="Load failed">
          {products.error}
          <div className="mt-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void products.reload()}
            >
              Retry
            </Button>
          </div>
        </Alert>
      </Card>
    );
  }

  const isDetailFirst =
    products.products.length > 0 &&
    products.products.length <= DETAIL_FIRST_MAX_COUNT;
  const effectiveSelectedSlug =
    selectedSlug ??
    (isDetailFirst ? (products.products[0]?.productSlug ?? null) : null);
  const selectedProduct =
    products.products.find(
      (product) => product.productSlug === effectiveSelectedSlug,
    ) ?? null;

  return (
    <>
      {selectedProduct ? (
        <div className="space-y-4">
          {isDetailFirst && products.products.length > 1 ? (
            <div
              className="flex flex-wrap gap-2 rounded-xl border border-line bg-surface-subtle/50 p-2"
              aria-label="Choose product workspace"
              role="group"
            >
              {products.products.map((product) => {
                const isSelected =
                  product.productSlug === selectedProduct.productSlug;

                return (
                  <button
                    key={product.productSlug}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => {
                      setSelectedSlug(product.productSlug);
                      products.setCreatedToken(null);
                    }}
                    className={`rounded-md border px-3 py-2 text-left transition-colors ${
                      isSelected
                        ? "border-brand-300 bg-surface text-brand-800 shadow-sm"
                        : "border-transparent text-ink-muted hover:border-line hover:bg-surface"
                    }`}
                  >
                    <span className="block text-sm font-medium">
                      {product.displayName}
                    </span>
                    <span className="block text-xs">
                      {product.planName ?? "No plan"} /{" "}
                      {product.planCode ? product.status : "unassigned"}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
          <ProductPanel
            siteId={siteId}
            conversationsBase={conversationsBase}
            product={selectedProduct}
            usage={products.usageBySlug[selectedProduct.productSlug]}
            tokens={products.tokensBySlug[selectedProduct.productSlug] ?? []}
            canManage={canManage}
            isPlatformAdmin={isPlatformAdmin}
            savingPlan={products.savingPlanSlug === selectedProduct.productSlug}
            creatingToken={
              products.creatingTokenSlug === selectedProduct.productSlug
            }
            createdToken={products.createdToken}
            tokenName={
              products.tokenNameBySlug[selectedProduct.productSlug] ?? ""
            }
            tokenDomains={
              products.tokenDomainsBySlug[selectedProduct.productSlug] ?? ""
            }
            showBack={!isDetailFirst}
            onBack={() => {
              setSelectedSlug(null);
              products.setCreatedToken(null);
            }}
            onPlanChange={(planCode) =>
              void products.changePlan(selectedProduct.productSlug, planCode)
            }
            onStatusToggle={() => void products.toggleStatus(selectedProduct)}
            onTokenNameChange={(value) =>
              products.setTokenName(selectedProduct.productSlug, value)
            }
            onTokenDomainsChange={(value) =>
              products.setTokenDomains(selectedProduct.productSlug, value)
            }
            onCreateToken={(event) =>
              void products.createToken(event, selectedProduct.productSlug)
            }
            onCopyToken={() => void products.copyToken()}
            onDismissCreated={() => products.setCreatedToken(null)}
            onRevoke={(tokenId) =>
              products.requestRevoke(selectedProduct.productSlug, tokenId)
            }
          />
        </div>
      ) : (
        <ProductsOverview
          products={products.products}
          usageBySlug={products.usageBySlug}
          tokensBySlug={products.tokensBySlug}
          siteId={siteId}
          isPlatformAdmin={isPlatformAdmin}
          togglingSlug={products.savingPlanSlug}
          onSelect={(productSlug) => {
            setSelectedSlug(productSlug);
            products.setCreatedToken(null);
          }}
          onToggleStatus={(product) => void products.toggleStatus(product)}
        />
      )}

      <ConfirmDialog
        open={products.pendingRevoke !== null}
        title="Revoke access key?"
        description="The product will stop authenticating with this key immediately. This cannot be undone."
        confirmLabel="Revoke key"
        loading={products.revoking}
        onCancel={products.cancelRevoke}
        onConfirm={() => void products.confirmRevoke()}
      />
    </>
  );
}
