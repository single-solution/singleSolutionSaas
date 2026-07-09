/**
 * Guards the product's internal endpoints. Only the platform (which holds the
 * shared secret) may call these to read conversations and post agent replies on
 * a merchant's behalf.
 */

import { timingSafeEqual } from "node:crypto";

import { loadEnvironment } from "@/lib/env";
import { unauthorized } from "./responses";

function secretMatches(header: string | null, secret: string): boolean {
  if (!header) {
    return false;
  }
  const provided = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${secret}`);
  if (provided.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(provided, expected);
}

export function requireInternalAuth(request: Request): Response | null {
  const { internalApiSecret } = loadEnvironment();
  if (!secretMatches(request.headers.get("authorization"), internalApiSecret)) {
    return unauthorized();
  }
  return null;
}
