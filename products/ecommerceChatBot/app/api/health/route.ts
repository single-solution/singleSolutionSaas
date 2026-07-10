import { getProductHealthReport } from "@/lib/services/health.service";
import { resolveRequestId, runWithRequestContext } from "@/lib/logging/requestContext";

export async function GET(request: Request) {
  const requestId = resolveRequestId(request.headers.get("x-request-id"));
  return runWithRequestContext(
    {
      requestId,
      method: request.method,
      path: "/api/health",
    },
    async () => {
      const report = await getProductHealthReport();
      const status = report.status === "healthy" ? 200 : 503;
      return Response.json(report, {
        status,
        headers: {
          "Cache-Control": "public, max-age=60",
          "X-Request-ID": requestId,
        },
      });
    },
  );
}
