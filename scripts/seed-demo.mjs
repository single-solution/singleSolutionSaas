/**
 * Seeds a complete, real end-to-end demo into the platform database:
 *   - the ecommerce chatbot product (catalog entry + plans + config schema)
 *   - a merchant with an owner user who can sign in
 *   - a site, an ACTIVE paid subscription (Pro plan)
 *   - a fresh product access token bound to the demo domains
 *
 * It prints the login credentials, the product token, and a ready-to-open demo
 * URL. Idempotent: upserts by natural keys; the access token is rotated on every
 * run (the plaintext is only shown once, so a new one is minted each time).
 *
 * Run (Node 20+):
 *   node --env-file=.env scripts/seed-demo.mjs
 *
 * Optional env:
 *   DEMO_PRODUCT_BASE_URL  Product deployment URL (default: Vercel demo host)
 *   DEMO_MERCHANT_PASSWORD Owner password (default: Passw0rd!demo)
 */
import { createHash, randomBytes } from "node:crypto";

import bcrypt from "bcryptjs";
import mongoose from "mongoose";

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGODB_URI is required.");
  process.exit(1);
}

const platformDbName = process.env.MONGODB_PLATFORM_DB?.trim() || "platform";
const productBaseUrl = (
  process.env.DEMO_PRODUCT_BASE_URL?.trim() ||
  "https://single-solution-saas-ecommerce-chat.vercel.app"
).replace(/\/$/, "");
const productHost = new URL(productBaseUrl).hostname.toLowerCase();
const ownerPassword =
  process.env.DEMO_MERCHANT_PASSWORD?.trim() || "Passw0rd!demo";
const adminEmail = process.env.DEMO_ADMIN_EMAIL?.trim() || "admin@example.com";
const adminPassword =
  process.env.DEMO_ADMIN_PASSWORD?.trim() || "Passw0rd!admin";

const PRODUCT_SLUG = "ecommerce-chatbot";
const OWNER_EMAIL =
  process.env.DEMO_MERCHANT_EMAIL?.trim() || "owner@northwind.test";
const MERCHANT_SLUG = "northwind-outfitters";
const SITE_SLUG = "storefront";
const PLAN_CODE = "pro";
const PUBLIC_DEMO_MERCHANT_SLUG = "public-demo";
const PUBLIC_DEMO_SITE_SLUG = "sandbox";
const PUBLIC_DEMO_PLAN_CODE = "starter";
const SCOPES = ["chat:read", "chat:write"];
const ALLOWED_DOMAINS = [productHost, "localhost"];

const LEGACY_PRODUCT_DB =
  process.env.LEGACY_PRODUCT_DB?.trim() || "ecommerce-chatbot";

function hashApiKey(plaintext) {
  return createHash("sha256").update(plaintext).digest("hex");
}

// Mirror of lib/services/tenantDb.ts buildTenantDbName - keep in sync.
function sanitizeSegment(value, maxLength) {
  const cleaned = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.slice(0, maxLength) || "x";
}

function buildTenantDbName(
  merchantSlug,
  siteSlug,
  productSlug,
  subscriptionId,
) {
  const suffix =
    String(subscriptionId)
      .replace(/[^a-z0-9]/gi, "")
      .slice(-8)
      .toLowerCase() || "0";
  return `t-${sanitizeSegment(merchantSlug, 8)}-${sanitizeSegment(siteSlug, 6)}-${sanitizeSegment(productSlug, 8)}-${suffix}`.slice(
    0,
    38,
  );
}

/** Copy a site's product data from the legacy shared DB into its tenant DB. */
async function migrateLegacyData(legacyDb, tenantDb, siteId) {
  const collections = [
    "conversations",
    "sitesettings",
    "webhookdeliveries",
    "usages",
  ];
  let moved = 0;
  for (const name of collections) {
    const docs = await legacyDb.collection(name).find({ siteId }).toArray();
    for (const doc of docs) {
      await tenantDb
        .collection(name)
        .updateOne({ _id: doc._id }, { $setOnInsert: doc }, { upsert: true });
      moved += 1;
    }
    if (docs.length > 0) {
      await legacyDb.collection(name).deleteMany({ siteId });
    }
  }
  return moved;
}

function generateProductToken() {
  const plaintextToken = `pk_live_${randomBytes(24).toString("base64url")}`;
  return {
    plaintextToken,
    tokenHash: hashApiKey(plaintextToken),
    tokenPrefix: plaintextToken.slice(-4),
  };
}

const configSchema = [
  {
    key: "general",
    title: "General",
    description: "Core behavior and appearance of the chat widget.",
    kind: "settings",
    fields: [
      {
        key: "enabled",
        label: "Chat enabled",
        type: "boolean",
        default: true,
        help: "Turn the widget on or off.",
        lockable: true,
      },
      {
        key: "assistantEnabled",
        label: "Automated assistant",
        type: "boolean",
        default: true,
        help: "Auto-reply to customers before a human joins.",
        lockable: true,
      },
      {
        key: "assistantName",
        label: "Assistant name",
        type: "string",
        default: "Northwind Support",
        help: "Shown as the sender name and widget title.",
      },
      {
        key: "welcomeMessage",
        label: "Welcome message",
        type: "text",
        default:
          "Hi! Welcome to Northwind Outfitters. Ask about products, orders, or shipping.",
        help: "First message shown when the widget opens.",
      },
      {
        key: "themeColor",
        label: "Accent color",
        type: "color",
        default: "#2563eb",
        help: "Primary color of the launcher button.",
      },
    ],
  },
];

const testActions = [
  {
    key: "assistant-reply",
    label: "Assistant reply",
    description:
      "Preview the automated reply for a sample customer message using the draft config.",
    inputLabel: "Customer message",
    inputPlaceholder: "e.g. Do you offer refunds?",
  },
];

const plans = [
  {
    code: "starter",
    name: "Starter",
    priceMonthly: 0,
    currency: "USD",
    scopes: SCOPES,
    quotas: [{ metric: "messages", limit: 500, unit: "messages/mo" }],
  },
  {
    code: PLAN_CODE,
    name: "Pro",
    priceMonthly: 49,
    currency: "USD",
    scopes: SCOPES,
    quotas: [{ metric: "messages", limit: 10000, unit: "messages/mo" }],
  },
];

async function upsertReturningId(collection, filter, insertDoc) {
  const now = new Date();
  await collection.updateOne(
    filter,
    { $setOnInsert: { ...insertDoc, createdAt: now, updatedAt: now } },
    { upsert: true },
  );
  const doc = await collection.findOne(filter, { projection: { _id: 1 } });
  return doc._id;
}

async function run() {
  await mongoose.connect(uri.replace(/\/$/, ""));
  const db = mongoose.connection.useDb(platformDbName, { useCache: true });
  const now = new Date();

  // 1. Product catalog entry (upsert; refresh sellable config every run).
  await db.collection("products").updateOne(
    { slug: PRODUCT_SLUG },
    {
      $set: {
        name: "Ecommerce Chatbot",
        description:
          "Embeddable live chat widget with an automated assistant and human handoff.",
        baseUrl: productBaseUrl,
        status: "active",
        availableScopes: SCOPES,
        plans,
        configSchema,
        testActions,
        updatedAt: now,
      },
      $setOnInsert: { slug: PRODUCT_SLUG, createdAt: now },
    },
    { upsert: true },
  );

  // 2a. Platform admin (bootstrap only runs on an empty DB, which the seed is
  // not, so ensure one explicitly). Idempotent: refreshes password every run.
  const adminPasswordHash = await bcrypt.hash(adminPassword, 12);
  await db.collection("users").updateOne(
    { email: adminEmail },
    {
      $set: {
        name: "Platform Admin",
        passwordHash: adminPasswordHash,
        status: "active",
        isPlatformAdmin: true,
        updatedAt: now,
      },
      $setOnInsert: {
        email: adminEmail,
        sessionVersion: 0,
        inviteTokenHash: null,
        inviteTokenExpiresAt: null,
        createdAt: now,
      },
    },
    { upsert: true },
  );

  // 2. Owner user (active, signable). Reset password + activation every run.
  const passwordHash = await bcrypt.hash(ownerPassword, 12);
  await db.collection("users").updateOne(
    { email: OWNER_EMAIL },
    {
      $set: {
        name: "Nadia Owner",
        passwordHash,
        status: "active",
        isPlatformAdmin: false,
        updatedAt: now,
      },
      $setOnInsert: {
        email: OWNER_EMAIL,
        sessionVersion: 0,
        inviteTokenHash: null,
        inviteTokenExpiresAt: null,
        createdAt: now,
      },
    },
    { upsert: true },
  );
  const userId = (
    await db
      .collection("users")
      .findOne({ email: OWNER_EMAIL }, { projection: { _id: 1 } })
  )._id;

  // 3. Merchant + owner membership.
  const merchantId = await upsertReturningId(
    db.collection("merchants"),
    { slug: MERCHANT_SLUG },
    { name: "Northwind Outfitters", slug: MERCHANT_SLUG },
  );
  await db.collection("merchantmemberships").updateOne(
    { merchantId, userId },
    {
      $set: { role: "owner", updatedAt: now },
      $setOnInsert: { merchantId, userId, createdAt: now },
    },
    { upsert: true },
  );

  // 4. Site owned by the merchant.
  const siteId = await upsertReturningId(
    db.collection("sites"),
    { merchantId, slug: SITE_SLUG },
    {
      merchantId,
      name: "Northwind Storefront",
      slug: SITE_SLUG,
      primaryDomain: productHost,
    },
  );

  // 5. Paid, active subscription on the Pro plan.
  await db.collection("subscriptions").updateOne(
    { siteId, productSlug: PRODUCT_SLUG },
    {
      $set: {
        merchantId,
        planCode: PLAN_CODE,
        status: "active",
        updatedAt: now,
      },
      $setOnInsert: {
        siteId,
        productSlug: PRODUCT_SLUG,
        scopeOverrides: null,
        quotaOverrides: null,
        createdAt: now,
      },
    },
    { upsert: true },
  );

  // 5b. Provision the tenant's dedicated product data database (merchant + site +
  // product), record its name on the subscription, and migrate any data that was
  // written to the legacy shared product DB before per-tenant isolation.
  const subscription = await db
    .collection("subscriptions")
    .findOne({ siteId, productSlug: PRODUCT_SLUG }, { projection: { _id: 1 } });
  const dataDbName = buildTenantDbName(
    MERCHANT_SLUG,
    SITE_SLUG,
    PRODUCT_SLUG,
    subscription._id.toString(),
  );
  const tenantDb = mongoose.connection.useDb(dataDbName, { useCache: true });
  await tenantDb.collection("tenantMeta").updateOne(
    { key: "tenant" },
    {
      $set: {
        merchantId: merchantId.toString(),
        siteId: siteId.toString(),
        productSlug: PRODUCT_SLUG,
        updatedAt: now,
      },
      $setOnInsert: { provisionedAt: now },
    },
    { upsert: true },
  );
  await db
    .collection("subscriptions")
    .updateOne({ _id: subscription._id }, { $set: { dataDbName } });

  let migrated = 0;
  if (LEGACY_PRODUCT_DB && LEGACY_PRODUCT_DB !== dataDbName) {
    const legacyDb = mongoose.connection.useDb(LEGACY_PRODUCT_DB, {
      useCache: true,
    });
    migrated = await migrateLegacyData(legacyDb, tenantDb, siteId.toString());
  }

  // 6. Fresh product access token (rotate: the plaintext is only shown once).
  await db
    .collection("productaccesstokens")
    .deleteMany({ siteId, productSlug: PRODUCT_SLUG });
  const { plaintextToken, tokenHash, tokenPrefix } = generateProductToken();
  await db.collection("productaccesstokens").insertOne({
    merchantId,
    siteId,
    productSlug: PRODUCT_SLUG,
    name: "Production test",
    tokenPrefix,
    tokenHash,
    scopes: SCOPES,
    allowedDomains: ALLOWED_DOMAINS,
    revokedAt: null,
    expiresAt: null,
    createdAt: now,
  });

  // 7. Dedicated restricted public sandbox (no user membership or portal login).
  const publicDemoMerchantId = await upsertReturningId(
    db.collection("merchants"),
    { slug: PUBLIC_DEMO_MERCHANT_SLUG },
    { name: "Public Demo Sandbox", slug: PUBLIC_DEMO_MERCHANT_SLUG },
  );
  const publicDemoSiteId = await upsertReturningId(
    db.collection("sites"),
    { merchantId: publicDemoMerchantId, slug: PUBLIC_DEMO_SITE_SLUG },
    {
      merchantId: publicDemoMerchantId,
      name: "Public Chatbot Sandbox",
      slug: PUBLIC_DEMO_SITE_SLUG,
      primaryDomain: productHost,
    },
  );
  await db.collection("subscriptions").updateOne(
    { siteId: publicDemoSiteId, productSlug: PRODUCT_SLUG },
    {
      $set: {
        merchantId: publicDemoMerchantId,
        planCode: PUBLIC_DEMO_PLAN_CODE,
        status: "active",
        updatedAt: now,
      },
      $setOnInsert: {
        siteId: publicDemoSiteId,
        productSlug: PRODUCT_SLUG,
        scopeOverrides: null,
        quotaOverrides: null,
        createdAt: now,
      },
    },
    { upsert: true },
  );
  const publicDemoSubscription = await db
    .collection("subscriptions")
    .findOne(
      { siteId: publicDemoSiteId, productSlug: PRODUCT_SLUG },
      { projection: { _id: 1 } },
    );
  const publicDemoDbName = buildTenantDbName(
    PUBLIC_DEMO_MERCHANT_SLUG,
    PUBLIC_DEMO_SITE_SLUG,
    PRODUCT_SLUG,
    publicDemoSubscription._id.toString(),
  );
  const publicDemoDb = mongoose.connection.useDb(publicDemoDbName, {
    useCache: true,
  });
  await Promise.all(
    ["conversations", "sitesettings", "webhookdeliveries", "usages"].map(
      (collectionName) =>
        publicDemoDb.collection(collectionName).deleteMany({}),
    ),
  );
  await publicDemoDb.collection("tenantMeta").updateOne(
    { key: "tenant" },
    {
      $set: {
        merchantId: publicDemoMerchantId.toString(),
        siteId: publicDemoSiteId.toString(),
        productSlug: PRODUCT_SLUG,
        isPublicDemo: true,
        updatedAt: now,
      },
      $setOnInsert: { provisionedAt: now },
    },
    { upsert: true },
  );
  await db
    .collection("subscriptions")
    .updateOne(
      { _id: publicDemoSubscription._id },
      { $set: { dataDbName: publicDemoDbName } },
    );
  await db
    .collection("productaccesstokens")
    .deleteMany({ siteId: publicDemoSiteId, productSlug: PRODUCT_SLUG });
  const publicDemoToken = generateProductToken();
  await db.collection("productaccesstokens").insertOne({
    merchantId: publicDemoMerchantId,
    siteId: publicDemoSiteId,
    productSlug: PRODUCT_SLUG,
    name: "Restricted public sandbox",
    tokenPrefix: publicDemoToken.tokenPrefix,
    tokenHash: publicDemoToken.tokenHash,
    scopes: SCOPES,
    allowedDomains: ALLOWED_DOMAINS,
    revokedAt: null,
    expiresAt: null,
    createdAt: now,
  });

  await mongoose.disconnect();

  const line = "=".repeat(64);
  console.log(`\n${line}\nDEMO SEED COMPLETE\n${line}`);
  console.log(`\nPlatform admin login (platform portal):`);
  console.log(`  email:    ${adminEmail}`);
  console.log(`  password: ${adminPassword}`);
  console.log(`\nMerchant login (platform portal):`);
  console.log(`  email:    ${OWNER_EMAIL}`);
  console.log(`  password: ${ownerPassword}`);
  console.log(
    `\nProduct:      ${PRODUCT_SLUG} (Pro plan, active subscription)`,
  );
  console.log(
    `Merchant:     Northwind Outfitters  |  Site: Northwind Storefront`,
  );
  console.log(
    `Tenant data DB: ${dataDbName}${migrated > 0 ? `  (migrated ${migrated} docs from ${LEGACY_PRODUCT_DB})` : ""}`,
  );
  console.log(`\nProduct access token (copy now, shown once):`);
  console.log(`  ${plaintextToken}`);
  console.log(`\nSet on the chatbot product host:`);
  console.log(`  PUBLIC_DEMO_PRODUCT_TOKEN=${publicDemoToken.plaintextToken}`);
  console.log(`\nPublic demo tenant DB: ${publicDemoDbName}`);
  console.log(`\nAllowed domains: ${ALLOWED_DOMAINS.join(", ")}`);
  console.log(`\nOpen the guest public demo:`);
  console.log(`  ${productBaseUrl}/public-demo`);
  console.log(`\nOpen a manual token demo:`);
  console.log(`  ${productBaseUrl}/demo?token=${plaintextToken}`);
  console.log(`\n${line}\n`);
}

run().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect();
  process.exit(1);
});
