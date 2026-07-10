"use client";

import { useState } from "react";

import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
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
                      {product.status === "unassigned"
                        ? "unassigned"
                        : product.status}
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
            tokenExpires={
              products.tokenExpiresBySlug[selectedProduct.productSlug] ?? ""
            }
            showBack={!isDetailFirst}
            onBack={() => {
              setSelectedSlug(null);
              products.setCreatedToken(null);
            }}
            onPlanChange={(planCode) =>
              void products.changePlan(selectedProduct.productSlug, planCode)
            }
            onRestore={() =>
              products.restoreProduct(selectedProduct.productSlug)
            }
            onStatusToggle={() => products.toggleStatus(selectedProduct)}
            onTokenNameChange={(value) =>
              products.setTokenName(selectedProduct.productSlug, value)
            }
            onTokenDomainsChange={(value) =>
              products.setTokenDomains(selectedProduct.productSlug, value)
            }
            onTokenExpiresChange={(value) =>
              products.setTokenExpires(selectedProduct.productSlug, value)
            }
            onCreateToken={(event) =>
              void products.createToken(event, selectedProduct.productSlug)
            }
            onCopyToken={() => void products.copyToken()}
            onDismissCreated={() => products.setCreatedToken(null)}
            onRevoke={(tokenId) =>
              products.requestRevoke(selectedProduct.productSlug, tokenId)
            }
            onRotate={(tokenId) =>
              products.requestRotate(selectedProduct.productSlug, tokenId)
            }
            onSaveOverrides={(input) =>
              void products.saveOverrides(selectedProduct.productSlug, input)
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
      <ConfirmDialog
        open={products.pendingRotate !== null}
        title="Rotate access key?"
        description="Issues a replacement key with the same domains. Copy the new key before closing."
        confirmLabel="Issue replacement"
        loading={products.rotating}
        onCancel={products.cancelRotate}
        onConfirm={() => void products.confirmRotate()}
      >
        <label className="inline-flex items-center gap-2 text-sm text-ink-secondary">
          <Checkbox
            checked={products.revokePreviousOnRotate}
            onChange={(event) =>
              products.setRevokePreviousOnRotate(event.target.checked)
            }
          />
          Revoke previous key immediately
        </label>
      </ConfirmDialog>
      <ConfirmDialog
        open={products.pendingStatusProduct !== null}
        title={
          products.pendingStatusProduct?.status === "active"
            ? "Suspend this subscription?"
            : "Resume this subscription?"
        }
        description={
          products.pendingStatusProduct?.status === "active"
            ? "Runtime token verification will stop granting access for this site. Existing keys remain recorded but cannot authorize requests."
            : "Existing active keys will authorize the product again for this site."
        }
        confirmLabel={
          products.pendingStatusProduct?.status === "active"
            ? "Suspend subscription"
            : "Resume subscription"
        }
        loading={
          products.pendingStatusProduct
            ? products.savingPlanSlug === products.pendingStatusProduct.productSlug
            : false
        }
        onCancel={products.cancelStatusToggle}
        onConfirm={() => void products.confirmStatusToggle()}
      />
      <ConfirmDialog
        open={products.pendingUnassignSlug !== null}
        title="Unassign this product?"
        description="Removes the plan and archives tenant data per retention policy. Keys stop working immediately."
        confirmLabel="Unassign product"
        loading={products.savingPlanSlug === products.pendingUnassignSlug}
        onCancel={products.cancelUnassign}
        onConfirm={() => void products.confirmUnassign()}
      />
      <ConfirmDialog
        open={products.pendingRestoreSlug !== null}
        title="Restore archived subscription?"
        description="Reactivates the product within the retention window. You may need to issue new keys."
        confirmLabel="Restore subscription"
        loading={products.savingPlanSlug === products.pendingRestoreSlug}
        onCancel={products.cancelRestore}
        onConfirm={() => void products.confirmRestore()}
      />
    </>
  );
}
