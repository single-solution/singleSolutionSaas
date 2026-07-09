/** GET /api/admin/overview?siteId=... - conversation analytics for a site. */

import { requireAdminApi, requireSiteId } from "@/lib/admin/guard";
import { badRequest, ok } from "@/lib/api/responses";
import { connectDb } from "@/lib/db/connection";
import { Conversation, type ConversationAttributes } from "@/lib/db/models/Conversation";
import type { ConversationLean } from "@/lib/chat/serializer";

export const dynamic = "force-dynamic";

const VOLUME_DAYS = 14;

export async function GET(request: Request) {
  const identity = requireAdminApi(request);
  if (identity instanceof Response) return identity;
  const siteId = requireSiteId(request);
  if (!siteId) {
    return badRequest("siteId is required.");
  }

  await connectDb();
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - (VOLUME_DAYS - 1));
  since.setUTCHours(0, 0, 0, 0);

  const [byStatus, recent] = await Promise.all([
    Conversation.aggregate<{ _id: string; count: number }>([
      { $match: { siteId } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    Conversation.find({ siteId, createdAt: { $gte: since } })
      .select({ createdAt: 1, messages: 1 })
      .lean<ConversationLean[]>(),
  ]);

  const statusCounts: Record<string, number> = { open: 0, "awaiting-customer": 0, resolved: 0 };
  let total = 0;
  for (const row of byStatus) {
    statusCounts[row._id] = row.count;
    total += row.count;
  }

  // Volume per day + average first-response time (customer -> first agent/assistant).
  const volume = new Map<string, number>();
  for (let dayOffset = 0; dayOffset < VOLUME_DAYS; dayOffset += 1) {
    const day = new Date(since);
    day.setUTCDate(since.getUTCDate() + dayOffset);
    volume.set(day.toISOString().slice(0, 10), 0);
  }

  let responseSamples = 0;
  let responseTotalMs = 0;
  for (const conversation of recent) {
    const key = new Date(conversation.createdAt ?? conversation.lastMessageAt).toISOString().slice(0, 10);
    if (volume.has(key)) {
      volume.set(key, (volume.get(key) ?? 0) + 1);
    }
    const firstResponse = computeFirstResponseMs(conversation);
    if (firstResponse !== null) {
      responseSamples += 1;
      responseTotalMs += firstResponse;
    }
  }

  return ok({
    totals: { total, ...statusCounts },
    volume: [...volume.entries()].map(([date, count]) => ({ date, count })),
    avgFirstResponseMs: responseSamples > 0 ? Math.round(responseTotalMs / responseSamples) : null,
    windowDays: VOLUME_DAYS,
  });
}

function computeFirstResponseMs(conversation: Pick<ConversationAttributes, "messages">): number | null {
  const messages = conversation.messages ?? [];
  const firstCustomer = messages.find((message) => message.author === "customer");
  if (!firstCustomer) {
    return null;
  }
  const firstReply = messages.find(
    (message) =>
      (message.author === "agent" || message.author === "assistant") &&
      new Date(message.createdAt).getTime() >= new Date(firstCustomer.createdAt).getTime(),
  );
  if (!firstReply) {
    return null;
  }
  return new Date(firstReply.createdAt).getTime() - new Date(firstCustomer.createdAt).getTime();
}
