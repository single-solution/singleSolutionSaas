import { loadEnvironment } from "@/lib/env";
import { logger } from "@/lib/logging/logger";

function readCronSecret(): string | undefined {
  return process.env.CRON_SECRET?.trim();
}

export function isValidCronAuthorization(authorization: string | null): boolean {
  const secret = readCronSecret();
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
  if (!readCronSecret()) {
    logger.warn("Cron route rejected: CRON_SECRET is not configured");
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!isValidCronAuthorization(request.headers.get("authorization"))) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  return null;
}

export function assertProductionCronConfigured(): void {
  if (loadEnvironment().nodeEnv !== "production") {
    return;
  }
  if (!readCronSecret()) {
    throw new Error("CRON_SECRET is required in production.");
  }
}
