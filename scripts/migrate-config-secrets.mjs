/**
 * Encrypts or re-encrypts secret configuration values (dry-run by default).
 *
 * Usage:
 *   node --env-file=.env scripts/migrate-config-secrets.mjs
 *   node --env-file=.env scripts/migrate-config-secrets.mjs --apply
 */

import mongoose from "mongoose";

const SCRIPT_VERSION = "1.0.0";
const BATCH_LIMIT = 50;
const CONNECT_TIMEOUT_MS = 15_000;

const MONGODB_URI = process.env.MONGODB_URI?.trim();
const MONGODB_PLATFORM_DB = process.env.MONGODB_PLATFORM_DB?.trim() || "platform";
const CONFIG_ENCRYPTION_KEYS = process.env.CONFIG_ENCRYPTION_KEYS?.trim();
const CONFIG_ENCRYPTION_ACTIVE_KEY_ID = process.env.CONFIG_ENCRYPTION_ACTIVE_KEY_ID?.trim();
const apply = process.argv.includes("--apply");

const ENVELOPE_VERSION = 1;
const KEY_BYTE_LENGTH = 32;
const IV_BYTE_LENGTH = 12;
const AUTH_TAG_BYTE_LENGTH = 16;

if (!MONGODB_URI) {
  console.error("MONGODB_URI is required.");
  process.exit(1);
}

if (!CONFIG_ENCRYPTION_KEYS || !CONFIG_ENCRYPTION_ACTIVE_KEY_ID) {
  console.error("CONFIG_ENCRYPTION_KEYS and CONFIG_ENCRYPTION_ACTIVE_KEY_ID are required.");
  process.exit(1);
}

function parseEncryptionKeys(raw) {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("CONFIG_ENCRYPTION_KEYS must be a JSON object.");
  }
  const keysById = new Map();
  for (const [keyId, encoded] of Object.entries(parsed)) {
    const keyBytes = Buffer.from(String(encoded).trim(), "base64");
    if (keyBytes.length !== KEY_BYTE_LENGTH) {
      throw new Error(`Encryption key "${keyId}" must decode to ${KEY_BYTE_LENGTH} bytes.`);
    }
    keysById.set(keyId, keyBytes);
  }
  if (!keysById.has(CONFIG_ENCRYPTION_ACTIVE_KEY_ID)) {
    throw new Error("CONFIG_ENCRYPTION_ACTIVE_KEY_ID is not present in CONFIG_ENCRYPTION_KEYS.");
  }
  return keysById;
}

function isEnvelope(value) {
  return (
    value &&
    typeof value === "object" &&
    value.enc === ENVELOPE_VERSION &&
    typeof value.kid === "string" &&
    typeof value.iv === "string" &&
    typeof value.tag === "string" &&
    typeof value.ciphertext === "string"
  );
}

function buildAad(context) {
  const siteSegment = context.scope === "subscription" ? (context.siteId ?? "") : "product-default";
  return Buffer.from(
    ["config-secret", `v${ENVELOPE_VERSION}`, context.scope, context.productSlug, siteSegment, context.fieldKey].join(
      ":",
    ),
    "utf8",
  );
}

async function loadCrypto() {
  const { createCipheriv, createDecipheriv, randomBytes } = await import("node:crypto");
  const keysById = parseEncryptionKeys(CONFIG_ENCRYPTION_KEYS);

  function encrypt(plaintext, context, keyId = CONFIG_ENCRYPTION_ACTIVE_KEY_ID) {
    const key = keysById.get(keyId);
    if (!key) {
      throw new Error(`Unknown encryption key "${keyId}".`);
    }
    const iv = randomBytes(IV_BYTE_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: AUTH_TAG_BYTE_LENGTH });
    cipher.setAAD(buildAad(context));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
      enc: ENVELOPE_VERSION,
      kid: keyId,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
  }

  function decrypt(value, context) {
    if (typeof value === "string") {
      return value;
    }
    if (!isEnvelope(value)) {
      throw new Error("Stored secret value is not decryptable.");
    }
    const key = keysById.get(value.kid);
    if (!key) {
      throw new Error(`Unknown encryption key "${value.kid}".`);
    }
    const iv = Buffer.from(value.iv, "base64");
    const tag = Buffer.from(value.tag, "base64");
    const ciphertext = Buffer.from(value.ciphertext, "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: AUTH_TAG_BYTE_LENGTH });
    decipher.setAAD(buildAad(context));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }

  return { encrypt, decrypt };
}

function flattenSecretFields(schema) {
  const fields = [];
  for (const section of schema ?? []) {
    for (const field of section.fields ?? []) {
      if (field.secret || field.type === "secret") {
        fields.push(field.key);
      }
    }
  }
  return fields;
}

function processValues(values, secretKeys, contextFactory, crypto) {
  if (!values || typeof values !== "object") {
    return { nextValues: values ?? {}, changes: [] };
  }
  const nextValues = { ...values };
  const changes = [];
  for (const fieldKey of secretKeys) {
    const stored = nextValues[fieldKey];
    if (stored === undefined || stored === null) {
      continue;
    }
    const context = contextFactory(fieldKey);
    const plaintext = crypto.decrypt(stored, context);
    const shouldReencrypt =
      typeof stored === "string" || (isEnvelope(stored) && stored.kid !== CONFIG_ENCRYPTION_ACTIVE_KEY_ID);
    if (!shouldReencrypt) {
      continue;
    }
    const envelope = crypto.encrypt(plaintext, context);
    crypto.decrypt(envelope, context);
    nextValues[fieldKey] = envelope;
    changes.push({
      fieldKey,
      action: typeof stored === "string" ? "encrypt-plaintext" : "reencrypt",
      keyId: envelope.kid,
    });
  }
  return { nextValues, changes };
}

async function main() {
  const startedAt = Date.now();
  const crypto = await loadCrypto();
  await mongoose.connect(MONGODB_URI.replace(/\/$/, ""), {
    serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
    connectTimeoutMS: CONNECT_TIMEOUT_MS,
  });
  const db = mongoose.connection.useDb(MONGODB_PLATFORM_DB, { useCache: true });
  const products = db.collection("products");
  const defaults = db.collection("productdefaultconfigs");
  const subscriptionConfigs = db.collection("subscriptionconfigs");

  const productRows = await products.find({}).toArray();
  const secretFieldsBySlug = new Map(
    productRows.map((product) => [String(product.slug).toLowerCase(), flattenSecretFields(product.configSchema)]),
  );

  const planned = [];

  for (const doc of await defaults.find({}).limit(BATCH_LIMIT * 10).toArray()) {
    const productSlug = String(doc.productSlug).toLowerCase();
    const secretKeys = secretFieldsBySlug.get(productSlug) ?? [];
    if (secretKeys.length === 0) {
      continue;
    }
    const contextFactory = (fieldKey) => ({
      scope: "product-default",
      productSlug,
      fieldKey,
    });
    const draft = processValues(doc.draft?.values, secretKeys, contextFactory, crypto);
    const published = processValues(doc.published?.values, secretKeys, contextFactory, crypto);
    if (draft.changes.length === 0 && published.changes.length === 0) {
      continue;
    }
    planned.push({
      collection: "productdefaultconfigs",
      id: doc._id.toString(),
      productSlug,
      siteId: null,
      draftChanges: draft.changes,
      publishedChanges: published.changes,
      update: {
        ...(draft.changes.length > 0 ? { "draft.values": draft.nextValues } : {}),
        ...(published.changes.length > 0 ? { "published.values": published.nextValues } : {}),
      },
    });
  }

  for (const doc of await subscriptionConfigs.find({}).limit(BATCH_LIMIT * 10).toArray()) {
    const productSlug = String(doc.productSlug).toLowerCase();
    const siteId = doc.siteId?.toString?.() ?? String(doc.siteId);
    const secretKeys = secretFieldsBySlug.get(productSlug) ?? [];
    if (secretKeys.length === 0) {
      continue;
    }
    const contextFactory = (fieldKey) => ({
      scope: "subscription",
      productSlug,
      siteId,
      fieldKey,
    });
    const draft = processValues(doc.draft?.values, secretKeys, contextFactory, crypto);
    const published = processValues(doc.published?.values, secretKeys, contextFactory, crypto);
    if (draft.changes.length === 0 && published.changes.length === 0) {
      continue;
    }
    planned.push({
      collection: "subscriptionconfigs",
      id: doc._id.toString(),
      productSlug,
      siteId,
      draftChanges: draft.changes,
      publishedChanges: published.changes,
      update: {
        ...(draft.changes.length > 0 ? { "draft.values": draft.nextValues } : {}),
        ...(published.changes.length > 0 ? { "published.values": published.nextValues } : {}),
      },
    });
  }

  const batch = planned.slice(0, BATCH_LIMIT);
  const report = {
    version: SCRIPT_VERSION,
    dryRun: !apply,
    scannedDefaults: await defaults.countDocuments({}),
    scannedSubscriptionConfigs: await subscriptionConfigs.countDocuments({}),
    documentsNeedingMigration: planned.length,
    batchLimit: BATCH_LIMIT,
    batchSize: batch.length,
    remainingAfterBatch: Math.max(0, planned.length - batch.length),
    durationMs: 0,
  };

  console.log(`Mode: ${apply ? "apply" : "dry-run"}`);
  console.log(JSON.stringify(report, null, 2));
  for (const item of batch) {
    console.log(
      `- ${item.collection} ${item.id} (${item.productSlug}${item.siteId ? ` / site ${item.siteId}` : ""}) draft=${item.draftChanges.length} published=${item.publishedChanges.length}`,
    );
    for (const change of [...item.draftChanges, ...item.publishedChanges]) {
      console.log(`    ${change.action} ${change.fieldKey} -> kid ${change.keyId}`);
    }
  }

  if (!apply) {
    if (planned.length > 0) {
      console.log("Re-run with --apply to write encrypted values (one batch per run).");
    }
    report.durationMs = Date.now() - startedAt;
    await mongoose.disconnect();
    return;
  }

  let written = 0;
  for (const item of batch) {
    const collection = db.collection(item.collection);
    await collection.updateOne({ _id: new mongoose.Types.ObjectId(item.id) }, { $set: item.update });
    written += 1;
  }
  console.log(`Updated ${written} documents.`);
  if (report.remainingAfterBatch > 0) {
    console.log(`Re-run --apply until remainingAfterBatch is 0.`);
  }
  report.durationMs = Date.now() - startedAt;
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Migration failed.");
  process.exit(1);
});
