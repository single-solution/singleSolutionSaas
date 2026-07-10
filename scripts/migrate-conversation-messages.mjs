/**
 * Backfill embedded conversation messages into the Message collection per tenant.
 *
 * Dry-run by default. Pass --apply to insert rows and set messagesMigratedAt.
 * Embedded arrays are never cleared in this pass.
 *
 * Usage:
 *   node --env-file=.env scripts/migrate-conversation-messages.mjs
 *   node --env-file=.env scripts/migrate-conversation-messages.mjs --apply
 *
 * Optional env:
 *   MONGODB_PLATFORM_DB  Platform database name (default: platform)
 *   PRODUCT_SLUG         Limit to one product slug (default: ecommerce-chatbot)
 */

import mongoose from "mongoose";

const SCRIPT_VERSION = "1.0.0";
const CONVERSATION_BATCH_LIMIT = 25;
const TENANT_BATCH_LIMIT = 10;
const CONNECT_TIMEOUT_MS = 15_000;
const JOB_TIMEOUT_MS = 120_000;

const MONGODB_URI = process.env.MONGODB_URI?.trim();
const PLATFORM_DB = process.env.MONGODB_PLATFORM_DB?.trim() || "platform";
const PRODUCT_SLUG = process.env.PRODUCT_SLUG?.trim() || "ecommerce-chatbot";
const apply = process.argv.includes("--apply");

if (!MONGODB_URI) {
  console.error("MONGODB_URI is required.");
  process.exit(1);
}

function legacyClientMessageId(conversationId, messageId) {
  return `legacy:${conversationId}:${messageId}`;
}

async function listTenantDatabases(platformDb) {
  const subscriptions = await platformDb
    .collection("subscriptions")
    .find({ productSlug: PRODUCT_SLUG, dataDbName: { $type: "string", $ne: "" } })
    .project({ dataDbName: 1 })
    .limit(TENANT_BATCH_LIMIT * 5)
    .toArray();
  const unique = new Set();
  for (const subscription of subscriptions) {
    unique.add(subscription.dataDbName.trim());
  }
  return [...unique].slice(0, TENANT_BATCH_LIMIT);
}

async function migrateTenant(dataDbName, report, startedAt) {
  const tenantDb = mongoose.connection.useDb(dataDbName, { useCache: true });
  const conversations = tenantDb.collection("conversations");
  const messages = tenantDb.collection("messages");

  const pending = await conversations
    .find({
      messagesMigratedAt: { $exists: false },
      "messages.0": { $exists: true },
    })
    .project({ messages: 1 })
    .limit(CONVERSATION_BATCH_LIMIT)
    .toArray();

  for (const conversation of pending) {
    if (Date.now() - startedAt > JOB_TIMEOUT_MS) {
      report.timedOut = true;
      return;
    }

    const conversationId = conversation._id;
    const embedded = Array.isArray(conversation.messages) ? conversation.messages : [];
    const existingCount = await messages.countDocuments({ conversationId });
    const planned = [];

    for (const message of embedded) {
      const messageId = message._id?.toString();
      if (!messageId) {
        continue;
      }
      planned.push({
        _id: message._id,
        conversationId,
        clientMessageId: legacyClientMessageId(conversationId.toString(), messageId),
        author: message.author,
        authorName: message.authorName,
        body: message.body,
        createdAt: message.createdAt ?? new Date(),
        ...(message.readByCustomerAt ? { readByCustomerAt: message.readByCustomerAt } : {}),
      });
    }

    const issue =
      existingCount > 0 && existingCount !== planned.length
        ? "count_mismatch_existing"
        : planned.length !== embedded.length
          ? "planned_count_mismatch"
          : null;

    report.tenants[dataDbName].conversations.push({
      conversationId: conversationId.toString(),
      embeddedCount: embedded.length,
      existingMessageCount: existingCount,
      plannedCount: planned.length,
      issue,
    });

    if (issue) {
      report.tenants[dataDbName].issues += 1;
      continue;
    }

    if (!apply) {
      report.tenants[dataDbName].wouldMigrate += 1;
      continue;
    }

    for (const row of planned) {
      await messages.updateOne(
        { conversationId, clientMessageId: row.clientMessageId },
        { $setOnInsert: row },
        { upsert: true },
      );
    }

    const finalCount = await messages.countDocuments({ conversationId });
    if (finalCount !== embedded.length) {
      report.tenants[dataDbName].issues += 1;
      report.tenants[dataDbName].conversations.at(-1).issue = "post_apply_count_mismatch";
      continue;
    }

    await conversations.updateOne(
      { _id: conversationId },
      { $set: { messagesMigratedAt: new Date() } },
    );
    report.tenants[dataDbName].migrated += 1;
  }
}

async function main() {
  const startedAt = Date.now();
  await mongoose.connect(`${MONGODB_URI.replace(/\/$/, "")}/${PLATFORM_DB}`, {
    serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
    connectTimeoutMS: CONNECT_TIMEOUT_MS,
  });
  const platformDb = mongoose.connection.db;
  const tenantNames = await listTenantDatabases(platformDb);

  const report = {
    version: SCRIPT_VERSION,
    dryRun: !apply,
    productSlug: PRODUCT_SLUG,
    tenantCount: tenantNames.length,
    conversationBatchLimit: CONVERSATION_BATCH_LIMIT,
    tenantBatchLimit: TENANT_BATCH_LIMIT,
    timedOut: false,
    durationMs: 0,
    tenants: {},
  };

  for (const dataDbName of tenantNames) {
    if (Date.now() - startedAt > JOB_TIMEOUT_MS) {
      report.timedOut = true;
      break;
    }
    report.tenants[dataDbName] = {
      wouldMigrate: 0,
      migrated: 0,
      issues: 0,
      conversations: [],
    };
    await migrateTenant(dataDbName, report, startedAt);
  }

  report.durationMs = Date.now() - startedAt;
  console.log(JSON.stringify(report, null, 2));
  if (!apply && Object.values(report.tenants).some((tenant) => tenant.wouldMigrate > 0)) {
    console.log("Re-run with --apply to backfill Message rows. Embedded arrays are preserved.");
  }
  if (report.timedOut) {
    console.log("Stopped early due to timeout; re-run to continue.");
  }
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
