/**
 * GET /admin/sso?token=...&siteId=...
 *
 * Entry point for the platform's admin deep-link. Verifies the short-lived SSO
 * token, sets an httpOnly admin session cookie, and redirects into the dashboard.
 */

import { NextResponse } from "next/server";

import { ADMIN_COOKIE_NAME, ADMIN_SESSION_MAX_AGE, mintAdminSessionToken, verifySsoToken } from "@/lib/admin/session";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? "";
  const claims = verifySsoToken(token);

  if (!claims) {
    return NextResponse.redirect(new URL("/admin?error=sso", url.origin));
  }

  const target = new URL("/admin", url.origin);
  const siteId = claims.siteId ?? url.searchParams.get("siteId");
  if (siteId) {
    target.searchParams.set("siteId", siteId);
  }

  const response = NextResponse.redirect(target);
  response.cookies.set({
    name: ADMIN_COOKIE_NAME,
    value: mintAdminSessionToken({ userId: claims.userId, name: claims.name, productSlug: claims.productSlug }),
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ADMIN_SESSION_MAX_AGE,
  });
  return response;
}
