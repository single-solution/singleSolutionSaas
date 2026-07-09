import { connectDb } from "@/lib/db/connection";
import { SiteSettings, type SiteSettingsAttributes } from "@/lib/db/models/SiteSettings";

export type SiteSettingsValues = Omit<SiteSettingsAttributes, "siteId">;

const EMPTY: SiteSettingsValues = {
  autoReplyRules: [],
  cannedReplies: [],
  handoffMessage: "",
  fallbackMessage: "",
  escalationKeywords: [],
  webhookUrl: "",
  webhookSecret: "",
};

/** Load a site's advanced settings, falling back to empty defaults. */
export async function getSiteSettings(siteId: string): Promise<SiteSettingsValues> {
  await connectDb();
  const doc = await SiteSettings.findOne({ siteId }).lean<SiteSettingsAttributes>();
  if (!doc) {
    return { ...EMPTY };
  }
  return {
    autoReplyRules: doc.autoReplyRules ?? [],
    cannedReplies: doc.cannedReplies ?? [],
    handoffMessage: doc.handoffMessage ?? "",
    fallbackMessage: doc.fallbackMessage ?? "",
    escalationKeywords: doc.escalationKeywords ?? [],
    webhookUrl: doc.webhookUrl ?? "",
    webhookSecret: doc.webhookSecret ?? "",
  };
}

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => String(entry).trim()).filter(Boolean).slice(0, 200);
}

function cleanString(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** Persist a site's advanced settings. Secrets are only replaced when provided. */
export async function saveSiteSettings(siteId: string, input: Partial<SiteSettingsValues>): Promise<SiteSettingsValues> {
  await connectDb();
  const update: Record<string, unknown> = {
    autoReplyRules: cleanList(input.autoReplyRules),
    cannedReplies: cleanList(input.cannedReplies),
    handoffMessage: cleanString(input.handoffMessage, 2_000),
    fallbackMessage: cleanString(input.fallbackMessage, 2_000),
    escalationKeywords: cleanList(input.escalationKeywords),
    webhookUrl: cleanString(input.webhookUrl, 2_000),
  };
  // Write-only secret: only overwrite when a fresh value is supplied.
  const secret = cleanString(input.webhookSecret, 512);
  if (secret.length > 0) {
    update.webhookSecret = secret;
  }
  await SiteSettings.findOneAndUpdate({ siteId }, { $set: update }, { upsert: true, new: true, setDefaultsOnInsert: true });
  return getSiteSettings(siteId);
}

/**
 * Merge advanced site settings over the portal-delivered config so the assistant
 * sees one config object. Site settings win when non-empty.
 */
export function mergeAssistantConfig(
  portalConfig: Record<string, unknown> | undefined,
  settings: SiteSettingsValues,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(portalConfig ?? {}) };
  if (settings.autoReplyRules.length > 0) {
    merged.autoReplyRules = settings.autoReplyRules;
  }
  if (settings.handoffMessage) {
    merged.handoffMessage = settings.handoffMessage;
  }
  if (settings.fallbackMessage) {
    merged.fallbackMessage = settings.fallbackMessage;
  }
  if (settings.escalationKeywords.length > 0) {
    merged.escalationKeywords = settings.escalationKeywords;
  }
  return merged;
}
