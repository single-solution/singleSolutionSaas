/**
 * Durable event outbox for `portal.publishEvent`: `enqueue()` writes the complete envelope to the control store keyed
 * by the event id (a second enqueue of the same id is a no-op), then the event is sent right away when possible;
 * `flush()` leases due events, posts them in batches (`POST /v1/product/events`, ≤ 50 events / ~200 kB), acknowledges
 * `accepted` / `duplicate` results (the envelope is dropped, the id kept 7 days for dedupe), dead-letters `rejected`
 * results and permanent 4xx answers, and retries everything else with exponential backoff + jitter (like usage).
 * Events that keep failing are dead-lettered after `maxAttempts`.
 * @module
 */
import { backoffDelay } from './usage.js';
import { isKitError, randomToken } from './util.js';

/** @typedef {import('./stores/types.js').EventOutboxStore} EventOutboxStore */
/** @typedef {import('./logger.js').Logger} Logger */

const RETAIN_MS = 7 * 24 * 60 * 60_000;
const MAX_BATCH_BYTES = 200 * 1024;

/**
 * @param {{
 *   store: EventOutboxStore,
 *   portal: { publishEvents: (events: Record<string, unknown>[]) => Promise<unknown> },
 *   now?: () => number,
 *   randomBytes: (length: number) => Uint8Array,
 *   logger: Logger,
 *   batchSize?: number,
 *   leaseMs?: number,
 *   baseDelayMs?: number,
 *   maxDelayMs?: number,
 *   maxAttempts?: number,
 * }} options
 */
export const createOutbox = ({
	store,
	portal,
	now = Date.now,
	randomBytes,
	logger,
	batchSize = 50,
	leaseMs = 60_000,
	baseDelayMs = 1000,
	maxDelayMs = 60 * 60_000,
	maxAttempts = 20,
}) => {
	const owner = randomToken(randomBytes, 9);
	const random = () => /** @type {number} */ (randomBytes(1)[0]) / 255;

	/**
	 * Store an event (idempotent by `envelope.id`).
	 * @param {Record<string, unknown> & { id: string }} envelope
	 * @returns {Promise<{ inserted: boolean }>}
	 */
	const enqueue = (envelope) => store.enqueue({ id: envelope.id, envelope });

	/**
	 * Split leased events into batches under the byte budget.
	 * @param {import('./stores/types.js').OutboxEvent[]} events
	 */
	const batchesOf = (events) => {
		/** @type {import('./stores/types.js').OutboxEvent[][]} */
		const out = [];
		/** @type {import('./stores/types.js').OutboxEvent[]} */
		let current = [];
		let bytes = 0;
		for (const event of events) {
			const size = Buffer.byteLength(JSON.stringify(event.envelope));
			if (current.length > 0 && bytes + size > MAX_BATCH_BYTES) {
				out.push(current);
				current = [];
				bytes = 0;
			}
			current.push(event);
			bytes += size;
		}
		if (current.length > 0) out.push(current);
		return out;
	};

	/**
	 * Send due events to the Portal (only the website's with `websiteId`).
	 * @param {{ maxBatches?: number, websiteId?: string }} [options]
	 * @returns {Promise<{ sent: number, duplicates: number, rejected: number, failed: number, batches: number }>}
	 */
	const flush = async ({ maxBatches = 20, websiteId } = {}) => {
		const totals = { sent: 0, duplicates: 0, rejected: 0, failed: 0, batches: 0 };
		while (totals.batches < maxBatches) {
			const leased = await store.lease({ now: now(), limit: batchSize, leaseMs, owner, ...(websiteId ? { websiteId } : {}) });
			if (leased.length === 0) break;
			let stop = false;
			for (const batch of batchesOf(leased)) {
				totals.batches += 1;
				const ids = batch.map((event) => event.id);
				/** @type {unknown} */
				let response;
				try {
					response = await portal.publishEvents(batch.map((event) => event.envelope));
				} catch (error) {
					const status = isKitError(error) ? /** @type {any} */ (error).details?.status : undefined;
					const permanent = typeof status === 'number' && status >= 400 && status < 500 && ![408, 425, 429].includes(status);
					const attempt = Math.max(...batch.map((event) => event.attempts)) + 1;
					if (permanent || attempt >= maxAttempts) {
						await store.deadLetter(ids, {
							now: now(),
							error: permanent ? `status_${status}` : 'attempts',
							retainMs: RETAIN_MS,
						});
						totals.rejected += ids.length;
						logger.error('events dead-lettered', { events: ids.length, ...(status ? { status } : {}) });
					} else {
						await store.retry(ids, {
							now: now(),
							nextAttemptAt: now() + backoffDelay(attempt, { baseMs: baseDelayMs, maxMs: maxDelayMs, random }),
							error: isKitError(error) ? error.code : 'error',
						});
						totals.failed += ids.length;
						logger.warn('event publish failed; will retry', { events: ids.length, attempt, ...(status ? { status } : {}) });
						stop = true;
					}
					continue;
				}
				const results = /** @type {any} */ (response)?.results;
				/** @type {Map<string, { status?: string, reason?: string }>} */
				const byId = new Map(Array.isArray(results) ? results.map((r) => [String(r?.id), r]) : []);
				/** @type {string[]} */
				const done = [];
				/** @type {string[]} */
				const dead = [];
				for (const id of ids) {
					// a 2xx without per-event results accepts the whole batch
					const status = Array.isArray(results) ? byId.get(id)?.status : 'accepted';
					if (status === 'rejected') {
						dead.push(id);
						totals.rejected += 1;
						logger.error('event rejected by the Portal', { id, reason: byId.get(id)?.reason ?? 'unknown' });
					} else {
						done.push(id);
						if (status === 'duplicate') totals.duplicates += 1;
						else totals.sent += 1;
					}
				}
				await store.ack(done, { now: now(), retainMs: RETAIN_MS });
				await store.deadLetter(dead, { now: now(), error: 'rejected', retainMs: RETAIN_MS });
			}
			if (stop || leased.length < batchSize) break;
		}
		return totals;
	};

	/**
	 * Store an event and try to send it right away. A failure leaves it queued for `flush()` (never throws for a
	 * delivery failure); a Portal rejection dead-letters it.
	 * @param {Record<string, unknown> & { id: string }} envelope
	 * @returns {Promise<{ queued: boolean, status: 'sent' | 'duplicate' | 'queued' | 'rejected' }>}
	 */
	const publish = async (envelope) => {
		const { inserted } = await enqueue(envelope);
		if (!inserted) return { queued: false, status: 'duplicate' };
		try {
			const response = await portal.publishEvents([envelope]);
			const results = /** @type {any} */ (response)?.results;
			const result = Array.isArray(results) ? results.find((r) => r?.id === envelope.id) : undefined;
			if (result?.status === 'rejected') {
				await store.deadLetter([envelope.id], { now: now(), error: 'rejected', retainMs: RETAIN_MS });
				logger.error('event rejected by the Portal', { id: envelope.id, reason: result.reason ?? 'unknown' });
				return { queued: false, status: 'rejected' };
			}
			await store.ack([envelope.id], { now: now(), retainMs: RETAIN_MS });
			return { queued: false, status: result?.status === 'duplicate' ? 'duplicate' : 'sent' };
		} catch (error) {
			const status = isKitError(error) ? /** @type {any} */ (error).details?.status : undefined;
			await store
				.retry([envelope.id], {
					now: now(),
					nextAttemptAt: now() + backoffDelay(1, { baseMs: baseDelayMs, maxMs: maxDelayMs, random }),
					error: isKitError(error) ? error.code : 'error',
				})
				.catch(() => {});
			logger.warn('event publish failed; queued for retry', { id: envelope.id, ...(status ? { status } : {}) });
			return { queued: true, status: 'queued' };
		}
	};

	return Object.freeze({ enqueue, publish, flush, stats: () => store.stats() });
};
