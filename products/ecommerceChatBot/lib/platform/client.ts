/**
 * Server-to-server client for the platform's internal endpoints. The product
 * verifies the site's access token (to resolve the site + check the billing
 * quota) and reports message usage for metering. The internal secret never
 * leaves the server.
 */

import { loadEnvironment } from "@/lib/env";

export interface ProductEntitlement {
  merchantId: string;
  merchantSlug: string;
  siteId: string;
  siteSlug: string;
  productSlug: string;
  plan: { code: string | null; name: string | null };
  scopes: string[];
  allowedDomains: string[];
  quotas: { metric: string; limit: number; unit?: string }[];
  usage: { metric: string; used: number; limit: number; withinQuota: boolean }[];
  withinQuota: boolean;
  /** Published, portal-managed configuration for this site + product. */
  config: Record<string, unknown>;
  /** This tenant's dedicated product data database (merchant + site + product). */
  dataDbName: string;
}

interface CacheEntry {
  entitlement: ProductEntitlement | null;
  expiresAt: number;
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, CacheEntry>();

export async function verifyProductToken(token: string): Promise<ProductEntitlement | null> {
  const now = Date.now();
  const cached = cache.get(token);
  if (cached && cached.expiresAt > now) {
    return cached.entitlement;
  }

  const { platformApiUrl, internalApiSecret } = loadEnvironment();
  let entitlement: ProductEntitlement | null = null;
  try {
    const res = await fetch(`${platformApiUrl}/api/internal/product-tokens/verifications`, {
      method: "POST",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${internalApiSecret}`,
      },
      body: JSON.stringify({ token }),
    });
    if (res.ok) {
      const data = (await res.json()) as { entitlement?: ProductEntitlement };
      entitlement = data.entitlement ?? null;
    }
  } catch {
    // Platform unreachable — treat as unverified for this window.
    entitlement = null;
  }

  cache.set(token, { entitlement, expiresAt: now + CACHE_TTL_MS });
  return entitlement;
}

/**
 * Fetch draft configuration for a preview token. Used by the hosted /embed page
 * when it is opened in preview mode from the portal. Returns null if the preview
 * token is invalid or the platform is unreachable.
 */
export async function fetchPreviewConfig(
  previewToken: string,
): Promise<{ siteId: string; productSlug: string; config: Record<string, unknown> } | null> {
  const { platformApiUrl, internalApiSecret } = loadEnvironment();
  try {
    const res = await fetch(`${platformApiUrl}/api/internal/product-config`, {
      method: "POST",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${internalApiSecret}`,
      },
      body: JSON.stringify({ previewToken }),
    });
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as { siteId: string; productSlug: string; config: Record<string, unknown> };
  } catch {
    return null;
  }
}

export interface ProductSiteRef {
  siteId: string;
  name: string;
  merchantName: string;
  /** The site's dedicated product data database for this product. */
  dataDbName: string;
}

/** List sites subscribed to a product, for the admin dashboard site switcher. */
export async function fetchProductSites(productSlug: string): Promise<ProductSiteRef[]> {
  const { platformApiUrl, internalApiSecret } = loadEnvironment();
  try {
    const res = await fetch(`${platformApiUrl}/api/internal/product-sites?slug=${encodeURIComponent(productSlug)}`, {
      method: "GET",
      cache: "no-store",
      headers: { Authorization: `Bearer ${internalApiSecret}` },
    });
    if (!res.ok) {
      return [];
    }
    const data = (await res.json()) as { sites?: ProductSiteRef[] };
    return data.sites ?? [];
  } catch {
    return [];
  }
}

const siteDbCache = new Map<string, { dataDbName: string; expiresAt: number }>();
const SITE_DB_CACHE_TTL_MS = 60_000;

/**
 * Resolve a site's tenant data database from the platform (cached). Used by the
 * in-product admin dashboard, whose requests carry only a `siteId`.
 */
export async function resolveSiteDataDb(productSlug: string, siteId: string): Promise<string | null> {
  const key = `${productSlug}:${siteId}`;
  const now = Date.now();
  const cached = siteDbCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.dataDbName || null;
  }
  const sites = await fetchProductSites(productSlug);
  for (const site of sites) {
    siteDbCache.set(`${productSlug}:${site.siteId}`, { dataDbName: site.dataDbName, expiresAt: now + SITE_DB_CACHE_TTL_MS });
  }
  return siteDbCache.get(key)?.dataDbName || null;
}

/** Report metered usage to the platform. Fire-and-forget; failures are swallowed. */
export async function reportProductUsage(token: string, metric: string, quantity = 1): Promise<void> {
  const { platformApiUrl, internalApiSecret } = loadEnvironment();
  try {
    await fetch(`${platformApiUrl}/api/internal/product-usage`, {
      method: "POST",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${internalApiSecret}`,
      },
      body: JSON.stringify({ token, metric, quantity }),
    });
    cache.delete(token);
  } catch {
    // Metering is best-effort; a dropped event must not block the reply.
  }
}
