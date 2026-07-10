import { runPlatformCronJob } from "@/lib/api/cronHandler";
import { processTenantDatabaseCleanup } from "@/lib/services/tenantDatabaseCleanup.service";

export async function POST(request: Request) {
  return runPlatformCronJob(request, "tenant-databases", () =>
    processTenantDatabaseCleanup("cron:tenant-databases"),
  );
}
