/**
 * POST /api/embed/sessions
 *
 * Bootstrap a short-lived signed embed session from a publishable product token
 * and the caller's browser origin.
 */

import { z } from "zod";

import { mintEmbedSessionToken, mintVisitorId, verifyEmbedSessionToken } from "@/lib/embed/session";
import { verifyProductToken } from "@/lib/platform/client";
import { loadEnvironment } from "@/lib/env";
import { demoIpRateLimitMax, isPublicDemoToken } from "@/lib/demo/safety";
import { preflight, withCors } from "@/lib/api/cors";
import { badRequest, ok, serviceUnavailable, unauthorized } from "@/lib/api/responses";
import { checkRateLimit, getClientIp } from "@/lib/api/rateLimit";
import { isHostAllowed, resolveRequestHost } from "@/lib/api/origin";

export const dynamic = "force-dynamic";

const bootstrapBodySchema = z
  .object({
    productToken: z.string().min(20).max(200),
  })
  .strict();

export function OPTIONS(request: Request) {
  return preflight(request);
}

export async function POST(request: Request) {
  return withCors(request, async () => {
    const environment = loadEnvironment();
    let parsedBody: z.infer<typeof bootstrapBodySchema>;
    try {
      const body = await request.json();
      const parsed = bootstrapBodySchema.safeParse(body);
      if (!parsed.success) {
        return badRequest(parsed.error.issues[0]?.message ?? "Invalid body.");
      }
      parsedBody = parsed.data;
    } catch {
      return badRequest("Invalid request body.");
    }

    const productToken = parsedBody.productToken.trim();
    const ipLimitMax = isPublicDemoToken(productToken)
      ? demoIpRateLimitMax()
      : 120;
    const ipLimit = await checkRateLimit(`embed:bootstrap:${getClientIp(request)}`, ipLimitMax, 60_000);
    if (ipLimit.unavailable) {
      return serviceUnavailable("Rate limiting is temporarily unavailable.");
    }
    if (!ipLimit.allowed) {
      return unauthorized("Rate limit reached. Please wait and try again.");
    }

    const entitlement = await verifyProductToken(productToken);
    if (!entitlement) {
      return unauthorized("Invalid or inactive product token.");
    }

    const host = resolveRequestHost(request);
    const selfHost = new URL(request.url).hostname.toLowerCase();
    const refererHost = (() => {
      const referer = request.headers.get("referer");
      if (!referer) return null;
      try {
        return new URL(referer).hostname.toLowerCase();
      } catch {
        return null;
      }
    })();
    const bindingHost =
      host === selfHost && refererHost && refererHost !== selfHost ? refererHost : host;
    const isSameOrigin = bindingHost === selfHost;
    if (!bindingHost) {
      return unauthorized("Origin is required to start an embed session.");
    }
    if (!isSameOrigin && !isHostAllowed(bindingHost, entitlement.allowedDomains)) {
      return unauthorized("This domain is not allowed to use this chat.");
    }
    if (isSameOrigin && refererHost && refererHost !== selfHost && !isHostAllowed(refererHost, entitlement.allowedDomains)) {
      return unauthorized("This domain is not allowed to use this chat.");
    }

    const existingToken = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
    let visitorId = mintVisitorId();
    if (existingToken) {
      const existing = verifyEmbedSessionToken(existingToken, environment.embedSigningSecret);
      if (
        existing &&
        existing.productToken === productToken &&
        existing.siteId === entitlement.siteId &&
        existing.originHost === bindingHost
      ) {
        visitorId = existing.visitorId;
      }
    }

    const sessionToken = mintEmbedSessionToken(
      {
        visitorId,
        siteId: entitlement.siteId,
        productSlug: entitlement.productSlug,
        originHost: bindingHost,
        productToken,
      },
      environment.embedSigningSecret,
    );

    return ok({
      sessionToken,
      visitorId,
      expiresInSeconds: 30 * 60,
    });
  });
}
