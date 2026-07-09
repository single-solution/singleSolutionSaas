import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

const quotaOverrideSchema = new Schema(
  {
    metric: { type: String, required: true, trim: true },
    limit: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

/**
 * A merchant's subscription to a product on a specific site. One product can be
 * subscribed on many of a merchant's sites, each with its own plan and status.
 */
const subscriptionSchema = new Schema(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true, index: true },
    siteId: { type: Schema.Types.ObjectId, ref: "Site", required: true, index: true },
    productSlug: { type: String, required: true, trim: true },
    planCode: { type: String, trim: true, default: null },
    status: { type: String, enum: ["active", "suspended"], required: true, default: "active" },
    scopeOverrides: { type: [String], default: null },
    quotaOverrides: { type: [quotaOverrideSchema], default: null },
  },
  { timestamps: true },
);

subscriptionSchema.index({ siteId: 1, productSlug: 1 }, { unique: true });

export type SubscriptionDocument = InferSchemaType<typeof subscriptionSchema> & {
  _id: Schema.Types.ObjectId;
};

export const Subscription: Model<SubscriptionDocument> =
  (models.Subscription as Model<SubscriptionDocument> | undefined) ??
  model<SubscriptionDocument>("Subscription", subscriptionSchema);
