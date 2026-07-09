"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

import { PageHeader } from "@/components/layout/PageHeader";
import { MerchantActivity } from "@/components/products/MerchantActivity";
import { SitesOverview } from "@/components/products/SitesOverview";
import { useMerchantOverview } from "@/components/products/useMerchantOverview";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { DetailSkeleton } from "@/components/ui/Skeleton";
import { platformApi } from "@/lib/api/client";
import type { MerchantSummary } from "@/lib/types";

export default function AdminMerchantDetailPage() {
  const params = useParams<{ merchantId: string }>();
  const merchantId = params.merchantId;
  const [merchant, setMerchant] = useState<MerchantSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const overview = useMerchantOverview(merchantId);

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
        <MerchantActivity merchantId={merchantId} />
      </div>
    </div>
  );
}
