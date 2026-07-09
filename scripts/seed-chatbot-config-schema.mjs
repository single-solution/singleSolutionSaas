/**
 * Seeds the ecommerce chatbot product with its config schema + test actions so
 * the portal's config editor is populated on day one. Idempotent: re-running
 * overwrites the schema/testActions on the product (never touches per-site
 * config).
 *
 * Run (Node 20+):
 *   node --env-file=.env scripts/seed-chatbot-config-schema.mjs [product-slug]
 */
import mongoose from "mongoose";

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGODB_URI is required.");
  process.exit(1);
}
const platformDbName = process.env.MONGODB_PLATFORM_DB?.trim() || "platform";
const slug = (process.argv[2] || "ecommerce-chatbot").toLowerCase();

const configSchema = [
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
  {
    key: "automation",
    title: "Automation",
    description: "Canned replies the assistant uses before escalating to a human.",
    kind: "settings",
    fields: [
      {
        key: "autoReplyRules",
        label: "Auto-reply rules",
        type: "list",
        default: [],
        help: "One rule per line as pattern::reply (pattern is a case-insensitive regex).",
      },
      { key: "handoffMessage", label: "Handoff message", type: "text", default: "", help: "Sent when a customer asks for a human." },
      { key: "fallbackMessage", label: "Fallback message", type: "text", default: "", help: "Sent when no rule matches." },
    ],
  },
  {
    key: "connections",
    title: "Connections",
    description: "Outbound integration for new-message notifications.",
    kind: "connection",
    fields: [
      { key: "webhookUrl", label: "Webhook URL", type: "url", default: "", help: "Optional endpoint notified on new conversations." },
      { key: "webhookSecret", label: "Webhook secret", type: "secret", default: "", help: "Signing secret sent to the webhook. Write-only." },
    ],
  },
];

const testActions = [
  {
    key: "assistant-reply",
    label: "Assistant reply",
    description: "Preview the automated reply for a sample customer message using the draft config.",
    inputLabel: "Customer message",
    inputPlaceholder: "e.g. Do you offer refunds?",
  },
];

async function run() {
  await mongoose.connect(uri.replace(/\/$/, ""));
  const db = mongoose.connection.useDb(platformDbName, { useCache: true });
  const result = await db.collection("products").updateOne({ slug }, { $set: { configSchema, testActions } });
  if (result.matchedCount === 0) {
    console.warn(`No product found with slug "${slug}". Register it in the portal first, then re-run.`);
  } else {
    console.log(`Seeded config schema + test actions on product "${slug}".`);
  }
  await mongoose.disconnect();
}

run().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect();
  process.exit(1);
});
