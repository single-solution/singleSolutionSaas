import { Schema } from "mongoose";

/**
 * Advanced, product-owned automation for a site. Basic settings (enabled,
 * assistant name, welcome, theme) come from the platform via the token
 * entitlement; these deeper controls are managed only in the in-product admin
 * dashboard and merged over the portal config at reply time.
 */
export interface SiteSettingsAttributes {
  siteId: string;
  autoReplyRules: string[];
  cannedReplies: string[];
  handoffMessage: string;
  fallbackMessage: string;
  escalationKeywords: string[];
  webhookUrl: string;
  webhookSecret: string;
}

export const siteSettingsSchema = new Schema<SiteSettingsAttributes>(
  {
    siteId: { type: String, required: true, unique: true, index: true },
    autoReplyRules: { type: [String], default: [] },
    cannedReplies: { type: [String], default: [] },
    handoffMessage: { type: String, default: "", trim: true, maxlength: 2_000 },
    fallbackMessage: { type: String, default: "", trim: true, maxlength: 2_000 },
    escalationKeywords: { type: [String], default: [] },
    webhookUrl: { type: String, default: "", trim: true, maxlength: 2_000 },
    webhookSecret: { type: String, default: "", trim: true, maxlength: 512 },
  },
  { timestamps: true },
);
