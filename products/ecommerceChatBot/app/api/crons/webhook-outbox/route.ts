import { runProductCronJob } from "@/lib/api/cronHandler";
import { processWebhookOutboxAcrossTenants } from "@/lib/services/outboxCron.service";

export async function POST(request: Request) {
  return runProductCronJob(request, "webhook-outbox", () =>
    processWebhookOutboxAcrossTenants("cron:webhook-outbox"),
  );
}
