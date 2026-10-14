/**
 * Templates (PLAN 0.8.5): one per template key × channel × language. Products and the send API name a template key
 * and the values; the merchant writes the words. A template's text fills `{placeholders}` from the values as plain
 * text, and shows an optional section `{?name}…{/name}` only when the value `name` is not empty (PLAN 0.8.10 N2).
 * No I/O: the API, the dashboard and the widgets share it.
 * @module
 */
import { CHANNELS } from './channels.js';

/** Template keys: lower case, digits, `_`, `.` and `-`, starting with a letter. */
const TEMPLATE_KEY = /^[a-z][a-z0-9_.-]{0,63}$/;

/**
 * Template keys of the other products' own events start with that product's id and a dot. They work without the
 * Merchant send API feature; every other key is the merchant's own and needs it (PLAN 0.8.4 builder choice).
 */
const PRODUCT_KEY_PREFIXES = Object.freeze(['accounts.', 'ecommerce.', 'chat.', 'payments.', 'growth.']);

/**
 * Template keys of Accounts' messages (sign-in codes, magic, reset and setup links, account updates): always required
 * (no unsubscribe or STOP reply stops them, PLAN 0.8.5), always urgent (neither quiet hours nor a delayed send hold
 * them) and always sensitive (PLAN 0.8.10 D11), whatever the template says.
 */
const ACCOUNT_KEY_PREFIX = 'accounts.';

/** The language of a template every recipient falls back to (written as `default` in paths). */
export const DEFAULT_LANGUAGE = '';

/** Longest texts per channel (characters). */
const TEXT_LIMITS = Object.freeze({ email: 100_000, sms: 1600, whatsapp: 4096, push: 500, staff_push: 500 });
/** Longest subject (email) or title (push). */
const SUBJECT_LIMIT = 200;
/** Placeholders Notifications fills itself. */
const BUILT_IN_VALUES = Object.freeze(['unsubscribeUrl']);

/** A value's name. */
const VALUE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** Most values of a send. */
const MAX_VALUES = 50;
/** What the delivery log keeps instead of a hidden value that is not empty: a link, else any other value. */
export const HIDDEN = Object.freeze({ link: '[link hidden]', value: '******' });
/** A value that is a link: an address with a scheme, or a path. */
const LINK = /:\/\/|^\//;

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]{0,63})\}/g;
/** An optional section's opening `{?name}` or closing `{/name}` tag. */
const SECTION_TAG = /\{([?/])([A-Za-z][A-Za-z0-9_]{0,63})\}/g;
/** A whole optional section (sections of one name never nest, so the first closing tag of its name ends it). */
const SECTION = /\{\?([A-Za-z][A-Za-z0-9_]{0,63})\}([\s\S]*?)\{\/\1\}/g;
const LANGUAGE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;

/** @typedef {import('./channels.js').Channel} Channel */
/**
 * @typedef {object} Template
 * @property {string} key
 * @property {Channel} channel
 * @property {string} language `''` for the default version
 * @property {string} subject email subject or push title (`''` for SMS and WhatsApp)
 * @property {string} text
 * @property {boolean} required required messages (sign-in codes, order and account updates) ignore unsubscribes;
 *   Accounts' templates always are
 * @property {boolean} urgent urgent messages ignore quiet hours; Accounts' templates always are
 * @property {string} providerTemplate WhatsApp: the name of an approved Meta template (`''` = plain text)
 * @property {Button[]} buttons WhatsApp templates at Meta: the buttons that take a value (PLAN 0.8.10 N1)
 * @property {boolean} sensitive sensitive messages (codes, links) keep none of their values in the delivery log (PLAN
 *   0.8.10 D11); Accounts' templates always are
 */
/**
 * A button of a WhatsApp template at Meta that takes a value: a URL button's variable part, or the code a copy-code
 * button copies. `index` is the button's place in the template at Meta (0–9); `value` may hold placeholders and
 * optional sections, for example `{code}`.
 * @typedef {{ index: number, type: ButtonType, value: string }} Button
 */
/** @typedef {'url' | 'copy_code'} ButtonType */

/** Button types (PLAN 0.8.10 N1). */
export const BUTTON_TYPES = Object.freeze(/** @type {ButtonType[]} */ (['url', 'copy_code']));
/** Most buttons a template at Meta has. */
const MAX_BUTTONS = 10;
/** Longest button value (characters, as written). */
const BUTTON_VALUE_LIMIT = 2000;

/**
 * Whether a template key belongs to another product's own events.
 * @param {string} key
 */
export const isProductKey = (key) => PRODUCT_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));

/**
 * Whether a template key belongs to Accounts' messages.
 * @param {string} key
 */
export const isAccountKey = (key) => key.startsWith(ACCOUNT_KEY_PREFIX);

/**
 * Whether the messages of a template are required (sent to people who unsubscribed): Accounts' always, else when the
 * merchant marks the template.
 * @param {Pick<Template, 'key' | 'required'>} template
 */
export const isRequired = (template) => template.required === true || isAccountKey(template.key);

/**
 * Whether the messages of a template are urgent (sent during quiet hours): Accounts' always, else when the merchant
 * marks the template.
 * @param {Pick<Template, 'key' | 'urgent'>} template
 */
export const isUrgent = (template) => template.urgent === true || isAccountKey(template.key);

/**
 * Whether the messages of a template are sensitive: Accounts' always, else when the merchant marks the template.
 * @param {Pick<Template, 'key' | 'sensitive'>} template
 */
export const isSensitive = (template) => template.sensitive === true || isAccountKey(template.key);

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
 * Every value name a text uses, in order of first use: its placeholders and the names of its optional sections (the
 * template editors ask for a sample of each to preview the words).
 * @param {string} text
 * @returns {string[]}
 */
export const valueNamesOf = (text) => [
	...new Set([...text.matchAll(/\{\??([A-Za-z][A-Za-z0-9_]{0,63})\}/g)].map((match) => /** @type {string} */ (match[1]))),
];

/**
 * What is wrong with the optional sections of a text, or null: every `{?name}` is closed by a later `{/name}`,
 * sections nest without crossing, and a section never sits inside one of the same name.
 * @param {string} text
 * @returns {string | null}
 */
export const sectionProblem = (text) => {
	/** @type {string[]} */
	const open = [];
	for (const [, kind, name] of text.matchAll(SECTION_TAG)) {
		if (kind === '?') {
			if (open.includes(/** @type {string} */ (name))) return `{?${name}} is already open: close it with {/${name}} first.`;
			open.push(/** @type {string} */ (name));
		} else if (open.at(-1) === name) open.pop();
		else
			return open.includes(/** @type {string} */ (name))
				? `Close {?${open.at(-1)}} before {/${name}}.`
				: `{/${name}} closes no {?${name}}.`;
	}
	return open.length > 0 ? `Close {?${open.at(-1)}} with {/${open.at(-1)}}.` : null;
};

/**
 * Check the buttons of a template: only a WhatsApp template with a template name at Meta has them; each names its
 * place (0–9, once), its type and its value. Sorted by place.
 * @param {unknown} input
 * @param {{ channel: Channel, providerTemplate: string }} template
 * @returns {{ ok: true, value: Button[] } | { ok: false, field: string, message: string }}
 */
export const checkButtons = (input, { channel, providerTemplate }) => {
	/** @param {string} field @param {string} message */
	const fail = (field, message) => /** @type {const} */ ({ ok: false, field, message });
	if (input === undefined || input === null) return { ok: true, value: [] };
	if (!Array.isArray(input)) return fail('buttons', 'buttons is a list of { index, type, value }.');
	if (input.length === 0) return { ok: true, value: [] };
	if (channel !== 'whatsapp' || providerTemplate === '')
		return fail('buttons', 'Only WhatsApp templates with a template name at Meta have buttons.');
	if (input.length > MAX_BUTTONS) return fail('buttons', `A template has at most ${MAX_BUTTONS} buttons.`);
	/** @type {Button[]} */
	const value = [];
	for (const [at, raw] of input.entries()) {
		const button = typeof raw === 'object' && raw !== null ? /** @type {Record<string, unknown>} */ (raw) : {};
		const index = button.index;
		if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= MAX_BUTTONS)
			return fail(`buttons/${at}/index`, 'The index is the button’s place in the template at Meta, from 0 to 9.');
		if (value.some((other) => other.index === index)) return fail(`buttons/${at}/index`, `Button ${index} is listed twice.`);
		if (!BUTTON_TYPES.includes(/** @type {ButtonType} */ (button.type)))
			return fail(`buttons/${at}/type`, 'Pick url or copy_code.');
		const text = typeof button.value === 'string' ? button.value.trim() : '';
		if (text.length === 0 || text.length > BUTTON_VALUE_LIMIT)
			return fail(
				`buttons/${at}/value`,
				`Write the button’s value (at most ${BUTTON_VALUE_LIMIT} characters), for example {code}.`,
			);
		const sections = sectionProblem(text);
		if (sections) return fail(`buttons/${at}/value`, sections);
		value.push({ index, type: /** @type {ButtonType} */ (button.type), value: text });
	}
	return { ok: true, value: value.sort((a, b) => a.index - b.index) };
};

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
	if (lang === null) return fail('language', 'Use a language code such as en, fr or pt-BR.');
	const text = typeof body.text === 'string' ? body.text.trim() : '';
	if (text.length === 0) return fail('text', 'Write the message.');
	if (text.length > TEXT_LIMITS[channel])
		return fail('text', `The message can have at most ${TEXT_LIMITS[channel]} characters.`);
	const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
	const titled = channel === 'email' || channel === 'push' || channel === 'staff_push';
	if (titled && subject.length === 0) return fail('subject', channel === 'email' ? 'Write the subject.' : 'Write the title.');
	if (subject.length > SUBJECT_LIMIT || /[\r\n]/.test(subject))
		return fail('subject', `Use one line of at most ${SUBJECT_LIMIT} characters.`);
	const textSections = sectionProblem(text);
	if (textSections) return fail('text', textSections);
	const subjectSections = titled ? sectionProblem(subject) : null;
	if (subjectSections) return fail('subject', subjectSections);
	const providerTemplate = typeof body.providerTemplate === 'string' ? body.providerTemplate.trim() : '';
	if (providerTemplate !== '' && (channel !== 'whatsapp' || !/^[a-z0-9_]{1,512}$/.test(providerTemplate)))
		return fail('providerTemplate', 'Only WhatsApp templates have a provider template name (lower case, digits and _).');
	const buttons = checkButtons(body.buttons, { channel, providerTemplate });
	if (!buttons.ok) return buttons;
	return {
		ok: true,
		value: {
			key: body.key,
			channel,
			language: lang,
			subject: titled ? subject : '',
			text,
			required: isRequired({ key: body.key, required: body.required === true }),
			urgent: isUrgent({ key: body.key, urgent: body.urgent === true }),
			providerTemplate,
			buttons: buttons.value,
			sensitive: isSensitive({ key: body.key, sensitive: body.sensitive === true }),
		},
	};
};

/**
 * Whether a value is given and not empty (blank counts as empty).
 * @param {Readonly<Record<string, string>>} values
 * @param {string} name
 */
const hasValue = (values, name) => Object.hasOwn(values, name) && /** @type {string} */ (values[name]).trim() !== '';

/**
 * Keep the optional sections whose value is not empty (without their tags) and drop the others, inner ones too.
 * @param {string} text
 * @param {Readonly<Record<string, string>>} values
 * @returns {string}
 */
const showSections = (text, values) =>
	text.replace(SECTION, (_match, name, inner) => (hasValue(values, name) ? showSections(inner, values) : ''));

/**
 * Fill a text: optional sections `{?name}…{/name}` show only when `name` is not empty, then `{placeholders}` get their
 * values (plain text; unknown placeholders stay as written).
 * @param {string} text
 * @param {Readonly<Record<string, string>>} values
 */
export const fillText = (text, values) =>
	showSections(text, values).replace(PLACEHOLDER, (match, name) =>
		Object.hasOwn(values, name) ? /** @type {string} */ (values[name]) : match,
	);

/**
 * Check the values of a send: up to 50 names, each a string or a number of at most 1000 characters.
 * @param {unknown} input
 * @returns {{ ok: true, value: Record<string, string> } | { ok: false }}
 */
export const checkValues = (input) => {
	if (input === undefined || input === null) return { ok: true, value: {} };
	if (typeof input !== 'object' || Array.isArray(input)) return { ok: false };
	const entries = Object.entries(/** @type {Record<string, unknown>} */ (input));
	if (entries.length > MAX_VALUES) return { ok: false };
	/** @type {Record<string, string>} */
	const value = {};
	for (const [name, raw] of entries) {
		if (!VALUE_NAME.test(name) || BUILT_IN_VALUES.includes(name)) return { ok: false };
		if (typeof raw === 'number' && Number.isFinite(raw)) value[name] = String(raw);
		else if (typeof raw === 'string' && raw.length <= 1000) value[name] = raw;
		else return { ok: false };
	}
	return { ok: true, value };
};

/**
 * Check the names of a send's secret values (`secretValues`): up to 50 value names, kept once each.
 * @param {unknown} input
 * @returns {{ ok: true, value: string[] } | { ok: false }}
 */
export const checkSecretValues = (input) => {
	if (input === undefined || input === null) return { ok: true, value: [] };
	if (!Array.isArray(input) || input.length > MAX_VALUES) return { ok: false };
	if (!input.every((name) => typeof name === 'string' && VALUE_NAME.test(name))) return { ok: false };
	return { ok: true, value: [...new Set(/** @type {string[]} */ (input))] };
};

/**
 * The values of a message the delivery log hides (PLAN 0.8.10 D11): every value of a sensitive message, else the
 * values the sender names as secret.
 * @param {Readonly<Record<string, string>>} values
 * @param {{ sensitive: boolean, secretValues: ReadonlyArray<string> }} input
 * @returns {string[]}
 */
export const hiddenNamesOf = (values, { sensitive, secretValues }) =>
	Object.keys(values).filter((name) => sensitive || secretValues.includes(name));

/**
 * The values as the delivery log keeps them: each hidden value that is not empty becomes `[link hidden]` (a link) or
 * `******`, so words filled with them show the same optional sections without the secrets.
 * @param {Readonly<Record<string, string>>} values
 * @param {ReadonlyArray<string>} names the hidden values
 * @returns {Record<string, string>}
 */
export const hideValues = (values, names) =>
	Object.fromEntries(
		Object.entries(values).map(([name, value]) => [
			name,
			!names.includes(name) || value.trim() === '' ? value : LINK.test(value.trim()) ? HIDDEN.link : HIDDEN.value,
		]),
	);

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
 * @returns {{ subject: string, text: string, parameters: string[], buttons: Button[] }} `parameters`: the values in the
 *   order the text uses them (a WhatsApp provider template's body parameters); `buttons`: their values filled
 */
export const renderTemplate = (template, values) => ({
	subject: fillText(template.subject, values),
	text: fillText(template.text, values),
	parameters: placeholdersOf(template.text).map((name) => values[name] ?? ''),
	buttons: template.buttons.map((button) => ({ ...button, value: fillText(button.value, values) })),
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
	required: isRequired(template),
	urgent: isUrgent(template),
	providerTemplate: template.providerTemplate,
	buttons: template.buttons,
	sensitive: isSensitive(template),
	...(template.updatedAt ? { updatedAt: new Date(template.updatedAt).toISOString() } : {}),
});
