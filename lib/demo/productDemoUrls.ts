/**
 * Signed-in portal surfaces can import these helpers to open product demos
 * without duplicating route strings or overlapping portal product pages.
 */

import { resolveChatbotPublicDemoUrl } from "./chatbotPublicDemoUrl";

export function chatbotPublicDemoUrl(): string | null {
  return resolveChatbotPublicDemoUrl();
}

export function chatbotTokenDemoUrl(
  productBaseUrl: string,
  token: string,
): string {
  const trimmed = productBaseUrl.trim().replace(/\/$/, "");
  return `${trimmed}/demo?token=${encodeURIComponent(token.trim())}`;
}
