"use client";

import { useEffect, useState } from "react";
import { Globe } from "lucide-react";

import { PageHeader } from "@/components/layout/PageHeader";
import { SitesOverview } from "@/components/products/SitesOverview";
import { useMerchantOverview } from "@/components/products/useMerchantOverview";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { DetailSkeleton } from "@/components/ui/Skeleton";
import { platformApi } from "@/lib/api/client";
import type { MerchantSummary } from "@/lib/types";

export default function MerchantSitesPage() {
  const [merchant, setMerchant] = useState<MerchantSummary | null>(null);
  const [merchantLoading, setMerchantLoading] = useState(true);

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
      <PageHeader title="Sites" description="Deployments where your products run. Sites are provisioned by your administrator." />

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
  );
}
