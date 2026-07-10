/**
 * POST /api/chat/[id]/messages
 *
 * The visitor sends a message into their conversation. Enforces the merchant's
 * billing quota, meters the message to the platform, then triggers the
 * automated reply.
 */

import { Types } from "@/lib/db/connection";
import { getTenantModels } from "@/lib/db/tenant";
import { mirrorUsage } from "@/lib/db/usageMirror";
import { resolveChatCaller } from "@/lib/api/productAuth";
import { preflight, withCors } from "@/lib/api/cors";
import { checkRateLimit, getClientIp } from "@/lib/api/rateLimit";
import {
  badRequest,
  created,
  notFound,
  paymentRequired,
  serverError,
  tooManyRequests,
} from "@/lib/api/responses";
import { maybeReplyWithAssistant } from "@/lib/chat/assistant";
import { dispatchWebhook } from "@/lib/admin/webhooks";
import { reportProductUsage } from "@/lib/platform/client";
import {
  toThreadLatestPage,
  type ConversationLean,
} from "@/lib/chat/serializer";
import { statusPatchAfterMessage } from "@/lib/chat/status";
import { CHAT_MESSAGE_BODY_MAX } from "@/lib/chat/types";

export const dynamic = "force-dynamic";

const USAGE_METRIC = "messages";
const MAX_PER_MINUTE = 30;
const IP_MAX_PER_MINUTE = 60;

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface PostBody {
  body?: unknown;
}

export function OPTIONS(request: Request) {
  return preflight(request);
}

export async function POST(request: Request, { params }: RouteContext) {
  return withCors(request, async () => {
    const caller = await resolveChatCaller(request);
    if (caller instanceof Response) return caller;

    const ipLimit = checkRateLimit(
      `chat-message:ip:${getClientIp(request)}`,
      IP_MAX_PER_MINUTE,
      60_000,
    );
    if (!ipLimit.allowed) {
      return tooManyRequests(
        ipLimit.retryAfterSeconds,
        "Too many messages. Please slow down.",
      );
    }
    const limit = checkRateLimit(
      `chat-message:${caller.entitlement.siteId}:${caller.visitorId}`,
      MAX_PER_MINUTE,
      60_000,
    );
    if (!limit.allowed) {
      return tooManyRequests(
        limit.retryAfterSeconds,
        "Too many messages. Please slow down.",
      );
    }

    if (!caller.entitlement.withinQuota) {
      return paymentRequired(
        "This chat has reached its plan limit. Please contact the site owner.",
        "quota_exceeded",
      );
    }

    const { id } = await params;
    if (!Types.ObjectId.isValid(id)) {
      return notFound("Conversation not found.");
    }

    let parsed: PostBody;
    try {
      parsed = (await request.json()) as PostBody;
    } catch {
      return badRequest("Invalid request body.");
    }
    const body = typeof parsed.body === "string" ? parsed.body.trim() : "";
    if (!body) {
      return badRequest("Message cannot be empty.");
    }
    if (body.length > CHAT_MESSAGE_BODY_MAX) {
      return badRequest("Message too long.");
    }

    const { Conversation } = await getTenantModels(caller.entitlement.dataDbName);
    const conversation = await Conversation.findOne({
      _id: new Types.ObjectId(id),
      siteId: caller.entitlement.siteId,
      visitorId: caller.visitorId,
    }).lean<ConversationLean>();
    if (!conversation) {
      return notFound("Conversation not found.");
    }

    try {
      const now = new Date();
      await Conversation.updateOne(
        { _id: conversation._id },
        {
          $push: {
            messages: {
              author: "customer",
              authorName: conversation.customerName,
              body,
              createdAt: now,
            },
          },
          $set: {
            lastMessageAt: now,
            lastMessagePreview: body.slice(0, 280),
            lastMessageAuthor: "customer",
            unreadByCustomer: 0,
            ...statusPatchAfterMessage(conversation.status, "customer"),
          },
          $inc: { unreadByTeam: 1 },
        },
      );

      void reportProductUsage(caller.token, USAGE_METRIC, 1);
      void mirrorUsage(
        caller.entitlement.dataDbName,
        caller.entitlement.siteId,
        caller.entitlement.productSlug,
        USAGE_METRIC,
        1,
      );
      void dispatchWebhook(caller.entitlement.dataDbName, caller.entitlement.siteId, "message.created", {
        conversationId: conversation._id.toString(),
        author: "customer",
        preview: body.slice(0, 280),
      });

      const refreshed = await Conversation.findById(
        conversation._id,
      ).lean<ConversationLean>();
      if (!refreshed) {
        return serverError("Conversation vanished while posting.");
      }

      await maybeReplyWithAssistant(caller.entitlement.dataDbName, refreshed, caller.entitlement.config);

      const withAssistant =
        (await Conversation.findById(
          conversation._id,
        ).lean<ConversationLean>()) ?? refreshed;
      return created(toThreadLatestPage(withAssistant));
    } catch {
      return serverError("Could not send your message. Please try again.");
    }
  });
}
