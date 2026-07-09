"use client";

import { FormEvent, useEffect, useState } from "react";
import { Globe, Plus } from "lucide-react";

import { PageHeader } from "@/components/layout/PageHeader";
import { SitesOverview } from "@/components/products/SitesOverview";
import { useMerchantOverview } from "@/components/products/useMerchantOverview";
import { useToast } from "@/components/providers/ToastProvider";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { DetailSkeleton } from "@/components/ui/Skeleton";
import { PlatformApiError, platformApi } from "@/lib/api/client";
import type { MerchantSummary } from "@/lib/types";

export default function MerchantSitesPage() {
  const toast = useToast();
  const [merchant, setMerchant] = useState<MerchantSummary | null>(null);
  const [merchantLoading, setMerchantLoading] = useState(true);

  const [name, setName] = useState("");
  const [primaryDomain, setPrimaryDomain] = useState("");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void platformApi
      .listMerchants()
      .then((response) => {
        if (active) setMerchant(response.items[0] ?? null);
      })
      .finally(() => {
        if (active) setMerchantLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const overview = useMerchantOverview(merchant?.id ?? "");
  const canManage = merchant?.role === "owner" || merchant?.role === "admin";

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    if (!name.trim()) {
      setFormError("Site name is required.");
      return;
    }
    if (!merchant) {
      return;
    }
    setCreating(true);
    try {
      await platformApi.createSite(merchant.id, { name: name.trim(), primaryDomain: primaryDomain.trim() });
      toast.showSuccess("Site created");
      setName("");
      setPrimaryDomain("");
      await overview.reload();
    } catch (caughtError) {
      setFormError(caughtError instanceof PlatformApiError ? caughtError.message : "Could not create site.");
    } finally {
      setCreating(false);
    }
  }

  if (merchantLoading) {
    return <DetailSkeleton />;
  }

  if (!merchant) {
    return (
      <div className="page-stack">
        <PageHeader title="Sites" description="Deployments where your products run." />
        <EmptyState icon={Globe} title="No workspace assigned" description="Contact your administrator." />
      </div>
    );
  }

  return (
    <div className="page-stack">
      <PageHeader title="Sites" description="Each site is a deployment where products run under their own plan and keys." />

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
            <SitesOverview sites={overview.sites} hrefBase="/sites" />
          )}
        </div>

        {canManage ? (
          <Card className="shadow-sm border-line bg-surface h-fit">
            <CardHeader title="Add a site" description="Name it and set the domain where the widget will run." />
            {formError ? (
              <Alert tone="danger" title="Could not create" className="mb-4">
                {formError}
              </Alert>
            ) : null}
            <form className="grid gap-4" onSubmit={handleCreate} noValidate>
              <Field label="Site name" htmlFor="site-name" required>
                <Input id="site-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Storefront" />
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
        ) : null}
      </div>
    </div>
  );
}
