/**
 * GET /admin/sso?code=...&siteId=...
 *
 * Entry point for the platform's admin deep-link. Exchanges the one-time SSO
 * code server-to-server, sets an httpOnly admin session cookie, and redirects
 * into the dashboard.
 */

import { NextResponse } from "next/server";

import { exchangePlatformSsoCode } from "@/lib/platform/client";
import { ADMIN_COOKIE_NAME, ADMIN_SESSION_MAX_AGE, mintAdminSessionToken } from "@/lib/admin/session";
import { loadEnvironment } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code") ?? "";
  const claims = await exchangePlatformSsoCode(code, loadEnvironment().productSlug);

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
    value: mintAdminSessionToken({
      userId: claims.userId,
      name: claims.name,
      productSlug: claims.productSlug,
      platformSessionVersion: claims.sessionVersion,
    }),
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ADMIN_SESSION_MAX_AGE,
  });
  return response;
}
