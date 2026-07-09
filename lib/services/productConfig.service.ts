/**
 * Per-subscription (site + product) configuration.
 *
 * The portal edits a `draft`; publishing copies it to `published`. The product
 * only ever receives `published` values (folded into token verification), while
 * previews receive `draft` values via a short-lived preview token. Secret fields
 * are write-only: they are never returned to the browser (masked as `{ set }`),
 * but their real values are delivered to the product over the server-to-server
 * channel.
 */

import { SignJWT, jwtVerify } from "jose";

import { Product, ProductDefaultConfig, Site, SubscriptionConfig, Types } from "@/lib/db";
import { loadEnvironment } from "@/lib/env";
import type {
  ProductConfigField,
  ProductConfigSection,
  ProductDefaultConfigSummary,
  ProductTestAction,
  SubscriptionConfigSummary,
} from "@/lib/types";
import { type RequestActor, writeAuditLog } from "@/lib/services/platform.service";

const PREVIEW_TTL_SECONDS = 15 * 60;

type ValueMap = Record<string, unknown>;

export class ProductConfigError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ProductConfigError";
  }
}

function normalizeSchema(raw: unknown): ProductConfigSection[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map((section) => {
    const source = section as Record<string, unknown>;
    const fields = Array.isArray(source.fields) ? (source.fields as Record<string, unknown>[]) : [];
    return {
      key: String(source.key ?? ""),
      title: String(source.title ?? ""),
      description: String(source.description ?? ""),
      kind: (source.kind as ProductConfigSection["kind"]) ?? "settings",
      fields: fields.map((field) => ({
        key: String(field.key ?? ""),
        label: String(field.label ?? ""),
        type: (field.type as ProductConfigField["type"]) ?? "string",
        default: field.default ?? null,
        help: String(field.help ?? ""),
        options: Array.isArray(field.options)
          ? (field.options as Record<string, unknown>[]).map((option) => ({
              value: String(option.value ?? ""),
              label: String(option.label ?? ""),
            }))
          : [],
        required: Boolean(field.required),
        secret: Boolean(field.secret),
        lockable: field.lockable === undefined ? true : Boolean(field.lockable),
        group: String(field.group ?? ""),
      })),
    };
  });
}

function normalizeTestActions(raw: unknown): ProductTestAction[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map((action) => {
    const source = action as Record<string, unknown>;
    return {
      key: String(source.key ?? ""),
      label: String(source.label ?? ""),
      description: String(source.description ?? ""),
      inputLabel: String(source.inputLabel ?? "Sample input"),
      inputPlaceholder: String(source.inputPlaceholder ?? ""),
    };
  });
}

function flattenFields(schema: ProductConfigSection[]): ProductConfigField[] {
  return schema.flatMap((section) => section.fields);
}

interface ProductMeta {
  schema: ProductConfigSection[];
  testActions: ProductTestAction[];
  previewAvailable: boolean;
}

function typeDefault(field: ProductConfigField): unknown {
  switch (field.type) {
    case "boolean":
      return false;
    case "number":
      return 0;
    case "list":
      return [];
    default:
      return "";
  }
}

function coerceValue(field: ProductConfigField, raw: unknown): unknown {
  switch (field.type) {
    case "boolean":
      return Boolean(raw);
    case "number": {
      const value = Number(raw);
      return Number.isFinite(value) ? value : typeDefault(field);
    }
    case "list": {
      if (Array.isArray(raw)) {
        return raw.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0);
      }
      if (typeof raw === "string") {
        return raw
          .split(/[\n,]/)
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
      }
      return [];
    }
    default:
      return raw === null || raw === undefined ? "" : String(raw);
  }
}

/** Resolve stored values against the schema, applying defaults. Includes secrets. */
function resolveValues(schema: ProductConfigSection[], stored: ValueMap): ValueMap {
  const resolved: ValueMap = {};
  for (const field of flattenFields(schema)) {
    const raw = stored[field.key];
    if (raw !== undefined && raw !== null && !(field.type !== "boolean" && raw === "")) {
      resolved[field.key] = coerceValue(field, raw);
      continue;
    }
    resolved[field.key] = field.default ?? typeDefault(field);
  }
  return resolved;
}

/** Editor-facing view: non-secret values resolved, secrets masked as `{ set }`. */
function editorValues(schema: ProductConfigSection[], stored: ValueMap): ValueMap {
  const view: ValueMap = {};
  for (const field of flattenFields(schema)) {
    if (field.secret) {
      view[field.key] = { set: Boolean(stored[field.key]) };
      continue;
    }
    const raw = stored[field.key];
    view[field.key] =
      raw !== undefined && raw !== null && !(field.type !== "boolean" && raw === "")
        ? coerceValue(field, raw)
        : field.default ?? typeDefault(field);
  }
  return view;
}

/** Comparable snapshot for change detection (secrets reduced to a set flag). */
function comparable(schema: ProductConfigSection[], stored: ValueMap): ValueMap {
  const resolved = resolveValues(schema, stored);
  const snapshot: ValueMap = {};
  for (const field of flattenFields(schema)) {
    snapshot[field.key] = field.secret ? Boolean(stored[field.key]) : resolved[field.key];
  }
  return snapshot;
}

/** True when a stored value counts as explicitly set (non-empty for non-booleans). */
function isFieldSet(field: ProductConfigField, value: unknown): boolean {
  return value !== undefined && value !== null && !(field.type !== "boolean" && value === "");
}

interface ProductDefaults {
  published: ValueMap;
  draft: ValueMap;
  lockedFields: string[];
}

async function loadProductDefaults(productSlug: string): Promise<ProductDefaults> {
  const doc = await ProductDefaultConfig.findOne({ productSlug: productSlug.toLowerCase() }).lean();
  return {
    published: (doc?.published?.values as ValueMap | undefined) ?? {},
    draft: (doc?.draft?.values as ValueMap | undefined) ?? {},
    lockedFields: doc?.lockedFields ?? [],
  };
}

/**
 * Fold product defaults under site values. Precedence per field:
 * enforced default > site value > product default > (schema default via resolveValues).
 */
function mergeStored(
  schema: ProductConfigSection[],
  productPublished: ValueMap,
  siteStored: ValueMap,
  enforcedFields: string[],
): ValueMap {
  const merged: ValueMap = {};
  for (const field of flattenFields(schema)) {
    const key = field.key;
    if (enforcedFields.includes(key)) {
      if (isFieldSet(field, productPublished[key])) {
        merged[key] = productPublished[key];
      }
      continue;
    }
    if (isFieldSet(field, siteStored[key])) {
      merged[key] = siteStored[key];
      continue;
    }
    if (isFieldSet(field, productPublished[key])) {
      merged[key] = productPublished[key];
    }
  }
  return merged;
}

interface ConfigDocLike {
  draft?: { values?: ValueMap; updatedAt?: Date | null } | null;
  published?: { values?: ValueMap; version?: number; publishedAt?: Date | null } | null;
  lockedFields?: string[] | null;
}

function toSummary(
  siteId: string,
  productSlug: string,
  meta: ProductMeta,
  doc: ConfigDocLike | null,
  defaults: ProductDefaults,
): SubscriptionConfigSummary {
  const { schema } = meta;
  const draftStored = doc?.draft?.values ?? {};
  const publishedStored = doc?.published?.values ?? {};
  const lockedFields = doc?.lockedFields ?? [];
  const draftSnapshot = comparable(schema, draftStored);
  const publishedSnapshot = comparable(schema, publishedStored);
  const version = doc?.published?.version ?? 0;
  const hasUnpublishedChanges = JSON.stringify(draftSnapshot) !== JSON.stringify(publishedSnapshot);
  const schemaKeys = new Set(flattenFields(schema).map((field) => field.key));
  const enforcedFields = defaults.lockedFields.filter((key) => schemaKeys.has(key));
  const effectiveDraftStored = Object.keys(draftStored).length > 0 ? draftStored : publishedStored;
  const overriddenFields = flattenFields(schema)
    .filter((field) => isFieldSet(field, effectiveDraftStored[field.key]))
    .map((field) => field.key);

  return {
    siteId,
    productSlug,
    schema,
    testActions: meta.testActions,
    previewAvailable: meta.previewAvailable,
    draft: editorValues(schema, effectiveDraftStored),
    published: editorValues(schema, publishedStored),
    lockedFields: [...lockedFields],
    inheritedDefaults: editorValues(schema, defaults.published),
    enforcedFields,
    overriddenFields,
    version,
    hasUnpublishedChanges,
    publishedAt: doc?.published?.publishedAt ? doc.published.publishedAt.toISOString() : null,
    draftUpdatedAt: doc?.draft?.updatedAt ? doc.draft.updatedAt.toISOString() : null,
  };
}

async function loadProductMeta(productSlug: string): Promise<ProductMeta> {
  const product = await Product.findOne({ slug: productSlug.toLowerCase() }).lean();
  if (!product) {
    throw new ProductConfigError("Product not found.", 404);
  }
  return {
    schema: normalizeSchema(product.configSchema),
    testActions: normalizeTestActions(product.testActions),
    previewAvailable: Boolean(product.baseUrl),
  };
}

async function loadSchema(productSlug: string): Promise<ProductConfigSection[]> {
  return (await loadProductMeta(productSlug)).schema;
}

export async function getProductConfig(siteId: string, productSlug: string): Promise<SubscriptionConfigSummary> {
  const slug = productSlug.toLowerCase();
  const [meta, defaults, doc] = await Promise.all([
    loadProductMeta(slug),
    loadProductDefaults(slug),
    SubscriptionConfig.findOne({ siteId: new Types.ObjectId(siteId), productSlug: slug }).lean(),
  ]);
  return toSummary(siteId, slug, meta, doc as ConfigDocLike | null, defaults);
}

export async function saveProductConfigDraft(
  actor: RequestActor,
  siteId: string,
  productSlug: string,
  input: { values?: ValueMap; lockedFields?: string[]; clearKeys?: string[] },
): Promise<SubscriptionConfigSummary> {
  const slug = productSlug.toLowerCase();
  const schema = await loadSchema(slug);
  const fieldByKey = new Map(flattenFields(schema).map((field) => [field.key, field]));
  const defaults = await loadProductDefaults(slug);

  const site = await Site.findById(siteId).lean();
  if (!site) {
    throw new ProductConfigError("Site not found.", 404);
  }

  const existing = await SubscriptionConfig.findOne({ siteId: new Types.ObjectId(siteId), productSlug: slug });
  const lockedFields = existing?.lockedFields ?? [];

  if (input.lockedFields !== undefined && !actor.isPlatformAdmin) {
    throw new ProductConfigError("Only administrators can lock fields.", 403);
  }

  const nextValues: ValueMap = { ...(existing?.draft?.values ?? {}) };
  // Reset-to-default: drop these keys so the field inherits the product default again.
  for (const key of input.clearKeys ?? []) {
    delete nextValues[key];
  }
  if (input.values) {
    for (const [key, raw] of Object.entries(input.values)) {
      const field = fieldByKey.get(key);
      if (!field) {
        continue;
      }
      // Enforced product defaults cannot be overridden per site; change them at product level.
      if (defaults.lockedFields.includes(key)) {
        continue;
      }
      if (lockedFields.includes(key) && !actor.isPlatformAdmin) {
        throw new ProductConfigError(`Field "${field.label}" is locked by the platform.`, 403);
      }
      if (field.secret) {
        // Write-only: only replace when a fresh non-empty string arrives; a
        // masked object or empty value keeps the stored secret untouched.
        if (typeof raw === "string" && raw.trim().length > 0) {
          nextValues[key] = raw.trim();
        }
        continue;
      }
      nextValues[key] = coerceValue(field, raw);
    }
  }

  let nextLocked = lockedFields;
  if (input.lockedFields !== undefined) {
    nextLocked = input.lockedFields.filter((key) => {
      const field = fieldByKey.get(key);
      return field ? field.lockable : false;
    });
  }

  const now = new Date();
  await SubscriptionConfig.findOneAndUpdate(
    { siteId: new Types.ObjectId(siteId), productSlug: slug },
    {
      $set: {
        merchantId: site.merchantId,
        "draft.values": nextValues,
        "draft.updatedAt": now,
        "draft.updatedBy": new Types.ObjectId(actor.userId),
        lockedFields: nextLocked,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  await writeAuditLog({
    merchantId: site.merchantId.toString(),
    actorUserId: actor.userId,
    action: "product_config.draft_saved",
    resourceType: "subscription_config",
    resourceId: slug,
    metadata: { siteId, productSlug: slug, lockedChanged: input.lockedFields !== undefined },
  });

  return getProductConfig(siteId, slug);
}

export async function publishProductConfig(
  actor: RequestActor,
  siteId: string,
  productSlug: string,
): Promise<SubscriptionConfigSummary> {
  const slug = productSlug.toLowerCase();
  const site = await Site.findById(siteId).lean();
  if (!site) {
    throw new ProductConfigError("Site not found.", 404);
  }

  const existing = await SubscriptionConfig.findOne({ siteId: new Types.ObjectId(siteId), productSlug: slug });
  const draftValues = existing?.draft?.values ?? {};
  const nextVersion = (existing?.published?.version ?? 0) + 1;
  const now = new Date();

  await SubscriptionConfig.findOneAndUpdate(
    { siteId: new Types.ObjectId(siteId), productSlug: slug },
    {
      $set: {
        merchantId: site.merchantId,
        "published.values": draftValues,
        "published.version": nextVersion,
        "published.publishedAt": now,
        "published.publishedBy": new Types.ObjectId(actor.userId),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  await writeAuditLog({
    merchantId: site.merchantId.toString(),
    actorUserId: actor.userId,
    action: "product_config.published",
    resourceType: "subscription_config",
    resourceId: slug,
    metadata: { siteId, productSlug: slug, version: nextVersion },
  });

  return getProductConfig(siteId, slug);
}

/**
 * Fully-resolved effective values (secrets included) for a site, folding product
 * defaults beneath the site's own values and enforcing globally-locked defaults.
 * `stage` "published" is what the running product receives; "draft" is for preview.
 */
export async function resolveEffectiveConfig(
  schema: ProductConfigSection[],
  productSlug: string,
  siteId: string,
  stage: "published" | "draft",
): Promise<ValueMap> {
  const slug = productSlug.toLowerCase();
  const [defaults, doc] = await Promise.all([
    loadProductDefaults(slug),
    SubscriptionConfig.findOne({ siteId: new Types.ObjectId(siteId), productSlug: slug }).lean(),
  ]);
  const sitePublished = (doc?.published?.values as ValueMap | undefined) ?? {};
  const siteDraft = (doc?.draft?.values as ValueMap | undefined) ?? {};
  const siteStored =
    stage === "draft" ? (Object.keys(siteDraft).length > 0 ? siteDraft : sitePublished) : sitePublished;
  const merged = mergeStored(schema, defaults.published, siteStored, defaults.lockedFields);
  return resolveValues(schema, merged);
}

/** Published, fully-resolved values (secrets included) for runtime delivery. */
export async function resolvePublishedConfig(
  schema: ProductConfigSection[],
  siteId: string,
  productSlug: string,
): Promise<ValueMap> {
  return resolveEffectiveConfig(schema, productSlug, siteId, "published");
}

/** Draft, fully-resolved values (secrets included) for preview delivery. */
export async function resolveDraftConfig(siteId: string, productSlug: string): Promise<ValueMap> {
  const schema = await loadSchema(productSlug);
  return resolveEffectiveConfig(schema, productSlug, siteId, "draft");
}

// ---------------------------------------------------------------------------
// Product-level default config (admin only). Same draft/publish shape as site
// config; `lockedFields` here enforce a default across every site.
// ---------------------------------------------------------------------------

function toDefaultsSummary(
  productSlug: string,
  meta: ProductMeta,
  doc: ConfigDocLike | null,
): ProductDefaultConfigSummary {
  const { schema } = meta;
  const draftStored = doc?.draft?.values ?? {};
  const publishedStored = doc?.published?.values ?? {};
  const schemaKeys = new Set(flattenFields(schema).map((field) => field.key));
  const lockedFields = (doc?.lockedFields ?? []).filter((key) => schemaKeys.has(key));
  const draftSnapshot = comparable(schema, draftStored);
  const publishedSnapshot = comparable(schema, publishedStored);

  return {
    productSlug,
    schema,
    testActions: meta.testActions,
    draft: editorValues(schema, Object.keys(draftStored).length > 0 ? draftStored : publishedStored),
    published: editorValues(schema, publishedStored),
    lockedFields,
    version: doc?.published?.version ?? 0,
    hasUnpublishedChanges: JSON.stringify(draftSnapshot) !== JSON.stringify(publishedSnapshot),
    publishedAt: doc?.published?.publishedAt ? doc.published.publishedAt.toISOString() : null,
    draftUpdatedAt: doc?.draft?.updatedAt ? doc.draft.updatedAt.toISOString() : null,
  };
}

export async function getProductDefaults(productSlug: string): Promise<ProductDefaultConfigSummary> {
  const slug = productSlug.toLowerCase();
  const [meta, doc] = await Promise.all([
    loadProductMeta(slug),
    ProductDefaultConfig.findOne({ productSlug: slug }).lean(),
  ]);
  return toDefaultsSummary(slug, meta, doc as ConfigDocLike | null);
}

export async function saveProductDefaultsDraft(
  actor: RequestActor,
  productSlug: string,
  input: { values?: ValueMap; lockedFields?: string[] },
): Promise<ProductDefaultConfigSummary> {
  if (!actor.isPlatformAdmin) {
    throw new ProductConfigError("Only administrators can edit product defaults.", 403);
  }
  const slug = productSlug.toLowerCase();
  const schema = await loadSchema(slug);
  const fieldByKey = new Map(flattenFields(schema).map((field) => [field.key, field]));

  const existing = await ProductDefaultConfig.findOne({ productSlug: slug });
  const nextValues: ValueMap = { ...(existing?.draft?.values ?? {}) };
  if (input.values) {
    for (const [key, raw] of Object.entries(input.values)) {
      const field = fieldByKey.get(key);
      if (!field) {
        continue;
      }
      if (field.secret) {
        if (typeof raw === "string" && raw.trim().length > 0) {
          nextValues[key] = raw.trim();
        }
        continue;
      }
      nextValues[key] = coerceValue(field, raw);
    }
  }

  const nextLocked =
    input.lockedFields !== undefined
      ? input.lockedFields.filter((key) => fieldByKey.has(key))
      : existing?.lockedFields ?? [];

  const now = new Date();
  await ProductDefaultConfig.findOneAndUpdate(
    { productSlug: slug },
    {
      $set: {
        "draft.values": nextValues,
        "draft.updatedAt": now,
        "draft.updatedBy": new Types.ObjectId(actor.userId),
        lockedFields: nextLocked,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  await writeAuditLog({
    merchantId: null,
    actorUserId: actor.userId,
    action: "product_defaults.draft_saved",
    resourceType: "product_default_config",
    resourceId: slug,
    metadata: { productSlug: slug, lockedChanged: input.lockedFields !== undefined },
  });

  return getProductDefaults(slug);
}

export async function publishProductDefaults(
  actor: RequestActor,
  productSlug: string,
): Promise<ProductDefaultConfigSummary> {
  if (!actor.isPlatformAdmin) {
    throw new ProductConfigError("Only administrators can publish product defaults.", 403);
  }
  const slug = productSlug.toLowerCase();
  const existing = await ProductDefaultConfig.findOne({ productSlug: slug });
  const draftValues = existing?.draft?.values ?? {};
  const nextVersion = (existing?.published?.version ?? 0) + 1;
  const now = new Date();

  await ProductDefaultConfig.findOneAndUpdate(
    { productSlug: slug },
    {
      $set: {
        "published.values": draftValues,
        "published.version": nextVersion,
        "published.publishedAt": now,
        "published.publishedBy": new Types.ObjectId(actor.userId),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  await writeAuditLog({
    merchantId: null,
    actorUserId: actor.userId,
    action: "product_defaults.published",
    resourceType: "product_default_config",
    resourceId: slug,
    metadata: { productSlug: slug, version: nextVersion },
  });

  return getProductDefaults(slug);
}

function previewSecret(): Uint8Array {
  return new TextEncoder().encode(loadEnvironment().INTERNAL_API_SECRET);
}

export async function createPreviewToken(siteId: string, productSlug: string): Promise<string> {
  return new SignJWT({ siteId, productSlug: productSlug.toLowerCase(), kind: "preview" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${PREVIEW_TTL_SECONDS}s`)
    .sign(previewSecret());
}

export async function verifyPreviewToken(
  token: string,
): Promise<{ siteId: string; productSlug: string } | null> {
  try {
    const verified = await jwtVerify(token, previewSecret());
    const { siteId, productSlug, kind } = verified.payload;
    if (kind !== "preview" || typeof siteId !== "string" || typeof productSlug !== "string") {
      return null;
    }
    return { siteId, productSlug };
  } catch {
    return null;
  }
}

export const PREVIEW_TOKEN_TTL_SECONDS = PREVIEW_TTL_SECONDS;
