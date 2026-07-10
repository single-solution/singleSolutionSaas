/**
 * Outbound webhook dispatch via tenant outbox. Delivery attempts are processed
 * asynchronously; diagnostics rows are written by the outbox processor.
 */

import { type WebhookEvent } from "@/lib/db/models/WebhookDelivery";
import { enqueueWebhookDelivery } from "@/lib/outbox/webhookOutbox";

/** Queue a webhook for an event if the site has one configured. */
export async function dispatchWebhook(
  dataDbName: string,
  siteId: string,
  event: WebhookEvent,
  payload: Record<string, unknown>,
  idempotencyKey: string,
): Promise<void> {
  await enqueueWebhookDelivery({
    dataDbName,
    idempotencyKey,
    siteId,
    event,
    payload,
  });
}

/** Queue a manual test delivery from the diagnostics UI. */
export async function sendTestWebhook(
  dataDbName: string,
  siteId: string,
): Promise<{ configured: boolean; delivered: boolean; queued: boolean }> {
  const { getSiteSettings } = await import("./siteSettings");
  const settings = await getSiteSettings(dataDbName, siteId);
  const url = settings.webhookUrl.trim();
  if (!url) {
    return { configured: false, delivered: false, queued: false };
  }
  const idempotencyKey = `webhook:test:${siteId}:${Date.now()}`;
  await enqueueWebhookDelivery({
    dataDbName,
    idempotencyKey,
    siteId,
    event: "test",
    payload: {
      message: "This is a test webhook from the chatbot admin dashboard.",
    },
  });
  return { configured: true, delivered: false, queued: true };
}
