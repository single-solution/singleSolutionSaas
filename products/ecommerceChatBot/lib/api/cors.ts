/**
 * CORS for the embeddable widget. The widget runs on the merchant's origin and
 * calls this product cross-origin, so responses must carry CORS headers.
 *
 * Reflecting the requesting origin here is safe: no cookies/credentials are used
 * (the token travels in a header), and the real security boundary is the
 * per-token domain allowlist enforced in the handler (see `origin.ts`). A
 * disallowed origin still gets a 403 from the handler.
 */

const ALLOW_METHODS = "GET, POST, OPTIONS";
const ALLOW_HEADERS = "content-type, x-product-token, x-visitor-id, if-none-match";

export function requestOrigin(request: Request): string | null {
  const origin = request.headers.get("origin");
  return origin && origin !== "null" ? origin : null;
}

function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin) {
    return {};
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": ALLOW_METHODS,
    "Access-Control-Allow-Headers": ALLOW_HEADERS,
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

/** Preflight response. Not a security boundary — the actual request is enforced. */
export function preflight(request: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(requestOrigin(request)) });
}

/** Runs a widget handler and stamps CORS headers on whatever it returns. */
export async function withCors(request: Request, run: () => Promise<Response>): Promise<Response> {
  const origin = requestOrigin(request);
  const response = await run();
  for (const [key, value] of Object.entries(corsHeaders(origin))) {
    response.headers.set(key, value);
  }
  return response;
}
