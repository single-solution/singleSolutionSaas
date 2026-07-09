/**
 * Chat settings.
 *
 * Defaults live here (env-overridable). Per-site values are managed in the
 * platform portal and delivered with the token verification response, then
 * layered on top of the defaults by `getChatSettings(config)`. The widget and
 * API read from this shape only, so the portal can change behavior without any
 * product deploy.
 */

export interface ChatSettings {
  enabled: boolean;
  assistantEnabled: boolean;
  assistantName: string;
  welcomeMessage: string;
  themeColor: string;
  pollIntervalMsFocused: number;
  pollIntervalMsBlurred: number;
}

export const CHAT_SETTINGS_DEFAULTS: ChatSettings = {
  enabled: true,
  assistantEnabled: true,
  assistantName: "Chat Support",
  welcomeMessage: "Hi! How can we help you today? Ask about products, orders, or anything else.",
  themeColor: "#c8ff00",
  pollIntervalMsFocused: 5_000,
  pollIntervalMsBlurred: 30_000,
};

function readString(config: Record<string, unknown> | undefined, key: string): string | null {
  const value = config?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readBoolean(config: Record<string, unknown> | undefined, key: string): boolean | null {
  const value = config?.[key];
  return typeof value === "boolean" ? value : null;
}

/**
 * Merge portal-managed config over the product defaults (which are themselves
 * env-overridable). Portal config wins when present.
 */
export function getChatSettings(config?: Record<string, unknown>): ChatSettings {
  const envDefaults: ChatSettings = {
    ...CHAT_SETTINGS_DEFAULTS,
    assistantEnabled: process.env.CHAT_ASSISTANT_ENABLED === "false" ? false : CHAT_SETTINGS_DEFAULTS.assistantEnabled,
    assistantName: process.env.CHAT_ASSISTANT_NAME?.trim() || CHAT_SETTINGS_DEFAULTS.assistantName,
    welcomeMessage: process.env.CHAT_WELCOME_MESSAGE?.trim() || CHAT_SETTINGS_DEFAULTS.welcomeMessage,
  };

  return {
    ...envDefaults,
    enabled: readBoolean(config, "enabled") ?? envDefaults.enabled,
    assistantEnabled: readBoolean(config, "assistantEnabled") ?? envDefaults.assistantEnabled,
    assistantName: readString(config, "assistantName") ?? envDefaults.assistantName,
    welcomeMessage: readString(config, "welcomeMessage") ?? envDefaults.welcomeMessage,
    themeColor: readString(config, "themeColor") ?? envDefaults.themeColor,
  };
}
