import { runPlatformCronJob } from "@/lib/api/cronHandler";
import { reconcileSubscriptions } from "@/lib/services/subscriptionReconciliation.service";

export async function POST(request: Request) {
  return runPlatformCronJob(request, "subscription-reconciliations", () =>
    reconcileSubscriptions({ dryRun: false }),
  );
}
