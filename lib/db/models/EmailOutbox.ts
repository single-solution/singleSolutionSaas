import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

import {
  OUTBOX_STATUSES,
  type OutboxStatus,
} from "@/lib/outbox/outboxShared";

export const EMAIL_OUTBOX_KINDS = ["invite", "recovery"] as const;
export type EmailOutboxKind = (typeof EMAIL_OUTBOX_KINDS)[number];

const emailOutboxSchema = new Schema(
  {
    idempotencyKey: { type: String, required: true, trim: true, unique: true },
    kind: { type: String, enum: EMAIL_OUTBOX_KINDS, required: true },
    to: { type: String, required: true, trim: true, lowercase: true },
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

emailOutboxSchema.index({ status: 1, nextAttemptAt: 1, leasedUntil: 1 });

export type EmailOutboxDocument = InferSchemaType<typeof emailOutboxSchema> & {
  _id: Schema.Types.ObjectId;
  kind: EmailOutboxKind;
  status: OutboxStatus;
};

export const EmailOutbox: Model<EmailOutboxDocument> =
  (models.EmailOutbox as Model<EmailOutboxDocument> | undefined) ??
  model<EmailOutboxDocument>("EmailOutbox", emailOutboxSchema);
