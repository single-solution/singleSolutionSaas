/**
 * POST /api/chat/[id]/read-receipts
 *
 * Marks unread agent/assistant messages as read by the visitor.
 */

import { connectDb, Types } from "@/lib/db/connection";
import { Conversation } from "@/lib/db/models/Conversation";
import { resolveChatCaller } from "@/lib/api/productAuth";
import { preflight, withCors } from "@/lib/api/cors";
import { noContent, notFound } from "@/lib/api/responses";
import type { ConversationLean } from "@/lib/chat/serializer";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export function OPTIONS(request: Request) {
  return preflight(request);
}

export async function POST(request: Request, { params }: RouteContext) {
  return withCors(request, async () => {
    const caller = await resolveChatCaller(request);
    if (caller instanceof Response) return caller;

    const { id } = await params;
    if (!Types.ObjectId.isValid(id)) {
      return notFound("Conversation not found.");
    }

    await connectDb();
    const conversation = await Conversation.findOne({
      _id: new Types.ObjectId(id),
      siteId: caller.entitlement.siteId,
      visitorId: caller.visitorId,
    }).lean<ConversationLean>();
    if (!conversation) {
      return notFound("Conversation not found.");
    }

    if (conversation.unreadByCustomer > 0) {
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
    }
    return noContent();
  });
}
