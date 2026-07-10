/** GET /api/admin/conversations?siteId=&status=&search=&page= - moderation list. */

import { requireAdminApi, requireSiteId, resolveAdminDataDb } from "@/lib/admin/guard";
import { badRequest, ok } from "@/lib/api/responses";
import { getTenantModels } from "@/lib/db/tenant";
import { CONVERSATION_STATUSES, type ConversationStatus } from "@/lib/db/models/Conversation";
import { summariseThread, type ConversationLean } from "@/lib/chat/serializer";
import { CONVERSATION_SUMMARY_SELECT } from "@/lib/chat/messageStorage";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

export async function GET(request: Request) {
  const identity = requireAdminApi(request);
  if (identity instanceof Response) return identity;
  const siteId = requireSiteId(request);
  if (!siteId) {
    return badRequest("siteId is required.");
  }

  const url = new URL(request.url);
  const statusParam = url.searchParams.get("status");
  const status =
    statusParam && CONVERSATION_STATUSES.includes(statusParam as ConversationStatus) ? (statusParam as ConversationStatus) : null;
  const search = url.searchParams.get("search")?.trim() ?? "";
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);

  const dataDbName = await resolveAdminDataDb(identity, siteId);
  if (!dataDbName) {
    return badRequest("Unknown site.");
  }
  const { Conversation } = await getTenantModels(dataDbName);
  const filter: Record<string, unknown> = { siteId, ...(status ? { status } : {}) };
  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [
      { customerName: { $regex: escaped, $options: "i" } },
      { lastMessagePreview: { $regex: escaped, $options: "i" } },
      { visitorId: { $regex: escaped, $options: "i" } },
    ];
  }

  const [docs, total] = await Promise.all([
    Conversation.find(filter)
      .select(CONVERSATION_SUMMARY_SELECT)
      .sort({ lastMessageAt: -1 })
      .skip((page - 1) * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .lean<ConversationLean[]>(),
    Conversation.countDocuments(filter),
  ]);

  return ok({ conversations: docs.map(summariseThread), total, page, pageSize: PAGE_SIZE });
}
