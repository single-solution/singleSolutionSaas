/**
 * Resolves the calling merchant + visitor for every widget request via a signed
 * embed session minted server-side. Raw visitor ids and product tokens alone do
 * not authorize widget APIs.
 */

import {
  verifyProductToken,
  type ProductEntitlement,
} from "@/lib/platform/client";
import { verifyEmbedSessionToken } from "@/lib/embed/session";
import { loadEnvironment } from "@/lib/env";
import { demoIpRateLimitMax, isPublicDemoToken } from "@/lib/demo/safety";
import { forbidden, serviceUnavailable, tooManyRequests, unauthorized } from "./responses";
import { checkRateLimit, getClientIp, type RateLimitPolicy } from "./rateLimit";
import { isHostAllowed, resolveRequestHost } from "./origin";

const IP_MAX_PER_MINUTE = 120;
const DEMO_IP_MAX_PER_MINUTE = demoIpRateLimitMax();

export interface ChatCaller {
  visitorId: string;
  productToken: string;
  entitlement: ProductEntitlement;
}

function readBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization")?.trim();
  if (!header || !header.toLowerCase().startsWith("bearer ")) {
    return null;
  }
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

export async function resolveChatCaller(
  request: Request,
  options?: { rateLimitPolicy?: RateLimitPolicy },
): Promise<ChatCaller | Response> {
  const sessionToken = readBearerToken(request);
  if (!sessionToken) {
    return unauthorized("Missing embed session.");
  }

  const identity = verifyEmbedSessionToken(sessionToken, loadEnvironment().embedSigningSecret);
  if (!identity) {
    return unauthorized("Invalid or expired embed session.", "session_expired");
  }

  const rateLimitPolicy = options?.rateLimitPolicy ?? "degrade";
  const ipLimitMax = isPublicDemoToken(identity.productToken)
    ? DEMO_IP_MAX_PER_MINUTE
    : IP_MAX_PER_MINUTE;
  const ipLimit = await checkRateLimit(
    `chat:ip:${getClientIp(request)}`,
    ipLimitMax,
    60_000,
    rateLimitPolicy,
  );
  if (ipLimit.unavailable) {
    return serviceUnavailable("Rate limiting is temporarily unavailable.");
  }
  if (!ipLimit.allowed) {
    return tooManyRequests(
      ipLimit.retryAfterSeconds,
      "Demo rate limit reached. Please wait and try again.",
    );
  }

  const entitlement = await verifyProductToken(identity.productToken);
  if (!entitlement) {
    return unauthorized("Invalid or inactive product token.", "demo_expired");
  }
  if (entitlement.siteId !== identity.siteId || entitlement.productSlug !== identity.productSlug) {
    return unauthorized("Embed session no longer matches site entitlement.", "session_expired");
  }

  const host = resolveRequestHost(request);
  const selfHost = new URL(request.url).hostname.toLowerCase();
  const isSameOrigin = host === selfHost;
  if (!isSameOrigin && identity.originHost !== host) {
    return forbidden("This origin is not allowed for this embed session.", "origin_not_allowed");
  }
  if (!isSameOrigin && !isHostAllowed(host, entitlement.allowedDomains)) {
    return forbidden("This domain is not allowed to use this chat.", "origin_not_allowed");
  }

  return { visitorId: identity.visitorId, productToken: identity.productToken, entitlement };
}
