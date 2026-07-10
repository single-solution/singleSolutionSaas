/**
 * Minimal HS256 JWT sign/verify using node:crypto. Admin dashboard sessions are
 * signed with SSO_SIGNING_SECRET (shared with the platform in production).
 */

import { createHmac, timingSafeEqual } from "node:crypto";

type Claims = Record<string, unknown>;

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function sign(data: string, secret: string): string {
  return base64UrlEncode(createHmac("sha256", secret).update(data).digest());
}

export function signJwt(claims: Claims, secret: string, expiresInSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64UrlEncode(JSON.stringify({ ...claims, iat: now, exp: now + expiresInSeconds }));
  const signature = sign(`${header}.${payload}`, secret);
  return `${header}.${payload}.${signature}`;
}

export function verifyJwt(token: string, secret: string): Claims | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [header, payload, signature] = parts;
  const expected = sign(`${header}.${payload}`, secret);
  const providedBuffer = base64UrlDecode(signature);
  const expectedBuffer = base64UrlDecode(expected);
  if (providedBuffer.length !== expectedBuffer.length || !timingSafeEqual(providedBuffer, expectedBuffer)) {
    return null;
  }
  let claims: Claims;
  try {
    claims = JSON.parse(base64UrlDecode(payload).toString("utf8")) as Claims;
  } catch {
    return null;
  }
  if (typeof claims.exp === "number" && claims.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }
  return claims;
}
