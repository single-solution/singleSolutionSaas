import { assertCronAuthorized } from "@/lib/api/cronAuth";
import { logger } from "@/lib/logging/logger";
import { resolveRequestId, runWithRequestContext } from "@/lib/logging/requestContext";
import { captureServerException } from "@/lib/observability/errorTracking";

export async function runProductCronJob<T>(
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
        const summary = await handler();
        logger.info("Cron job completed", {
          jobName,
          durationMs: Date.now() - startedAt,
        });
        return Response.json(
          {
            job: jobName,
            requestId,
            timestamp: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
            summary,
          },
          {
            status: 200,
            headers: {
              "Cache-Control": "no-store",
              "X-Request-ID": requestId,
            },
          },
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
