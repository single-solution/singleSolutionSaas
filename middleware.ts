import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE_NAME } from "@/lib/constants";
import { verifySessionTokenEdge } from "@/lib/session";

function applySecurityHeaders(response: NextResponse, isProduction: boolean) {
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.headers.set("X-XSS-Protection", "0");
  if (isProduction) {
    response.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  return response;
}

async function readSession(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!token) {
    return null;
  }
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    return null;
  }
  return verifySessionTokenEdge(token, secret);
}

export async function middleware(request: NextRequest) {
  const isProduction = process.env.NODE_ENV === "production";
  const { pathname } = request.nextUrl;

  if (pathname === "/login") {
    const session = await readSession(request);
    if (session) {
      return applySecurityHeaders(NextResponse.redirect(new URL("/", request.url)), isProduction);
    }
  }

  return applySecurityHeaders(NextResponse.next(), isProduction);
}

export const config = {
  matcher: ["/login"],
};
