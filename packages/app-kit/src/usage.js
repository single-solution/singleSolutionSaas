/**
 * Usage reporting, exactly once: `record()` writes to a durable queue keyed by `idempotencyKey` (a second record
 * with the same key is a no-op, even after it was sent), `flush()` leases due records, sends them to the Portal in
 * batches with the same idempotency keys (the Portal deduplicates too), acknowledges accepted and duplicate
 * results, dead-letters permanent rejections and retries everything else with exponential backoff + jitter.
 * @module
 */
import { kitError, isKitError, randomToken, sha256Hex } from './util.js';

/** @typedef {import('./stores/types.js').UsageQueueStore} UsageQueueStore */
/** @typedef {import('./stores/types.js').UsageRecord} UsageRecord */
/** @typedef {import('./logger.js').Logger} Logger */

const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;
const UNIT_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * Backoff delay for the n-th failed attempt (1-based): base × 2^(n−1), capped, with up to 20 % jitter.
 * @param {number} attempt
 * @param {{ baseMs: number, maxMs: number, random: () => number }} options
 * @returns {number}
 */
export const backoffDelay = (attempt, { baseMs, maxMs, random }) => {
	const raw = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
	return Math.round(raw * (1 + 0.2 * random()));
};

/**
 * @param {{
 *   queue: UsageQueueStore,
 *   portal: { usage: (records: UsageRecord[], options?: { idempotencyKey?: string }) => Promise<{ results: Array<{ idempotencyKey: string, status: string, reason?: string }> }> },
 *   units?: string[] | null,
 *   now?: () => number,
 *   randomBytes: (length: number) => Uint8Array,
 *   logger: Logger,
 *   batchSize?: number,
 *   leaseMs?: number,
 *   baseDelayMs?: number,
 *   maxDelayMs?: number,
 *   retainMs?: number,
 *   subscriptionFor?: ((websiteId: string) => Promise<string | null>) | null,
 * }} options `subscriptionFor` fills a missing `subscriptionId` (the product wiring reads it from the entitlement) `units` restricts `record()` to the metered units declared in the manifest (null = any unit).
 */
export const createUsage = ({
	queue,
	portal,
	units = null,
	now = Date.now,
	randomBytes,
	logger,
	batchSize = 500,
	leaseMs = 60_000,
	baseDelayMs = 1000,
	maxDelayMs = 60 * 60_000,
	retainMs = 35 * 24 * 60 * 60_000,
	subscriptionFor = null,
}) => {
	const owner = randomToken(randomBytes, 9);
	const random = () => /** @type {number} */ (randomBytes(1)[0]) / 255;
	const allowed = units ? new Set(units) : null;

	/**
	 * Record a usage quantity (durable; safe to call again with the same idempotencyKey).
	 * @param {{ websiteId: string, subscriptionId?: string, unit: string, quantity: number, idempotencyKey: string, occurredAt?: string | number | Date }} input
	 * @returns {Promise<{ ok: true, duplicate: boolean }>}
	 */
	const record = async ({ websiteId, subscriptionId: given, unit, quantity, idempotencyKey, occurredAt }) => {
		if (typeof websiteId !== 'string' || websiteId === '') throw kitError('invalid_usage', 'websiteId is required');
		const subscriptionId = given ?? (subscriptionFor ? await subscriptionFor(websiteId) : null);
		if (typeof subscriptionId !== 'string' || subscriptionId === '') {
			throw kitError('invalid_usage', 'subscriptionId is required (none given and no entitlement found)');
		}
		if (typeof unit !== 'string' || !UNIT_PATTERN.test(unit)) throw kitError('invalid_usage', 'unit must be snake_case');
		if (allowed && !allowed.has(unit)) throw kitError('invalid_usage', `unit '${unit}' is not a metered unit of this product`);
		if (!Number.isSafeInteger(quantity) || quantity <= 0)
			throw kitError('invalid_usage', 'quantity must be a positive integer');
		if (typeof idempotencyKey !== 'string' || !KEY_PATTERN.test(idempotencyKey)) {
			throw kitError('invalid_usage', 'idempotencyKey must be 1..255 printable ASCII characters');
		}
		const at = occurredAt === undefined ? new Date(now()) : new Date(occurredAt);
		if (Number.isNaN(at.getTime())) throw kitError('invalid_usage', 'occurredAt is invalid');
		const { inserted } = await queue.enqueue({
			idempotencyKey,
			websiteId,
			subscriptionId,
			unit,
			quantity,
			occurredAt: at.toISOString(),
		});
		return { ok: true, duplicate: !inserted };
	};

	/**
	 * Send due records to the Portal (only the website's with `websiteId`).
	 * @param {{ maxBatches?: number, websiteId?: string }} [options]
	 * @returns {Promise<{ sent: number, duplicates: number, rejected: number, failed: number, batches: number }>}
	 */
	const flush = async ({ maxBatches = 20, websiteId: only } = {}) => {
		const totals = { sent: 0, duplicates: 0, rejected: 0, failed: 0, batches: 0 };
		for (let i = 0; i < maxBatches; i += 1) {
			const leased = await queue.lease({ now: now(), limit: batchSize, leaseMs, owner, ...(only ? { websiteId: only } : {}) });
			if (leased.length === 0) break;
			totals.batches += 1;
			const records = leased.map(({ idempotencyKey, websiteId, subscriptionId, unit, quantity, occurredAt }) => ({
				idempotencyKey,
				websiteId,
				subscriptionId,
				unit,
				quantity,
				occurredAt,
			}));
			const batchKey = `usage-${sha256Hex(
				records
					.map((r) => r.idempotencyKey)
					.sort()
					.join('\n'),
			).slice(0, 48)}`;
			/** @type {Awaited<ReturnType<typeof portal.usage>>} */
			let response;
			try {
				response = await portal.usage(records, { idempotencyKey: batchKey });
			} catch (error) {
				const status = isKitError(error) ? /** @type {any} */ (error).details?.status : undefined;
				const attempt = Math.max(...leased.map((r) => r.attempts)) + 1;
				await queue.retry(
					records.map((r) => r.idempotencyKey),
					{
						now: now(),
						nextAttemptAt: now() + backoffDelay(attempt, { baseMs: baseDelayMs, maxMs: maxDelayMs, random }),
						error: isKitError(error) ? error.code : 'error',
					},
				);
				totals.failed += records.length;
				logger.warn('usage flush failed; will retry', { records: records.length, attempt, ...(status ? { status } : {}) });
				break;
			}
			const byKey = new Map(response.results.map((result) => [result.idempotencyKey, result]));
			/** @type {string[]} */
			const done = [];
			/** @type {string[]} */
			const dead = [];
			/** @type {string[]} */
			const again = [];
			for (const { idempotencyKey } of records) {
				const result = byKey.get(idempotencyKey);
				if (result?.status === 'accepted') {
					done.push(idempotencyKey);
					totals.sent += 1;
				} else if (result?.status === 'duplicate') {
					done.push(idempotencyKey);
					totals.duplicates += 1;
				} else if (result?.status === 'rejected') {
					dead.push(idempotencyKey);
					totals.rejected += 1;
					logger.error('usage record rejected by the Portal', { idempotencyKey, reason: result.reason ?? 'unknown' });
				} else {
					again.push(idempotencyKey);
					totals.failed += 1;
				}
			}
			await queue.ack(done, { now: now(), retainMs });
			await queue.deadLetter(dead, { now: now(), error: 'rejected' });
			if (again.length > 0) {
				await queue.retry(again, { now: now(), nextAttemptAt: now() + baseDelayMs, error: 'no_result' });
			}
			if (leased.length < batchSize) break;
		}
		return totals;
	};

	return Object.freeze({ record, flush, stats: () => queue.stats() });
};
