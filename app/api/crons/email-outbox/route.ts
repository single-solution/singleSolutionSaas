import { runPlatformCronJob } from "@/lib/api/cronHandler";
import { processEmailOutbox } from "@/lib/services/emailOutbox.service";

export async function POST(request: Request) {
  return runPlatformCronJob(request, "email-outbox", () =>
    processEmailOutbox("cron:email-outbox"),
  );
}
