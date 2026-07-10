"use client";

import { FormEvent, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Activity,
  CreditCard,
  Globe,
  LayoutDashboard,
  Plus,
} from "lucide-react";

import { PageHeader } from "@/components/layout/PageHeader";
import { MerchantActivity } from "@/components/products/MerchantActivity";
import { SitesOverview } from "@/components/products/SitesOverview";
import { useMerchantOverview } from "@/components/products/useMerchantOverview";
import { useToast } from "@/components/providers/ToastProvider";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { DetailSkeleton } from "@/components/ui/Skeleton";
import { Tabs } from "@/components/ui/Tabs";
import { PlatformApiError, platformApi } from "@/lib/api/client";
import type { MerchantSummary } from "@/lib/types";

export default function AdminMerchantDetailPage() {
  const params = useParams<{ merchantId: string }>();
  const merchantId = params.merchantId;
  const router = useRouter();
  const toast = useToast();
  const [merchant, setMerchant] = useState<MerchantSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const overview = useMerchantOverview(merchantId);

  const [siteName, setSiteName] = useState("");
  const [primaryDomain, setPrimaryDomain] = useState("");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [showCreateSite, setShowCreateSite] = useState(false);

  useEffect(() => {
    let active = true;
    void platformApi
      .getMerchant(merchantId)
      .then((response) => {
        if (active) setMerchant(response.merchant);
      })
      .catch(() => {
        if (active) setNotFound(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [merchantId]);

  async function handleCreateSite(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    if (!siteName.trim()) {
      setFormError("Site name is required.");
      return;
    }
    setCreating(true);
    try {
      const response = await platformApi.createSite(merchantId, {
        name: siteName.trim(),
        primaryDomain: primaryDomain.trim(),
      });
      toast.showSuccess(
        "Site created",
        "Assign a product to it to issue a widget key.",
      );
      setSiteName("");
      setPrimaryDomain("");
      setShowCreateSite(false);
      await overview.reload();
      router.push(`/sites/${response.site.id}?assign=1`);
    } catch (caughtError) {
      setFormError(
        caughtError instanceof PlatformApiError
          ? caughtError.message
          : "Could not create site.",
      );
    } finally {
      setCreating(false);
    }
  }

  if (loading) {
    return <DetailSkeleton />;
  }

  if (notFound || !merchant) {
    return (
      <Alert tone="danger" title="Merchant not found">
        This merchant could not be loaded.
      </Alert>
    );
  }

  return (
    <div className="page-stack">
      <PageHeader
        title={merchant.name}
        description="Sites, products, plans, and activity for this merchant."
        breadcrumbs={[
          { label: "Merchants", href: "/merchants" },
          { label: merchant.name },
        ]}
        action={
          <div className="flex items-center gap-2">
            <Badge tone="neutral">{merchant.slug}</Badge>
            <Button onClick={() => setShowCreateSite(true)}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add site
            </Button>
          </div>
        }
      />

      <Modal
        open={showCreateSite}
        title="Add a site"
        description="Provision a deployment, then continue directly to product assignment."
        onClose={() => setShowCreateSite(false)}
      >
        {formError ? (
          <Alert tone="danger" title="Could not create" className="mb-4">
            {formError}
          </Alert>
        ) : null}
        <form className="grid gap-4" onSubmit={handleCreateSite} noValidate>
          <Field label="Site name" htmlFor="site-name" required>
            <Input
              id="site-name"
              value={siteName}
              onChange={(event) => setSiteName(event.target.value)}
              placeholder="Storefront"
            />
          </Field>
          <Field
            label="Primary domain"
            htmlFor="site-domain"
            hint="Hostname only. Example: shop.example.com"
          >
            <Input
              id="site-domain"
              type="url"
              value={primaryDomain}
              onChange={(event) => setPrimaryDomain(event.target.value)}
              placeholder="shop.example.com"
            />
          </Field>
          <Button type="submit" loading={creating}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Create and assign product
          </Button>
        </form>
      </Modal>

      <Tabs
        tabs={[
          {
            id: "overview",
            label: "Overview",
            icon: LayoutDashboard,
            content: (
              <div className="grid gap-4 sm:grid-cols-3">
                <Card>
                  <p className="text-sm text-ink-muted">Sites</p>
                  <p className="mt-1 text-2xl font-semibold text-ink">
                    {overview.sites.length}
                  </p>
                </Card>
                <Card>
                  <p className="text-sm text-ink-muted">Active products</p>
                  <p className="mt-1 text-2xl font-semibold text-ink">
                    {overview.sites.reduce(
                      (sum, site) => sum + site.activeProducts,
                      0,
                    )}
                  </p>
                </Card>
                <Card>
                  <p className="text-sm text-ink-muted">Onboarding</p>
                  <p className="mt-1 text-lg font-semibold text-ink">
                    {merchant.pendingInvite
                      ? "Invite pending"
                      : "Account active"}
                  </p>
                </Card>
              </div>
            ),
          },
          {
            id: "sites",
            label: "Sites & Products",
            icon: Globe,
            content: (
              <div>
                {overview.error ? (
                  <Alert tone="danger" title="Load failed">
                    {overview.error}
                    <div className="mt-3">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void overview.reload()}
                      >
                        Retry
                      </Button>
                    </div>
                  </Alert>
                ) : (
                  <SitesOverview sites={overview.sites} hrefBase="/sites" />
                )}
              </div>
            ),
          },
          {
            id: "billing",
            label: "Billing",
            icon: CreditCard,
            content: (
              <Card>
                <p className="text-sm text-ink-muted">
                  Monthly recurring spend across active subscriptions
                </p>
                <p className="mt-2 text-2xl font-semibold text-ink">
                  {merchant.monthlySpend && merchant.currency
                    ? `${merchant.currency} ${merchant.monthlySpend.toFixed(2)}`
                    : "No paid subscriptions"}
                </p>
              </Card>
            ),
          },
          {
            id: "activity",
            label: "Activity log",
            icon: Activity,
            content: <MerchantActivity merchantId={merchantId} />,
          },
        ]}
      />
    </div>
  );
}
