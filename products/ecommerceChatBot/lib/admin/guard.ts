import { unauthorized } from "@/lib/api/responses";
import { readAdminSessionFromRequest, type AdminIdentity } from "./session";

/** Guard an admin API route. Returns the identity or a 401 Response. */
export function requireAdminApi(request: Request): AdminIdentity | Response {
  const identity = readAdminSessionFromRequest(request);
  if (!identity) {
    return unauthorized("Admin session required.");
  }
  return identity;
}

/** Extract and validate the `siteId` query param (required for site-scoped routes). */
export function requireSiteId(request: Request): string | null {
  const siteId = new URL(request.url).searchParams.get("siteId")?.trim();
  return siteId && siteId.length > 0 ? siteId : null;
}
