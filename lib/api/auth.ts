import { cookies } from "next/headers";

import { jsonForbidden, jsonUnauthorized } from "@/lib/api/responses";
import { SESSION_COOKIE_NAME } from "@/lib/constants";
import { ensurePlatformReady } from "@/lib/db/ready";
import { User } from "@/lib/db";
import { loadEnvironment } from "@/lib/env";
import { createSessionToken, SESSION_COOKIE_OPTIONS, verifySessionToken } from "@/lib/session";
import type { MerchantMemberRole, UserSummary } from "@/lib/types";
import { getMembershipRole, type RequestActor } from "@/lib/services/platform.service";
import { isProduction } from "@/lib/utils";

export interface RequestAuth {
  actor: RequestActor;
  user: UserSummary;
  merchantRole?: MerchantMemberRole;
}

function mapUser(user: {
  _id: { toString(): string };
  email: string;
  name: string;
  isPlatformAdmin: boolean;
}): UserSummary {
  return {
    id: user._id.toString(),
    email: user.email,
    name: user.name,
    isPlatformAdmin: user.isPlatformAdmin,
  };
}

export async function getRequestAuth(): Promise<RequestAuth | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) {
    return null;
  }

  await ensurePlatformReady();

  const environment = loadEnvironment();
  const payload = await verifySessionToken(environment, token);
  if (!payload) {
    return null;
  }

  const user = await User.findById(payload.userId);
  if (!user) {
    return null;
  }

  if (user.sessionVersion !== payload.sessionVersion) {
    return null;
  }

  if (user.isPlatformAdmin !== payload.isPlatformAdmin) {
    return null;
  }

  return {
    actor: { userId: user._id.toString(), isPlatformAdmin: user.isPlatformAdmin },
    user: mapUser(user),
  };
}

export async function setSessionCookie(user: UserSummary): Promise<void> {
  const environment = loadEnvironment();
  const userDocument = await User.findById(user.id);
  if (!userDocument) {
    return;
  }

  const token = await createSessionToken(environment, {
    userId: user.id,
    sessionVersion: userDocument.sessionVersion,
    isPlatformAdmin: user.isPlatformAdmin,
  });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, token, {
    ...SESSION_COOKIE_OPTIONS,
    secure: isProduction(environment),
  });
}

export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE_NAME);
}

export async function requireMerchantRole(
  auth: RequestAuth,
  merchantId: string,
  allowedRoles: MerchantMemberRole[],
): Promise<RequestAuth | Response> {
  if (auth.actor.isPlatformAdmin) {
    return auth;
  }

  const role = await getMembershipRole(merchantId, auth.actor.userId);
  if (!role || !allowedRoles.includes(role)) {
    return jsonForbidden();
  }

  return { ...auth, merchantRole: role };
}
