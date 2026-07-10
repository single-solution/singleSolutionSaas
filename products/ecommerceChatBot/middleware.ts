import { NextResponse, type NextRequest } from "next/server";

import { applySecurityHeaders } from "@/lib/security/headers";

export async function middleware(request: NextRequest) {
  const isProduction = process.env.NODE_ENV === "production";
  const { pathname } = request.nextUrl;
  const allowFraming = pathname === "/embed" || pathname.startsWith("/embed/");

  return applySecurityHeaders(NextResponse.next(), {
    isProduction,
    allowFraming,
  });
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|embed.js|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
