import { getTenantModels } from "@/lib/db/tenant";
import type { WebhookEvent } from "@/lib/db/models/WebhookDelivery";

export interface EnqueueWebhookInput {
  dataDbName: string;
  idempotencyKey: string;
  siteId: string;
  event: WebhookEvent;
  payload: Record<string, unknown>;
}

export async function enqueueWebhookDelivery(
  input: EnqueueWebhookInput,
): Promise<void> {
  const { WebhookOutbox } = await getTenantModels(input.dataDbName);
  await WebhookOutbox.updateOne(
    { idempotencyKey: input.idempotencyKey },
    {
      $setOnInsert: {
        idempotencyKey: input.idempotencyKey,
        siteId: input.siteId,
        event: input.event,
        payload: input.payload,
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
