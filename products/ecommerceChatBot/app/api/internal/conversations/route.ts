/**
 * GET /api/internal/conversations?siteId=...&status=...&page=...&pageSize=...
 *
 * Platform-only: lists a site's conversations for the agent inbox.
 */

import { connectDb } from "@/lib/db/connection";
import { Conversation, CONVERSATION_STATUSES, type ConversationStatus } from "@/lib/db/models/Conversation";
import { requireInternalAuth } from "@/lib/api/internalAuth";
import { badRequest, ok } from "@/lib/api/responses";
import { summariseThread, type ConversationLean } from "@/lib/chat/serializer";

export const dynamic = "force-dynamic";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

export async function GET(request: Request) {
  const unauthorizedResponse = requireInternalAuth(request);
  if (unauthorizedResponse) return unauthorizedResponse;

  const url = new URL(request.url);
  const siteId = url.searchParams.get("siteId")?.trim();
  if (!siteId) {
    return badRequest("siteId is required.");
  }

  const statusParam = url.searchParams.get("status");
  const status = statusParam && CONVERSATION_STATUSES.includes(statusParam as ConversationStatus) ? (statusParam as ConversationStatus) : null;
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(url.searchParams.get("pageSize")) || DEFAULT_PAGE_SIZE));

  await connectDb();
  const filter = { siteId, ...(status ? { status } : {}) };
  const [docs, total] = await Promise.all([
    Conversation.find(filter)
      .sort({ lastMessageAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean<ConversationLean[]>(),
    Conversation.countDocuments(filter),
  ]);

  return ok({ conversations: docs.map(summariseThread), total, page, pageSize });
}
