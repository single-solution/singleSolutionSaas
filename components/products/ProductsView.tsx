"use client";

import { useState } from "react";

import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

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
    return (
      <Card className="shadow-sm border-line bg-surface">
        <CardHeader title="Products" description="Access, usage, and billing for isolated SaaS products." />
        <p className="text-sm text-ink-muted" aria-live="polite">
          Loading products...
        </p>
      </Card>
    );
  }

  if (products.error) {
    return (
      <Card className="shadow-sm border-line bg-surface">
        <CardHeader title="Products" />
        <Alert tone="danger" title="Load failed">
          {products.error}
          <div className="mt-3">
            <Button variant="outline" size="sm" onClick={() => void products.reload()}>
              Retry
            </Button>
          </div>
        </Alert>
      </Card>
    );
  }

  const selectedProduct = products.products.find((product) => product.productSlug === selectedSlug) ?? null;

  return (
    <>
      {selectedProduct ? (
        <ProductPanel
          siteId={siteId}
          conversationsBase={conversationsBase}
          product={selectedProduct}
          usage={products.usageBySlug[selectedProduct.productSlug]}
          tokens={products.tokensBySlug[selectedProduct.productSlug] ?? []}
          canManage={canManage}
          isPlatformAdmin={isPlatformAdmin}
          savingPlan={products.savingPlanSlug === selectedProduct.productSlug}
          creatingToken={products.creatingTokenSlug === selectedProduct.productSlug}
          createdToken={products.createdToken}
          tokenName={products.tokenNameBySlug[selectedProduct.productSlug] ?? ""}
          tokenDomains={products.tokenDomainsBySlug[selectedProduct.productSlug] ?? ""}
          onBack={() => {
            setSelectedSlug(null);
            products.setCreatedToken(null);
          }}
          onPlanChange={(planCode) => void products.changePlan(selectedProduct.productSlug, planCode)}
          onStatusToggle={() => void products.toggleStatus(selectedProduct)}
          onTokenNameChange={(value) => products.setTokenName(selectedProduct.productSlug, value)}
          onTokenDomainsChange={(value) => products.setTokenDomains(selectedProduct.productSlug, value)}
          onCreateToken={(event) => void products.createToken(event, selectedProduct.productSlug)}
          onCopyToken={() => void products.copyToken()}
          onDismissCreated={() => products.setCreatedToken(null)}
          onRevoke={(tokenId) => products.requestRevoke(selectedProduct.productSlug, tokenId)}
        />
      ) : (
        <ProductsOverview
          products={products.products}
          usageBySlug={products.usageBySlug}
          tokensBySlug={products.tokensBySlug}
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
