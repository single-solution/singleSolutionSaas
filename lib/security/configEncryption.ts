import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { Environment } from "@/lib/env";
import { loadEnvironment } from "@/lib/env";
import { isProduction } from "@/lib/utils";

export const CONFIG_ENVELOPE_VERSION = 1;
export const ENCRYPTION_KEY_BYTE_LENGTH = 32;
export const MAX_ENCRYPTION_KEYS = 5;
export const IV_BYTE_LENGTH = 12;
export const AUTH_TAG_BYTE_LENGTH = 16;

export interface ConfigSecretEnvelope {
  enc: typeof CONFIG_ENVELOPE_VERSION;
  kid: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface ConfigSecretEncryptionContext {
  scope: "subscription" | "product-default";
  productSlug: string;
  siteId?: string;
  fieldKey: string;
}

export class ConfigEncryptionError extends Error {
  constructor(
    message: string,
    readonly code:
      | "CONFIG_ENCRYPTION_UNAVAILABLE"
      | "CONFIG_DECRYPTION_FAILED"
      | "CONFIG_ENCRYPTION_MISCONFIGURED",
  ) {
    super(message);
    this.name = "ConfigEncryptionError";
  }
}

interface EncryptionKeySet {
  activeKeyId: string;
  keysById: Map<string, Buffer>;
}

let cachedKeySet: EncryptionKeySet | null | undefined;

function trimEnvString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().replace(/\r/g, "");
  return trimmed === "" ? undefined : trimmed;
}

function decodeEncryptionKey(keyId: string, encoded: string): Buffer {
  let keyBytes: Buffer;
  try {
    keyBytes = Buffer.from(encoded, "base64");
  } catch {
    throw new ConfigEncryptionError(
      "CONFIG_ENCRYPTION_KEYS contains an invalid base64 key.",
      "CONFIG_ENCRYPTION_MISCONFIGURED",
    );
  }
  if (keyBytes.length !== ENCRYPTION_KEY_BYTE_LENGTH) {
    throw new ConfigEncryptionError(
      `Encryption key "${keyId}" must decode to ${ENCRYPTION_KEY_BYTE_LENGTH} bytes.`,
      "CONFIG_ENCRYPTION_MISCONFIGURED",
    );
  }
  return keyBytes;
}

function parseEncryptionKeys(raw: string): Map<string, Buffer> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigEncryptionError(
      "CONFIG_ENCRYPTION_KEYS must be a JSON object mapping key IDs to base64-encoded 32-byte keys.",
      "CONFIG_ENCRYPTION_MISCONFIGURED",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigEncryptionError(
      "CONFIG_ENCRYPTION_KEYS must be a JSON object mapping key IDs to base64-encoded 32-byte keys.",
      "CONFIG_ENCRYPTION_MISCONFIGURED",
    );
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) {
    throw new ConfigEncryptionError(
      "CONFIG_ENCRYPTION_KEYS must include at least one key.",
      "CONFIG_ENCRYPTION_MISCONFIGURED",
    );
  }
  if (entries.length > MAX_ENCRYPTION_KEYS) {
    throw new ConfigEncryptionError(
      `CONFIG_ENCRYPTION_KEYS supports at most ${MAX_ENCRYPTION_KEYS} keys.`,
      "CONFIG_ENCRYPTION_MISCONFIGURED",
    );
  }
  const keysById = new Map<string, Buffer>();
  for (const [keyId, encoded] of entries) {
    const normalizedKeyId = keyId.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,31}$/.test(normalizedKeyId)) {
      throw new ConfigEncryptionError(
        `Encryption key ID "${keyId}" is invalid.`,
        "CONFIG_ENCRYPTION_MISCONFIGURED",
      );
    }
    if (typeof encoded !== "string") {
      throw new ConfigEncryptionError(
        `Encryption key "${normalizedKeyId}" must be a base64 string.`,
        "CONFIG_ENCRYPTION_MISCONFIGURED",
      );
    }
    keysById.set(normalizedKeyId, decodeEncryptionKey(normalizedKeyId, encoded.trim()));
  }
  return keysById;
}

export function isConfigSecretEnvelope(value: unknown): value is ConfigSecretEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const envelope = value as Record<string, unknown>;
  return (
    envelope.enc === CONFIG_ENVELOPE_VERSION &&
    typeof envelope.kid === "string" &&
    envelope.kid.length > 0 &&
    typeof envelope.iv === "string" &&
    envelope.iv.length > 0 &&
    typeof envelope.tag === "string" &&
    envelope.tag.length > 0 &&
    typeof envelope.ciphertext === "string" &&
    envelope.ciphertext.length > 0
  );
}

export function resetConfigEncryptionCache(): void {
  cachedKeySet = undefined;
}

export function loadEncryptionKeySet(environment: Environment = loadEnvironment()): EncryptionKeySet | null {
  if (cachedKeySet !== undefined) {
    return cachedKeySet;
  }
  const rawKeys = trimEnvString(environment.CONFIG_ENCRYPTION_KEYS);
  const activeKeyId = trimEnvString(environment.CONFIG_ENCRYPTION_ACTIVE_KEY_ID);
  if (!rawKeys || !activeKeyId) {
    cachedKeySet = null;
    return cachedKeySet;
  }
  const keysById = parseEncryptionKeys(rawKeys);
  if (!keysById.has(activeKeyId)) {
    throw new ConfigEncryptionError(
      "CONFIG_ENCRYPTION_ACTIVE_KEY_ID is not present in CONFIG_ENCRYPTION_KEYS.",
      "CONFIG_ENCRYPTION_MISCONFIGURED",
    );
  }
  cachedKeySet = { activeKeyId, keysById };
  return cachedKeySet;
}

export function encryptionKeysConfigured(environment: Environment = loadEnvironment()): boolean {
  return loadEncryptionKeySet(environment) !== null;
}

function buildAdditionalAuthenticatedData(context: ConfigSecretEncryptionContext): Buffer {
  const siteSegment = context.scope === "subscription" ? (context.siteId ?? "") : "product-default";
  const payload = [
    "config-secret",
    `v${CONFIG_ENVELOPE_VERSION}`,
    context.scope,
    context.productSlug.toLowerCase(),
    siteSegment,
    context.fieldKey,
  ].join(":");
  return Buffer.from(payload, "utf8");
}

function requireEncryptionKeySet(environment: Environment): EncryptionKeySet {
  const keySet = loadEncryptionKeySet(environment);
  if (!keySet) {
    if (isProduction(environment)) {
      throw new ConfigEncryptionError(
        "Secret configuration encryption is not configured. Set CONFIG_ENCRYPTION_KEYS and CONFIG_ENCRYPTION_ACTIVE_KEY_ID.",
        "CONFIG_ENCRYPTION_UNAVAILABLE",
      );
    }
    throw new ConfigEncryptionError(
      "Secret configuration encryption is not configured. Set CONFIG_ENCRYPTION_KEYS and CONFIG_ENCRYPTION_ACTIVE_KEY_ID before saving secret values.",
      "CONFIG_ENCRYPTION_UNAVAILABLE",
    );
  }
  return keySet;
}

export function encryptConfigSecret(
  plaintext: string,
  context: ConfigSecretEncryptionContext,
  environment: Environment = loadEnvironment(),
  keyId?: string,
): ConfigSecretEnvelope {
  const keySet = requireEncryptionKeySet(environment);
  const resolvedKeyId = keyId ?? keySet.activeKeyId;
  const key = keySet.keysById.get(resolvedKeyId);
  if (!key) {
    throw new ConfigEncryptionError(
      "The requested encryption key is not available.",
      "CONFIG_ENCRYPTION_UNAVAILABLE",
    );
  }
  const iv = randomBytes(IV_BYTE_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv, {
    authTagLength: AUTH_TAG_BYTE_LENGTH,
  });
  cipher.setAAD(buildAdditionalAuthenticatedData(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    enc: CONFIG_ENVELOPE_VERSION,
    kid: resolvedKeyId,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decryptConfigSecret(
  value: unknown,
  context: ConfigSecretEncryptionContext,
  environment: Environment = loadEnvironment(),
): string {
  if (typeof value === "string") {
    return value;
  }
  if (!isConfigSecretEnvelope(value)) {
    throw new ConfigEncryptionError(
      "Stored secret value is not decryptable.",
      "CONFIG_DECRYPTION_FAILED",
    );
  }
  const keySet = loadEncryptionKeySet(environment);
  if (!keySet) {
    throw new ConfigEncryptionError(
      "Secret configuration encryption is not configured.",
      "CONFIG_ENCRYPTION_UNAVAILABLE",
    );
  }
  const key = keySet.keysById.get(value.kid);
  if (!key) {
    throw new ConfigEncryptionError(
      "Stored secret was encrypted with an unknown key. Configure the matching key or re-encrypt the value.",
      "CONFIG_DECRYPTION_FAILED",
    );
  }
  let iv: Buffer;
  let tag: Buffer;
  let ciphertext: Buffer;
  try {
    iv = Buffer.from(value.iv, "base64");
    tag = Buffer.from(value.tag, "base64");
    ciphertext = Buffer.from(value.ciphertext, "base64");
  } catch {
    throw new ConfigEncryptionError("Stored secret envelope is malformed.", "CONFIG_DECRYPTION_FAILED");
  }
  if (iv.length !== IV_BYTE_LENGTH || tag.length !== AUTH_TAG_BYTE_LENGTH) {
    throw new ConfigEncryptionError("Stored secret envelope is malformed.", "CONFIG_DECRYPTION_FAILED");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv, {
    authTagLength: AUTH_TAG_BYTE_LENGTH,
  });
  decipher.setAAD(buildAdditionalAuthenticatedData(context));
  decipher.setAuthTag(tag);
  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    return plaintext;
  } catch {
    throw new ConfigEncryptionError(
      "Stored secret could not be authenticated or decrypted.",
      "CONFIG_DECRYPTION_FAILED",
    );
  }
}

export function isSecretValuePresent(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (isConfigSecretEnvelope(value)) {
    return true;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return false;
}

export function envelopeNeedsReencryption(
  value: unknown,
  environment: Environment = loadEnvironment(),
): value is ConfigSecretEnvelope {
  if (!isConfigSecretEnvelope(value)) {
    return false;
  }
  const keySet = loadEncryptionKeySet(environment);
  if (!keySet) {
    return false;
  }
  return value.kid !== keySet.activeKeyId;
}
