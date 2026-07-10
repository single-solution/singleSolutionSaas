/**
 * POST /api/chat/conversations
 *
 * Opens (or returns) the visitor's single conversation. No name, phone, or
 * first message required — anonymous by design.
 */

import { getTenantModels } from "@/lib/db/tenant";
import { resolveChatCaller } from "@/lib/api/productAuth";
import { preflight, withCors } from "@/lib/api/cors";
import { checkRateLimit, getClientIp } from "@/lib/api/rateLimit";
import {
  badRequest,
  created,
  serverError,
  serviceUnavailable,
  tooManyRequests,
} from "@/lib/api/responses";
import { getChatSettings } from "@/lib/chat/settings";
import { dispatchWebhook } from "@/lib/admin/webhooks";
import {
  toThreadLatestPage,
  type ConversationLean,
} from "@/lib/chat/serializer";
import { CONVERSATION_SUMMARY_SELECT } from "@/lib/chat/messageStorage";

export const dynamic = "force-dynamic";

const CREATE_MAX_PER_MINUTE = 15;

export function OPTIONS(request: Request) {
  return preflight(request);
}

export async function POST(request: Request) {
  return withCors(request, async () => {
    const caller = await resolveChatCaller(request, { rateLimitPolicy: "fail_closed" });
    if (caller instanceof Response) return caller;

    const createLimit = await checkRateLimit(
      `chat-conv:ip:${getClientIp(request)}`,
      CREATE_MAX_PER_MINUTE,
      60_000,
      "fail_closed",
    );
    if (createLimit.unavailable) {
      return serviceUnavailable("Rate limiting is temporarily unavailable.");
    }
    if (!createLimit.allowed) {
      return tooManyRequests(createLimit.retryAfterSeconds);
    }

    const settings = getChatSettings();
    if (!settings.enabled) {
      return badRequest("Chat is currently disabled.");
    }

    const { Conversation } = await getTenantModels(caller.entitlement.dataDbName);
    const dataDbName = caller.entitlement.dataDbName;
    try {
      const existing = await Conversation.findOne({
        siteId: caller.entitlement.siteId,
        visitorId: caller.visitorId,
      })
        .select(CONVERSATION_SUMMARY_SELECT)
        .lean<ConversationLean>();
      if (existing) {
        return created(await toThreadLatestPage(dataDbName, existing));
      }

      const now = new Date();
      const doc = await Conversation.create({
        siteId: caller.entitlement.siteId,
        productSlug: caller.entitlement.productSlug,
        visitorId: caller.visitorId,
        customerName: "Visitor",
        status: "open",
        lastMessageAt: now,
        lastMessagePreview: "",
        lastMessageAuthor: "assistant",
        unreadByCustomer: 0,
        unreadByTeam: 0,
        messages: [],
      });

      const lean = await Conversation.findById(doc._id)
        .select(CONVERSATION_SUMMARY_SELECT)
        .lean<ConversationLean>();
      if (!lean) {
        return serverError("Conversation vanished after creation.");
      }
      void dispatchWebhook(
        dataDbName,
        caller.entitlement.siteId,
        "conversation.created",
        {
          conversationId: doc._id.toString(),
          visitorId: caller.visitorId,
        },
        `webhook:conversation.created:${doc._id.toString()}`,
      );
      return created(await toThreadLatestPage(dataDbName, lean));
    } catch {
      return serverError("Could not start chat. Please try again.");
    }
  });
}
