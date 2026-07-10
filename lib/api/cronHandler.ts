import "server-only";

import { assertCronAuthorized } from "@/lib/api/cronAuth";
import { jsonOk } from "@/lib/api/responses";
import { ensurePlatformReady } from "@/lib/db/ready";
import { logger } from "@/lib/logging/logger";
import {
  patchRequestContext,
  resolveRequestId,
  runWithRequestContext,
} from "@/lib/logging/requestContext";
import { captureServerException } from "@/lib/observability/errorTracking";

export async function runPlatformCronJob<T>(
  request: Request,
  jobName: string,
  handler: () => Promise<T>,
): Promise<Response> {
  const requestId = resolveRequestId(request.headers.get("x-request-id"));
  return runWithRequestContext(
    {
      requestId,
      method: request.method,
      path: request.url,
    },
    async () => {
      const unauthorized = assertCronAuthorized(request);
      if (unauthorized) {
        return unauthorized;
      }

      const startedAt = Date.now();
      try {
        await ensurePlatformReady();
        const summary = await handler();
        logger.info("Cron job completed", {
          jobName,
          durationMs: Date.now() - startedAt,
        });
        return jsonOk(
          {
            job: jobName,
            requestId,
            timestamp: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
            summary,
          },
          200,
          { cache: "no-store", varyCookie: false, requestId },
        );
      } catch (error) {
        logger.error("Cron job failed", {
          jobName,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : "unknown",
        });
        captureServerException(error, { jobName });
        return Response.json(
          { error: "Cron job failed", requestId },
          {
            status: 500,
            headers: {
              "Cache-Control": "no-store",
              "X-Request-ID": requestId,
            },
          },
        );
      }
    },
  );
}

export function attachActorContext(input: {
  userId?: string;
  isPlatformAdmin?: boolean;
  merchantRole?: string;
  clientIp?: string;
}): void {
  patchRequestContext({
    actorUserId: input.userId ?? null,
    actorRole: input.isPlatformAdmin
      ? "platform_admin"
      : input.merchantRole ?? "authenticated",
    clientIp: input.clientIp ?? null,
  });
}
