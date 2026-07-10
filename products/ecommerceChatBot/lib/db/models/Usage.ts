import { Schema } from "mongoose";

/**
 * Per-tenant usage mirror. The platform holds the authoritative billing counter;
 * this is a local copy inside the tenant database so the in-product dashboard can
 * show the tenant its own usage without calling back to the platform. One row per
 * metric per billing period (YYYY-MM).
 */
export interface UsageAttributes {
  siteId: string;
  productSlug: string;
  metric: string;
  period: string;
  quantity: number;
  lastEventAt: Date;
}

export const usageSchema = new Schema<UsageAttributes>(
  {
    siteId: { type: String, required: true, index: true },
    productSlug: { type: String, required: true, trim: true },
    metric: { type: String, required: true, trim: true },
    period: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, default: 0, min: 0 },
    lastEventAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: true },
);

usageSchema.index({ siteId: 1, metric: 1, period: 1 }, { unique: true });
