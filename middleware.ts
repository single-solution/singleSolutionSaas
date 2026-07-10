import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE_NAME } from "@/lib/constants";
import { applySecurityHeaders } from "@/lib/security/headers";
import { verifySessionTokenEdge } from "@/lib/session";

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
      return applySecurityHeaders(
        NextResponse.redirect(new URL("/", request.url)),
        { isProduction },
      );
    }
  }

  return applySecurityHeaders(NextResponse.next(), { isProduction });
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
