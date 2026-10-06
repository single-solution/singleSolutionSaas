/**
 * Product health (pure). Products may send `POST /v1/product/heartbeat { version, status, queues? }` (PLAN F.9), and
 * every authenticated product call marks the app as seen (`lastSeenAt`). Nothing pings on a timer (F.19), so an app
 * is flagged `stale` only when it has not been in touch at all within the staleness window.
 * @module
 */

/** An app neither seen nor heard from for a day is stale. */
export const STALE_AFTER_MS = 24 * 60 * 60_000;
/** `lastSeenAt` is written at most this often per app (a product call is the trigger; no timer). */
export const SEEN_EVERY_MS = 5 * 60_000;

const STATUS = /^[a-z][a-z_]{0,31}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const QUEUE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/** @typedef {{ version: string, status: string, queues: Record<string, number> | null }} Heartbeat */

/**
 * Validate a heartbeat body.
 * @param {unknown} body
 * @returns {{ ok: true, value: Heartbeat } | { ok: false, errors: Array<{ path: string, message: string }> }}
 */
export const parseHeartbeat = (body) => {
	if (typeof body !== 'object' || body === null || Array.isArray(body))
		return { ok: false, errors: [{ path: '', message: 'body must be { version, status, queues? }' }] };
	const { version, status, queues, ...rest } = /** @type {Record<string, unknown>} */ (body);
	/** @type {Array<{ path: string, message: string }>} */
	const errors = Object.keys(rest).map((key) => ({ path: `/${key}`, message: 'unknown property' }));
	if (typeof version !== 'string' || !VERSION.test(version)) errors.push({ path: '/version', message: 'version is required' });
	if (typeof status !== 'string' || !STATUS.test(status))
		errors.push({ path: '/status', message: 'status must be a lower-case word' });
	/** @type {Record<string, number> | null} */
	let parsedQueues = null;
	if (queues !== undefined && queues !== null) {
		if (typeof queues !== 'object' || Array.isArray(queues) || Object.keys(queues).length > 20)
			errors.push({ path: '/queues', message: 'queues must be an object of at most 20 counters' });
		else {
			parsedQueues = {};
			for (const [name, value] of Object.entries(queues)) {
				if (!QUEUE.test(name) || !Number.isSafeInteger(value) || /** @type {number} */ (value) < 0)
					errors.push({ path: `/queues/${name}`, message: 'queue counters are non-negative integers' });
				else parsedQueues[name] = /** @type {number} */ (value);
			}
		}
	}
	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		value: { version: /** @type {string} */ (version), status: /** @type {string} */ (status), queues: parsedQueues },
	};
};

/**
 * Health view of an app.
 * @param {{ lastHeartbeatAt?: Date | null, lastSeenAt?: Date | null, version?: string | null, status?: string | null,
 *   queues?: Record<string, number> | null } | null | undefined} health
 * @param {number} now
 * @param {number} [staleAfterMs]
 */
export const healthView = (health, now, staleAfterMs = STALE_AFTER_MS) => {
	const beat = health?.lastHeartbeatAt instanceof Date ? health.lastHeartbeatAt : null;
	const seen = health?.lastSeenAt instanceof Date ? health.lastSeenAt : null;
	const last = beat && seen ? (beat > seen ? beat : seen) : (beat ?? seen);
	return {
		lastHeartbeatAt: beat ? beat.toISOString() : null,
		lastSeenAt: last ? last.toISOString() : null,
		version: health?.version ?? null,
		status: health?.status ?? null,
		queues: health?.queues ?? null,
		stale: last === null || now - last.getTime() > staleAfterMs,
	};
};
