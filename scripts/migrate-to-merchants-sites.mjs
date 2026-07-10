/**
 * Migrates the legacy "organization" model to the "merchant + site" model.
 *
 * Dry-run by default. Pass --apply to execute writes.
 * Idempotent: safe to re-run with --apply.
 *
 * Usage:
 *   node --env-file=.env scripts/migrate-to-merchants-sites.mjs
 *   node --env-file=.env scripts/migrate-to-merchants-sites.mjs --apply
 */
import mongoose from "mongoose";

const SCRIPT_VERSION = "1.0.0";
const CONNECT_TIMEOUT_MS = 15_000;
const { Types } = mongoose;

const uri = process.env.MONGODB_URI?.trim();
const apply = process.argv.includes("--apply");

if (!uri) {
  console.error("MONGODB_URI is required.");
  process.exit(1);
}
const platformDbName = process.env.MONGODB_PLATFORM_DB?.trim() || "platform";
const chatbotDbName = process.env.MONGODB_CHATBOT_DB?.trim() || "chatbot";

async function listCollectionNames(connection) {
  const database = connection.db ?? connection;
  const cursor = database.listCollections();
  const collections = typeof cursor.toArray === "function" ? await cursor.toArray() : await cursor;
  return new Set(collections.map((collection) => collection.name));
}

async function planRenameCollection(db, from, to, report) {
  const names = await listCollectionNames(db);
  if (names.has(to)) {
    report.skipped.push(`rename ${from} -> ${to} (target exists)`);
    return;
  }
  if (!names.has(from)) {
    report.skipped.push(`rename ${from} -> ${to} (source missing)`);
    return;
  }
  report.planned.push(`rename collection ${from} -> ${to}`);
}

async function executeRenameCollection(db, from, to) {
  await db.collection(from).rename(to);
  console.log(`  renamed ${from} -> ${to}`);
}

async function countFieldRename(db, collection, from) {
  const names = await listCollectionNames(db);
  if (!names.has(collection)) {
    return 0;
  }
  return db.collection(collection).countDocuments({ [from]: { $exists: true } });
}

async function resolveCollectionName(db, preferred, legacy) {
  const names = await listCollectionNames(db);
  if (names.has(preferred)) {
    return preferred;
  }
  if (names.has(legacy)) {
    return legacy;
  }
  return null;
}

async function run() {
  const startedAt = Date.now();
  await mongoose.connect(uri.replace(/\/$/, ""), {
    serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
    connectTimeoutMS: CONNECT_TIMEOUT_MS,
  });
  const conn = mongoose.connection;
  const platform = conn.useDb(platformDbName, { useCache: true });
  const chatbot = conn.useDb(chatbotDbName, { useCache: true });

  const report = {
    version: SCRIPT_VERSION,
    dryRun: !apply,
    platformDb: platformDbName,
    chatbotDb: chatbotDbName,
    planned: [],
    skipped: [],
    counts: {},
    durationMs: 0,
  };

  await planRenameCollection(platform, "organizations", "merchants", report);
  await planRenameCollection(platform, "organizationmemberships", "merchantmemberships", report);
  await planRenameCollection(platform, "organizationproducts", "subscriptions", report);

  const membershipCollection = await resolveCollectionName(
    platform,
    "merchantmemberships",
    "organizationmemberships",
  );
  const subscriptionCollection = await resolveCollectionName(
    platform,
    "subscriptions",
    "organizationproducts",
  );

  for (const [collection, from, to] of [
    [membershipCollection, "organizationId", "merchantId"],
    [subscriptionCollection, "organizationId", "merchantId"],
    ["productaccesstokens", "organizationId", "merchantId"],
    ["auditlogs", "organizationId", "merchantId"],
  ]) {
    if (!collection) {
      continue;
    }
    const count = await countFieldRename(platform, collection, from);
    if (count > 0) {
      report.planned.push(`${collection}: rename field ${from} -> ${to} (${count} docs)`);
    }
    report.counts[`${collection}.${from}`] = count;
  }

  const merchantCollection = (await listCollectionNames(platform)).has("merchants")
    ? "merchants"
    : (await listCollectionNames(platform)).has("organizations")
      ? "organizations"
      : null;
  const merchants = merchantCollection
    ? await platform.collection(merchantCollection).find({}, { projection: { _id: 1 } }).toArray()
    : [];
  let sitesToCreate = 0;
  for (const merchant of merchants) {
    const existing = await platform.collection("sites").findOne({ merchantId: merchant._id });
    if (!existing) {
      sitesToCreate += 1;
    }
  }
  report.counts.defaultSitesToCreate = sitesToCreate;

  for (const collection of [subscriptionCollection, "productaccesstokens"]) {
    if (!collection) {
      continue;
    }
    const count = await platform.collection(collection).countDocuments({ siteId: { $exists: false } });
    report.counts[`${collection}.missingSiteId`] = count;
    if (count > 0) {
      report.planned.push(`${collection}: backfill siteId (${count} docs)`);
    }
  }

  const usageCount = await platform.collection("productusages").countDocuments({ organizationId: { $exists: true } });
  report.counts.productusagesWithOrganizationId = usageCount;
  if (usageCount > 0) {
    report.planned.push(`productusages: remap organizationId -> siteId (${usageCount} docs)`);
  }

  const chatbotCollections = await listCollectionNames(chatbot);
  if (chatbotCollections.has("conversations")) {
    const convoCount = await chatbot.collection("conversations").countDocuments({ organizationId: { $exists: true } });
    report.counts.conversationsWithOrganizationId = convoCount;
    if (convoCount > 0) {
      report.planned.push(`chatbot conversations: remap organizationId -> siteId (${convoCount} docs)`);
    }
  }

  console.log(JSON.stringify(report, null, 2));

  if (!apply) {
    if (report.planned.length > 0) {
      console.log("Re-run with --apply to execute planned changes.");
    }
    report.durationMs = Date.now() - startedAt;
    await mongoose.disconnect();
    return;
  }

  console.log("Applying migration...");
  await executeRenameCollection(platform, "organizations", "merchants");
  await executeRenameCollection(platform, "organizationmemberships", "merchantmemberships");
  await executeRenameCollection(platform, "organizationproducts", "subscriptions");

  for (const [collection, from, to] of [
    ["merchantmemberships", "organizationId", "merchantId"],
    ["subscriptions", "organizationId", "merchantId"],
    ["productaccesstokens", "organizationId", "merchantId"],
    ["auditlogs", "organizationId", "merchantId"],
  ]) {
    const names = await listCollectionNames(platform);
    if (!names.has(collection)) {
      continue;
    }
    const result = await platform
      .collection(collection)
      .updateMany({ [from]: { $exists: true } }, { $rename: { [from]: to } });
    if (result.modifiedCount > 0) {
      console.log(`  ${collection}: renamed field ${from} -> ${to} on ${result.modifiedCount} doc(s)`);
    }
  }

  const siteByMerchant = new Map();
  for (const merchant of await platform.collection("merchants").find({}, { projection: { _id: 1 } }).toArray()) {
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

  const chatbotNames = await listCollectionNames(chatbot);
  if (chatbotNames.has("conversations")) {
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
  }

  console.log("Done.");
  report.durationMs = Date.now() - startedAt;
  await mongoose.disconnect();
}

run().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect();
  process.exit(1);
});
