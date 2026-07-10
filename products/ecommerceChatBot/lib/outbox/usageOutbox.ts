import { getTenantModels } from "@/lib/db/tenant";

export interface EnqueueUsageInput {
  dataDbName: string;
  idempotencyKey: string;
  siteId: string;
  productSlug: string;
  token: string;
  metric: string;
  quantity: number;
}

export async function enqueueUsageReport(input: EnqueueUsageInput): Promise<void> {
  const { UsageOutbox } = await getTenantModels(input.dataDbName);
  await UsageOutbox.updateOne(
    { idempotencyKey: input.idempotencyKey },
    {
      $setOnInsert: {
        idempotencyKey: input.idempotencyKey,
        siteId: input.siteId,
        productSlug: input.productSlug,
        token: input.token,
        metric: input.metric,
        quantity: input.quantity,
        status: "pending",
        attempts: 0,
        nextAttemptAt: new Date(),
        leasedUntil: null,
        leasedBy: null,
        lastError: null,
      },
    },
    { upsert: true },
  );
}
