/**
 * Outbound webhook dispatch + delivery logging. Notifies a merchant's endpoint
 * on new conversations and customer messages, signing the payload with the
 * site's webhook secret. Every attempt is recorded for the admin diagnostics UI.
 */

import { createHmac } from "node:crypto";

import { connectDb } from "@/lib/db/connection";
import { WebhookDelivery, type WebhookEvent } from "@/lib/db/models/WebhookDelivery";
import { getSiteSettings } from "./siteSettings";

const TIMEOUT_MS = 5_000;

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

async function deliver(siteId: string, event: WebhookEvent, url: string, secret: string, payload: unknown): Promise<void> {
  const requestBody = JSON.stringify(payload);
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Chatbot-Event": event,
        ...(secret ? { "X-Chatbot-Signature": sign(requestBody, secret) } : {}),
      },
      body: requestBody,
    });
    const text = await response.text().catch(() => "");
    await recordDelivery({
      siteId,
      event,
      url,
      status: response.ok ? "success" : "failed",
      statusCode: response.status,
      error: response.ok ? null : `HTTP ${response.status}`,
      requestBody,
      responseSnippet: text.slice(0, 500),
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    await recordDelivery({
      siteId,
      event,
      url,
      status: "failed",
      statusCode: null,
      error: error instanceof Error ? error.message : "Request failed",
      requestBody,
      responseSnippet: "",
      durationMs: Date.now() - startedAt,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function recordDelivery(entry: {
  siteId: string;
  event: WebhookEvent;
  url: string;
  status: "success" | "failed";
  statusCode: number | null;
  error: string | null;
  requestBody: string;
  responseSnippet: string;
  durationMs: number;
}): Promise<void> {
  await connectDb();
  await WebhookDelivery.create(entry);
}

/** Fire a webhook for an event if the site has one configured. Fire-and-forget. */
export async function dispatchWebhook(siteId: string, event: WebhookEvent, payload: Record<string, unknown>): Promise<void> {
  const settings = await getSiteSettings(siteId);
  const url = settings.webhookUrl.trim();
  if (!url) {
    return;
  }
  await deliver(siteId, event, url, settings.webhookSecret, { event, siteId, ...payload, sentAt: new Date().toISOString() });
}

/** Send a manual test delivery from the diagnostics UI. Returns whether it succeeded. */
export async function sendTestWebhook(siteId: string): Promise<{ configured: boolean; delivered: boolean }> {
  const settings = await getSiteSettings(siteId);
  const url = settings.webhookUrl.trim();
  if (!url) {
    return { configured: false, delivered: false };
  }
  await deliver(siteId, "test", url, settings.webhookSecret, {
    event: "test",
    siteId,
    message: "This is a test webhook from the chatbot admin dashboard.",
    sentAt: new Date().toISOString(),
  });
  const latest = await WebhookDelivery.findOne({ siteId, event: "test" }).sort({ createdAt: -1 }).lean();
  return { configured: true, delivered: latest?.status === "success" };
}
