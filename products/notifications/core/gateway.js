/**
 * Reading a provider's answer, and why an attempt failed. A failure is a code (`reason`) with its values, never a
 * sentence (the delivery log shows it through the website's texts `reason.<code>`); the provider's own answer is kept
 * apart as `detail`, short technical text for whoever debugs the provider. No I/O.
 *
 * Failure codes: `provider_status` (`{ status }`: the provider answered an HTTP status that is not a success),
 * `provider_refused` (`{ path }`: a success status whose JSON answer does not have the value the merchant's success rule
 * names at its path), `provider_unreachable` (`{ cause }`: a network
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

/** Longest provider detail kept (characters). */
export const DETAIL_LIMIT = 200;

/**
 * What success is for a provider's answer (fixed-choices N1): the HTTP statuses that count (`[from, to]` ranges), and,
 * for a gateway that answers a success status for a refusal too, the JSON path whose value must be `value` (compared
 * as text). `idPath` is where the message id is. Never words in the answer.
 * @typedef {{ statuses: ReadonlyArray<readonly [number, number]>, path?: string, value?: string, idPath?: string }} SuccessRule
 */

/** Any 2xx status. */
export const SUCCESS_2XX = Object.freeze([Object.freeze(/** @type {const} */ ([200, 299]))]);

/**
 * The statuses a rule names: codes, ranges and classes, comma-separated (`200`, `200-204`, `2xx`); empty: any 2xx.
 * Null when it cannot be read.
 * @param {unknown} text
 * @returns {Array<[number, number]> | null}
 */
export const parseStatusRule = (text) => {
	const rule = typeof text === 'string' ? text.trim() : '';
	if (rule === '') return [[200, 299]];
	/** @type {Array<[number, number]>} */
	const ranges = [];
	for (const part of rule.split(',').map((piece) => piece.trim())) {
		const single = /^([1-5]\d\d)$/.exec(part);
		const range = /^([1-5]\d\d)\s*-\s*([1-5]\d\d)$/.exec(part);
		const kind = /^([1-5])xx$/i.exec(part);
		if (single) ranges.push([Number(single[1]), Number(single[1])]);
		else if (range && Number(range[1]) <= Number(range[2])) ranges.push([Number(range[1]), Number(range[2])]);
		else if (kind) ranges.push([Number(kind[1]) * 100, Number(kind[1]) * 100 + 99]);
		else return null;
	}
	return ranges;
};

/** A JSON path: keys and list places joined by dots, optionally after `$.` (`data.0.status`). */
export const JSON_PATH = /^(\$\.)?[A-Za-z0-9_-]{1,64}(\.[A-Za-z0-9_-]{1,64}){0,15}$/;

/**
 * The value at a JSON path, or undefined.
 * @param {unknown} json
 * @param {string} path
 * @returns {unknown}
 */
export const valueAt = (json, path) => {
	/** @type {unknown} */
	let at = json;
	for (const key of path.replace(/^\$\./, '').split('.')) {
		if (Array.isArray(at) && /^\d+$/.test(key)) at = at[Number(key)];
		else if (typeof at === 'object' && at !== null && !Array.isArray(at) && Object.hasOwn(at, key))
			at = /** @type {Record<string, unknown>} */ (at)[key];
		else return undefined;
	}
	return at;
};

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
 * The outcome of a provider's HTTP answer by its success rule: a status outside the rule is `provider_status` (5xx, 408
 * and 429 are retried, other statuses are final); a success status whose JSON answer does not have the rule's value at
 * its path is `provider_refused` (final). The message id is read at `idPath` (none: no id).
 * @param {number} status
 * @param {string} text the body
 * @param {SuccessRule} rule
 * @returns {SendOutcome}
 */
export const httpOutcome = (status, text, { statuses, path, value, idPath }) => {
	if (!statuses.some(([from, to]) => status >= from && status <= to))
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
	if (path) {
		const found = valueAt(parsed, path);
		const shown = typeof found === 'object' && found !== null ? JSON.stringify(found) : String(found);
		if (found === undefined || shown !== (value ?? '').trim())
			return failed('provider_refused', { values: { path }, detail: detailOf(text) });
	}
	const id = idPath ? valueAt(parsed, idPath) : undefined;
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
