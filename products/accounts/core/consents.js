/**
 * The consent list (A2), pure: what the merchant asks people to agree to, each `{ key, label, url, version, required,
 * purpose }`, in the merchant's order, and what each user gave, `{ [key]: { version, given, at } }`.
 *
 * - `purpose` `agreement` (terms, a privacy policy, an age confirmation …): a required one is asked at sign-up and again
 *   at the next sign-in once its version changes; it cannot be withdrawn (the user deletes their account instead).
 * - `purpose` `marketing` (offers by email …) is kept apart: never required, never blocks a sign-in, and the user gives
 *   or withdraws it at any time.
 * - Each answer keeps the version and the time it was given or withdrawn.
 * @module
 */

/** The purposes a consent may have. */
const CONSENT_PURPOSES = Object.freeze(/** @type {const} */ (['agreement', 'marketing']));
/** Most consents a website asks for. */
export const MAX_CONSENTS = 20;
const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const WEB = /^https?:\/\/[^\s]+$/i;

/**
 * @typedef {object} Consent
 * @property {string} key
 * @property {string} label the words next to the box, the merchant's own
 * @property {string} url the page to read ('' for none)
 * @property {string} version a new version asks again (agreements)
 * @property {boolean} required asked before sign-up and sign-in go on (agreements only)
 * @property {typeof CONSENT_PURPOSES[number]} purpose
 */
/** @typedef {{ version: string, given: boolean, at: Date }} ConsentAnswer */

/** The ready-made consent a website starts with: today's terms acceptance. @type {ReadonlyArray<Consent>} */
export const CONSENT_TEMPLATES = Object.freeze([
	Object.freeze({
		key: 'terms',
		label: 'I accept the terms',
		url: '',
		version: '1',
		required: true,
		purpose: /** @type {const} */ ('agreement'),
	}),
]);

/**
 * Text of at most `max` characters on one line, trimmed; null when it is not.
 * @param {unknown} value @param {number} max
 */
const line = (value, max) => {
	if (value === undefined || value === null) return '';
	if (typeof value !== 'string') return null;
	const text = value.trim();
	return text.length > max || [...text].some((ch) => ch.charCodeAt(0) < 32) ? null : text;
};

/**
 * Check a consent as the merchant saves it (the key comes from the path).
 * @param {string} key @param {unknown} input
 * @returns {{ ok: true, value: Consent } | { ok: false, field: string, message: string }}
 */
export const checkConsent = (key, input) => {
	const body = typeof input === 'object' && input !== null ? /** @type {Record<string, unknown>} */ (input) : {};
	if (!KEY.test(key)) return { ok: false, field: 'key', message: 'Use 1–40 lower-case letters, digits or _.' };
	const label = line(body.label, 200);
	if (!label) return { ok: false, field: 'label', message: 'Write the words next to the box (at most 200 characters).' };
	const url = line(body.url, 2048);
	if (url === null || (url !== '' && !WEB.test(url)))
		return { ok: false, field: 'url', message: 'The page is a web address starting with https:// or http://.' };
	const version = body.version === undefined ? '1' : line(body.version, 40);
	if (!version) return { ok: false, field: 'version', message: 'The version is text of 1 to 40 characters.' };
	const purpose = body.purpose === undefined ? 'agreement' : CONSENT_PURPOSES.find((p) => p === body.purpose);
	if (!purpose) return { ok: false, field: 'purpose', message: 'The purpose is agreement or marketing.' };
	const required = body.required === true;
	if (required && purpose === 'marketing')
		return { ok: false, field: 'required', message: 'Marketing consent is never required.' };
	return { ok: true, value: { key, label, url, version, required, purpose } };
};

/**
 * The required agreements a user has not given in their current version (asked before a sign-up or sign-in goes on).
 * @param {ReadonlyArray<Consent>} consents @param {Record<string, ConsentAnswer>} given
 */
export const consentsToAsk = (consents, given) =>
	consents.filter(
		(consent) => consent.required && !(given[consent.key]?.given === true && given[consent.key]?.version === consent.version),
	);

/**
 * Record a user's answers (`{ [key]: true | false }`): each in the consent's current version with the time. A required
 * agreement cannot be refused or withdrawn; an unknown key or an answer that is not true or false is refused.
 * @param {ReadonlyArray<Consent>} consents @param {Record<string, ConsentAnswer>} given what the user gave so far
 * @param {unknown} answers @param {Date} at
 * @returns {{ ok: true, value: Record<string, ConsentAnswer> } | { ok: false, field: string, message: string }}
 */
export const answerConsents = (consents, given, answers, at) => {
	if (answers === undefined || answers === null) return { ok: true, value: { ...given } };
	if (typeof answers !== 'object' || Array.isArray(answers))
		return { ok: false, field: 'consents', message: 'Send the consents as { key: true or false }.' };
	/** @type {Record<string, ConsentAnswer>} */
	const out = { ...given };
	for (const [key, answer] of Object.entries(answers)) {
		const consent = consents.find((c) => c.key === key);
		if (!consent) return { ok: false, field: `consents/${key}`, message: 'There is no such consent.' };
		if (typeof answer !== 'boolean') return { ok: false, field: `consents/${key}`, message: 'Answer true or false.' };
		if (!answer && consent.required)
			return { ok: false, field: `consents/${key}`, message: `${consent.label}: this is required.` };
		const before = given[key];
		if (before && before.given === answer && before.version === consent.version) continue;
		out[key] = { version: consent.version, given: answer, at };
	}
	return { ok: true, value: out };
};

/**
 * A user's answers as the API answers them.
 * @param {Record<string, ConsentAnswer> | undefined} given
 */
export const ownConsents = (given) =>
	Object.fromEntries(
		Object.entries(given ?? {}).map(([key, answer]) => [
			key,
			{ version: answer.version, given: answer.given, at: answer.at.toISOString() },
		]),
	);
