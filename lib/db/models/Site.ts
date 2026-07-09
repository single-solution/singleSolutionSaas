import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

/**
 * A deployment surface owned by a merchant (e.g. a storefront domain). Products
 * are subscribed per site, so the same product can run on several of a
 * merchant's sites under different plans. `primaryDomain` is where the product's
 * widget is expected to run and seeds a token's allowed domains.
 */
const siteSchema = new Schema(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true, index: true },
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, lowercase: true, trim: true },
    primaryDomain: { type: String, trim: true, lowercase: true, default: "" },
  },
  { timestamps: true },
);

siteSchema.index({ merchantId: 1, slug: 1 }, { unique: true });

export type SiteDocument = InferSchemaType<typeof siteSchema> & { _id: Schema.Types.ObjectId };

export const Site: Model<SiteDocument> =
  (models.Site as Model<SiteDocument> | undefined) ?? model<SiteDocument>("Site", siteSchema);
