/**
 * Helpers the Chat widgets share: the widget config and its settings with defaults, widget texts, problem codes (shown
 * as the widget's own texts, never the server's English detail), labeled fields, small forms and attachments. Text is
 * always set as text, never as HTML.
 * @module
 */
import {
	checkbox,
	element,
	field as kitField,
	formatDate,
	normalizeFormat,
	segmented,
	toggle,
	viewerOf,
} from '@ss/app-kit/widget';
import { attachmentKind } from '../core/widgets.js';

/** @typedef {(key: string) => string} Texts */

/** @typedef {import('../core/labels.js').Label} Label a tag, topic or priority of the merchant (C7) */

/**
 * @typedef {object} CustomField
 * @property {string} key
 * @property {string} label
 * @property {'text' | 'number' | 'yes_no' | 'choice'} type
 * @property {string[]} options
 */

/**
 * The settings Chat adds to the widget config (`hooks.widgetConfig`); each part matters only while its feature is on.
 * @typedef {object} ChatSettings
 * @property {{ avatarUrl: string, launcherPosition: string, launcherStyle: string, windowStyle: string,
 *   fullScreenOnMobile: boolean, hideOnPages: string[], showTimes: boolean }} look `showTimes`: each message's time and
 *   a divider for each day (C8)
 * @property {{ messageLimit: number, contactCapture: string }} guests
 * @property {string} signInUrl
 * @property {{ showLabel: boolean }} ai
 * @property {{ showButton: boolean }} handoff whether the window offers Talk to a person (C4)
 * @property {{ idleMinutes: number, pageRules: Array<{ path: string, delay: number, message: string }>,
 *   oncePer: 'session' | 'product', hideOnMobile: boolean }} proactive whether the idle nudge shows once per session or
 *   once per product, and whether phones get none (C14)
 * @property {{ tags: Label[], topics: Label[], priorities: Label[] }} labels the inbox's tags, topics and priorities
 *   (C7; admin widgets only)
 * @property {Array<{ key: string, name: string, path: string, nudge: string }>} pageTypes the merchant's page types
 *   (C6): a page is typed by setPage's kind or a path pattern; each may have its own idle nudge ('' = the general
 *   text)
 * @property {Array<{ id: string, name: string, start: { kind: string, path: string, delay: number } }>} flows
 * @property {{ fields: string[], customFields: string[], consentText: string }} leads
 * @property {CustomField[]} customFields
 * @property {{ visitors: string, types: string[], limits?: Record<string, number>, maxBytes: number, storage: boolean
 *   }} attachments what visitors may send (`types`, each type's cap in `limits`, C11, the largest in `maxBytes`), as the
 *   server checks it
 * @property {{ kind: 'csat' | 'nps', labels: string[], askWhen: string, comment: boolean }} ratings csat: the
 *   merchant's labels, lowest first; nps: 0 to 10 (C13)
 */

/**
 * The website's widget config, from the kit.
 * @typedef {object} WidgetConfig
 * @property {Record<string, string>} texts
 * @property {import('@ss/app-kit/widget').WidgetTheme} theme
 * @property {string} customCss
 * @property {Partial<import('@ss/contracts/format').Format>} [format] how money and dates look (K7)
 * @property {string} [timeZone] the business.json time zone (UTC when missing)
 * @property {string[]} features the switched-on features
 * @property {string[]} widgets the keys of the widgets whose feature is on
 * @property {ChatSettings} settings
 */

/** @type {ChatSettings} */
const DEFAULTS = {
	look: {
		avatarUrl: '',
		launcherPosition: 'bottom-right',
		launcherStyle: 'round',
		windowStyle: 'floating',
		fullScreenOnMobile: true,
		hideOnPages: [],
		showTimes: false,
	},
	guests: { messageLimit: 0, contactCapture: 'never' },
	signInUrl: '',
	ai: { showLabel: true },
	handoff: { showButton: true },
	proactive: {
		idleMinutes: 7,
		pageRules: [],
		oncePer: 'session',
		hideOnMobile: false,
	},
	pageTypes: [],
	labels: { tags: [], topics: [], priorities: [] },
	flows: [],
	leads: { fields: ['name', 'email'], customFields: [], consentText: '' },
	customFields: [],
	attachments: { visitors: 'off', types: [], limits: {}, maxBytes: 0, storage: false },
	ratings: { kind: 'csat', labels: ['1', '2', '3', '4', '5'], askWhen: 'on_resolve', comment: false },
};

/**
 * The config's settings with every part present.
 * @param {{ settings?: Partial<ChatSettings> }} config
 * @returns {ChatSettings}
 */
export const settingsOf = ({ settings = {} }) => {
	const out = /** @type {Record<string, unknown>} */ ({ ...DEFAULTS, ...settings });
	for (const [key, value] of Object.entries(DEFAULTS)) {
		if (value && typeof value === 'object' && !Array.isArray(value))
			out[key] = { ...value, .../** @type {object} */ (/** @type {Record<string, unknown>} */ (settings)[key] ?? {}) };
	}
	return /** @type {ChatSettings} */ (out);
};

/**
 * The widget texts of a config: the website's text, else the key.
 * @param {{ texts: Record<string, string> }} config
 * @returns {Texts}
 */
export const textsOf = (config) => (key) => config.texts[key] ?? key;

/**
 * The code of an RFC 9457 problem (the end of its `type`), or ''.
 * @param {unknown} data
 */
export const problemCode = (data) => {
	const type = /** @type {{ type?: unknown } | null} */ (data)?.type;
	return typeof type === 'string' ? type.slice(type.lastIndexOf('/') + 1) : '';
};

/**
 * Whether the server refused what was sent (`validation_failed`). Widgets then show their own text for that action:
 * never the server's English detail, so every word stays editable (PLAN 0.4.10).
 * @param {import('@ss/app-kit/widget').Answer} answer
 */
export const isInvalid = (answer) => problemCode(answer.data) === 'validation_failed';

/**
 * An http(s) address, or null (addresses from answers are only ever used as links when they are web pages).
 * @param {unknown} value
 * @param {string} [base]
 * @returns {string | null}
 */
export const webAddress = (value, base) => {
	try {
		const url = new URL(String(value), base);
		return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
	} catch {
		return null;
	}
};

/** @param {Element} node @param {boolean} hidden */
export const setHidden = (node, hidden) => {
	if (hidden) node.setAttribute('hidden', '');
	else node.removeAttribute('hidden');
};

/**
 * Dates and times as the website's Format says (K7): its locale (else the viewer's), in the viewer's time zone or the
 * business one (`times`).
 * @param {{ format?: WidgetConfig['format'], timeZone?: string }} config
 * @param {{ navigator?: { language?: string } } | null | undefined} win the browser window (the viewer)
 * @returns {(value: unknown, style?: 'date' | 'datetime' | 'time') => string} '' for a value that is not a time
 */
export const whenOf = (config, win) => {
	const viewer = viewerOf(win);
	return (value, style = 'datetime') => {
		const time = Date.parse(String(value));
		return Number.isNaN(time) ? '' : formatDate(time, config.format, { timeZone: config.timeZone, style, viewer });
	};
};

/** No-break spaces the runtime puts in numbers (fr-FR "12 000"), as plain spaces like the kit's formatters. */
const NO_BREAK_SPACES = new RegExp('[\u00a0\u202f]', 'g');

/**
 * Numbers as the website's Format says (K7): in its locale, else the viewer's, else en-US ("12,000" in en-US,
 * "12.000" in de-DE).
 * @param {{ format?: WidgetConfig['format'] }} config
 * @param {{ navigator?: { language?: string } } | null | undefined} win the browser window (the viewer)
 * @returns {(value: number, digits?: number) => string} `digits`: exactly that many decimals
 */
export const numbersOf = (config, win) => {
	const wanted = normalizeFormat(config.format).locale || viewerOf(win).locale || 'en-US';
	let locale = 'en-US';
	try {
		locale = Intl.NumberFormat.supportedLocalesOf(wanted)[0] ?? locale;
	} catch {
		// not a language tag: en-US
	}
	return (value, digits) =>
		new Intl.NumberFormat(locale, digits === undefined ? {} : { minimumFractionDigits: digits, maximumFractionDigits: digits })
			.format(value)
			.replace(NO_BREAK_SPACES, ' ');
};

/**
 * A button that does not submit.
 * @param {Document} doc @param {string} text @param {Record<string, string>} [attributes]
 */
export const buttonOf = (doc, text, attributes = {}) =>
	/** @type {HTMLButtonElement} */ (element(doc, 'button', { type: 'button', ...attributes }, text));

/**
 * Builders of labeled fields with ids unique inside one widget.
 * @param {Document} doc
 * @param {string} prefix
 */
export const fieldMaker = (doc, prefix) => {
	let n = 0;
	/**
	 * A label and its input in one wrapper.
	 * @param {string} tag @param {string} label @param {Record<string, string>} [attributes]
	 */
	const field = (tag, label, attributes = {}) => {
		n += 1;
		const id = `${prefix}-${n}`;
		const input = /** @type {HTMLInputElement} */ (element(doc, tag, { id, ...attributes }));
		const wrap = element(doc, 'div', { class: 'field' });
		wrap.append(element(doc, 'label', { for: id }, label), input);
		return { wrap, input };
	};
	/** A checkbox with its text. @param {string} label */
	const check = (label) => {
		const { box, node } = checkbox(doc, label);
		return { wrap: node, input: box };
	};
	/** A switch with its text, for a filter. @param {string} label */
	const flip = (label) => {
		const { box, node } = toggle(doc, label, { inline: true });
		return { wrap: node, input: box };
	};
	/**
	 * One choice from a few as a segmented control under its label; `input.value` reads and sets the choice.
	 * @param {string} label @param {Array<{ value: string, label: string }>} items
	 */
	const choose = (label, items) => {
		n += 1;
		const input = segmented(doc, { label, name: `${prefix}-choice-${n}`, items, value: items[0]?.value });
		return { wrap: kitField(doc, label, input.node), input };
	};
	return { field, check, flip, choose };
};

/** @typedef {ReturnType<typeof fieldMaker>} FieldMaker */

/**
 * The input of one custom field (yes/no and choice lists as selects).
 * @param {Document} doc @param {FieldMaker} make @param {Texts} t @param {CustomField} definition
 */
export const customInput = (doc, make, t, definition) => {
	/** @type {Array<[string, string]> | null} */
	const choices =
		definition.type === 'yes_no'
			? [
					['true', t('common.yes')],
					['false', t('common.no')],
				]
			: definition.type === 'choice'
				? definition.options.map((option) => [option, option])
				: null;
	const made = make.field(
		choices ? 'select' : 'input',
		definition.label,
		definition.type === 'number' ? { type: 'number' } : {},
	);
	if (choices)
		made.input.append(
			element(doc, 'option', { value: '' }, t('common.choose')),
			...choices.map(([value, label]) => element(doc, 'option', { value }, label)),
		);
	/** The value: numbers as numbers, yes/no as true/false, '' when empty. @returns {string | number | boolean} */
	const read = () => {
		const raw = made.input.value.trim();
		if (raw === '') return '';
		return definition.type === 'number' ? Number(raw) : definition.type === 'yes_no' ? raw === 'true' : raw;
	};
	/** @param {unknown} value */
	const write = (value) => {
		made.input.value = value === undefined || value === null ? '' : String(value);
	};
	return { ...made, read, write };
};

/**
 * A small form: an optional heading, fields, a submit button and a status line. `submit` returns the text to show.
 * @param {Document} doc
 * @param {{ title?: string, nodes: Node[], label: string, submit: () => Promise<string> }} input
 */
export const formPart = (doc, { title, nodes, label, submit }) => {
	const form = element(doc, 'form', { class: 'part' });
	const send = element(doc, 'button', { type: 'submit' }, label);
	const note = element(doc, 'p', { class: 'status', role: 'status' });
	form.append(...(title ? [element(doc, 'p', { class: 'ask' }, title)] : []), ...nodes, send, note);
	form.addEventListener('submit', async (event) => {
		event.preventDefault();
		send.setAttribute('disabled', '');
		const text = await submit();
		send.removeAttribute('disabled');
		note.textContent = text;
	});
	return form;
};

/**
 * An attachment: the images browsers show inline (linked), video and audio as players (C11: voice notes too), a file
 * that opens in the browser (`inline`, PDFs with that setting, CH-8) as a link to a new tab, anything else (HEIC
 * photos, office files) as a download link.
 * @param {Document} doc
 * @param {{ name: string, type: string, url: string, inline?: boolean }} attachment
 */
export const attachmentNode = (doc, attachment) => {
	const url = webAddress(attachment.url);
	if (!url) return element(doc, 'span', { class: 'meta' }, attachment.name);
	const kind = attachmentKind(attachment.type);
	if (kind === 'video' || kind === 'audio')
		return element(doc, kind, {
			src: url,
			controls: '',
			preload: 'metadata',
			class: `file ${kind}`,
			'aria-label': attachment.name,
		});
	if (kind === 'image') {
		const link = element(doc, 'a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: 'file' });
		link.append(element(doc, 'img', { src: url, alt: attachment.name, loading: 'lazy' }));
		return link;
	}
	if (attachment.inline === true)
		return element(doc, 'a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: 'file' }, attachment.name);
	return element(doc, 'a', { href: url, download: attachment.name, rel: 'noopener noreferrer', class: 'file' }, attachment.name);
};

/**
 * The attachment rules of a file: '' when allowed, else the text key of the reason.
 * @param {{ type: string, size: number }} file
 * @param {readonly string[]} types allowed types
 * @param {number} maxBytes
 * @returns {'' | 'type' | 'size'}
 */
export const fileProblem = (file, types, maxBytes) =>
	!types.includes(file.type) ? 'type' : file.size > maxBytes || file.size <= 0 ? 'size' : '';

/**
 * Upload a file: ask for the presigned PUT, send the file with exactly the returned headers, and answer the attachment
 * for the message.
 * @param {typeof globalThis.fetch} fetch
 * @param {(body: unknown) => Promise<import('@ss/app-kit/widget').Answer>} ask the uploads route
 * @param {File} file
 * @returns {Promise<{ attachment: { key: string, name: string, type: string, size: number } } |
 *   { failed: import('@ss/app-kit/widget').Answer | null }>}
 */
export const uploadFile = async (fetch, ask, file) => {
	const answer = await ask({ name: file.name, type: file.type, size: file.size });
	if (!answer.ok) return { failed: answer };
	try {
		const { upload, attachment } = answer.data;
		const response = await fetch(upload.url, { method: upload.method ?? 'PUT', headers: upload.headers ?? {}, body: file });
		return response.ok ? { attachment } : { failed: null };
	} catch {
		return { failed: null };
	}
};
