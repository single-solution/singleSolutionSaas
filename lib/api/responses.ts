import { NextResponse } from "next/server";

import { getRequestId } from "@/lib/logging/requestContext";

type ResponseOptions = {
  cache?: "no-store" | "public";
  varyCookie?: boolean;
  retryAfterSeconds?: number;
  requestId?: string;
};

function applyResponseHeaders(response: NextResponse, options: ResponseOptions = {}) {
  const cacheControl = options.cache === "public" ? "public, max-age=60" : "no-store";
  response.headers.set("Cache-Control", cacheControl);
  const requestId = options.requestId ?? getRequestId();
  if (requestId) {
    response.headers.set("X-Request-ID", requestId);
  }
  if (options.varyCookie) {
    response.headers.set("Vary", "Cookie");
  }
  if (options.retryAfterSeconds) {
    response.headers.set("Retry-After", String(options.retryAfterSeconds));
  }
  return response;
}

export function jsonOk<T>(data: T, status = 200, options: ResponseOptions = { cache: "no-store", varyCookie: true }) {
  return applyResponseHeaders(NextResponse.json(data, { status }), options);
}

export function jsonCreated<T>(data: T, options: ResponseOptions = { cache: "no-store", varyCookie: true }) {
  return applyResponseHeaders(NextResponse.json(data, { status: 201 }), options);
}

export function jsonError(
  message: string,
  status: number,
  options: ResponseOptions = { cache: "no-store" },
  code?: string,
) {
  const body = code ? { error: message, code } : { error: message };
  return applyResponseHeaders(NextResponse.json(body, { status }), options);
}

export function jsonUnauthorized() {
  return jsonError("Unauthorized", 401, { cache: "no-store", varyCookie: true });
}

export function jsonForbidden(message = "Forbidden") {
  return jsonError(message, 403, { cache: "no-store", varyCookie: true });
}

export function jsonTooManyRequests(retryAfterSeconds: number) {
  return jsonError("Too many requests", 429, { cache: "no-store", retryAfterSeconds });
}

export function jsonServiceUnavailable(
  message = "Service temporarily unavailable. Please try again shortly.",
  options: ResponseOptions = { cache: "no-store" },
) {
  return jsonError(message, 503, options);
}

export async function parseJsonBody<T>(request: Request): Promise<T | Response> {
  try {
    return (await request.json()) as T;
  } catch {
    return jsonError("Invalid JSON body", 400);
  }
}
