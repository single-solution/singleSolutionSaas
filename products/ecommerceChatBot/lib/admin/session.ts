/**
 * Admin dashboard session. The platform deep-links here with a one-time SSO code;
 * the product exchanges it server-to-server, then sets a short-lived httpOnly
 * admin cookie that guards every `/admin` surface.
 */

import { cookies } from "next/headers";

import { loadEnvironment } from "@/lib/env";
import { signJwt, verifyJwt } from "./jwt";

export const ADMIN_COOKIE_NAME = "chatbot_admin_session";
const ADMIN_SESSION_TTL_SECONDS = 30 * 60;

export interface AdminIdentity {
  userId: string;
  name: string;
  productSlug: string;
  platformSessionVersion: number;
}

export interface SsoClaims extends AdminIdentity {
  siteId: string | null;
}

export function mintAdminSessionToken(identity: AdminIdentity): string {
  return signJwt(
    {
      sub: identity.userId,
      name: identity.name,
      productSlug: identity.productSlug,
      platformSessionVersion: identity.platformSessionVersion,
      scope: "admin-session",
    },
    loadEnvironment().ssoSigningSecret,
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
  const match = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${ADMIN_COOKIE_NAME}=`));
  if (!match) {
    return null;
  }
  return parseSession(decodeURIComponent(match.slice(ADMIN_COOKIE_NAME.length + 1)));
}

/** Read + verify the admin cookie from server components (layout guard). */
export async function readAdminSession(): Promise<AdminIdentity | null> {
  const token = (await cookies()).get(ADMIN_COOKIE_NAME)?.value;
  return token ? parseSession(token) : null;
}

function parseSession(token: string): AdminIdentity | null {
  const claims = verifyJwt(token, loadEnvironment().ssoSigningSecret);
  if (!claims || claims.scope !== "admin-session") {
    return null;
  }
  const userId = typeof claims.sub === "string" ? claims.sub : "";
  const productSlug = typeof claims.productSlug === "string" ? claims.productSlug : "";
  const platformSessionVersion =
    typeof claims.platformSessionVersion === "number" ? claims.platformSessionVersion : -1;
  if (!userId || !productSlug || platformSessionVersion < 0) {
    return null;
  }
  return {
    userId,
    name: typeof claims.name === "string" ? claims.name : "Administrator",
    productSlug,
    platformSessionVersion,
  };
}
