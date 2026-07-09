/**
 * POST /api/chat/conversations
 *
 * Opens (or returns) the visitor's single conversation. No name, phone, or
 * first message required — anonymous by design.
 */

import { connectDb } from "@/lib/db/connection";
import { Conversation } from "@/lib/db/models/Conversation";
import { resolveChatCaller } from "@/lib/api/productAuth";
import { preflight, withCors } from "@/lib/api/cors";
import { checkRateLimit, getClientIp } from "@/lib/api/rateLimit";
import {
  badRequest,
  created,
  serverError,
  tooManyRequests,
} from "@/lib/api/responses";
import { getChatSettings } from "@/lib/chat/settings";
import { dispatchWebhook } from "@/lib/admin/webhooks";
import {
  toThreadLatestPage,
  type ConversationLean,
} from "@/lib/chat/serializer";

export const dynamic = "force-dynamic";

const CREATE_MAX_PER_MINUTE = 15;

export function OPTIONS(request: Request) {
  return preflight(request);
}

export async function POST(request: Request) {
  return withCors(request, async () => {
    const caller = await resolveChatCaller(request);
    if (caller instanceof Response) return caller;

    const createLimit = checkRateLimit(
      `chat-conv:ip:${getClientIp(request)}`,
      CREATE_MAX_PER_MINUTE,
      60_000,
    );
    if (!createLimit.allowed) {
      return tooManyRequests(createLimit.retryAfterSeconds);
    }

    const settings = getChatSettings();
    if (!settings.enabled) {
      return badRequest("Chat is currently disabled.");
    }

    await connectDb();
    try {
      const existing = await Conversation.findOne({
        siteId: caller.entitlement.siteId,
        visitorId: caller.visitorId,
      }).lean<ConversationLean>();
      if (existing) {
        return created(toThreadLatestPage(existing));
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

      const lean = await Conversation.findById(
        doc._id,
      ).lean<ConversationLean>();
      if (!lean) {
        return serverError("Conversation vanished after creation.");
      }
      void dispatchWebhook(caller.entitlement.siteId, "conversation.created", {
        conversationId: doc._id.toString(),
        visitorId: caller.visitorId,
      });
      return created(toThreadLatestPage(lean));
    } catch {
      return serverError("Could not start chat. Please try again.");
    }
  });
}
