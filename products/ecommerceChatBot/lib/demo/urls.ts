/**
 * Reusable URLs for signed-in portal surfaces.
 */

import { buildPublicDemoPath } from "@/lib/demo/config";

export function publicDemoUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/$/, "");
  return `${trimmed}${buildPublicDemoPath()}`;
}
