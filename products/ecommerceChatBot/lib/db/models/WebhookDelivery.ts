import { Schema } from "mongoose";

/**
 * Log of a single outbound webhook attempt, for the admin dashboard's webhook
 * diagnostics. One row per delivery attempt (real events and manual tests).
 */
export const WEBHOOK_EVENTS = ["conversation.created", "message.created", "test"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const WEBHOOK_STATUSES = ["success", "failed"] as const;
export type WebhookStatus = (typeof WEBHOOK_STATUSES)[number];

export interface WebhookDeliveryAttributes {
  siteId: string;
  event: WebhookEvent;
  url: string;
  status: WebhookStatus;
  statusCode: number | null;
  error: string | null;
  requestBody: string;
  responseSnippet: string;
  durationMs: number;
}

export const webhookDeliverySchema = new Schema<WebhookDeliveryAttributes>(
  {
    siteId: { type: String, required: true, index: true },
    event: { type: String, enum: WEBHOOK_EVENTS, required: true },
    url: { type: String, required: true },
    status: { type: String, enum: WEBHOOK_STATUSES, required: true },
    statusCode: { type: Number, default: null },
    error: { type: String, default: null },
    requestBody: { type: String, default: "" },
    responseSnippet: { type: String, default: "" },
    durationMs: { type: Number, default: 0 },
  },
  { timestamps: true },
);

webhookDeliverySchema.index({ siteId: 1, createdAt: -1 });
