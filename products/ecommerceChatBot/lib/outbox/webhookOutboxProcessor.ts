import { createHmac } from "node:crypto";

import { getTenantModels } from "@/lib/db/tenant";
import type { WebhookOutboxAttributes } from "@/lib/db/models/WebhookOutbox";
import { getSiteSettings } from "@/lib/admin/siteSettings";
import { OutboundUrlError, safeFetch } from "@/lib/security/outboundUrl";
import {
  OUTBOX_BATCH_LIMIT,
  OUTBOX_DEFAULT_MAX_ATTEMPTS,
  OUTBOX_LEASE_MS,
  computeOutboxBackoff,
  sanitizeOutboxError,
} from "@/lib/outbox/outboxShared";

const TIMEOUT_MS = 5_000;

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

async function recordDelivery(
  dataDbName: string,
  entry: {
    siteId: string;
    event: WebhookOutboxAttributes["event"];
    url: string;
    status: "success" | "failed";
    statusCode: number | null;
    error: string | null;
    requestBody: string;
    responseSnippet: string;
    durationMs: number;
  },
): Promise<void> {
  const { WebhookDelivery } = await getTenantModels(dataDbName);
  await WebhookDelivery.create(entry);
}

async function deliverWebhook(
  dataDbName: string,
  item: WebhookOutboxAttributes & { _id: unknown },
): Promise<void> {
  const settings = await getSiteSettings(dataDbName, item.siteId);
  const url = settings.webhookUrl.trim();
  if (!url) {
    throw new Error("Webhook URL is not configured.");
  }

  const requestBody = JSON.stringify({
    event: item.event,
    siteId: item.siteId,
    ...item.payload,
    sentAt: new Date().toISOString(),
  });
  const startedAt = Date.now();

  try {
    const { response, bodyText } = await safeFetch(url, {
      allowLocalhost: true,
      method: "POST",
      timeoutMs: TIMEOUT_MS,
      maxResponseBytes: 500,
      headers: {
        "Content-Type": "application/json",
        "X-Chatbot-Event": item.event,
        ...(settings.webhookSecret
          ? { "X-Chatbot-Signature": sign(requestBody, settings.webhookSecret) }
          : {}),
      },
      body: requestBody,
    });
    await recordDelivery(dataDbName, {
      siteId: item.siteId,
      event: item.event,
      url,
      status: response.ok ? "success" : "failed",
      statusCode: response.status,
      error: response.ok ? null : `HTTP ${response.status}`,
      requestBody,
      responseSnippet: bodyText.slice(0, 500),
      durationMs: Date.now() - startedAt,
    });
    if (!response.ok) {
      throw new Error(`Webhook returned HTTP ${response.status}`);
    }
  } catch (error) {
    if (error instanceof OutboundUrlError) {
      throw new Error(error.message);
    }
    throw error;
  }
}

export interface ProcessWebhookOutboxResult {
  processed: number;
  completed: number;
  retried: number;
  dead: number;
}

export async function processWebhookOutbox(
  dataDbName: string,
  processorId = "webhook-outbox",
): Promise<ProcessWebhookOutboxResult> {
  const { WebhookOutbox } = await getTenantModels(dataDbName);
  const now = new Date();
  const result: ProcessWebhookOutboxResult = {
    processed: 0,
    completed: 0,
    retried: 0,
    dead: 0,
  };

  for (let index = 0; index < OUTBOX_BATCH_LIMIT; index += 1) {
    const leased = await WebhookOutbox.findOneAndUpdate(
      {
        status: { $in: ["pending", "processing"] },
        nextAttemptAt: { $lte: now },
        $or: [{ leasedUntil: null }, { leasedUntil: { $lte: now } }],
      },
      {
        $set: {
          status: "processing",
          leasedUntil: new Date(now.getTime() + OUTBOX_LEASE_MS),
          leasedBy: processorId,
        },
      },
      { sort: { nextAttemptAt: 1 }, new: true },
    ).lean<WebhookOutboxAttributes & { _id: unknown }>();

    if (!leased) {
      break;
    }

    result.processed += 1;
    try {
      await deliverWebhook(dataDbName, leased);
      await WebhookOutbox.updateOne(
        { _id: leased._id },
        {
          $set: {
            status: "completed",
            leasedUntil: null,
            leasedBy: null,
            lastError: null,
          },
        },
      );
      result.completed += 1;
    } catch (error) {
      const attempts = leased.attempts + 1;
      const terminal = attempts >= OUTBOX_DEFAULT_MAX_ATTEMPTS;
      await WebhookOutbox.updateOne(
        { _id: leased._id },
        {
          $set: {
            status: terminal ? "dead" : "pending",
            attempts,
            nextAttemptAt: terminal ? now : computeOutboxBackoff(attempts),
            leasedUntil: null,
            leasedBy: null,
            lastError: sanitizeOutboxError(error),
          },
        },
      );
      if (terminal) {
        result.dead += 1;
      } else {
        result.retried += 1;
      }
    }
  }

  return result;
}
