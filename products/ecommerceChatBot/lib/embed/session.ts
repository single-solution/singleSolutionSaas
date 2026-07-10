import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const EMBED_SESSION_TTL_SECONDS = 30 * 60;

type EmbedClaims = Record<string, unknown>;

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function base64UrlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function sign(data: string, secret: string): string {
  return base64UrlEncode(createHmac("sha256", secret).update(data).digest());
}

export interface EmbedSessionIdentity {
  visitorId: string;
  siteId: string;
  productSlug: string;
  originHost: string;
  productToken: string;
}

export function mintVisitorId(): string {
  return randomBytes(16).toString("base64url");
}

export function mintEmbedSessionToken(identity: EmbedSessionIdentity, secret: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64UrlEncode(
    JSON.stringify({
      sub: identity.visitorId,
      siteId: identity.siteId,
      productSlug: identity.productSlug,
      originHost: identity.originHost,
      productToken: identity.productToken,
      scope: "embed-session",
      iat: now,
      exp: now + EMBED_SESSION_TTL_SECONDS,
    }),
  );
  const signature = sign(`${header}.${payload}`, secret);
  return `${header}.${payload}.${signature}`;
}

export function verifyEmbedSessionToken(token: string, secret: string): EmbedSessionIdentity | null {
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
  let claims: EmbedClaims;
  try {
    claims = JSON.parse(base64UrlDecode(payload).toString("utf8")) as EmbedClaims;
  } catch {
    return null;
  }
  if (claims.scope !== "embed-session") {
    return null;
  }
  if (typeof claims.exp === "number" && claims.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }
  const visitorId = typeof claims.sub === "string" ? claims.sub : "";
  const siteId = typeof claims.siteId === "string" ? claims.siteId : "";
  const productSlug = typeof claims.productSlug === "string" ? claims.productSlug : "";
  const originHost = typeof claims.originHost === "string" ? claims.originHost : "";
  const productToken = typeof claims.productToken === "string" ? claims.productToken : "";
  if (!visitorId || !siteId || !productSlug || !originHost || !productToken) {
    return null;
  }
  return { visitorId, siteId, productSlug, originHost, productToken };
}

export const EMBED_SESSION_MAX_AGE_SECONDS = EMBED_SESSION_TTL_SECONDS;
