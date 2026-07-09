/**
 * Admin dashboard session. The platform deep-links here with a short-lived SSO
 * token (scope `admin-dashboard`); we exchange it for a longer-lived httpOnly
 * cookie (scope `admin-session`) that guards every `/admin` surface. Both are
 * HS256 signed with the shared `INTERNAL_API_SECRET`.
 */

import { cookies } from "next/headers";

import { loadEnvironment } from "@/lib/env";
import { signJwt, verifyJwt } from "./jwt";

export const ADMIN_COOKIE_NAME = "chatbot_admin_session";
const ADMIN_SESSION_TTL_SECONDS = 8 * 60 * 60;

export interface AdminIdentity {
  userId: string;
  name: string;
  productSlug: string;
}

export interface SsoClaims extends AdminIdentity {
  siteId: string | null;
}

/** Verify the platform-issued deep-link token. Returns null when invalid. */
export function verifySsoToken(token: string): SsoClaims | null {
  const claims = verifyJwt(token, loadEnvironment().internalApiSecret);
  if (!claims || claims.scope !== "admin-dashboard") {
    return null;
  }
  const userId = typeof claims.sub === "string" ? claims.sub : "";
  const productSlug = typeof claims.productSlug === "string" ? claims.productSlug : "";
  if (!userId || !productSlug) {
    return null;
  }
  return {
    userId,
    name: typeof claims.name === "string" ? claims.name : "Administrator",
    productSlug,
    siteId: typeof claims.siteId === "string" ? claims.siteId : null,
  };
}

export function mintAdminSessionToken(identity: AdminIdentity): string {
  return signJwt(
    { sub: identity.userId, name: identity.name, productSlug: identity.productSlug, scope: "admin-session" },
    loadEnvironment().internalApiSecret,
    ADMIN_SESSION_TTL_SECONDS,
  );
}

export const ADMIN_SESSION_MAX_AGE = ADMIN_SESSION_TTL_SECONDS;

/** Read + verify the admin cookie from a Request (API routes). */
export function readAdminSessionFromRequest(request: Request): AdminIdentity | null {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) {
    return null;
  }
  const match = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${ADMIN_COOKIE_NAME}=`));
  if (!match) {
    return null;
  }
  return parseSession(decodeURIComponent(match.slice(ADMIN_COOKIE_NAME.length + 1)));
}

/** Read + verify the admin cookie from server components (layout guard). */
export function readAdminSession(): AdminIdentity | null {
  const token = cookies().get(ADMIN_COOKIE_NAME)?.value;
  return token ? parseSession(token) : null;
}

function parseSession(token: string): AdminIdentity | null {
  const claims = verifyJwt(token, loadEnvironment().internalApiSecret);
  if (!claims || claims.scope !== "admin-session") {
    return null;
  }
  const userId = typeof claims.sub === "string" ? claims.sub : "admin";
  const productSlug = typeof claims.productSlug === "string" ? claims.productSlug : "";
  return {
    userId,
    name: typeof claims.name === "string" ? claims.name : "Administrator",
    productSlug,
  };
}
