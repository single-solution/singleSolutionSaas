import { NextResponse } from "next/server";

export interface SecurityHeaderOptions {
  isProduction: boolean;
  /** When true, allow this response to be embedded in third-party frames (widget only). */
  allowFraming?: boolean;
}

export function buildSecurityHeaders(options: SecurityHeaderOptions): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "X-XSS-Protection": "0",
  };

  if (options.allowFraming) {
    headers["Content-Security-Policy"] = "frame-ancestors *";
  } else {
    headers["X-Frame-Options"] = "DENY";
    headers["Content-Security-Policy"] = "frame-ancestors 'none'";
  }

  if (options.isProduction) {
    headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  }

  return headers;
}

export function applySecurityHeaders(
  response: NextResponse,
  options: SecurityHeaderOptions,
): NextResponse {
  for (const [key, value] of Object.entries(buildSecurityHeaders(options))) {
    response.headers.set(key, value);
  }
  return response;
}
