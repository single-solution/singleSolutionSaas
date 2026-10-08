/**
 * Templates (PLAN 0.8.5): one per template key × channel × language. Products and the send API name a template key
 * and the values; the merchant writes the words. A template's text fills `{placeholders}` from the values as plain
 * text. No I/O: the API, the dashboard and the widgets share it.
 * @module
 */
import { CHANNELS } from './channels.js';

/** Template keys: lower case, digits, `_`, `.` and `-`, starting with a letter. */
export const TEMPLATE_KEY = /^[a-z][a-z0-9_.-]{0,63}$/;

/**
 * Template keys of the other products' own events start with that product's id and a dot. They work without the
 * Merchant send API feature; every other key is the merchant's own and needs it (PLAN 0.8.4 builder choice).
 */
export const PRODUCT_KEY_PREFIXES = Object.freeze(['accounts.', 'ecommerce.', 'chat.', 'payments.', 'growth.']);

/** The language of a template every recipient falls back to (written as `default` in paths). */
export const DEFAULT_LANGUAGE = '';

/** Longest texts per channel (characters). */
export const TEXT_LIMITS = Object.freeze({ email: 100_000, sms: 1600, whatsapp: 4096, push: 500, staff_push: 500 });
/** Longest subject (e-mail) or title (push). */
export const SUBJECT_LIMIT = 200;
/** Placeholders Notifications fills itself. */
export const BUILT_IN_VALUES = Object.freeze(['unsubscribeUrl']);

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]{0,63})\}/g;
const LANGUAGE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;

/** @typedef {import('./channels.js').Channel} Channel */
/**
 * @typedef {object} Template
 * @property {string} key
 * @property {Channel} channel
 * @property {string} language `''` for the default version
 * @property {string} subject e-mail subject or push title (`''` for SMS and WhatsApp)
 * @property {string} text
 * @property {boolean} required required messages (sign-in codes, order and account updates) ignore unsubscribes
 * @property {boolean} urgent urgent messages ignore quiet hours
 * @property {string} providerTemplate WhatsApp: the name of an approved Meta template (`''` = plain text)
 */

/**
 * Whether a template key belongs to another product's own events.
 * @param {string} key
 */
export const isProductKey = (key) => PRODUCT_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));

/**
 * The language of a path segment (`default` → `''`), or null.
 * @param {unknown} segment
 * @returns {string | null}
 */
export const languageOfSegment = (segment) =>
	segment === 'default' ? DEFAULT_LANGUAGE : typeof segment === 'string' && LANGUAGE.test(segment) ? segment : null;

/**
 * The placeholders a text uses, in order of first use.
 * @param {string} text
 * @returns {string[]}
 */
export const placeholdersOf = (text) => [
	...new Set([...text.matchAll(PLACEHOLDER)].map((match) => /** @type {string} */ (match[1]))),
];

/**
 * Check a template the merchant saves.
 * @param {unknown} input
 * @returns {{ ok: true, value: Template } | { ok: false, field: string, message: string }}
 */
export const checkTemplate = (input) => {
	const body = typeof input === 'object' && input !== null ? /** @type {Record<string, unknown>} */ (input) : {};
	/** @param {string} field @param {string} message */
	const fail = (field, message) => /** @type {const} */ ({ ok: false, field, message });
	if (typeof body.key !== 'string' || !TEMPLATE_KEY.test(body.key))
		return fail('key', 'Use 1–64 lower-case letters, digits, _, . or -, starting with a letter.');
	if (!CHANNELS.includes(/** @type {Channel} */ (body.channel))) return fail('channel', 'Pick a channel.');
	const channel = /** @type {Channel} */ (body.channel);
	const language = body.language === undefined || body.language === null ? 'default' : body.language;
	const lang = languageOfSegment(language === '' ? 'default' : language);
	if (lang === null) return fail('language', 'Use a language code such as en, ur or pt-BR.');
	const text = typeof body.text === 'string' ? body.text.trim() : '';
	if (text.length === 0) return fail('text', 'Write the message.');
	if (text.length > TEXT_LIMITS[channel])
		return fail('text', `The message can have at most ${TEXT_LIMITS[channel]} characters.`);
	const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
	const titled = channel === 'email' || channel === 'push' || channel === 'staff_push';
	if (titled && subject.length === 0) return fail('subject', channel === 'email' ? 'Write the subject.' : 'Write the title.');
	if (subject.length > SUBJECT_LIMIT || /[\r\n]/.test(subject))
		return fail('subject', `Use one line of at most ${SUBJECT_LIMIT} characters.`);
	const providerTemplate = typeof body.providerTemplate === 'string' ? body.providerTemplate.trim() : '';
	if (providerTemplate !== '' && (channel !== 'whatsapp' || !/^[a-z0-9_]{1,512}$/.test(providerTemplate)))
		return fail('providerTemplate', 'Only WhatsApp templates have a provider template name (lower case, digits and _).');
	return {
		ok: true,
		value: {
			key: body.key,
			channel,
			language: lang,
			subject: titled ? subject : '',
			text,
			required: body.required === true,
			urgent: body.urgent === true,
			providerTemplate,
		},
	};
};

/**
 * Fill `{placeholders}` with values (plain text; unknown placeholders stay as written).
 * @param {string} text
 * @param {Readonly<Record<string, string>>} values
 */
export const fillText = (text, values) =>
	text.replace(PLACEHOLDER, (match, name) => (Object.hasOwn(values, name) ? /** @type {string} */ (values[name]) : match));

/**
 * Check the values of a send: up to 50 names, each a string or a number of at most 1000 characters.
 * @param {unknown} input
 * @returns {{ ok: true, value: Record<string, string> } | { ok: false }}
 */
export const checkValues = (input) => {
	if (input === undefined || input === null) return { ok: true, value: {} };
	if (typeof input !== 'object' || Array.isArray(input)) return { ok: false };
	const entries = Object.entries(/** @type {Record<string, unknown>} */ (input));
	if (entries.length > 50) return { ok: false };
	/** @type {Record<string, string>} */
	const value = {};
	for (const [name, raw] of entries) {
		if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) || BUILT_IN_VALUES.includes(name)) return { ok: false };
		if (typeof raw === 'number' && Number.isFinite(raw)) value[name] = String(raw);
		else if (typeof raw === 'string' && raw.length <= 1000) value[name] = raw;
		else return { ok: false };
	}
	return { ok: true, value };
};

/**
 * The version of a template to use: the recipient's language (exact, then its base language) while multi-language
 * templates are on, else the default version.
 * @template {{ language: string }} T
 * @param {T[]} versions the template's versions for one key and channel
 * @param {string | null} language the recipient's language
 * @param {boolean} multiLanguage
 * @returns {T | null}
 */
export const pickVersion = (versions, language, multiLanguage) => {
	const fallback = versions.find((version) => version.language === DEFAULT_LANGUAGE) ?? null;
	if (!multiLanguage || !language) return fallback;
	const base = language.split('-')[0];
	return (
		versions.find((version) => version.language === language) ??
		versions.find((version) => version.language === base) ??
		fallback
	);
};

/**
 * The message a template makes for one send.
 * @param {Template} template
 * @param {Readonly<Record<string, string>>} values the send's values plus the built-in ones
 * @returns {{ subject: string, text: string, parameters: string[] }} `parameters`: the values in the order the text
 *   uses them (a WhatsApp provider template's body parameters)
 */
export const renderTemplate = (template, values) => ({
	subject: fillText(template.subject, values),
	text: fillText(template.text, values),
	parameters: placeholdersOf(template.text).map((name) => values[name] ?? ''),
});

/**
 * A template as the API answers it.
 * @param {Template & { updatedAt?: Date | string }} template
 */
export const templateView = (template) => ({
	key: template.key,
	channel: template.channel,
	language: template.language === DEFAULT_LANGUAGE ? 'default' : template.language,
	subject: template.subject,
	text: template.text,
	required: template.required,
	urgent: template.urgent,
	providerTemplate: template.providerTemplate,
	...(template.updatedAt ? { updatedAt: new Date(template.updatedAt).toISOString() } : {}),
});
