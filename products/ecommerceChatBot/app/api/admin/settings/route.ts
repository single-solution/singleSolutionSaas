/**
 * GET /api/admin/settings?siteId= - advanced assistant + webhook settings.
 * PUT /api/admin/settings          - save them.
 */

import { requireAdminApi, requireAdminMutation, requireSiteId, resolveAdminDataDb } from "@/lib/admin/guard";
import { badRequest, ok } from "@/lib/api/responses";
import { getSiteSettings, saveSiteSettings, SiteSettingsError, type SiteSettingsValues } from "@/lib/admin/siteSettings";

export const dynamic = "force-dynamic";

/** Never return the raw secret; report only whether one is set. */
function present(settings: SiteSettingsValues) {
  const { webhookSecret, ...rest } = settings;
  return { ...rest, webhookSecretSet: webhookSecret.length > 0 };
}

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
  const settings = await getSiteSettings(dataDbName, siteId);
  return ok({ settings: present(settings) });
}

interface PutBody extends Partial<SiteSettingsValues> {
  siteId?: string;
}

export async function PUT(request: Request) {
  const identity = await requireAdminMutation(request);
  if (identity instanceof Response) return identity;

  let parsed: PutBody;
  try {
    parsed = (await request.json()) as PutBody;
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
  try {
    const settings = await saveSiteSettings(dataDbName, siteId, parsed);
    return ok({ settings: present(settings) });
  } catch (error) {
    if (error instanceof SiteSettingsError) {
      return badRequest(error.message);
    }
    throw error;
  }
}
