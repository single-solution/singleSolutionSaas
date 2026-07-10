/**
 * Public sandbox demo configuration. The publishable product access token may be
 * injected into demo pages server-side; privileged secrets stay in server env only.
 */

export type PublicDemoAvailability = "ready" | "unconfigured";

export interface PublicDemoConfig {
  /** Publishable widget token for the restricted demo tenant. */
  productToken: string | null;
  availability: PublicDemoAvailability;
}

let cached: PublicDemoConfig | null = null;

function readConfiguredToken(): string | null {
  const serverToken = process.env.PUBLIC_DEMO_PRODUCT_TOKEN?.trim();
  if (serverToken) {
    return serverToken;
  }
  const legacyToken = process.env.NEXT_PUBLIC_DEMO_PRODUCT_TOKEN?.trim();
  return legacyToken || null;
}

export function loadPublicDemoConfig(): PublicDemoConfig {
  if (cached) {
    return cached;
  }
  const productToken = readConfiguredToken();
  cached = {
    productToken,
    availability: productToken ? "ready" : "unconfigured",
  };
  return cached;
}

export function buildPublicDemoPath(): string {
  return "/public-demo";
}

export function buildTokenDemoPath(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) {
    return "/demo";
  }
  return `/demo?token=${encodeURIComponent(trimmed)}`;
}
