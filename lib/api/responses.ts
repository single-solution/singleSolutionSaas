import { NextResponse } from "next/server";

type ResponseOptions = {
  cache?: "no-store" | "public";
  varyCookie?: boolean;
  retryAfterSeconds?: number;
};

function applyResponseHeaders(response: NextResponse, options: ResponseOptions = {}) {
  const cacheControl = options.cache === "public" ? "public, max-age=60" : "no-store";
  response.headers.set("Cache-Control", cacheControl);
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

export function jsonError(message: string, status: number, options: ResponseOptions = { cache: "no-store" }) {
  return applyResponseHeaders(NextResponse.json({ error: message }, { status }), options);
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

export async function parseJsonBody<T>(request: Request): Promise<T | Response> {
  try {
    return (await request.json()) as T;
  } catch {
    return jsonError("Invalid JSON body", 400);
  }
}
