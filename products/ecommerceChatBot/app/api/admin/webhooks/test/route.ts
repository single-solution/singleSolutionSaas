/** POST /api/admin/webhooks/test - send a test delivery to the site's webhook. */

import { requireAdminMutation, resolveAdminDataDb } from "@/lib/admin/guard";
import { badRequest, ok } from "@/lib/api/responses";
import { sendTestWebhook } from "@/lib/admin/webhooks";

export const dynamic = "force-dynamic";

interface Body {
  siteId?: unknown;
}

export async function POST(request: Request) {
  const identity = await requireAdminMutation(request);
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
  const dataDbName = await resolveAdminDataDb(identity, siteId);
  if (!dataDbName) {
    return badRequest("Unknown site.");
  }

  const result = await sendTestWebhook(dataDbName, siteId);
  if (!result.configured) {
    return badRequest("No webhook URL configured for this site.");
  }
  return ok(result);
}
