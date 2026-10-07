/**
 * Pure delivery rules: retry budget, outcome classification and the events endpoint.
 * @module
 */

/** Deliveries keep retrying for this long before they are marked `failed`. */
export const RETRY_WINDOW_MS = 24 * 60 * 60_000;
/** Per-attempt timeout of an outbound delivery. */
export const DELIVERY_TIMEOUT_MS = 10_000;

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
 * (the delivery fails at once); everything else retries.
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
 * The events endpoint of a product: its connected production base URL (`catalog.getApp().baseUrl`) + the manifest's
 * `endpoints.events` path.
 * @param {{ base?: unknown, events?: unknown } | null | undefined} endpoints
 * @returns {string | null}
 */
export const eventsEndpoint = (endpoints) => {
	if (!endpoints || typeof endpoints.base !== 'string' || typeof endpoints.events !== 'string') return null;
	if (!endpoints.events.startsWith('/')) return null;
	return `${endpoints.base.replace(/\/+$/, '')}${endpoints.events}`;
};
