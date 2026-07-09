/**
 * GET /api/admin/data?siteId=&resource=visitors|conversations|messages&page=
 *
 * Read-only raw data browser for the admin dashboard.
 */

import { requireAdminApi, requireSiteId } from "@/lib/admin/guard";
import { badRequest, ok } from "@/lib/api/responses";
import { connectDb } from "@/lib/db/connection";
import { Conversation, type ConversationAttributes } from "@/lib/db/models/Conversation";
import type { ConversationLean } from "@/lib/chat/serializer";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;
const RESOURCES = ["visitors", "conversations", "messages"] as const;
type Resource = (typeof RESOURCES)[number];

export async function GET(request: Request) {
  const identity = requireAdminApi(request);
  if (identity instanceof Response) return identity;
  const siteId = requireSiteId(request);
  if (!siteId) {
    return badRequest("siteId is required.");
  }

  const url = new URL(request.url);
  const resourceParam = url.searchParams.get("resource") ?? "conversations";
  if (!RESOURCES.includes(resourceParam as Resource)) {
    return badRequest("Unknown resource.");
  }
  const resource = resourceParam as Resource;
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);

  await connectDb();

  if (resource === "visitors") {
    const rows = await Conversation.aggregate<{ _id: string; conversations: number; lastActivity: Date }>([
      { $match: { siteId } },
      { $group: { _id: "$visitorId", conversations: { $sum: 1 }, lastActivity: { $max: "$lastMessageAt" } } },
      { $sort: { lastActivity: -1 } },
      { $skip: (page - 1) * PAGE_SIZE },
      { $limit: PAGE_SIZE },
    ]);
    return ok({
      resource,
      page,
      rows: rows.map((row) => ({
        visitorId: row._id,
        conversations: row.conversations,
        lastActivity: row.lastActivity?.toISOString() ?? null,
      })),
    });
  }

  if (resource === "messages") {
    const docs = await Conversation.find({ siteId })
      .select({ visitorId: 1, messages: 1 })
      .sort({ lastMessageAt: -1 })
      .limit(60)
      .lean<ConversationLean[]>();
    const flattened = docs
      .flatMap((doc) =>
        (doc.messages ?? []).map((message) => ({
          conversationId: doc._id.toString(),
          visitorId: doc.visitorId,
          author: message.author,
          authorName: message.authorName ?? "",
          body: message.body,
          createdAt: new Date(message.createdAt).toISOString(),
        })),
      )
      .sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1));
    const start = (page - 1) * PAGE_SIZE;
    return ok({ resource, page, rows: flattened.slice(start, start + PAGE_SIZE), total: flattened.length });
  }

  const [docs, total] = await Promise.all([
    Conversation.find({ siteId })
      .sort({ lastMessageAt: -1 })
      .skip((page - 1) * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .lean<ConversationLean[]>(),
    Conversation.countDocuments({ siteId }),
  ]);
  return ok({
    resource,
    page,
    total,
    rows: docs.map((doc: ConversationAttributes & { _id: unknown }) => ({
      id: String(doc._id),
      visitorId: doc.visitorId,
      customerName: doc.customerName,
      status: doc.status,
      messages: doc.messages?.length ?? 0,
      unreadByTeam: doc.unreadByTeam,
      lastMessageAt: new Date(doc.lastMessageAt).toISOString(),
    })),
  });
}
