/**
 * Templates (PLAN 0.8.5): one per template key × channel × language. Products and the send API name a template key
 * and the values; the merchant writes the words. A template's text fills `{placeholders}` from the values as plain
 * text, and shows an optional section `{?name}…{/name}` only when the value `name` is not empty (PLAN 0.8.10 N2).
 * The rules of the words are `@ss/contracts/templates`, which products' default templates follow too (parity P1): a
 * send of a product's message carries its defaults, used while the website has no template of its own for the channel.
 * A product's message may have long values (`longValues`, up to 50,000 characters each, for example a chat
 * transcript): they go only in the message's text; email sends them whole, and a channel with a shorter limit (SMS,
 * WhatsApp, push) gets them cut to fit, at a line or word end, with a note.
 * No I/O: the API, the dashboard and the widgets share it.
 * @module
 */
import {
	BUILT_IN_VALUES,
	LONG_VALUE_LIMIT,
	MAX_VALUES,
	SUBJECT_LIMIT,
	TEMPLATE_KEY,
	TEXT_LIMITS,
	VALUES_TOTAL_LIMIT,
	VALUE_LIMIT,
	VALUE_NAME,
	isTitled,
	longValueProblem,
	placeholdersOf,
	sectionProblem,
	valueNamesOf,
	wordsProblem,
} from '@ss/contracts/templates';
import { CHANNELS, LANGUAGE } from './channels.js';

export { placeholdersOf, sectionProblem, valueNamesOf };

/**
 * Template keys of Accounts' messages (sign-in codes, magic, reset and setup links, account updates): always required
 * (no unsubscribe or STOP reply stops them, PLAN 0.8.5), always urgent (neither quiet hours nor a delayed send hold
 * them) and always sensitive (PLAN 0.8.10 D11), whatever the template says. They are never switched off either.
 */
const ACCOUNT_KEY_PREFIX = 'accounts.';

/** The language of a template every recipient falls back to (written as `default` in paths). */
export const DEFAULT_LANGUAGE = '';

/**
 * The language code Meta takes with a WhatsApp template: a language version's own, as Meta writes it (`pt-BR` →
 * `pt_BR`), else the website's setting "Language of your Meta templates" (empty: `en`).
 * @param {string} language the version's language (`''` = the default version)
 * @param {unknown} templateLanguage the WhatsApp setting `templateLanguage`
 * @returns {string}
 */
export const metaLanguageOf = (language, templateLanguage) =>
	language !== DEFAULT_LANGUAGE ? language.replaceAll('-', '_') : String(templateLanguage ?? '').trim() || 'en';

/** What the delivery log keeps instead of a hidden value that is not empty: a link, else any other value. */
const HIDDEN = Object.freeze({ link: '[link hidden]', value: '******' });
/** A value that is a link: an address with a scheme, or a path. */
const LINK = /:\/\/|^\//;

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]{0,63})\}/g;
/** A whole optional section (sections of one name never nest, so the first closing tag of its name ends it). */
const SECTION = /\{\?([A-Za-z][A-Za-z0-9_]{0,63})\}([\s\S]*?)\{\/\1\}/g;

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
/** Whether a channel's messages have a subject or title (the widgets read it here). */
export { isTitled };

/** @typedef {'url' | 'copy_code'} ButtonType */

/** Button types (PLAN 0.8.10 N1). */
export const BUTTON_TYPES = Object.freeze(/** @type {ButtonType[]} */ (['url', 'copy_code']));
/** Most buttons a template at Meta has. */
export const MAX_BUTTONS = 10;
/** Longest button value (characters, as written). */
const BUTTON_VALUE_LIMIT = 2000;

/**
 * The product a template key belongs to, or null for the merchant's own keys. A key of another product's own messages
 * starts with that product's id and a dot (`chat.staff_new_message`); the products are the ones the Portal's directory
 * lists, so a product made later is known without a change here. Products' keys work without the Merchant send API
 * feature, and their messages can be switched off (but Accounts'); every other key is the merchant's own (PLAN 0.8.4
 * builder choice).
 * @param {string} key
 * @param {ReadonlyArray<string>} productIds the other products (the Portal's directory)
 * @returns {string | null}
 */
export const productOfKey = (key, productIds) => {
	const dot = key.indexOf('.');
	const id = dot > 0 ? key.slice(0, dot) : '';
	return productIds.includes(id) ? id : null;
};

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
 * Check a template the merchant saves (or a product's default words): with the long values of its product's message,
 * which go only in the text, never in the subject or a button.
 * @param {unknown} input
 * @param {ReadonlyArray<string>} [longValues]
 * @returns {{ ok: true, value: Template } | { ok: false, field: string, message: string }}
 */
export const checkTemplate = (input, longValues = []) => {
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
	const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
	const titled = isTitled(channel);
	const words = wordsProblem(channel, { subject, text });
	if (words) return fail(words.field, words.message);
	const providerTemplate = typeof body.providerTemplate === 'string' ? body.providerTemplate.trim() : '';
	if (providerTemplate !== '' && (channel !== 'whatsapp' || !/^[a-z0-9_]{1,512}$/.test(providerTemplate)))
		return fail('providerTemplate', 'Only WhatsApp templates have a provider template name (lower case, digits and _).');
	const buttons = checkButtons(body.buttons, { channel, providerTemplate });
	if (!buttons.ok) return buttons;
	const longSubject = longValueProblem(subject, longValues);
	if (longSubject) return fail('subject', longSubject);
	for (const [at, button] of buttons.value.entries()) {
		const longButton = longValueProblem(button.value, longValues);
		if (longButton) return fail(`buttons/${at}/value`, longButton);
	}
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
 * Check the defaults a send carries (parity P1; the kit adds them to every send of a product's declared message): for
 * each channel but WhatsApp, the default words `{ subject?, text, required?, urgent?, sensitive? }`, checked as a
 * template the merchant saves, with the send's long values. WhatsApp never has a default (it sends only templates
 * approved at Meta).
 * @param {unknown} input
 * @param {string} key the send's template key
 * @param {ReadonlyArray<string>} [longValues] the send's long values
 * @returns {{ ok: true, value: Partial<Record<Channel, Template>> } | { ok: false, field: string, message: string }}
 */
export const checkDefaults = (input, key, longValues = []) => {
	/** @param {string} field @param {string} message */
	const fail = (field, message) => /** @type {const} */ ({ ok: false, field, message });
	if (input === undefined || input === null) return { ok: true, value: {} };
	if (typeof input !== 'object' || Array.isArray(input))
		return fail('defaults', 'defaults maps channels to the default words { subject?, text }.');
	/** @type {Partial<Record<Channel, Template>>} */
	const value = {};
	for (const [channel, given] of Object.entries(/** @type {Record<string, unknown>} */ (input))) {
		if (channel === 'whatsapp')
			return fail('defaults/whatsapp', 'WhatsApp has no default: it sends only templates approved at Meta.');
		if (!CHANNELS.includes(/** @type {Channel} */ (channel))) return fail(`defaults/${channel}`, 'This is not a channel.');
		const words = typeof given === 'object' && given !== null ? /** @type {Record<string, unknown>} */ (given) : {};
		const checked = checkTemplate(
			{
				key,
				channel,
				subject: words.subject,
				text: words.text,
				required: words.required,
				urgent: words.urgent,
				sensitive: words.sensitive,
			},
			longValues,
		);
		if (!checked.ok) return fail(`defaults/${channel}/${checked.field}`, checked.message);
		value[/** @type {Channel} */ (channel)] = checked.value;
	}
	return { ok: true, value };
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
 * Check the values of a send: up to 50 names, each a string or a number of at most 1,000 characters — 50,000 for a
 * long value of the send's product message — and 100,000 characters in all.
 * @param {unknown} input
 * @param {ReadonlyArray<string>} [longValues] the send's long values
 * @returns {{ ok: true, value: Record<string, string> } | { ok: false }}
 */
export const checkValues = (input, longValues = []) => {
	if (input === undefined || input === null) return { ok: true, value: {} };
	if (typeof input !== 'object' || Array.isArray(input)) return { ok: false };
	const entries = Object.entries(/** @type {Record<string, unknown>} */ (input));
	if (entries.length > MAX_VALUES) return { ok: false };
	/** @type {Record<string, string>} */
	const value = {};
	let total = 0;
	for (const [name, raw] of entries) {
		if (!VALUE_NAME.test(name) || BUILT_IN_VALUES.includes(name)) return { ok: false };
		const text = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : typeof raw === 'string' ? raw : null;
		if (text === null || text.length > (longValues.includes(name) ? LONG_VALUE_LIMIT : VALUE_LIMIT)) return { ok: false };
		total += text.length;
		value[name] = text;
	}
	return total > VALUES_TOTAL_LIMIT ? { ok: false } : { ok: true, value };
};

/**
 * Check a send's list of value names (`secretValues`, `longValues`): up to 50 value names, kept once each.
 * @param {unknown} input
 * @returns {{ ok: true, value: string[] } | { ok: false }}
 */
export const checkValueNames = (input) => {
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

/** A value cut to fit ends at a line end, else a word end, found in its last fifth, else exactly where room ends. */
const BREAK_ZONE = 0.8;

/**
 * A long value cut to at most `max` characters, ending with `note`: at the last line end in its last fifth, else the
 * last word end there, else at `max`, never between the two halves of a character; empty when not even the note fits.
 * @param {string} value
 * @param {number} max
 * @param {string} note
 */
const cutValue = (value, max, note) => {
	if (value.length <= max) return value;
	let end = max - note.length;
	if (end <= 0) return '';
	const last = value.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end -= 1;
	const head = value.slice(0, end);
	const at = [head.lastIndexOf('\n'), head.lastIndexOf(' ')].find((index) => index >= end * BREAK_ZONE) ?? end;
	return `${head.slice(0, at).trimEnd()}${note}`;
};

/**
 * The values that fill a text within `limit` characters: when the filled text is longer, the long values it shows are
 * cut (each to its share of the room the rest of the text leaves, a short one keeping its whole length) with `note` at
 * their end; every other value stays whole. A text that fits keeps its values.
 * @param {string} text
 * @param {Readonly<Record<string, string>>} values
 * @param {{ longValues: ReadonlyArray<string>, limit: number, note: string }} fit
 * @returns {Readonly<Record<string, string>>}
 */
export const fitValues = (text, values, { longValues, limit, note }) => {
	const shown = showSections(text, values);
	/** How often each long value that is not empty shows. @type {Map<string, number>} */
	const uses = new Map();
	for (const [, name] of shown.matchAll(PLACEHOLDER))
		if (longValues.includes(/** @type {string} */ (name)) && hasValue(values, /** @type {string} */ (name)))
			uses.set(/** @type {string} */ (name), (uses.get(/** @type {string} */ (name)) ?? 0) + 1);
	if (uses.size === 0 || fillText(text, values).length <= limit) return values;
	const rest = shown.replace(PLACEHOLDER, (match, name) =>
		uses.has(name) ? '' : Object.hasOwn(values, name) ? /** @type {string} */ (values[name]) : match,
	);
	let room = Math.max(0, limit - rest.length);
	let left = [...uses.values()].reduce((sum, count) => sum + count, 0);
	/** @type {Record<string, string>} */
	const fitted = { ...values };
	for (const [name, count] of [...uses].sort(([a], [b]) => String(values[a]).length - String(values[b]).length)) {
		const share = Math.floor(room / left);
		fitted[name] = cutValue(/** @type {string} */ (values[name]), share, note);
		room -= fitted[name].length * count;
		left -= count;
	}
	return fitted;
};

/**
 * The message a template makes for one send. Long values (`fit.longValues`) fill the text whole on email; elsewhere,
 * and in a subject, title or button, they are cut to fit with `fit.note` (`fitValues`).
 * @param {Template} template
 * @param {Readonly<Record<string, string>>} values the send's values plus the built-in ones
 * @param {{ longValues: ReadonlyArray<string>, note: string }} [fit]
 * @returns {{ subject: string, text: string, parameters: string[], buttons: Button[] }} `parameters`: the values in the
 *   order the text uses them (a WhatsApp provider template's body parameters); `buttons`: their values filled
 */
export const renderTemplate = (template, values, fit = { longValues: [], note: '' }) => {
	/** @param {string} text @param {number} limit */
	const valuesFor = (text, limit) => (fit.longValues.length === 0 ? values : fitValues(text, values, { ...fit, limit }));
	const textValues = template.channel === 'email' ? values : valuesFor(template.text, TEXT_LIMITS[template.channel]);
	return {
		subject: fillText(template.subject, valuesFor(template.subject, SUBJECT_LIMIT)),
		text: fillText(template.text, textValues),
		parameters: placeholdersOf(template.text).map((name) => textValues[name] ?? ''),
		buttons: template.buttons.map((button) => ({
			...button,
			value: fillText(button.value, valuesFor(button.value, BUTTON_VALUE_LIMIT)),
		})),
	};
};

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

/**
 * A message a product declares (its `GET /v1/message-defaults`), with the product's id: `channels` holds the default
 * words of each channel it is sent on (`null` for WhatsApp, which has no default); `longValues` the values that hold
 * long text.
 * @typedef {{ productId: string, key: string, name: string, description?: string, values: string[],
 *   longValues?: string[], required?: boolean, urgent?: boolean, sensitive?: boolean,
 *   channels: Partial<Record<Channel, { subject?: string, text: string } | null>> }} ProductMessage
 */
/**
 * A row of the dashboard's template list (parity P1). A product's message has a row per channel it is sent on, in the
 * state `default` (the product's words are sent), `edited` (the merchant's default version is), `not_set_up`
 * (WhatsApp without the merchant's version: nothing is sent there) or `off` (switched off); `template` is the
 * merchant's default version, `defaults` the product's words as a template (null on WhatsApp). Every other saved
 * template (the merchant's own keys, other languages) is a `saved` row.
 * @typedef {{ key: string, channel: Channel, language: string, state: 'default' | 'edited' | 'not_set_up' | 'off' | 'saved',
 *   message: ProductMessage | null, template: (Template & { updatedAt?: string }) | null, defaults: Template | null,
 *   switchable: boolean }} TemplateRow
 */

/**
 * The rows of the dashboard's template list: each product message × channel first (by key, then in the order of
 * `CHANNELS`), then every saved template no product row shows, by key, channel and language.
 * @param {{ messages: ProductMessage[], templates: Array<Template & { updatedAt?: string }>,
 *   off: Array<{ key: string, channel: string }> }} input `templates` as the API answers them (`language: 'default'`)
 * @returns {TemplateRow[]}
 */
export const templateRows = ({ messages, templates, off }) => {
	/** @param {string} key @param {string} channel @param {string} language */
	const id = (key, channel, language) => `${key}|${channel}|${language}`;
	const saved = new Map(templates.map((template) => [id(template.key, template.channel, template.language), template]));
	const switchedOff = new Set(off.map((entry) => `${entry.key}|${entry.channel}`));
	/** @type {Set<string>} */
	const shown = new Set();
	/** @type {TemplateRow[]} */
	const rows = [];
	for (const message of [...messages].sort((a, b) => a.key.localeCompare(b.key)))
		for (const channel of CHANNELS) {
			if (!Object.hasOwn(message.channels, channel)) continue;
			const words = message.channels[channel] ?? null;
			const template = saved.get(id(message.key, channel, 'default')) ?? null;
			shown.add(id(message.key, channel, 'default'));
			const checked = words
				? checkTemplate(
						{
							key: message.key,
							channel,
							subject: words.subject,
							text: words.text,
							required: message.required,
							urgent: message.urgent,
							sensitive: message.sensitive,
						},
						message.longValues,
					)
				: null;
			const defaults = checked?.ok ? checked.value : null;
			rows.push({
				key: message.key,
				channel,
				language: 'default',
				state: switchedOff.has(`${message.key}|${channel}`)
					? 'off'
					: template
						? 'edited'
						: defaults
							? 'default'
							: 'not_set_up',
				message,
				template,
				defaults,
				// every product's message but Accounts' (sign-in codes and links are always sent)
				switchable: !isAccountKey(message.key),
			});
		}
	for (const template of templates)
		if (!shown.has(id(template.key, template.channel, template.language)))
			rows.push({
				key: template.key,
				channel: template.channel,
				language: template.language,
				state: 'saved',
				message: null,
				template,
				defaults: null,
				switchable: false,
			});
	return rows;
};
