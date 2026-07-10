import "server-only";

import { loadEnvironment } from "@/lib/env";
import { logger } from "@/lib/logging/logger";

export function isValidCronAuthorization(authorization: string | null): boolean {
  const secret = loadEnvironment().CRON_SECRET;
  if (!secret) {
    return false;
  }
  if (!authorization?.startsWith("Bearer ")) {
    return false;
  }
  const token = authorization.slice("Bearer ".length).trim();
  return token.length > 0 && token === secret;
}

export function assertCronAuthorized(request: Request): Response | null {
  const environment = loadEnvironment();
  if (!environment.CRON_SECRET) {
    logger.warn("Cron route rejected: CRON_SECRET is not configured");
    return Response.json({ error: "Unauthorized" }, {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
  }
  if (!isValidCronAuthorization(request.headers.get("authorization"))) {
    return Response.json({ error: "Unauthorized" }, {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
  }
  return null;
}
