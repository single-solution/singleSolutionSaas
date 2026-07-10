import { createHash } from "node:crypto";

export function hashCacheSegment(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}
