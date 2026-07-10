import { runProductCronJob } from "@/lib/api/cronHandler";
import { processDemoCleanup } from "@/lib/services/demoCleanup.service";

export async function POST(request: Request) {
  return runProductCronJob(request, "demo-cleanups", () => processDemoCleanup());
}
