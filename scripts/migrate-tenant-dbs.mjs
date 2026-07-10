/**
 * One-time migration to per-tenant product data databases.
 *
 * For every subscription it:
 *   - builds and records the tenant database name (merchant + site + product)
 *   - provisions the tenant database (marker document)
 *   - moves any product data that predates isolation from the legacy shared
 *     product database into the tenant database (matched by siteId)
 *
 * Non-destructive to tokens/credentials. Idempotent: re-running only fills gaps.
 *
 * Run (Node 20+):
 *   node --env-file=.env scripts/migrate-tenant-dbs.mjs
 *
 * Optional env:
 *   LEGACY_PRODUCT_DB  Shared product DB to drain (default: ecommerce-chatbot)
 */
import mongoose from "mongoose";

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGODB_URI is required.");
  process.exit(1);
}

const platformDbName = process.env.MONGODB_PLATFORM_DB?.trim() || "platform";
const LEGACY_PRODUCT_DB = process.env.LEGACY_PRODUCT_DB?.trim() || "ecommerce-chatbot";

function sanitizeSegment(value, maxLength) {
  const cleaned = String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, maxLength) || "x";
}

function buildTenantDbName(merchantSlug, siteSlug, productSlug, subscriptionId) {
  const suffix = String(subscriptionId).replace(/[^a-z0-9]/gi, "").slice(-8).toLowerCase() || "0";
  return `t-${sanitizeSegment(merchantSlug, 8)}-${sanitizeSegment(siteSlug, 6)}-${sanitizeSegment(productSlug, 8)}-${suffix}`.slice(0, 38);
}

async function migrateLegacyData(legacyDb, tenantDb, siteId) {
  const collections = ["conversations", "sitesettings", "webhookdeliveries", "usages"];
  let moved = 0;
  for (const name of collections) {
    const docs = await legacyDb.collection(name).find({ siteId }).toArray();
    for (const doc of docs) {
      await tenantDb.collection(name).updateOne({ _id: doc._id }, { $setOnInsert: doc }, { upsert: true });
      moved += 1;
    }
    if (docs.length > 0) {
      await legacyDb.collection(name).deleteMany({ siteId });
    }
  }
  return moved;
}

async function run() {
  await mongoose.connect(uri.replace(/\/$/, ""));
  const db = mongoose.connection.useDb(platformDbName, { useCache: true });
  const legacyDb = mongoose.connection.useDb(LEGACY_PRODUCT_DB, { useCache: true });
  const now = new Date();

  const subscriptions = await db.collection("subscriptions").find({}).toArray();
  let provisioned = 0;
  let migratedTotal = 0;

  for (const subscription of subscriptions) {
    const [merchant, site] = await Promise.all([
      db.collection("merchants").findOne({ _id: subscription.merchantId }, { projection: { slug: 1 } }),
      db.collection("sites").findOne({ _id: subscription.siteId }, { projection: { slug: 1 } }),
    ]);
    const dataDbName =
      subscription.dataDbName ||
      buildTenantDbName(
        merchant?.slug ?? String(subscription.merchantId),
        site?.slug ?? String(subscription.siteId),
        subscription.productSlug,
        subscription._id.toString(),
      );

    const tenantDb = mongoose.connection.useDb(dataDbName, { useCache: true });
    await tenantDb.collection("tenantMeta").updateOne(
      { key: "tenant" },
      {
        $set: {
          merchantId: String(subscription.merchantId),
          siteId: String(subscription.siteId),
          productSlug: subscription.productSlug,
          updatedAt: now,
        },
        $setOnInsert: { provisionedAt: now },
      },
      { upsert: true },
    );
    if (!subscription.dataDbName) {
      await db.collection("subscriptions").updateOne({ _id: subscription._id }, { $set: { dataDbName } });
      provisioned += 1;
    }

    if (LEGACY_PRODUCT_DB !== dataDbName) {
      migratedTotal += await migrateLegacyData(legacyDb, tenantDb, String(subscription.siteId));
    }
    console.log(`  ${subscription.productSlug} / site ${subscription.siteId} -> ${dataDbName}`);
  }

  await mongoose.disconnect();
  console.log(`\nDone. ${subscriptions.length} subscriptions, ${provisioned} newly named, ${migratedTotal} docs migrated from ${LEGACY_PRODUCT_DB}.`);
}

run().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect();
  process.exit(1);
});
