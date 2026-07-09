import { timingSafeEqual } from "node:crypto";

import { jsonError } from "@/lib/api/responses";

/** Constant-time check of an `Authorization: Bearer <secret>` header. */
export function isValidInternalAuthorization(header: string | null, secret: string): boolean {
  if (!header) {
    return false;
  }
  const expected = `Bearer ${secret}`;
  const provided = Buffer.from(header);
  const target = Buffer.from(expected);
  if (provided.length !== target.length) {
    return false;
  }
  return timingSafeEqual(provided, target);
}

export function assertSameOrigin(request: Request): Response | null {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");

  if (origin) {
    const originHost = new URL(origin).host;
    if (originHost !== requestUrl.host) {
      return jsonError("Forbidden", 403);
    }
    return null;
  }

  if (referer) {
    const refererHost = new URL(referer).host;
    if (refererHost !== requestUrl.host) {
      return jsonError("Forbidden", 403);
    }
    return null;
  }

  if (!request.headers.get("x-requested-with")) {
    return jsonError("Forbidden", 403);
  }

  return null;
}

export function assertMutationHeaders(request: Request): Response | null {
  const sameOrigin = assertSameOrigin(request);
  if (sameOrigin) {
    return sameOrigin;
  }

  if (request.headers.get("x-requested-with") !== "XMLHttpRequest") {
    return jsonError("Forbidden", 403);
  }

  return null;
}
