import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

/**
 * Idempotent usage ledger entry. Each accepted metering call creates one row;
 * duplicates on the same idempotency key are rejected by a unique index.
 */
const productUsageEventSchema = new Schema(
  {
    idempotencyKey: { type: String, required: true, trim: true, unique: true },
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true, index: true },
    siteId: { type: Schema.Types.ObjectId, ref: "Site", required: true, index: true },
    productSlug: { type: String, required: true, trim: true },
    tokenId: { type: Schema.Types.ObjectId, ref: "ProductAccessToken", required: true },
    metric: { type: String, required: true, trim: true },
    period: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 1 },
    usedAfter: { type: Number, required: true, min: 0 },
    limit: { type: Number, min: 0, default: null },
    withinQuota: { type: Boolean, required: true },
    denied: { type: Boolean, required: true, default: false },
  },
  { timestamps: true },
);

export type ProductUsageEventDocument = InferSchemaType<typeof productUsageEventSchema> & {
  _id: Schema.Types.ObjectId;
};

export const ProductUsageEvent: Model<ProductUsageEventDocument> =
  (models.ProductUsageEvent as Model<ProductUsageEventDocument> | undefined) ??
  model<ProductUsageEventDocument>("ProductUsageEvent", productUsageEventSchema);
