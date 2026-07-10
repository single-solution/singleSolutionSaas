"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { Copy, PackagePlus } from "lucide-react";

import { useAuth } from "@/components/AuthProvider";
import { PageHeader } from "@/components/layout/PageHeader";
import { ProductsView } from "@/components/products/ProductsView";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { SiteDetailSkeleton } from "@/components/ui/portalSkeletons";
import { platformApi } from "@/lib/api/client";
import type {
  MerchantSummary,
  ProductAccessTokenCreated,
  SiteSummary,
  SubscriptionSummary,
} from "@/lib/types";

export default function SiteDetailPage() {
  const params = useParams<{ siteId: string }>();
  const searchParams = useSearchParams();
  const siteId = params.siteId;
  const { user } = useAuth();
  const [site, setSite] = useState<SiteSummary | null>(null);
  const [merchant, setMerchant] = useState<MerchantSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [productViewKey, setProductViewKey] = useState(0);
  const [showAssignment, setShowAssignment] = useState(
    searchParams.get("assign") === "1",
  );
  const [availableProducts, setAvailableProducts] = useState<
    SubscriptionSummary[]
  >([]);
  const [selectedProductSlug, setSelectedProductSlug] = useState("");
  const [selectedPlanCode, setSelectedPlanCode] = useState("");
  const [assigning, setAssigning] = useState(false);
  const [assignmentError, setAssignmentError] = useState<string | null>(null);
  const [createdToken, setCreatedToken] =
    useState<ProductAccessTokenCreated | null>(null);
  const selectedProduct =
    availableProducts.find(
      (product) => product.productSlug === selectedProductSlug,
    ) ?? null;

  const load = useCallback(async () => {
    setLoadError(null);
    setLoading(true);
    try {
      const siteResponse = await platformApi.getSite(siteId);
      setSite(siteResponse.site);
      const merchantResponse = await platformApi.getMerchant(
        siteResponse.site.merchantId,
      );
      setMerchant(merchantResponse.merchant);
    } catch {
      setSite(null);
      setLoadError("Could not load this site.");
    } finally {
      setLoading(false);
    }
  }, [siteId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!showAssignment || !user?.isPlatformAdmin) {
      return;
    }
    void platformApi.listSiteProducts(siteId).then((response) => {
      setAvailableProducts(response.items);
      const first =
        response.items.find((product) => product.status === "unassigned") ??
        response.items[0];
      if (first) {
        setSelectedProductSlug((current) => current || first.productSlug);
        setSelectedPlanCode(
          (current) => current || first.availablePlans[0]?.code || "",
        );
      }
    });
  }, [showAssignment, siteId, user?.isPlatformAdmin]);

  async function handleAssignProduct() {
    if (!selectedProductSlug || !selectedPlanCode) {
      setAssignmentError("Choose a product and plan.");
      return;
    }
    setAssignmentError(null);
    setAssigning(true);
    try {
      await platformApi.setSiteProductPlan(siteId, selectedProductSlug, {
        planCode: selectedPlanCode,
        status: "active",
      });
      if (site?.primaryDomain) {
        const response = await platformApi.createProductToken(
          siteId,
          selectedProductSlug,
          "Production",
          [site.primaryDomain],
        );
        setCreatedToken(response.token);
      } else {
        setShowAssignment(false);
      }
      setProductViewKey((current) => current + 1);
    } catch {
      setAssignmentError(
        "Could not assign this product. Check the plan and try again.",
      );
    } finally {
      setAssigning(false);
    }
  }

  async function copyCreatedToken() {
    if (createdToken) {
      await navigator.clipboard.writeText(createdToken.plaintextToken);
    }
  }

  if (loading) {
    return <SiteDetailSkeleton />;
  }

  if (!site) {
    return (
      <Alert tone="danger" title="Site not found">
        This site could not be loaded.
        <div className="mt-3">
          <Link
            href="/sites"
            className="text-sm font-medium text-accent hover:text-brand-800"
          >
            Back to sites
          </Link>
        </div>
      </Alert>
    );
  }

  const isPlatformAdmin = Boolean(user?.isPlatformAdmin);

  return (
    <div className="page-stack">
      <PageHeader
        title={site.name}
        description={
          site.primaryDomain
            ? `Products & keys · ${site.primaryDomain}`
            : "Products & keys"
        }
        breadcrumbs={[
          { label: "Sites", href: "/sites" },
          ...(isPlatformAdmin && merchant
            ? [{ label: merchant.name, href: `/merchants/${merchant.id}` }]
            : []),
          { label: site.name },
        ]}
        action={
          isPlatformAdmin ? (
            <Button onClick={() => setShowAssignment(true)}>
              <PackagePlus className="h-4 w-4" aria-hidden="true" />
              Assign product
            </Button>
          ) : undefined
        }
      />

      <Modal
        open={isPlatformAdmin && showAssignment}
        title={createdToken ? "Product assigned" : "Assign a product"}
        description={
          createdToken
            ? "The domain-bound publishable key is shown once. Copy it before closing."
            : "Choose access and provision the tenant database. A domain-bound key is issued next."
        }
        onClose={() => {
          setShowAssignment(false);
          setCreatedToken(null);
          setAssignmentError(null);
        }}
      >
        {assignmentError ? (
          <Alert tone="danger" title="Assignment failed" className="mb-4">
            {assignmentError}
          </Alert>
        ) : null}
        {createdToken ? (
          <Alert tone="success" title="Copy the new key now">
            <code className="mt-2 block break-all rounded-md bg-surface px-3 py-2 text-xs text-ink">
              {createdToken.plaintextToken}
            </code>
            <Button
              className="mt-3"
              variant="outline"
              size="sm"
              onClick={() => void copyCreatedToken()}
            >
              <Copy className="h-4 w-4" aria-hidden="true" />
              Copy key
            </Button>
          </Alert>
        ) : (
          <div className="grid gap-4">
            <Field label="Product" htmlFor="assignment-product" required>
              <Select
                id="assignment-product"
                value={selectedProductSlug}
                onChange={(event) => {
                  const nextProduct = availableProducts.find(
                    (product) => product.productSlug === event.target.value,
                  );
                  setSelectedProductSlug(event.target.value);
                  setSelectedPlanCode(
                    nextProduct?.availablePlans[0]?.code ?? "",
                  );
                }}
              >
                <option value="">Choose a product</option>
                {availableProducts.map((product) => (
                  <option key={product.productSlug} value={product.productSlug}>
                    {product.displayName}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Plan"
              htmlFor="assignment-plan"
              required
              hint="The tenant database is provisioned when this assignment is saved."
            >
              <Select
                id="assignment-plan"
                value={selectedPlanCode}
                onChange={(event) => setSelectedPlanCode(event.target.value)}
              >
                <option value="">Choose a plan</option>
                {selectedProduct?.availablePlans.map((plan) => (
                  <option key={plan.code} value={plan.code}>
                    {plan.name} - {plan.currency} {plan.priceMonthly.toFixed(2)}
                    /month
                  </option>
                ))}
              </Select>
            </Field>
            {selectedProduct ? (
              <div className="rounded-lg border border-line bg-surface-subtle p-3 text-sm text-ink-secondary">
                <p>
                  {selectedProduct.description || "No product description."}
                </p>
                <p className="mt-2 text-xs text-ink-muted">
                  {selectedProduct.availablePlans
                    .find((plan) => plan.code === selectedPlanCode)
                    ?.scopes.join(", ") || "No scopes"}
                </p>
              </div>
            ) : null}
            <Button
              loading={assigning}
              onClick={() => void handleAssignProduct()}
            >
              Assign and issue key
            </Button>
          </div>
        )}
      </Modal>

      {loadError ? (
        <Alert tone="danger" title="Load failed">
          {loadError}
          <div className="mt-3">
            <Button variant="outline" size="sm" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        </Alert>
      ) : null}

      <ProductsView
        key={productViewKey}
        siteId={siteId}
        canManage={isPlatformAdmin}
        isPlatformAdmin={isPlatformAdmin}
        conversationsBase={`/sites/${siteId}/products`}
      />
    </div>
  );
}
