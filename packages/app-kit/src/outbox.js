/**
 * Durable event outbox for `portal.publishEvent`: `enqueue()` writes the complete envelope to the control store keyed
 * by the event id (a second enqueue of the same id is a no-op), then the event is sent right away when possible;
 * `flush()` leases due events, posts them in batches (`POST /v1/product/events`, ≤ 50 events / ~200 kB), acknowledges
 * `accepted` / `duplicate` results (the envelope is dropped, the id kept 7 days for dedupe), and retries everything
 * else with exponential backoff + jitter (like usage) within a bounded retry window (`maxAttempts`, ~a day with the
 * default backoff). `rejected` results, permanent 4xx answers and events past the retry window are dropped with an
 * error log through the kit logger (no dead-letter store).
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
						await store.ack(ids, { now: now(), retainMs: RETAIN_MS });
						totals.rejected += ids.length;
						logger.error('events dropped', {
							events: ids.length,
							reason: permanent ? 'rejected' : 'retry_window',
							...(status ? { status } : {}),
						});
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
				for (const id of ids) {
					// a 2xx without per-event results accepts the whole batch
					const status = Array.isArray(results) ? byId.get(id)?.status : 'accepted';
					if (status === 'rejected') {
						totals.rejected += 1;
						logger.error('event rejected by the Portal; dropped', { id, reason: byId.get(id)?.reason ?? 'unknown' });
					} else if (status === 'duplicate') totals.duplicates += 1;
					else totals.sent += 1;
				}
				await store.ack(ids, { now: now(), retainMs: RETAIN_MS });
			}
			if (stop || leased.length < batchSize) break;
		}
		return totals;
	};

	/**
	 * Store an event and try to send it right away. A failure leaves it queued for `flush()` (never throws for a
	 * delivery failure); a Portal rejection drops it (error log).
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
			await store.ack([envelope.id], { now: now(), retainMs: RETAIN_MS });
			if (result?.status === 'rejected') {
				logger.error('event rejected by the Portal; dropped', { id: envelope.id, reason: result.reason ?? 'unknown' });
				return { queued: false, status: 'rejected' };
			}
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
