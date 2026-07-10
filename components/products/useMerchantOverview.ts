"use client";

import { useCallback, useEffect, useState } from "react";

import { platformApi } from "@/lib/api/client";
import type { SiteSummary } from "@/lib/types";

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
    if (!merchantId) {
      setSites([]);
      setLoading(false);
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const response = await platformApi.listSites(merchantId);
      setSites(
        response.items.map((site) => ({
          site,
          activeProducts: site.activeProducts ?? 0,
          monthlySpend: site.monthlySpend ?? 0,
          currency: site.currency ?? "USD",
        })),
      );
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
