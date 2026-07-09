/**
 * Automated reply engine.
 *
 * This is a rule-based assistant: it answers common intents (greeting, pricing,
 * shipping, returns, thanks) and hands off to a human when the visitor asks for
 * one. It is intentionally catalog-agnostic — a real LLM or the merchant's
 * product catalog can plug in behind `generateAssistantReplies` later without
 * changing the API or widget.
 */

import { connectDb } from "@/lib/db/connection";
import { Conversation } from "@/lib/db/models/Conversation";
import { getSiteSettings, mergeAssistantConfig } from "@/lib/admin/siteSettings";
import { getChatSettings } from "./settings";
import { statusPatchAfterMessage } from "./status";
import type { ConversationLean } from "./serializer";

const HANDOFF_PATTERN = /\b(speak|talk|chat)\s+(to|with)\s+(someone|a\s+human|an?\s+agent|a\s+person|support|staff|team)\b|\b(human|real person|live agent|customer service)\b/i;

interface Rule {
  test: RegExp;
  replies: string[];
}

const RULES: Rule[] = [
  {
    test: /\b(hi|hello|hey|salam|assalam|good (morning|afternoon|evening))\b/i,
    replies: ["Hi there! Thanks for reaching out. How can I help you today?"],
  },
  {
    test: /\b(price|pricing|cost|how much|charges?)\b/i,
    replies: ["Happy to help with pricing. Could you tell me which product or plan you're interested in?"],
  },
  {
    test: /\b(ship|shipping|delivery|deliver|track(ing)?|order status)\b/i,
    replies: ["For shipping and order tracking, share your order number and I'll pull up the details for you."],
  },
  {
    test: /\b(return|refund|exchange|warranty)\b/i,
    replies: ["We can help with returns and refunds. Could you share your order number and what you'd like to do?"],
  },
  {
    test: /\b(thanks|thank you|appreciate|great|perfect)\b/i,
    replies: ["You're welcome! Is there anything else I can help you with?"],
  },
];

const FALLBACK = "Thanks for your message! I've noted it and our team will follow up here shortly. Meanwhile, feel free to add any more details.";
const HANDOFF_REPLY = "Sure — I'm connecting you with a teammate. They'll reply right here in this chat. Feel free to leave any details in the meantime.";

/**
 * Portal-managed rules take the form `pattern::reply`. `pattern` is matched
 * case-insensitively as a regular expression against the customer message.
 * Invalid patterns are skipped so bad config can never break the assistant.
 */
function rulesFromConfig(config?: Record<string, unknown>): Rule[] {
  const raw = config?.autoReplyRules;
  if (!Array.isArray(raw)) {
    return [];
  }
  const rules: Rule[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      continue;
    }
    const separator = entry.indexOf("::");
    if (separator === -1) {
      continue;
    }
    const pattern = entry.slice(0, separator).trim();
    const reply = entry.slice(separator + 2).trim();
    if (!pattern || !reply) {
      continue;
    }
    try {
      rules.push({ test: new RegExp(pattern, "i"), replies: [reply] });
    } catch {
      // Skip invalid regexes.
    }
  }
  return rules;
}

function stringConfig(config: Record<string, unknown> | undefined, key: string, fallback: string): string {
  const value = config?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

/** Config-defined keywords that force a handoff, in addition to the built-in pattern. */
function matchesEscalationKeyword(text: string, config?: Record<string, unknown>): boolean {
  const keywords = config?.escalationKeywords;
  if (!Array.isArray(keywords)) {
    return false;
  }
  const lower = text.toLowerCase();
  return keywords.some((keyword) => typeof keyword === "string" && keyword.trim() && lower.includes(keyword.trim().toLowerCase()));
}

/** Decide the assistant's reply bubbles for a customer message. */
export function generateAssistantReplies(
  customerBody: string,
  config?: Record<string, unknown>,
): { replies: string[]; escalate: boolean } {
  const text = customerBody.trim();
  if (HANDOFF_PATTERN.test(text) || matchesEscalationKeyword(text, config)) {
    return { replies: [stringConfig(config, "handoffMessage", HANDOFF_REPLY)], escalate: true };
  }
  const rules = [...rulesFromConfig(config), ...RULES];
  for (const rule of rules) {
    if (rule.test.test(text)) {
      return { replies: rule.replies, escalate: false };
    }
  }
  return { replies: [stringConfig(config, "fallbackMessage", FALLBACK)], escalate: false };
}

/**
 * Append an automated reply to a conversation after a customer message, unless
 * the assistant is disabled or already paused (a human has taken over).
 */
export async function maybeReplyWithAssistant(
  conversation: ConversationLean,
  config?: Record<string, unknown>,
): Promise<void> {
  const settings = getChatSettings(config);
  if (!settings.assistantEnabled || conversation.assistantMuted) {
    return;
  }
  const lastCustomer = [...conversation.messages].reverse().find((message) => message.author === "customer");
  if (!lastCustomer) {
    return;
  }

  // Portal config is the base; advanced per-site automation overrides it.
  const siteSettings = await getSiteSettings(conversation.siteId);
  const effectiveConfig = mergeAssistantConfig(config, siteSettings);
  const { replies, escalate } = generateAssistantReplies(lastCustomer.body, effectiveConfig);
  if (replies.length === 0) {
    return;
  }

  await connectDb();
  const now = new Date();
  const messages = replies.map((body, index) => ({
    author: "assistant" as const,
    authorName: settings.assistantName,
    body,
    createdAt: new Date(now.getTime() + index),
  }));
  const lastBody = replies[replies.length - 1];

  await Conversation.updateOne(
    { _id: conversation._id },
    {
      $push: { messages: { $each: messages } },
      $set: {
        lastMessageAt: messages[messages.length - 1].createdAt,
        lastMessagePreview: lastBody.slice(0, 280),
        lastMessageAuthor: "assistant",
        ...statusPatchAfterMessage(conversation.status, "assistant"),
        ...(escalate ? { assistantMuted: true, assistantMuteReason: "escalation", assistantMutedAt: now } : {}),
      },
      $inc: { unreadByCustomer: replies.length, unreadByTeam: escalate ? 1 : 0 },
    },
  );
}
