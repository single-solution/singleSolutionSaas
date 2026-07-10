/** GET /api/admin/webhooks?siteId= - recent webhook delivery logs. */

import { requireAdminApi, requireSiteId, resolveAdminDataDb } from "@/lib/admin/guard";
import { badRequest, ok } from "@/lib/api/responses";
import { getTenantModels } from "@/lib/db/tenant";

export const dynamic = "force-dynamic";

const LIMIT = 50;

export async function GET(request: Request) {
  const identity = requireAdminApi(request);
  if (identity instanceof Response) return identity;
  const siteId = requireSiteId(request);
  if (!siteId) {
    return badRequest("siteId is required.");
  }
  const dataDbName = await resolveAdminDataDb(identity, siteId);
  if (!dataDbName) {
    return badRequest("Unknown site.");
  }

  const { WebhookDelivery } = await getTenantModels(dataDbName);
  const docs = await WebhookDelivery.find({ siteId }).sort({ createdAt: -1 }).limit(LIMIT).lean();
  const deliveries = docs.map((doc) => {
    const withTimestamps = doc as typeof doc & { createdAt?: Date };
    return {
      id: doc._id.toString(),
      event: doc.event,
      url: doc.url,
      status: doc.status,
      statusCode: doc.statusCode ?? null,
      error: doc.error ?? null,
      responseSnippet: doc.responseSnippet ?? "",
      durationMs: doc.durationMs ?? 0,
      createdAt: withTimestamps.createdAt?.toISOString() ?? new Date().toISOString(),
    };
  });
  return ok({ deliveries });
}
