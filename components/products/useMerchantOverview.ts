"use client";

import { useCallback, useEffect, useState } from "react";

import { platformApi } from "@/lib/api/client";
import type { SiteSummary, SubscriptionSummary } from "@/lib/types";

export interface SiteOverview {
  site: SiteSummary;
  activeProducts: number;
  monthlySpend: number;
  currency: string;
}

/**
 * Loads a merchant's sites and a light per-site rollup (active products +
 * estimated monthly spend) for the dashboard. Heavier per-product detail (usage,
 * keys) is loaded on the site detail view, not here.
 */
export function useMerchantOverview(merchantId: string) {
  const [sites, setSites] = useState<SiteOverview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const response = await platformApi.listSites(merchantId);
      const rollups = await Promise.all(
        response.items.map(async (site): Promise<SiteOverview> => {
          try {
            const products = await platformApi.listSiteProducts(site.id);
            const granted = products.items.filter(
              (product: SubscriptionSummary) => product.planCode && product.status === "active",
            );
            const monthlySpend = granted.reduce((sum, product) => sum + (product.priceMonthly ?? 0), 0);
            const currency = granted.find((product) => product.currency)?.currency ?? "USD";
            return { site, activeProducts: granted.length, monthlySpend, currency };
          } catch {
            return { site, activeProducts: 0, monthlySpend: 0, currency: "USD" };
          }
        }),
      );
      setSites(rollups);
    } catch {
      setError("Could not load your sites.");
    } finally {
      setLoading(false);
    }
  }, [merchantId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { sites, loading, error, reload };
}
