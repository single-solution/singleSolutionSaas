/**
 * Guest entry URL for the ecommerce chatbot public demo sandbox.
 */

const DEFAULT_CHATBOT_ORIGIN = "http://localhost:3002";

export function resolveChatbotPublicDemoUrl(): string | null {
  const configured =
    process.env.ECOMMERCE_CHATBOT_PUBLIC_URL?.trim() ||
    process.env.DEMO_PRODUCT_BASE_URL?.trim() ||
    (process.env.NODE_ENV === "development" ? DEFAULT_CHATBOT_ORIGIN : "");
  if (!configured) {
    return null;
  }
  const base = configured.replace(/\/$/, "");
  return `${base}/public-demo`;
}
