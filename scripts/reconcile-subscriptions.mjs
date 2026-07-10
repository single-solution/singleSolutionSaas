/**
 * Reconciles legacy subscription assignments (dry-run by default).
 *
 * Usage:
 *   node --env-file=.env scripts/reconcile-subscriptions.mjs
 *   node --env-file=.env scripts/reconcile-subscriptions.mjs --apply
 */

import mongoose from "mongoose";

const SCRIPT_VERSION = "1.0.0";
const BATCH_LIMIT = 100;
const CONNECT_TIMEOUT_MS = 15_000;
const JOB_TIMEOUT_MS = 120_000;

const MONGODB_URI = process.env.MONGODB_URI?.trim();
const MONGODB_DB = process.env.MONGODB_DB?.trim() || process.env.MONGODB_PLATFORM_DB?.trim() || "platform";
const apply = process.argv.includes("--apply");

if (!MONGODB_URI) {
  console.error("MONGODB_URI is required.");
  process.exit(1);
}

const RETENTION_MS = 30 * 24 * 60 * 60_000;

function normalizeLegacyStatus(subscription) {
  if (subscription.status === "active" && !subscription.planCode) {
    return "archived";
  }
  return subscription.status;
}

async function main() {
  const startedAt = Date.now();
  await mongoose.connect(`${MONGODB_URI.replace(/\/$/, "")}/${MONGODB_DB}`, {
    serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
    connectTimeoutMS: CONNECT_TIMEOUT_MS,
  });
  const db = mongoose.connection.db;
  const subscriptions = db.collection("subscriptions");
  const products = db.collection("products");
  const tokens = db.collection("productaccesstokens");

  const totalCount = await subscriptions.countDocuments({});
  const productRows = await products.find({}).toArray();
  const productBySlug = new Map(productRows.map((product) => [product.slug, product]));
  const rows = await subscriptions.find({}).limit(BATCH_LIMIT).toArray();

  const issues = [];
  let fixed = 0;

  for (const subscription of rows) {
    if (Date.now() - startedAt > JOB_TIMEOUT_MS) {
      break;
    }
    const product = productBySlug.get(subscription.productSlug);
    const normalized = normalizeLegacyStatus(subscription);

    if (normalized !== subscription.status) {
      issues.push({
        subscriptionId: subscription._id.toString(),
        issue: "active_without_plan",
        proposedStatus: "archived",
      });
      if (apply) {
        await subscriptions.updateOne(
          { _id: subscription._id },
          {
            $set: {
              status: "archived",
              deletionEligibleAt: new Date(Date.now() + RETENTION_MS),
            },
            $push: {
              lifecycleHistory: {
                fromStatus: subscription.status,
                toStatus: "archived",
                actorUserId: null,
                reason: "subscription reconciliation",
                at: new Date(),
              },
            },
          },
        );
        fixed += 1;
      }
      continue;
    }

    if (
      (subscription.status === "active" || subscription.status === "suspended") &&
      subscription.planCode &&
      product &&
      !product.plans?.some((plan) => plan.code === subscription.planCode)
    ) {
      issues.push({
        subscriptionId: subscription._id.toString(),
        issue: "orphan_plan_code",
        proposedStatus: "archived",
      });
      if (apply) {
        await subscriptions.updateOne(
          { _id: subscription._id },
          {
            $set: {
              status: "archived",
              deletionEligibleAt: new Date(Date.now() + RETENTION_MS),
            },
            $push: {
              lifecycleHistory: {
                fromStatus: subscription.status,
                toStatus: "archived",
                actorUserId: null,
                reason: "subscription reconciliation",
                at: new Date(),
              },
            },
          },
        );
        fixed += 1;
      }
    }

    if (subscription.status === "archived") {
      const activeTokenCount = await tokens.countDocuments({
        siteId: subscription.siteId,
        productSlug: subscription.productSlug,
        revokedAt: null,
      });
      if (activeTokenCount > 0) {
        issues.push({
          subscriptionId: subscription._id.toString(),
          issue: "archived_with_active_tokens",
          activeTokenCount,
        });
        if (apply) {
          await tokens.updateMany(
            {
              siteId: subscription.siteId,
              productSlug: subscription.productSlug,
              revokedAt: null,
            },
            { $set: { revokedAt: new Date() } },
          );
          fixed += 1;
        }
      }
    }
  }

  const timedOut = Date.now() - startedAt > JOB_TIMEOUT_MS;
  console.log(
    JSON.stringify(
      {
        version: SCRIPT_VERSION,
        dryRun: !apply,
        scanned: rows.length,
        totalSubscriptions: totalCount,
        batchLimit: BATCH_LIMIT,
        remainingAfterBatch: Math.max(0, totalCount - rows.length),
        issues,
        fixed,
        timedOut,
        durationMs: Date.now() - startedAt,
      },
      null,
      2,
    ),
  );
  if (!apply && issues.length > 0) {
    console.log("Re-run with --apply to repair drift.");
  }
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
