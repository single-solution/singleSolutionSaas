"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

import { useAuth } from "@/components/AuthProvider";
import { PageHeader } from "@/components/layout/PageHeader";
import { ProductConversations } from "@/components/products/ProductConversations";
import { Alert } from "@/components/ui/Alert";
import { platformApi } from "@/lib/api/client";
import type { MerchantSummary, SiteSummary } from "@/lib/types";

export default function SiteProductConversationsPage() {
  const params = useParams<{ siteId: string; productSlug: string }>();
  const { siteId, productSlug } = params;
  const { user } = useAuth();
  const [site, setSite] = useState<SiteSummary | null>(null);
  const [merchant, setMerchant] = useState<MerchantSummary | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let active = true;
    void platformApi
      .getSite(siteId)
      .then(async (response) => {
        if (!active) return;
        setSite(response.site);
        const merchantResponse = await platformApi.getMerchant(response.site.merchantId);
        if (active) setMerchant(merchantResponse.merchant);
      })
      .catch(() => {
        if (active) setNotFound(true);
      });
    return () => {
      active = false;
    };
  }, [siteId]);

  if (notFound) {
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

  const canReply = Boolean(user?.isPlatformAdmin) || merchant?.role === "owner" || merchant?.role === "admin";

  return (
    <div className="page-stack">
      <PageHeader
        title="Conversations"
        description="Read and reply to customer chats from this product."
        breadcrumbs={[
          { label: "Sites", href: "/sites" },
          { label: site?.name ?? "Site", href: `/sites/${siteId}` },
          { label: "Conversations" },
        ]}
      />
      <ProductConversations siteId={siteId} productSlug={productSlug} canReply={canReply} />
    </div>
  );
}
