/** Thread polling utilities (304 / If-None-Match). */

import { toIsoDate, toMillis } from "./wireCoercion";

export function threadPollEtag(lastMessageAt: unknown): string {
  return `"${toIsoDate(lastMessageAt)}"`;
}

export function parsePollSince(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function isThreadUnchangedForPoll(args: { lastMessageAt: unknown; updatedAt: unknown; since: Date | null; ifNoneMatch: string | null }): boolean {
  const etag = threadPollEtag(args.lastMessageAt);
  if (args.ifNoneMatch && args.ifNoneMatch === etag) {
    return true;
  }
  if (args.since) {
    const sinceMillis = args.since.getTime();
    return toMillis(args.lastMessageAt) <= sinceMillis && toMillis(args.updatedAt) <= sinceMillis;
  }
  return false;
}
