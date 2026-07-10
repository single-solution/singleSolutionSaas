/**
 * POST /api/chat/[id]/messages
 *
 * The visitor sends a message into their conversation. Enforces the merchant's
 * billing quota, meters the message to the platform, then triggers the
 * automated reply.
 */

import { Types } from "@/lib/db/connection";
import { getTenantModels } from "@/lib/db/tenant";
import { resolveChatCaller } from "@/lib/api/productAuth";
import { preflight, withCors } from "@/lib/api/cors";
import { checkRateLimit, getClientIp } from "@/lib/api/rateLimit";
import {
  badRequest,
  created,
  notFound,
  paymentRequired,
  serverError,
  serviceUnavailable,
  tooManyRequests,
} from "@/lib/api/responses";
import { demoMessageRateLimitMax, isPublicDemoToken } from "@/lib/demo/safety";
import { maybeReplyWithAssistant } from "@/lib/chat/assistant";
import {
  normalizeClientMessageId,
  usageIdempotencyKey,
  webhookIdempotencyKey,
} from "@/lib/chat/clientMessageId";
import { CONVERSATION_SUMMARY_SELECT } from "@/lib/chat/messageStorage";
import { appendConversationMessage } from "@/lib/chat/messageService";
import { toThreadLatestPage, type ConversationLean } from "@/lib/chat/serializer";
import { statusPatchAfterMessage } from "@/lib/chat/status";
import { CHAT_MESSAGE_BODY_MAX } from "@/lib/chat/types";

export const dynamic = "force-dynamic";

const USAGE_METRIC = "messages";
const MAX_PER_MINUTE = 30;
const IP_MAX_PER_MINUTE = 60;
const DEMO_MAX_PER_MINUTE = demoMessageRateLimitMax();
const DEMO_IP_MAX_PER_MINUTE = 30;

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface PostBody {
  body?: unknown;
  clientMessageId?: unknown;
}

export function OPTIONS(request: Request) {
  return preflight(request);
}

export async function POST(request: Request, { params }: RouteContext) {
  return withCors(request, async () => {
    const caller = await resolveChatCaller(request, { rateLimitPolicy: "fail_closed" });
    if (caller instanceof Response) return caller;

    const isDemo = isPublicDemoToken(caller.productToken);
    const ipLimit = await checkRateLimit(
      `chat-message:ip:${getClientIp(request)}`,
      isDemo ? DEMO_IP_MAX_PER_MINUTE : IP_MAX_PER_MINUTE,
      60_000,
      "fail_closed",
    );
    if (ipLimit.unavailable) {
      return serviceUnavailable("Rate limiting is temporarily unavailable.");
    }
    if (!ipLimit.allowed) {
      return tooManyRequests(
        ipLimit.retryAfterSeconds,
        "Too many messages. Please slow down.",
      );
    }
    const limit = await checkRateLimit(
      `chat-message:${caller.entitlement.siteId}:${caller.visitorId}`,
      isDemo ? DEMO_MAX_PER_MINUTE : MAX_PER_MINUTE,
      60_000,
      "fail_closed",
    );
    if (limit.unavailable) {
      return serviceUnavailable("Rate limiting is temporarily unavailable.");
    }
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
    const clientMessageId = normalizeClientMessageId(parsed.clientMessageId);
    if (!body) {
      return badRequest("Message cannot be empty.");
    }
    if (body.length > CHAT_MESSAGE_BODY_MAX) {
      return badRequest("Message too long.");
    }
    if (!clientMessageId) {
      return badRequest("clientMessageId is required.");
    }

    const { Conversation } = await getTenantModels(
      caller.entitlement.dataDbName,
    );
    const conversation = await Conversation.findOne({
      _id: new Types.ObjectId(id),
      siteId: caller.entitlement.siteId,
      visitorId: caller.visitorId,
    })
      .select(CONVERSATION_SUMMARY_SELECT)
      .lean<ConversationLean>();
    if (!conversation) {
      return notFound("Conversation not found.");
    }

    try {
      const now = new Date();
      const usageKey = usageIdempotencyKey(conversation._id.toString(), clientMessageId);
      const result = await appendConversationMessage({
        dataDbName: caller.entitlement.dataDbName,
        conversation: { ...conversation, messages: [] },
        clientMessageId,
        author: "customer",
        authorName: conversation.customerName,
        body,
        createdAt: now,
        conversationPatch: {
          lastMessageAt: now,
          lastMessagePreview: body.slice(0, 280),
          lastMessageAuthor: "customer",
          unreadByCustomer: 0,
          unreadByTeam: 1,
          statusPatch: statusPatchAfterMessage(conversation.status, "customer"),
        },
        usage: {
          token: caller.productToken,
          metric: USAGE_METRIC,
          quantity: 1,
          idempotencyKey: usageKey,
          siteId: caller.entitlement.siteId,
          productSlug: caller.entitlement.productSlug,
        },
        webhook: {
          siteId: caller.entitlement.siteId,
          event: "message.created",
          idempotencyKey: webhookIdempotencyKey(
            conversation._id.toString(),
            clientMessageId,
            "message.created",
          ),
          payload: {
            conversationId: conversation._id.toString(),
            author: "customer",
            preview: body.slice(0, 280),
            clientMessageId,
          },
        },
      });

      if (!result.duplicate) {
        const refreshed = await Conversation.findById(conversation._id)
          .select(CONVERSATION_SUMMARY_SELECT)
          .lean<ConversationLean>();
        if (refreshed) {
          await maybeReplyWithAssistant(
            caller.entitlement.dataDbName,
            refreshed,
            clientMessageId,
            caller.entitlement.config,
          );
          return created(
            await toThreadLatestPage(caller.entitlement.dataDbName, refreshed),
          );
        }
      }

      return created(result.thread);
    } catch {
      return serverError("Could not send your message. Please try again.");
    }
  });
}
