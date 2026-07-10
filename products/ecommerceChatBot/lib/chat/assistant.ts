/**
 * Automated reply engine.
 *
 * Rule-based assistant that answers common intents and hands off to humans.
 */

import { getSiteSettings, mergeAssistantConfig } from "@/lib/admin/siteSettings";
import {
  createAssistantClientMessageId,
} from "@/lib/chat/clientMessageId";
import { appendConversationMessage } from "@/lib/chat/messageService";
import {
  CONVERSATION_SUMMARY_SELECT,
  findMessageByClientMessageId,
} from "@/lib/chat/messageStorage";
import { getTenantModels } from "@/lib/db/tenant";
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

function matchesEscalationKeyword(text: string, config?: Record<string, unknown>): boolean {
  const keywords = config?.escalationKeywords;
  if (!Array.isArray(keywords)) {
    return false;
  }
  const lower = text.toLowerCase();
  return keywords.some((keyword) => typeof keyword === "string" && keyword.trim() && lower.includes(keyword.trim().toLowerCase()));
}

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

export async function maybeReplyWithAssistant(
  dataDbName: string,
  conversation: ConversationLean,
  parentClientMessageId: string,
  config?: Record<string, unknown>,
): Promise<void> {
  const settings = getChatSettings(config);
  if (!settings.assistantEnabled || conversation.assistantMuted) {
    return;
  }

  const lastCustomer = await findMessageByClientMessageId(
    dataDbName,
    conversation._id,
    parentClientMessageId,
  );
  if (!lastCustomer) {
    return;
  }

  const siteSettings = await getSiteSettings(dataDbName, conversation.siteId);
  const effectiveConfig = mergeAssistantConfig(config, siteSettings);
  const { replies, escalate } = generateAssistantReplies(lastCustomer.body, effectiveConfig);
  if (replies.length === 0) {
    return;
  }

  const now = new Date();
  let currentConversation = conversation;

  for (let index = 0; index < replies.length; index += 1) {
    const body = replies[index];
    const createdAt = new Date(now.getTime() + index);
    const isLast = index === replies.length - 1;
    await appendConversationMessage({
      dataDbName,
      conversation: currentConversation,
      clientMessageId: createAssistantClientMessageId(parentClientMessageId, index),
      author: "assistant",
      authorName: settings.assistantName,
      body,
      createdAt,
      conversationPatch: {
        lastMessageAt: createdAt,
        lastMessagePreview: body.slice(0, 280),
        lastMessageAuthor: "assistant",
        unreadByCustomer: 1,
        unreadByTeam: escalate && isLast ? 1 : 0,
        statusPatch: statusPatchAfterMessage(currentConversation.status, "assistant"),
        ...(escalate && isLast
          ? {
              assistantMuted: true,
              assistantMuteReason: "escalation" as const,
              assistantMutedAt: now,
            }
          : {}),
      },
    });
    const { Conversation } = await getTenantModels(dataDbName);
    const refreshed = await Conversation.findById(currentConversation._id)
      .select(CONVERSATION_SUMMARY_SELECT)
      .lean<ConversationLean>();
    if (refreshed) {
      currentConversation = refreshed;
    }
  }
}
