import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

/**
 * Product-wide default configuration (one per product). Sits beneath per-site
 * `SubscriptionConfig`: sites inherit these values unless they set their own.
 * `lockedFields` are enforced across every site - a locked default cannot be
 * overridden per site. Edited only by platform admins, with the same
 * draft -> publish flow as site config.
 */
const productDefaultConfigSchema = new Schema(
  {
    productSlug: { type: String, required: true, unique: true, lowercase: true, trim: true },
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

export type ProductDefaultConfigDocument = InferSchemaType<typeof productDefaultConfigSchema> & {
  _id: Schema.Types.ObjectId;
};

export const ProductDefaultConfig: Model<ProductDefaultConfigDocument> =
  (models.ProductDefaultConfig as Model<ProductDefaultConfigDocument> | undefined) ??
  model<ProductDefaultConfigDocument>("ProductDefaultConfig", productDefaultConfigSchema);
