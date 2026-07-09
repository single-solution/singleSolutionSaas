"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

import { useAuth } from "@/components/AuthProvider";
import { PageHeader } from "@/components/layout/PageHeader";
import { MerchantActivity } from "@/components/products/MerchantActivity";
import { ProductsView } from "@/components/products/ProductsView";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { DetailSkeleton } from "@/components/ui/Skeleton";
import { platformApi } from "@/lib/api/client";
import type { MerchantSummary, SiteSummary } from "@/lib/types";

export default function SiteDetailPage() {
  const params = useParams<{ siteId: string }>();
  const siteId = params.siteId;
  const { user } = useAuth();
  const [site, setSite] = useState<SiteSummary | null>(null);
  const [merchant, setMerchant] = useState<MerchantSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activitySignal, setActivitySignal] = useState(0);

  async function load() {
    setLoadError(null);
    setLoading(true);
    try {
      const siteResponse = await platformApi.getSite(siteId);
      setSite(siteResponse.site);
      const merchantResponse = await platformApi.getMerchant(siteResponse.site.merchantId);
      setMerchant(merchantResponse.merchant);
    } catch {
      setSite(null);
      setLoadError("Could not load this site.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [siteId]);

  if (loading) {
    return <DetailSkeleton />;
  }

  if (!site) {
    return (
      <Alert tone="danger" title="Site not found">
        This site could not be loaded.
        <div className="mt-3">
          <Link href="/sites" className="text-sm font-medium text-accent hover:text-brand-800">
            Back to sites
          </Link>
        </div>
      </Alert>
    );
  }

  const canManage = Boolean(user?.isPlatformAdmin) || merchant?.role === "owner" || merchant?.role === "admin";

  return (
    <div className="page-stack">
      <PageHeader
        title={site.name}
        description={site.primaryDomain ? `Products & keys · ${site.primaryDomain}` : "Products & keys"}
        breadcrumbs={[
          { label: "Sites", href: "/sites" },
          { label: site.name },
        ]}
      />

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
        siteId={siteId}
        canManage={canManage}
        isPlatformAdmin={Boolean(user?.isPlatformAdmin)}
        conversationsBase={`/sites/${siteId}/products`}
        onChanged={() => setActivitySignal((current) => current + 1)}
      />

      {merchant ? <MerchantActivity merchantId={merchant.id} refreshSignal={activitySignal} /> : null}
    </div>
  );
}
