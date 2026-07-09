/** GET /api/admin/sites - sites subscribed to this product, for the switcher. */

import { requireAdminApi } from "@/lib/admin/guard";
import { ok } from "@/lib/api/responses";
import { fetchProductSites } from "@/lib/platform/client";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const identity = requireAdminApi(request);
  if (identity instanceof Response) return identity;

  const sites = await fetchProductSites(identity.productSlug);
  return ok({ sites });
}
