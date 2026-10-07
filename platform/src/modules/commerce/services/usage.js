/**
 * Usage ingestion (F.9 `POST /v1/product/usage`): exactly once per `(subscriptionId, idempotencyKey)` by a unique
 * index on the append-only usage records, bucketed by the UTC hour in which the Portal **received** them, with hourly
 * counters for quotas. Usage is never charged (PLAN 0.5.3: charges do not depend on traffic).
 * A record that makes a hard-stop quota exhausted invalidates the subscription's document (feature `quota_exhausted`).
 * @module
 */
import { floorHour, periodBounds } from '@ss/entitlements';
import { knownUnits } from '../core/catalog.js';
import { quotaCrossed } from '../core/documents.js';
import { checkUsageRecord } from '../core/validate.js';

/** @typedef {import('../../../infra/modules.js').ModuleContext} ModuleContext */
/** @typedef {import('../repo.js').CommerceRepo} CommerceRepo */
/** @typedef {import('./deps.js').Deps} Deps */
/** @typedef {import('./subscriptions.js').Subscriptions} Subscriptions */
/** @typedef {{ idempotencyKey: string | null, status: 'accepted' | 'duplicate' | 'rejected', reason?: string }} UsageResult */

/**
 * @param {{ ctx: ModuleContext, repo: CommerceRepo, deps: Deps, subscriptions: Subscriptions }} input
 */
export const createUsage = ({ ctx, repo, deps, subscriptions }) => {
	/**
	 * @param {{ appId: string, records: readonly unknown[] }} input
	 * @returns {Promise<{ results: UsageResult[] }>}
	 */
	const recordUsage = async ({ appId, records }) => {
		const now = ctx.now();
		const bucket = new Date(floorHour(now));
		/** @type {Map<string, Promise<Record<string, any> | null>>} */
		const subs = new Map();
		/** @type {Map<string, Set<string>>} */
		const touched = new Map();
		/** @type {UsageResult[]} */
		const results = [];
		for (const raw of records) {
			const checked = checkUsageRecord(raw);
			if (!checked.ok) {
				results.push({ idempotencyKey: checked.idempotencyKey, status: 'rejected', reason: checked.reason });
				continue;
			}
			const record = checked.value;
			const reject = (/** @type {string} */ reason) =>
				results.push({ idempotencyKey: record.idempotencyKey, status: 'rejected', reason });
			if (!subs.has(record.subscriptionId)) subs.set(record.subscriptionId, repo.subscriptionById(record.subscriptionId));
			const sub = await subs.get(record.subscriptionId);
			if (!sub || sub.cancelledAt) {
				reject('not_subscribed');
				continue;
			}
			if (sub.appId !== appId || sub.websiteId !== record.websiteId) {
				reject('subscription_mismatch');
				continue;
			}
			const { product } = await deps.manifestOf(sub.appId, sub.manifestVersion);
			if (!knownUnits(product).has(record.unit)) {
				reject('unknown_unit');
				continue;
			}
			try {
				await repo.insertUsage(sub.merchantId, {
					subscriptionId: sub._id,
					websiteId: sub.websiteId,
					appId,
					unit: record.unit,
					quantity: record.quantity,
					idempotencyKey: record.idempotencyKey,
					occurredAt: record.occurredAt,
					receivedAt: new Date(now),
					bucket,
				});
			} catch (error) {
				if (repo.isDuplicateKey(error)) {
					results.push({ idempotencyKey: record.idempotencyKey, status: 'duplicate' });
					continue;
				}
				throw error;
			}
			if (record.quantity > 0) await repo.incCounter(sub.merchantId, sub._id, record.unit, bucket, record.quantity);
			results.push({ idempotencyKey: record.idempotencyKey, status: 'accepted' });
			const units = touched.get(sub._id) ?? new Set();
			units.add(record.unit);
			touched.set(sub._id, units);
		}
		for (const [subscriptionId, units] of touched) {
			const sub = /** @type {any} */ (await subs.get(subscriptionId));
			await checkQuotas(sub, units, now);
		}
		return { results };
	};

	/**
	 * Invalidate the document when a hard-stop quota counting one of `units` has just been exhausted.
	 * @param {Record<string, any>} sub @param {Set<string>} units @param {number} now
	 */
	const checkQuotas = async (sub, units, now) => {
		const doc = await repo.documentOf(sub.merchantId, sub._id);
		/** @type {{ key: string, unit: string, period: 'hour' | 'day' | 'week' | 'month', limit: number, blocked: boolean }[]} */
		const watch = (doc?.quotas ?? []).filter((/** @type {{ unit: string }} */ q) => units.has(q.unit));
		if (watch.length === 0) return;
		const website = await deps.getWebsite(sub.websiteId);
		/** @type {Record<string, number>} */
		const used = {};
		for (const quota of watch) {
			const period = periodBounds({ unit: quota.period, timeZone: website.timeZone ?? 'UTC', at: now });
			const sums = await repo.countersBetween(
				sub.merchantId,
				sub._id,
				[quota.unit],
				new Date(period.start),
				new Date(period.end),
			);
			used[quota.key] = sums[quota.unit] ?? 0;
		}
		if (quotaCrossed(watch, used)) await subscriptions.refreshQuietly(sub);
	};

	return Object.freeze({ recordUsage });
};
/** @typedef {ReturnType<typeof createUsage>} Usage */
