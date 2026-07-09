import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { API_KEY_PREFIX, PRODUCT_TOKEN_PREFIX } from "@/lib/constants";

export function generateApiKey(): { plaintextKey: string; keyHash: string; keyPrefix: string } {
  const secret = randomBytes(24).toString("base64url");
  const plaintextKey = `${API_KEY_PREFIX}${secret}`;
  const keyHash = hashApiKey(plaintextKey);
  const keyPrefix = plaintextKey.slice(-4);
  return { plaintextKey, keyHash, keyPrefix };
}

export function generateProductToken(): { plaintextToken: string; tokenHash: string; tokenPrefix: string } {
  const secret = randomBytes(24).toString("base64url");
  const plaintextToken = `${PRODUCT_TOKEN_PREFIX}${secret}`;
  const tokenHash = hashApiKey(plaintextToken);
  const tokenPrefix = plaintextToken.slice(-4);
  return { plaintextToken, tokenHash, tokenPrefix };
}

export function generateInviteToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashApiKey(token) };
}

export function hashApiKey(plaintextKey: string): string {
  return createHash("sha256").update(plaintextKey).digest("hex");
}

export function verifyApiKeyHash(plaintextKey: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashApiKey(plaintextKey), "utf8");
  const expected = Buffer.from(storedHash, "utf8");
  if (candidate.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(candidate, expected);
}
