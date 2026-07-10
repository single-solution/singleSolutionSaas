"use client";

import { FormEvent, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Plus } from "lucide-react";

import { PageHeader } from "@/components/layout/PageHeader";
import { MerchantActivity } from "@/components/products/MerchantActivity";
import { SitesOverview } from "@/components/products/SitesOverview";
import { useMerchantOverview } from "@/components/products/useMerchantOverview";
import { useToast } from "@/components/providers/ToastProvider";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { DetailSkeleton } from "@/components/ui/Skeleton";
import { PlatformApiError, platformApi } from "@/lib/api/client";
import type { MerchantSummary } from "@/lib/types";

export default function AdminMerchantDetailPage() {
  const params = useParams<{ merchantId: string }>();
  const merchantId = params.merchantId;
  const toast = useToast();
  const [merchant, setMerchant] = useState<MerchantSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const overview = useMerchantOverview(merchantId);

  const [siteName, setSiteName] = useState("");
  const [primaryDomain, setPrimaryDomain] = useState("");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

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
      await platformApi.createSite(merchantId, { name: siteName.trim(), primaryDomain: primaryDomain.trim() });
      toast.showSuccess("Site created", "Assign a product to it to issue a widget key.");
      setSiteName("");
      setPrimaryDomain("");
      await overview.reload();
    } catch (caughtError) {
      setFormError(caughtError instanceof PlatformApiError ? caughtError.message : "Could not create site.");
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
        breadcrumbs={[{ label: "Merchants", href: "/" }, { label: merchant.name }]}
        action={<Badge tone="neutral">{merchant.slug}</Badge>}
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          {overview.error ? (
            <Alert tone="danger" title="Load failed">
              {overview.error}
              <div className="mt-3">
                <Button variant="outline" size="sm" onClick={() => void overview.reload()}>
                  Retry
                </Button>
              </div>
            </Alert>
          ) : (
            <SitesOverview sites={overview.sites} hrefBase={`/merchants/${merchantId}/sites`} />
          )}
        </div>

        <div className="grid gap-5">
          <Card className="shadow-sm border-line bg-surface h-fit">
            <CardHeader title="Add a site" description="Provision a deployment for this merchant, then assign a product to it." />
            {formError ? (
              <Alert tone="danger" title="Could not create" className="mb-4">
                {formError}
              </Alert>
            ) : null}
            <form className="grid gap-4" onSubmit={handleCreateSite} noValidate>
              <Field label="Site name" htmlFor="site-name" required>
                <Input id="site-name" value={siteName} onChange={(event) => setSiteName(event.target.value)} placeholder="Storefront" />
              </Field>
              <Field label="Primary domain" htmlFor="site-domain" hint="Where the widget runs. Example: shop.example.com">
                <Input
                  id="site-domain"
                  value={primaryDomain}
                  onChange={(event) => setPrimaryDomain(event.target.value)}
                  placeholder="shop.example.com"
                />
              </Field>
              <Button type="submit" loading={creating}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                Create site
              </Button>
            </form>
          </Card>

          <MerchantActivity merchantId={merchantId} />
        </div>
      </div>
    </div>
  );
}
