import { unauthorized } from "@/lib/api/responses";
import { isPublicDemoToken, demoForbiddenMessage } from "@/lib/demo/safety";
import { verifyPlatformAdminSession } from "@/lib/platform/client";
import { resolveSiteDataDb } from "@/lib/platform/client";
import { readAdminSessionFromRequest, type AdminIdentity } from "./session";

/** Reject public demo tokens from privileged admin surfaces. */
function rejectPublicDemoProductToken(request: Request): Response | null {
  const token = request.headers.get("x-product-token")?.trim();
  if (token && isPublicDemoToken(token)) {
    return unauthorized(demoForbiddenMessage(), "demo_forbidden");
  }
  return null;
}

/** Guard an admin API route. Returns the identity or a 401 Response. */
export function requireAdminApi(request: Request): AdminIdentity | Response {
  const demoBlocked = rejectPublicDemoProductToken(request);
  if (demoBlocked) {
    return demoBlocked;
  }
  const identity = readAdminSessionFromRequest(request);
  if (!identity) {
    return unauthorized("Admin session required.");
  }
  return identity;
}

/** Guard sensitive admin mutations with a live platform session check. */
export async function requireAdminMutation(
  request: Request,
): Promise<AdminIdentity | Response> {
  const identity = requireAdminApi(request);
  if (identity instanceof Response) {
    return identity;
  }
  const valid = await verifyPlatformAdminSession(
    identity.userId,
    identity.platformSessionVersion,
  );
  if (!valid) {
    return unauthorized("Platform administrator session is no longer valid.", "platform_session_expired");
  }
  return identity;
}

/** Extract and validate the `siteId` query param (required for site-scoped routes). */
export function requireSiteId(request: Request): string | null {
  const siteId = new URL(request.url).searchParams.get("siteId")?.trim();
  return siteId && siteId.length > 0 ? siteId : null;
}

/**
 * Resolve the tenant data database for an admin request's site. The dashboard
 * only ever carries a `siteId`; the platform maps it to the tenant DB.
 */
export function resolveAdminDataDb(
  identity: AdminIdentity,
  siteId: string,
): Promise<string | null> {
  return resolveSiteDataDb(identity.productSlug, siteId);
}
