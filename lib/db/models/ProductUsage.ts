import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

/**
 * Monthly usage aggregate per site + product + metric. Products report events to
 * the platform which increments `quantity` for the current period (YYYY-MM).
 * Keeping a rolling aggregate (not raw events) keeps billing reads cheap and
 * quota checks O(1).
 */
const productUsageSchema = new Schema(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true, index: true },
    siteId: { type: Schema.Types.ObjectId, ref: "Site", required: true, index: true },
    productSlug: { type: String, required: true, trim: true },
    metric: { type: String, required: true, trim: true },
    period: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, default: 0, min: 0 },
    lastEventAt: { type: Date },
  },
  { timestamps: true },
);

productUsageSchema.index({ siteId: 1, productSlug: 1, metric: 1, period: 1 }, { unique: true });

export type ProductUsageDocument = InferSchemaType<typeof productUsageSchema> & { _id: Schema.Types.ObjectId };

export const ProductUsage: Model<ProductUsageDocument> =
  (models.ProductUsage as Model<ProductUsageDocument> | undefined) ??
  model<ProductUsageDocument>("ProductUsage", productUsageSchema);
