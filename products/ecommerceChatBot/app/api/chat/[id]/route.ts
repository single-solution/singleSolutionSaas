/**
 * GET /api/chat/[id]
 *
 * Fetch a conversation the calling visitor owns. Supports poll (`since` + ETag
 * 304), older-page (`before`) pagination, and marks unread agent/assistant
 * messages read on a full open.
 */

import { Types } from "@/lib/db/connection";
import { type ConversationMessageAttributes } from "@/lib/db/models/Conversation";
import { getTenantModels } from "@/lib/db/tenant";
import { resolveChatCaller } from "@/lib/api/productAuth";
import { preflight, withCors } from "@/lib/api/cors";
import { notFound, notModified, ok } from "@/lib/api/responses";
import {
  CHAT_MESSAGE_PAGE_SIZE,
  sliceChatMessages,
} from "@/lib/chat/messagePagination";
import {
  isThreadUnchangedForPoll,
  parsePollSince,
  threadPollEtag,
} from "@/lib/chat/poll";
import { toThread, type ConversationLean } from "@/lib/chat/serializer";
import { asArray } from "@/lib/chat/wireCoercion";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export function OPTIONS(request: Request) {
  return preflight(request);
}

export async function GET(request: Request, { params }: RouteContext) {
  return withCors(request, async () => {
    const caller = await resolveChatCaller(request);
    if (caller instanceof Response) return caller;

    const { id } = await params;
    if (!Types.ObjectId.isValid(id)) {
      return notFound("Conversation not found.");
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

    const url = new URL(request.url);
    const since = parsePollSince(url.searchParams.get("since"));
    const isPoll = since !== null;
    const beforeId = url.searchParams.get("before");
    const isOlderPage = beforeId !== null;
    const ifNoneMatch = request.headers.get("If-None-Match");
    const etag = threadPollEtag(conversation.lastMessageAt);

    if (
      isPoll &&
      isThreadUnchangedForPoll({
        lastMessageAt: conversation.lastMessageAt,
        updatedAt: conversation.updatedAt,
        since,
        ifNoneMatch,
      })
    ) {
      return notModified(etag);
    }

    let toReturn: ConversationLean = conversation;
    if (!isPoll && !isOlderPage && conversation.unreadByCustomer > 0) {
      const now = new Date();
      await Conversation.updateOne(
        { _id: conversation._id },
        {
          $set: {
            unreadByCustomer: 0,
            "messages.$[unread].readByCustomerAt": now,
          },
        },
        {
          arrayFilters: [
            {
              "unread.author": { $in: ["agent", "assistant"] },
              "unread.readByCustomerAt": { $exists: false },
            },
          ],
        },
      );
      const refreshed = await Conversation.findById(
        conversation._id,
      ).lean<ConversationLean>();
      if (refreshed) toReturn = refreshed;
    }

    const allMessages = asArray<ConversationMessageAttributes>(
      toReturn.messages,
    );
    const slice = sliceChatMessages(allMessages, {
      beforeId,
      sinceMillis: since ? since.getTime() : null,
      limit: CHAT_MESSAGE_PAGE_SIZE,
    });
    const response = ok(
      toThread(toReturn, {
        messages: allMessages.slice(slice.start, slice.end),
        hasMoreOlder: slice.hasMoreOlder,
      }),
    );
    response.headers.set("ETag", etag);
    return response;
  });
}
