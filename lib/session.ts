import { SignJWT, jwtVerify } from "jose";

import type { Environment } from "@/lib/env";

export interface SessionPayload {
  userId: string;
  sessionVersion: number;
  isPlatformAdmin: boolean;
}

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

function getSecret(environment: Environment) {
  return new TextEncoder().encode(environment.JWT_SECRET);
}

export async function createSessionToken(environment: Environment, payload: SessionPayload): Promise<string> {
  return new SignJWT({
    userId: payload.userId,
    sessionVersion: payload.sessionVersion,
    isPlatformAdmin: payload.isPlatformAdmin,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(getSecret(environment));
}

export async function verifySessionToken(environment: Environment, token: string): Promise<SessionPayload | null> {
  try {
    const verified = await jwtVerify(token, getSecret(environment));
    const userId = verified.payload.userId;
    const sessionVersion = verified.payload.sessionVersion;
    const isPlatformAdmin = verified.payload.isPlatformAdmin;
    if (typeof userId !== "string") {
      return null;
    }
    if (typeof sessionVersion !== "number") {
      return null;
    }
    if (typeof isPlatformAdmin !== "boolean") {
      return null;
    }
    return { userId, sessionVersion, isPlatformAdmin };
  } catch {
    return null;
  }
}

export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: SESSION_MAX_AGE_SECONDS,
};

export async function verifySessionTokenEdge(token: string, secret: string): Promise<SessionPayload | null> {
  try {
    const verified = await jwtVerify(token, new TextEncoder().encode(secret));
    const userId = verified.payload.userId;
    const sessionVersion = verified.payload.sessionVersion;
    const isPlatformAdmin = verified.payload.isPlatformAdmin;
    if (typeof userId !== "string" || typeof sessionVersion !== "number" || typeof isPlatformAdmin !== "boolean") {
      return null;
    }
    return { userId, sessionVersion, isPlatformAdmin };
  } catch {
    return null;
  }
}
