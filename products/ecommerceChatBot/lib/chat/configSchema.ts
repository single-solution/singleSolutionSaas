/**
 * The chatbot's self-declared configuration schema and test actions. The portal
 * pulls this over `GET /api/internal/config-schema` when connecting to this
 * running product, so the portal never hand-authors the schema.
 */

/*
 * Only the "basics" are managed from the portal (admin defaults + per-site
 * overrides). Advanced automation (auto-reply rules, handoff/fallback,
 * escalation keywords) and webhook connections live in the in-product admin
 * dashboard (SiteSettings) and are edited there.
 */
export const CHATBOT_CONFIG_SCHEMA = [
  {
    key: "general",
    title: "General",
    description: "Core behavior and appearance of the chat widget.",
    kind: "settings",
    fields: [
      { key: "enabled", label: "Chat enabled", type: "boolean", default: true, help: "Turn the widget on or off.", lockable: true },
      { key: "assistantEnabled", label: "Automated assistant", type: "boolean", default: true, help: "Auto-reply to customers before a human joins.", lockable: true },
      { key: "assistantName", label: "Assistant name", type: "string", default: "Chat Support", help: "Shown as the sender name and widget title." },
      {
        key: "welcomeMessage",
        label: "Welcome message",
        type: "text",
        default: "Hi! How can we help you today? Ask about products, orders, or anything else.",
        help: "First message shown when the widget opens.",
      },
      { key: "themeColor", label: "Accent color", type: "color", default: "#c8ff00", help: "Primary color of the launcher button." },
    ],
  },
] as const;

export const CHATBOT_TEST_ACTIONS = [
  {
    key: "assistant-reply",
    label: "Assistant reply",
    description: "Preview the automated reply for a sample customer message using the draft config.",
    inputLabel: "Customer message",
    inputPlaceholder: "e.g. Do you offer refunds?",
  },
] as const;
