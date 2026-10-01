/**
 * Pure delivery rules: retry budget, outcome classification, DLQ retention and log cursors.
 * @module
 */

/** Deliveries keep retrying for this long before they are dead-lettered. */
export const RETRY_WINDOW_MS = 24 * 60 * 60_000;
/** Sealed DLQ payloads are kept at most this long after the first dead-letter. */
export const DLQ_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** Per-attempt timeout of an outbound delivery. */
export const DELIVERY_TIMEOUT_MS = 10_000;

/** Delivery statuses. */
export const DELIVERY_STATUSES = Object.freeze(/** @type {const} */ (['pending', 'retrying', 'delivered', 'dead']));

/**
 * Smallest job `maxAttempts` whose nominal backoff (`baseMs · 2^(n-1)` capped at `maxMs`, the job queue's schedule)
 * spans `windowMs`.
 * @param {{ windowMs?: number, baseMs?: number, maxMs?: number }} [options]
 * @returns {number}
 */
export const attemptsForWindow = ({ windowMs = RETRY_WINDOW_MS, baseMs = 5_000, maxMs = 60 * 60_000 } = {}) => {
	let elapsed = 0;
	let attempts = 1;
	while (elapsed < windowMs && attempts < 100) {
		elapsed += Math.min(maxMs, baseMs * 2 ** (attempts - 1));
		attempts += 1;
	}
	return attempts;
};

/**
 * @typedef {{ ok: true, status: number } | { ok: false, code: string, permanent: boolean, status?: number }} AttemptOutcome
 */

/**
 * Classify an HTTP answer: 2xx = delivered, anything else retries.
 * @param {number} status
 * @returns {AttemptOutcome}
 */
export const classifyStatus = (status) =>
	status >= 200 && status < 300 ? { ok: true, status } : { ok: false, code: `http_${status}`, permanent: false, status };

/** Responses of a delivery are read up to this size (the body is discarded). */
export const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * Classify a transport error (`@ss/net` `NetError`) into a stable code. SSRF refusals and refused URLs are permanent
 * (straight to the DLQ); everything else retries.
 * @param {unknown} error
 * @returns {AttemptOutcome}
 */
export const classifyError = (error) => {
	const e = typeof error === 'object' && error !== null ? /** @type {Record<string, unknown>} */ (error) : {};
	const { code, reason, detail } = e;
	if (code === 'ssrf_blocked' || code === 'bad_url') return { ok: false, code: 'ssrf_blocked', permanent: true };
	if (code === 'timeout') return { ok: false, code: 'timeout', permanent: false };
	if (code === 'aborted') return { ok: false, code: 'aborted', permanent: false };
	if (code === 'too_large') return { ok: false, code: 'response_too_large', permanent: false };
	if (code === 'network') {
		if (reason === 'dns_failed') return { ok: false, code: 'dns_failed', permanent: false };
		if (reason === 'tls_failed') return { ok: false, code: 'tls_failed', permanent: false };
		if (detail === 'ECONNREFUSED') return { ok: false, code: 'connection_refused', permanent: false };
		if (detail === 'ECONNRESET' || detail === 'EPIPE') return { ok: false, code: 'connection_reset', permanent: false };
	}
	return { ok: false, code: 'network_error', permanent: false };
};

/**
 * The events endpoint of a product: a base URL (the registered environment, {@link deliveryTarget}) + the manifest's
 * `endpoints.events` path.
 * @param {{ base?: unknown, events?: unknown } | null | undefined} endpoints
 * @returns {string | null}
 */
export const eventsEndpoint = (endpoints) => {
	if (!endpoints || typeof endpoints.base !== 'string' || typeof endpoints.events !== 'string') return null;
	if (!endpoints.events.startsWith('/')) return null;
	return `${endpoints.base.replace(/\/+$/, '')}${endpoints.events}`;
};

/**
 * The registered environment base a delivery goes to (never the manifest's self-declared `endpoints.base`): events of
 * a `test` website go to the app's staging environment when one is registered, everything else (live websites,
 * platform-scoped events, apps without staging) to production. `null` when the app has no such environment.
 * @param {{ production?: unknown, staging?: unknown } | null | undefined} environments catalog `environments` view
 * @param {'live' | 'test' | null | undefined} env the event's environment
 * @returns {{ base: string, environment: 'production' | 'staging' } | null}
 */
export const deliveryTarget = (environments, env) => {
	if (env === 'test' && typeof environments?.staging === 'string' && environments.staging.length > 0)
		return { base: environments.staging, environment: 'staging' };
	if (typeof environments?.production === 'string' && environments.production.length > 0)
		return { base: environments.production, environment: 'production' };
	return null;
};

/**
 * Expiry of a sealed DLQ payload: 7 days after the first dead-letter, never extended by replays.
 * @param {number} now
 * @param {Date | null | undefined} firstExpiry
 * @returns {Date}
 */
export const dlqExpiry = (now, firstExpiry) => firstExpiry ?? new Date(now + DLQ_RETENTION_MS);

/**
 * Encode a log cursor (newest first: createdAt, then id).
 * @param {{ createdAt: Date, _id: string }} last
 */
export const encodeCursor = (last) => Buffer.from(JSON.stringify([last.createdAt.getTime(), last._id])).toString('base64url');

/**
 * @param {string | null | undefined} cursor
 * @returns {{ ok: true, after: { at: Date, id: string } | null } | { ok: false }}
 */
export const decodeCursor = (cursor) => {
	if (cursor === undefined || cursor === null || cursor === '') return { ok: true, after: null };
	if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) return { ok: false };
	try {
		const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
		if (
			Array.isArray(parsed) &&
			parsed.length === 2 &&
			Number.isSafeInteger(parsed[0]) &&
			typeof parsed[1] === 'string' &&
			parsed[1].length > 0 &&
			parsed[1].length <= 128
		)
			return { ok: true, after: { at: new Date(parsed[0]), id: parsed[1] } };
	} catch {
		// fall through
	}
	return { ok: false };
};

/**
 * @param {unknown} limit
 * @param {{ fallback?: number, max?: number }} [options]
 * @returns {number | null} null = invalid
 */
export const parseLimit = (limit, { fallback = 50, max = 200 } = {}) => {
	if (limit === undefined || limit === null || limit === '') return fallback;
	const n = typeof limit === 'number' ? limit : /^\d{1,4}$/.test(String(limit)) ? Number(limit) : Number.NaN;
	return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
};

/**
 * Public view of a delivery (no payload, ever).
 * @param {Record<string, any>} doc
 */
export const deliveryView = (doc) => ({
	deliveryId: doc._id,
	eventId: doc.eventId,
	type: doc.type,
	kind: doc.kind,
	websiteId: doc.websiteId,
	appId: doc.appId,
	status: doc.status,
	attempts: doc.attempts ?? 0,
	replays: doc.replays ?? 0,
	lastErrorCode: doc.lastErrorCode ?? null,
	lastHttpStatus: doc.lastHttpStatus ?? null,
	createdAt: doc.createdAt,
	updatedAt: doc.updatedAt,
	lastAttemptAt: doc.lastAttemptAt ?? null,
	deliveredAt: doc.deliveredAt ?? null,
	deadAt: doc.deadAt ?? null,
});
