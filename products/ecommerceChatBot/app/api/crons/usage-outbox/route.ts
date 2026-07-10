import { runProductCronJob } from "@/lib/api/cronHandler";
import { processUsageOutboxAcrossTenants } from "@/lib/services/outboxCron.service";

export async function POST(request: Request) {
  return runProductCronJob(request, "usage-outbox", () =>
    processUsageOutboxAcrossTenants("cron:usage-outbox"),
  );
}
