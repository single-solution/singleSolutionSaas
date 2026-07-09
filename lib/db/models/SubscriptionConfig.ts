import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

/**
 * Per-subscription (site + product) configuration. The product only ever reads
 * `published`; the portal edits `draft` and previews it. `lockedFields` are keys
 * only a platform admin may change (merchants cannot edit locked values).
 */
const subscriptionConfigSchema = new Schema(
  {
    siteId: { type: Schema.Types.ObjectId, ref: "Site", required: true, index: true },
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true, index: true },
    productSlug: { type: String, required: true, trim: true },
    draft: {
      values: { type: Schema.Types.Mixed, default: {} },
      updatedAt: { type: Date, default: null },
      updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    },
    published: {
      values: { type: Schema.Types.Mixed, default: {} },
      version: { type: Number, default: 0 },
      publishedAt: { type: Date, default: null },
      publishedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    },
    lockedFields: { type: [String], default: [] },
  },
  { timestamps: true },
);

subscriptionConfigSchema.index({ siteId: 1, productSlug: 1 }, { unique: true });

export type SubscriptionConfigDocument = InferSchemaType<typeof subscriptionConfigSchema> & {
  _id: Schema.Types.ObjectId;
};

export const SubscriptionConfig: Model<SubscriptionConfigDocument> =
  (models.SubscriptionConfig as Model<SubscriptionConfigDocument> | undefined) ??
  model<SubscriptionConfigDocument>("SubscriptionConfig", subscriptionConfigSchema);
