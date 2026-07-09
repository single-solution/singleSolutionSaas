"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

import { PageHeader } from "@/components/layout/PageHeader";
import { MerchantActivity } from "@/components/products/MerchantActivity";
import { ProductsView } from "@/components/products/ProductsView";
import { Alert } from "@/components/ui/Alert";
import { DetailSkeleton } from "@/components/ui/Skeleton";
import { platformApi } from "@/lib/api/client";
import type { MerchantSummary, SiteSummary } from "@/lib/types";

export default function AdminSiteDetailPage() {
  const params = useParams<{ merchantId: string; siteId: string }>();
  const { merchantId, siteId } = params;
  const [site, setSite] = useState<SiteSummary | null>(null);
  const [merchant, setMerchant] = useState<MerchantSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [activitySignal, setActivitySignal] = useState(0);

  useEffect(() => {
    let active = true;
    Promise.all([platformApi.getSite(siteId), platformApi.getMerchant(merchantId)])
      .then(([siteResponse, merchantResponse]) => {
        if (!active) return;
        setSite(siteResponse.site);
        setMerchant(merchantResponse.merchant);
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
  }, [merchantId, siteId]);

  if (loading) {
    return <DetailSkeleton />;
  }

  if (notFound || !site) {
    return (
      <Alert tone="danger" title="Site not found">
        This site could not be loaded.
        <div className="mt-3">
          <Link href={`/merchants/${merchantId}`} className="text-sm font-medium text-accent hover:text-brand-800">
            Back to merchant
          </Link>
        </div>
      </Alert>
    );
  }

  return (
    <div className="page-stack">
      <PageHeader
        title={site.name}
        description={site.primaryDomain ? `Products & keys · ${site.primaryDomain}` : "Products & keys"}
        breadcrumbs={[
          { label: "Merchants", href: "/" },
          { label: merchant?.name ?? "Merchant", href: `/merchants/${merchantId}` },
          { label: site.name },
        ]}
      />

      <ProductsView
        siteId={siteId}
        canManage
        isPlatformAdmin
        conversationsBase={`/merchants/${merchantId}/sites/${siteId}/products`}
        onChanged={() => setActivitySignal((current) => current + 1)}
      />

      <MerchantActivity merchantId={merchantId} refreshSignal={activitySignal} />
    </div>
  );
}
