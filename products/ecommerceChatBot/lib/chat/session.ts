"use client";

/**
 * Anonymous visitor session. The widget bootstraps a signed embed session from
 * the publishable product token and browser origin. The bearer session authorizes
 * widget APIs; a raw visitor id alone is never accepted as authority.
 */

const STORAGE_PREFIX = "ecommerce-chatbot:embed-session:";

let activeProductToken = "";
let activeSessionToken = "";
let activeVisitorId = "";
let bootstrapPromise: Promise<void> | null = null;

async function bootstrapEmbedSession(productToken: string): Promise<void> {
  const storageKey = `${STORAGE_PREFIX}${productToken}`;
  let cachedToken = "";
  try {
    cachedToken = window.sessionStorage.getItem(storageKey) ?? "";
  } catch {
    cachedToken = "";
  }

  const response = await fetch("/api/embed/sessions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cachedToken ? { Authorization: `Bearer ${cachedToken}` } : {}),
    },
    body: JSON.stringify({ productToken }),
  });

  if (!response.ok) {
    let message = "Could not start chat session.";
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) {
        message = body.error;
      }
    } catch {
      // ignore
    }
    throw new Error(message);
  }

  const data = (await response.json()) as {
    sessionToken: string;
    visitorId: string;
  };
  activeSessionToken = data.sessionToken;
  activeVisitorId = data.visitorId;
  try {
    window.sessionStorage.setItem(storageKey, activeSessionToken);
  } catch {
    // sessionStorage blocked in some iframe contexts
  }
}

export function initChatSession(productToken: string): Promise<void> {
  if (activeProductToken === productToken && activeSessionToken) {
    return Promise.resolve();
  }
  activeProductToken = productToken;
  if (!bootstrapPromise) {
    bootstrapPromise = bootstrapEmbedSession(productToken)
      .catch((error) => {
        activeSessionToken = "";
        activeVisitorId = "";
        throw error;
      })
      .finally(() => {
        bootstrapPromise = null;
      });
  }
  return bootstrapPromise;
}

export function getChatSessionHeaders(): Record<string, string> {
  if (!activeSessionToken) {
    return {};
  }
  return {
    Authorization: `Bearer ${activeSessionToken}`,
  };
}

export function getVisitorId(): string {
  return activeVisitorId;
}
