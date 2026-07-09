/**
 * Resolves the calling merchant + visitor for every widget request.
 *
 * The widget sends `x-product-token` (the site's product access token) and
 * `x-visitor-id` (the anonymous per-browser id). The token is verified against
 * the platform to resolve the site + entitlement; the visitor id scopes
 * conversation ownership. Returns a `Response` on failure so handlers can early-
 * return it.
 */

import { verifyProductToken, type ProductEntitlement } from "@/lib/platform/client";
import { forbidden, tooManyRequests, unauthorized } from "./responses";
import { checkRateLimit, getClientIp } from "./rateLimit";
import { isHostAllowed, resolveRequestHost } from "./origin";

const VISITOR_ID_MAX = 64;
const IP_MAX_PER_MINUTE = 120;

export interface ChatCaller {
  token: string;
  visitorId: string;
  entitlement: ProductEntitlement;
}

function readVisitorId(request: Request): string | null {
  const raw = request.headers.get("x-visitor-id")?.trim();
  if (!raw || raw.length > VISITOR_ID_MAX || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    return null;
  }
  return raw;
}

export async function resolveChatCaller(request: Request): Promise<ChatCaller | Response> {
  const ipLimit = checkRateLimit(`chat:ip:${getClientIp(request)}`, IP_MAX_PER_MINUTE, 60_000);
  if (!ipLimit.allowed) {
    return tooManyRequests(ipLimit.retryAfterSeconds);
  }

  const token = request.headers.get("x-product-token")?.trim();
  if (!token) {
    return unauthorized("Missing product token.");
  }
  const visitorId = readVisitorId(request);
  if (!visitorId) {
    return unauthorized("Missing or invalid visitor id.");
  }
  const entitlement = await verifyProductToken(token);
  if (!entitlement) {
    return unauthorized("Invalid or inactive product token.");
  }

  // Requests from the product's own pages (the hosted /embed iframe and demo)
  // are same-origin; their framing is already gated per-token on the /embed page.
  // Cross-origin callers must match the token's domain allowlist.
  const host = resolveRequestHost(request);
  const selfHost = new URL(request.url).hostname.toLowerCase();
  const isSameOrigin = host === selfHost;
  if (!isSameOrigin && !isHostAllowed(host, entitlement.allowedDomains)) {
    return forbidden("This domain is not allowed to use this chat.", "origin_not_allowed");
  }

  return { token, visitorId, entitlement };
}
