/**
 * Resolves tenant database bindings from the platform. Products must not trust
 * caller-supplied dataDbName; they validate siteId + productSlug here.
 */

import { loadEnvironment } from "@/lib/env";

export interface TenantBinding {
  siteId: string;
  productSlug: string;
  merchantId: string;
  subscriptionId: string;
  status: "active" | "suspended" | "archived";
  planCode: string | null;
  dataDbName: string;
}

export async function resolveTenantBindingFromPlatform(input: {
  siteId: string;
  productSlug: string;
  requireBridgeAccess?: boolean;
}): Promise<TenantBinding | null> {
  const { platformApiUrl, internalApiSecret, productSlug } = loadEnvironment();
  const params = new URLSearchParams({
    siteId: input.siteId,
    productSlug: input.productSlug || productSlug,
  });
  if (input.requireBridgeAccess) {
    params.set("bridge", "true");
  }
  try {
    const response = await fetch(
      `${platformApiUrl}/api/internal/tenant-bindings?${params.toString()}`,
      {
        method: "GET",
        cache: "no-store",
        headers: { Authorization: `Bearer ${internalApiSecret}` },
      },
    );
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { binding?: TenantBinding };
    return body.binding ?? null;
  } catch {
    return null;
  }
}
