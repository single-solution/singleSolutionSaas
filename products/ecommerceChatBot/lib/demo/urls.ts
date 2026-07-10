/**
 * Reusable URLs for signed-in portal surfaces. Import from product package paths
 * when wiring catalog or subscription cards without duplicating route strings.
 */

import { buildPublicDemoPath, buildTokenDemoPath } from "@/lib/demo/config";

export function publicDemoUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/$/, "");
  return `${trimmed}${buildPublicDemoPath()}`;
}

export function tokenDemoUrl(baseUrl: string, token: string): string {
  const trimmed = baseUrl.trim().replace(/\/$/, "");
  return `${trimmed}${buildTokenDemoPath(token)}`;
}
