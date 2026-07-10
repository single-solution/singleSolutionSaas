/**
 * Server-to-server client for the platform's internal endpoints. The product
 * verifies the site's access token (to resolve the site + check the billing
 * quota) and reports message usage for metering. The internal secret never
 * leaves the server.
 */

import { loadEnvironment } from "@/lib/env";
import {
  invalidateEntitlementCache,
  invalidatePlatformSessionCache,
  invalidateSiteBindingCache,
  readEntitlementCache,
  readPlatformSessionCache,
  readSiteBindingCache,
  writeEntitlementCache,
  writePlatformSessionCache,
  writeSiteBindingCache,
} from "@/lib/redis/entitlementCache";
import { getRequestId } from "@/lib/logging/requestContext";

function buildInternalHeaders(): Record<string, string> {
  const { internalApiSecret } = loadEnvironment();
  const requestId = getRequestId();
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${internalApiSecret}`,
    ...(requestId ? { "X-Request-ID": requestId } : {}),
  };
}

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

export async function verifyProductToken(token: string): Promise<ProductEntitlement | null> {
  const cached = await readEntitlementCache(token);
  if (cached) {
    if (cached.kind === "valid") {
      return cached.entitlement ?? null;
    }
    if (cached.kind === "invalid") {
      return null;
    }
    if (cached.kind === "transient") {
      return null;
    }
  }

  const { platformApiUrl } = loadEnvironment();
  let entitlement: ProductEntitlement | null = null;
  let cacheKind: "valid" | "invalid" | "transient" = "invalid";
  try {
    const response = await fetch(`${platformApiUrl}/api/internal/product-tokens/verifications`, {
      method: "POST",
      cache: "no-store",
      headers: buildInternalHeaders(),
      body: JSON.stringify({ token }),
    });
    if (response.ok) {
      const data = (await response.json()) as { entitlement?: ProductEntitlement };
      entitlement = data.entitlement ?? null;
      cacheKind = entitlement ? "valid" : "invalid";
    } else if (response.status >= 500) {
      cacheKind = "transient";
      entitlement = null;
    } else {
      cacheKind = "invalid";
      entitlement = null;
    }
  } catch {
    cacheKind = "transient";
    entitlement = null;
  }

  await writeEntitlementCache(token, {
    kind: cacheKind,
    entitlement: entitlement ?? undefined,
  });
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
  const { platformApiUrl } = loadEnvironment();
  try {
    const response = await fetch(`${platformApiUrl}/api/internal/product-config`, {
      method: "POST",
      cache: "no-store",
      headers: buildInternalHeaders(),
      body: JSON.stringify({ previewToken }),
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as { siteId: string; productSlug: string; config: Record<string, unknown> };
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

export interface PlatformSsoClaims {
  userId: string;
  name: string;
  productSlug: string;
  siteId: string | null;
  sessionVersion: number;
}

export async function exchangePlatformSsoCode(
  code: string,
  productSlug: string,
): Promise<PlatformSsoClaims | null> {
  const trimmedCode = code.trim();
  if (!trimmedCode) {
    return null;
  }
  const { platformApiUrl } = loadEnvironment();
  try {
    const response = await fetch(`${platformApiUrl}/api/internal/sso/exchanges`, {
      method: "POST",
      cache: "no-store",
      headers: buildInternalHeaders(),
      body: JSON.stringify({ code: trimmedCode, productSlug }),
    });
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as { claims?: PlatformSsoClaims };
    return data.claims ?? null;
  } catch {
    return null;
  }
}

export async function verifyPlatformAdminSession(
  userId: string,
  sessionVersion: number,
): Promise<boolean> {
  const cached = await readPlatformSessionCache(userId, sessionVersion);
  if (cached) {
    return cached.valid;
  }

  const { platformApiUrl } = loadEnvironment();
  let valid = false;
  try {
    const response = await fetch(`${platformApiUrl}/api/internal/platform-sessions/verifications`, {
      method: "POST",
      cache: "no-store",
      headers: buildInternalHeaders(),
      body: JSON.stringify({ userId, sessionVersion }),
    });
    if (response.ok) {
      const data = (await response.json()) as { valid?: boolean };
      valid = Boolean(data.valid);
    }
  } catch {
    valid = false;
  }

  await writePlatformSessionCache(userId, sessionVersion, valid);
  return valid;
}

/** List sites subscribed to a product, for the admin dashboard site switcher. */
export async function fetchProductSites(productSlug: string): Promise<ProductSiteRef[]> {
  const { platformApiUrl } = loadEnvironment();
  try {
    const response = await fetch(`${platformApiUrl}/api/internal/product-sites?slug=${encodeURIComponent(productSlug)}`, {
      method: "GET",
      cache: "no-store",
      headers: buildInternalHeaders(),
    });
    if (!response.ok) {
      return [];
    }
    const data = (await response.json()) as { sites?: ProductSiteRef[] };
    return data.sites ?? [];
  } catch {
    return [];
  }
}

/**
 * Resolve a site's tenant data database from the platform (cached). Used by the
 * in-product admin dashboard, whose requests carry only a `siteId`.
 */
export async function resolveSiteDataDb(productSlug: string, siteId: string): Promise<string | null> {
  const cached = await readSiteBindingCache(productSlug, siteId);
  if (cached?.dataDbName) {
    return cached.dataDbName;
  }

  const { resolveTenantBindingFromPlatform } = await import("@/lib/platform/tenantBinding");
  const binding = await resolveTenantBindingFromPlatform({ siteId, productSlug });
  if (!binding) {
    return null;
  }
  await writeSiteBindingCache(productSlug, siteId, binding.dataDbName);
  return binding.dataDbName;
}

/** Report metered usage to the platform. Fire-and-forget; failures are swallowed. */
export async function reportProductUsage(
  token: string,
  metric: string,
  quantity = 1,
  idempotencyKey?: string,
): Promise<void> {
  const { platformApiUrl } = loadEnvironment();
  const key =
    idempotencyKey ??
    `chatbot:${metric}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
  try {
    await fetch(`${platformApiUrl}/api/internal/product-usage`, {
      method: "POST",
      cache: "no-store",
      headers: buildInternalHeaders(),
      body: JSON.stringify({ token, metric, quantity, idempotencyKey: key }),
    });
    await invalidateEntitlementCache(token);
  } catch {
    // Metering is best-effort; a dropped event must not block the reply.
  }
}

export {
  invalidateEntitlementCache,
  invalidatePlatformSessionCache,
  invalidateSiteBindingCache,
};
