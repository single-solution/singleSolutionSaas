/**
 * Reading a provider's answer: many gateways answer HTTP 200 for a refused message with the failure in the body, so a
 * 2xx alone does not mean sent. No I/O.
 * @module
 */

/** @typedef {{ ok: true, id: string | null } | { ok: false, error: string, retryable: boolean }} SendOutcome */

const FAILURE_WORDS = new Set(['error', 'failed', 'fail', 'failure', 'invalid', 'rejected', 'false']);
const SNIPPET = 200;

/** @param {unknown} value */
const isFalse = (value) => value === false || value === 0 || value === 'false' || value === '0';

/** @param {unknown} value */
const snippet = (value) => (typeof value === 'string' ? value : (JSON.stringify(value) ?? 'error')).slice(0, SNIPPET);

/**
 * The outcome of an HTTP answer: 4xx are final (except 408 and 429), 5xx are retried; a 2xx JSON body saying `error`,
 * `sent: false`, `success: false` or a failure `status` is final.
 * @param {number} status
 * @param {string} text the body
 * @returns {SendOutcome}
 */
export const gatewayOutcome = (status, text) => {
	if (status >= 400 || status < 200)
		return {
			ok: false,
			error: `The provider answered HTTP ${status}.`,
			retryable: status >= 500 || status === 408 || status === 429,
		};
	/** @type {unknown} */
	let parsed;
	try {
		parsed = text.trim() ? JSON.parse(text) : undefined;
	} catch {
		parsed = undefined;
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: true, id: null };
	const body = /** @type {Record<string, unknown>} */ (parsed);
	const error = body.error ?? body.errors;
	if (error !== undefined && error !== null && error !== '' && error !== false)
		return { ok: false, error: snippet(error), retryable: false };
	if (('sent' in body && isFalse(body.sent)) || ('success' in body && isFalse(body.success)))
		return { ok: false, error: snippet(body.message ?? 'The message was not sent.'), retryable: false };
	if (typeof body.status === 'string' && FAILURE_WORDS.has(body.status.trim().toLowerCase()))
		return { ok: false, error: snippet(body.message ?? body.status), retryable: false };
	const id = body.id ?? body.sid ?? body.messageId ?? body.message_id;
	return { ok: true, id: typeof id === 'string' || typeof id === 'number' ? String(id) : null };
};
