"use client";

/**
 * Anonymous visitor session. The widget is embedded with a merchant product
 * token; each browser also gets a stable random `visitorId` (persisted in
 * localStorage, scoped by token) so a visitor keeps the same conversation
 * across reloads without any login. Both travel as request headers to the
 * product API, which resolves the merchant from the token and checks visitor
 * ownership from the id.
 */

const STORAGE_PREFIX = "ecommerce-chatbot:visitor:";

let activeToken = "";
let activeVisitorId = "";

function randomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function initChatSession(token: string): void {
  activeToken = token;
  const storageKey = `${STORAGE_PREFIX}${token}`;
  let visitorId = "";
  try {
    visitorId = window.localStorage.getItem(storageKey) ?? "";
    if (!visitorId) {
      visitorId = randomId();
      window.localStorage.setItem(storageKey, visitorId);
    }
  } catch {
    // localStorage blocked (private mode / third-party) — fall back to an
    // in-memory id for this session only.
    visitorId = visitorId || randomId();
  }
  activeVisitorId = visitorId;
}

export function getChatSessionHeaders(): Record<string, string> {
  return {
    "x-product-token": activeToken,
    "x-visitor-id": activeVisitorId,
  };
}
