/**
 * Server-to-server calls to an isolated product's internal endpoints.
 */

import { randomUUID } from "node:crypto";

import { loadEnvironment } from "@/lib/env";
import { OutboundUrlError, safeFetch } from "@/lib/security/outboundUrl";
import type { ProductConversation, ProductConversationSummary } from "@/lib/types";
import { isProduction } from "@/lib/utils";

function createAgentClientMessageId(): string {
  return `agent:${randomUUID()}`;
}

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
  const normalized = normalizeBaseUrl(baseUrl);
  const url = `${normalized}${path}`;
  const { getRequestId } = await import("@/lib/logging/requestContext");
  const requestId = getRequestId();
  try {
    const { response, bodyText } = await safeFetch(url, {
      isProduction: isProduction(environment),
      allowLocalhost: true,
      method: init.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${environment.INTERNAL_API_SECRET}`,
        ...(requestId ? { "X-Request-ID": requestId } : {}),
        ...Object.fromEntries(
          Object.entries(init.headers ?? {}).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ),
      },
      body: typeof init.body === "string" ? init.body : undefined,
    });
    let body: { error?: string } = {};
    if (bodyText) {
      try {
        body = JSON.parse(bodyText) as { error?: string };
      } catch {
        body = {};
      }
    }
    if (!response.ok) {
      throw new ProductBridgeError(body.error ?? "Product request failed.", response.status);
    }
    return body as T;
  } catch (error) {
    if (error instanceof ProductBridgeError) {
      throw error;
    }
    if (error instanceof OutboundUrlError) {
      throw new ProductBridgeError(error.message, 400);
    }
    throw new ProductBridgeError("Product service is unreachable.", 502);
  }
}

export function fetchProductConversations(
  baseUrl: string,
  siteId: string,
  productSlug: string,
  query: { status?: string; page: number; pageSize: number },
): Promise<{ conversations: ProductConversationSummary[]; total: number; page: number; pageSize: number }> {
  const params = new URLSearchParams({
    siteId,
    productSlug,
    page: String(query.page),
    pageSize: String(query.pageSize),
  });
  if (query.status) {
    params.set("status", query.status);
  }
  return callProduct(baseUrl, `/api/internal/conversations?${params.toString()}`, { method: "GET" });
}

export function fetchProductConversation(
  baseUrl: string,
  siteId: string,
  productSlug: string,
  conversationId: string,
): Promise<ProductConversation> {
  const params = new URLSearchParams({ siteId, productSlug });
  return callProduct(
    baseUrl,
    `/api/internal/conversations/${encodeURIComponent(conversationId)}?${params.toString()}`,
    { method: "GET" },
  );
}

export function postProductConversationReply(
  baseUrl: string,
  siteId: string,
  productSlug: string,
  conversationId: string,
  body: string,
  agentName: string,
  clientMessageId: string = createAgentClientMessageId(),
): Promise<ProductConversation> {
  return callProduct(baseUrl, `/api/internal/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: "POST",
    body: JSON.stringify({ siteId, productSlug, body, agentName, clientMessageId }),
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
