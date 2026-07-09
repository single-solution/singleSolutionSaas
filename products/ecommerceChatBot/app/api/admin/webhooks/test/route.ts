/** POST /api/admin/webhooks/test - send a test delivery to the site's webhook. */

import { requireAdminApi } from "@/lib/admin/guard";
import { badRequest, ok } from "@/lib/api/responses";
import { sendTestWebhook } from "@/lib/admin/webhooks";

export const dynamic = "force-dynamic";

interface Body {
  siteId?: unknown;
}

export async function POST(request: Request) {
  const identity = requireAdminApi(request);
  if (identity instanceof Response) return identity;

  let parsed: Body;
  try {
    parsed = (await request.json()) as Body;
  } catch {
    return badRequest("Invalid request body.");
  }
  const siteId = typeof parsed.siteId === "string" ? parsed.siteId.trim() : "";
  if (!siteId) {
    return badRequest("siteId is required.");
  }

  const result = await sendTestWebhook(siteId);
  if (!result.configured) {
    return badRequest("No webhook URL configured for this site.");
  }
  return ok(result);
}
