"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

import { PageHeader } from "@/components/layout/PageHeader";
import { ProductConversations } from "@/components/products/ProductConversations";
import { Alert } from "@/components/ui/Alert";
import { platformApi } from "@/lib/api/client";
import type { MerchantSummary, SiteSummary } from "@/lib/types";

export default function AdminSiteProductConversationsPage() {
  const params = useParams<{ merchantId: string; siteId: string; productSlug: string }>();
  const { merchantId, siteId, productSlug } = params;
  const [site, setSite] = useState<SiteSummary | null>(null);
  const [merchant, setMerchant] = useState<MerchantSummary | null>(null);
  const [notFound, setNotFound] = useState(false);

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
      });
    return () => {
      active = false;
    };
  }, [merchantId, siteId]);

  if (notFound) {
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
        title="Conversations"
        description="Read and reply to customer chats from this product."
        breadcrumbs={[
          { label: "Merchants", href: "/" },
          { label: merchant?.name ?? "Merchant", href: `/merchants/${merchantId}` },
          { label: site?.name ?? "Site", href: `/merchants/${merchantId}/sites/${siteId}` },
          { label: "Conversations" },
        ]}
      />
      <ProductConversations siteId={siteId} productSlug={productSlug} canReply />
    </div>
  );
}
