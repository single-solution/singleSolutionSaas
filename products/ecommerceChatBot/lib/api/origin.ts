/**
 * Embed-origin allowlist. The product token is a publishable key that lives in
 * the merchant's page HTML, so it can be copied. Binding each token to a set of
 * allowed domains is what actually stops a stolen token from being used on
 * another site to burn the merchant's quota. Enforced on every widget request.
 */

/** The host that issued the request, preferring Origin, falling back to Referer. */
export function resolveRequestHost(request: Request): string | null {
  const origin = request.headers.get("origin");
  const candidate = origin && origin !== "null" ? origin : request.headers.get("referer");
  if (!candidate) {
    return null;
  }
  try {
    return new URL(candidate).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function matchDomain(host: string, pattern: string): boolean {
  if (!pattern) {
    return false;
  }
  if (pattern.startsWith("*.")) {
    const base = pattern.slice(2);
    return host === base || host.endsWith(`.${base}`);
  }
  return host === pattern;
}

/**
 * Block-all by default: a token with no configured domains is rejected, and a
 * request with no resolvable host is rejected.
 */
export function isHostAllowed(host: string | null, allowedDomains: string[]): boolean {
  if (!host || allowedDomains.length === 0) {
    return false;
  }
  return allowedDomains.some((pattern) => matchDomain(host, pattern.trim().toLowerCase()));
}
