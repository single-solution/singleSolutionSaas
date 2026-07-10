import { Schema } from "mongoose";

import {
  OUTBOX_STATUSES,
  type OutboxStatus,
} from "@/lib/outbox/outboxShared";
import {
  WEBHOOK_EVENTS,
  type WebhookEvent,
} from "@/lib/db/models/WebhookDelivery";

export interface WebhookOutboxAttributes {
  idempotencyKey: string;
  siteId: string;
  event: WebhookEvent;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: Date;
  leasedUntil: Date | null;
  leasedBy: string | null;
  lastError: string | null;
}

export const webhookOutboxSchema = new Schema<WebhookOutboxAttributes>(
  {
    idempotencyKey: { type: String, required: true, trim: true, unique: true },
    siteId: { type: String, required: true, index: true },
    event: { type: String, enum: WEBHOOK_EVENTS, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    status: {
      type: String,
      enum: OUTBOX_STATUSES,
      required: true,
      default: "pending",
    },
    attempts: { type: Number, required: true, default: 0, min: 0 },
    nextAttemptAt: { type: Date, required: true, default: () => new Date() },
    leasedUntil: { type: Date, default: null },
    leasedBy: { type: String, default: null, trim: true },
    lastError: { type: String, default: null, trim: true, maxlength: 500 },
  },
  { timestamps: true },
);

webhookOutboxSchema.index({ status: 1, nextAttemptAt: 1, leasedUntil: 1 });
