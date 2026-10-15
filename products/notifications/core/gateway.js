/**
 * Reading a provider's answer, and why an attempt failed. A failure is a code (`reason`) with its values, never a
 * sentence (the delivery log shows it through the website's texts `reason.<code>`); the provider's own answer is kept
 * apart as `detail`, short technical text for whoever debugs the provider. No I/O.
 *
 * Failure codes: `provider_status` (`{ status }`: the provider answered an HTTP status that is not a success),
 * `provider_refused` (a 2xx answer saying the message was not taken), `provider_unreachable` (`{ cause }`: a network
 * error code such as `timeout`), `provider_error` (`{ cause }`: an SMTP failure), `connection_unusable`
 * (`{ connection }`: the saved connection does not fit its provider), `feature_off` (`{ feature }`), `not_connected`
 * (`{ connection }`), `no_subscription` (no browser subscribed), `subscription_gone` (the browser unsubscribed),
 * `interrupted` (a database or provider was briefly unreachable), `sealed_unreadable` (the encryption key changed) and
 * `not_set_up` (`{ template, fallbackTemplate? }`: a product's message on WhatsApp without the merchant's template).
 * Skip reasons: `unsubscribed`, `limited` and `switched_off`.
 * @module
 */

/** @typedef {{ reason: string, values?: Record<string, string>, detail?: string }} Failure */
/** @typedef {{ ok: true, id: string | null } | ({ ok: false, retryable: boolean } & Failure)} SendOutcome */

/** Every failure code an attempt or a message may keep. */
export const FAILURE_REASONS = Object.freeze([
	'provider_status',
	'provider_refused',
	'provider_unreachable',
	'provider_error',
	'connection_unusable',
	'feature_off',
	'not_connected',
	'no_subscription',
	'subscription_gone',
	'interrupted',
	'sealed_unreadable',
	'not_set_up',
]);

/** Why a message was not sent at all (skipped). */
export const SKIP_REASONS = Object.freeze(['unsubscribed', 'limited', 'switched_off']);

const FAILURE_WORDS = new Set(['error', 'failed', 'fail', 'failure', 'invalid', 'rejected', 'false']);
/** Longest provider detail kept (characters). */
export const DETAIL_LIMIT = 200;

/** @param {unknown} value */
const isFalse = (value) => value === false || value === 0 || value === 'false' || value === '0';

/**
 * A provider's answer as short technical text (at most 200 characters), with a secret the connection holds removed.
 * @param {unknown} value
 * @param {ReadonlyArray<string>} [secrets]
 */
export const detailOf = (value, secrets = []) => {
	let text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
	for (const secret of secrets) if (secret.length >= 4) text = text.split(secret).join('***');
	return text.trim().slice(0, DETAIL_LIMIT);
};

/**
 * A failure without an attempt at a provider (or with its error), retryable or not.
 * @param {string} reason
 * @param {{ values?: Record<string, string>, detail?: string, retryable?: boolean }} [extra]
 * @returns {Extract<SendOutcome, { ok: false }>}
 */
export const failed = (reason, { values, detail, retryable = false } = {}) => ({
	ok: false,
	reason,
	...(values && Object.keys(values).length > 0 ? { values } : {}),
	...(detail ? { detail } : {}),
	retryable,
});

/**
 * The outcome of an HTTP answer: 4xx are final (except 408 and 429), 5xx are retried; a 2xx JSON body saying `error`,
 * `sent: false`, `success: false` or a failure `status` is final.
 * @param {number} status
 * @param {string} text the body
 * @returns {SendOutcome}
 */
export const gatewayOutcome = (status, text) => {
	if (status >= 400 || status < 200)
		return failed('provider_status', {
			values: { status: String(status) },
			detail: detailOf(text),
			retryable: status >= 500 || status === 408 || status === 429,
		});
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
		return failed('provider_refused', { detail: detailOf(error) });
	if (('sent' in body && isFalse(body.sent)) || ('success' in body && isFalse(body.success)))
		return failed('provider_refused', { detail: detailOf(body.message ?? text) });
	if (typeof body.status === 'string' && FAILURE_WORDS.has(body.status.trim().toLowerCase()))
		return failed('provider_refused', { detail: detailOf(body.message ?? body.status) });
	const id = body.id ?? body.sid ?? body.messageId ?? body.message_id;
	return { ok: true, id: typeof id === 'string' || typeof id === 'number' ? String(id) : null };
};

/**
 * A failure in plain US English, for the Connections screen's test message only (the delivery log keeps the code).
 * @param {Failure} failure
 * @returns {string}
 */
export const failureMessage = ({ reason, values = {} }) =>
	reason === 'provider_status'
		? `The provider answered HTTP ${values.status}.`
		: reason === 'provider_unreachable'
			? `The provider could not be reached (${values.cause}).`
			: reason === 'provider_refused'
				? 'The provider refused the request.'
				: 'The provider could not be used.';
