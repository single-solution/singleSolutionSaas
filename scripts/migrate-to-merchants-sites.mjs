/**
 * Migrates the legacy "organization" model to the "merchant + site" model.
 *
 * Idempotent: safe to re-run. It renames collections/fields, creates one
 * default site per merchant, backfills siteId on subscriptions/tokens/usage,
 * and remaps chatbot conversations from organizationId to siteId.
 *
 * Run (Node 20+):
 *   node --env-file=.env scripts/migrate-to-merchants-sites.mjs
 */
import mongoose from "mongoose";

const { Types } = mongoose;

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGODB_URI is required.");
  process.exit(1);
}
const platformDbName = process.env.MONGODB_PLATFORM_DB?.trim() || "platform";
const chatbotDbName = process.env.MONGODB_CHATBOT_DB?.trim() || "chatbot";

async function listCollectionNames(db) {
  const collections = await db.listCollections().toArray();
  return new Set(collections.map((collection) => collection.name));
}

async function renameCollection(db, from, to) {
  const names = await listCollectionNames(db);
  if (names.has(to)) {
    console.log(`  skip rename ${from} -> ${to} (target exists)`);
    return;
  }
  if (!names.has(from)) {
    console.log(`  skip rename ${from} -> ${to} (source missing)`);
    return;
  }
  await db.collection(from).rename(to);
  console.log(`  renamed ${from} -> ${to}`);
}

async function renameField(db, collection, from, to) {
  const names = await listCollectionNames(db);
  if (!names.has(collection)) {
    return;
  }
  const result = await db.collection(collection).updateMany({ [from]: { $exists: true } }, { $rename: { [from]: to } });
  if (result.modifiedCount > 0) {
    console.log(`  ${collection}: renamed field ${from} -> ${to} on ${result.modifiedCount} doc(s)`);
  }
}

async function run() {
  await mongoose.connect(uri.replace(/\/$/, ""));
  const conn = mongoose.connection;
  const platform = conn.useDb(platformDbName, { useCache: true });
  const chatbot = conn.useDb(chatbotDbName, { useCache: true });

  console.log(`Platform DB: ${platformDbName}`);
  console.log(`Chatbot DB:  ${chatbotDbName}`);

  console.log("1. Renaming collections...");
  await renameCollection(platform, "organizations", "merchants");
  await renameCollection(platform, "organizationmemberships", "merchantmemberships");
  await renameCollection(platform, "organizationproducts", "subscriptions");

  console.log("2. Renaming organizationId -> merchantId...");
  await renameField(platform, "merchantmemberships", "organizationId", "merchantId");
  await renameField(platform, "subscriptions", "organizationId", "merchantId");
  await renameField(platform, "productaccesstokens", "organizationId", "merchantId");
  await renameField(platform, "auditlogs", "organizationId", "merchantId");

  console.log("3. Ensuring a default site per merchant...");
  const merchants = await platform.collection("merchants").find({}, { projection: { _id: 1 } }).toArray();
  const siteByMerchant = new Map();
  for (const merchant of merchants) {
    const existing = await platform.collection("sites").findOne({ merchantId: merchant._id });
    if (existing) {
      siteByMerchant.set(merchant._id.toString(), existing._id);
      continue;
    }
    const now = new Date();
    const site = {
      _id: new Types.ObjectId(),
      merchantId: merchant._id,
      name: "Default site",
      slug: "default-site",
      primaryDomain: "",
      createdAt: now,
      updatedAt: now,
    };
    await platform.collection("sites").insertOne(site);
    siteByMerchant.set(merchant._id.toString(), site._id);
    console.log(`  created default site for merchant ${merchant._id.toString()}`);
  }

  console.log("4. Backfilling siteId on subscriptions / tokens...");
  for (const collection of ["subscriptions", "productaccesstokens"]) {
    const docs = await platform.collection(collection).find({ siteId: { $exists: false } }).toArray();
    for (const doc of docs) {
      const siteId = siteByMerchant.get(doc.merchantId?.toString());
      if (!siteId) {
        console.warn(`  ${collection}: no site for merchant ${doc.merchantId?.toString()} (doc ${doc._id})`);
        continue;
      }
      await platform.collection(collection).updateOne({ _id: doc._id }, { $set: { siteId } });
    }
    console.log(`  ${collection}: backfilled ${docs.length} doc(s)`);
  }

  console.log("5. Remapping productusages organizationId -> siteId...");
  const usageDocs = await platform.collection("productusages").find({ organizationId: { $exists: true } }).toArray();
  for (const doc of usageDocs) {
    const siteId = siteByMerchant.get(doc.organizationId?.toString());
    if (!siteId) {
      console.warn(`  productusages: no site for org ${doc.organizationId?.toString()} (doc ${doc._id})`);
      continue;
    }
    await platform
      .collection("productusages")
      .updateOne({ _id: doc._id }, { $set: { siteId }, $unset: { organizationId: "" } });
  }
  console.log(`  productusages: remapped ${usageDocs.length} doc(s)`);

  console.log("6. Remapping chatbot conversations organizationId -> siteId...");
  const chatbotCollections = await listCollectionNames(chatbot);
  if (chatbotCollections.has("conversations")) {
    const convoDocs = await chatbot.collection("conversations").find({ organizationId: { $exists: true } }).toArray();
    for (const doc of convoDocs) {
      const siteId = siteByMerchant.get(doc.organizationId?.toString());
      if (!siteId) {
        console.warn(`  conversations: no site for org ${doc.organizationId?.toString()} (doc ${doc._id})`);
        continue;
      }
      await chatbot
        .collection("conversations")
        .updateOne({ _id: doc._id }, { $set: { siteId }, $unset: { organizationId: "" } });
    }
    console.log(`  conversations: remapped ${convoDocs.length} doc(s)`);
  } else {
    console.log("  skip (no conversations collection)");
  }

  console.log("Done.");
  await mongoose.disconnect();
}

run().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect();
  process.exit(1);
});
