/**
 * Calls an isolated product's internal endpoints on a merchant's behalf. The
 * platform never touches the product's database directly — it reaches the
 * product over HTTP using the shared internal secret, keeping the product fully
 * isolated. Used by the agent inbox to read conversations and post replies.
 */

import { loadEnvironment } from "@/lib/env";
import type { ProductConversation, ProductConversationSummary } from "@/lib/types";

export class ProductBridgeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ProductBridgeError";
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/$/, "");
}

async function callProduct<T>(baseUrl: string, path: string, init: RequestInit): Promise<T> {
  const environment = loadEnvironment();
  const url = `${normalizeBaseUrl(baseUrl)}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${environment.INTERNAL_API_SECRET}`,
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new ProductBridgeError("Product service is unreachable.", 502);
  }
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new ProductBridgeError(body.error ?? "Product request failed.", response.status);
  }
  return body as T;
}

export function fetchProductConversations(
  baseUrl: string,
  siteId: string,
  query: { status?: string; page: number; pageSize: number },
): Promise<{ conversations: ProductConversationSummary[]; total: number; page: number; pageSize: number }> {
  const params = new URLSearchParams({ siteId, page: String(query.page), pageSize: String(query.pageSize) });
  if (query.status) {
    params.set("status", query.status);
  }
  return callProduct(baseUrl, `/api/internal/conversations?${params.toString()}`, { method: "GET" });
}

export function fetchProductConversation(baseUrl: string, siteId: string, conversationId: string): Promise<ProductConversation> {
  const params = new URLSearchParams({ siteId });
  return callProduct(baseUrl, `/api/internal/conversations/${encodeURIComponent(conversationId)}?${params.toString()}`, { method: "GET" });
}

export function postProductConversationReply(
  baseUrl: string,
  siteId: string,
  conversationId: string,
  body: string,
  agentName: string,
): Promise<ProductConversation> {
  return callProduct(baseUrl, `/api/internal/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: "POST",
    body: JSON.stringify({ siteId, body, agentName }),
  });
}

/** Pull the product's self-declared configuration schema and test actions. */
export function fetchProductSchema(baseUrl: string): Promise<{ configSchema?: unknown; testActions?: unknown }> {
  return callProduct(baseUrl, `/api/internal/config-schema`, { method: "GET" });
}

/** Run a product's declared test action as a dry-run against draft config. */
export function postProductTest(
  baseUrl: string,
  input: { action: string; input: string; config: Record<string, unknown> },
): Promise<{ result: unknown }> {
  return callProduct(baseUrl, `/api/internal/test`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}
