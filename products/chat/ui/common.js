/**
 * Helpers the Chat widgets share: the widget config and its settings with defaults, widget texts, JSON calls that
 * answer `{ ok, status, data }`, problem codes, labelled fields, small forms and attachments. Text is always set as
 * text, never as HTML.
 * @module
 */
import { element } from './dom.js';

/** @typedef {{ ok: boolean, status: number, data: any }} Answer status 0 when signed out or unreachable */
/** @typedef {(key: string) => string} Texts */

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
 * @property {{ botName: string, avatarUrl: string, launcherPosition: string, launcherStyle: string, windowStyle: string,
 *   fullScreenOnMobile: boolean, hideOnPages: string[] }} look
 * @property {{ messageLimit: number, rememberDays: number, contactCapture: string }} guests
 * @property {string} signInUrl
 * @property {{ showLabel: boolean }} ai
 * @property {{ idleMinutes: number, dismissDays: number, pageRules: Array<{ path: string, delay: number, message: string }> }} proactive
 * @property {Array<{ id: string, name: string, start: { kind: string, path: string, delay: number } }>} flows
 * @property {{ fields: string[], customFields: string[], consentText: string }} leads
 * @property {CustomField[]} customFields
 * @property {{ visitors: string, types: string[], maxBytes: number, storage: boolean }} attachments
 * @property {{ scale: number, askWhen: string, comment: boolean }} ratings
 * @property {boolean} queuePosition
 */

/**
 * The website's widget config, from the kit.
 * @typedef {object} WidgetConfig
 * @property {Record<string, string>} texts
 * @property {import('@ss/app-kit/widget').WidgetTheme} theme
 * @property {string} customCss
 * @property {string[]} features
 * @property {ChatSettings} settings
 */

/** @type {ChatSettings} */
const DEFAULTS = {
	look: {
		botName: '',
		avatarUrl: '',
		launcherPosition: 'bottom-right',
		launcherStyle: 'round',
		windowStyle: 'floating',
		fullScreenOnMobile: true,
		hideOnPages: [],
	},
	guests: { messageLimit: 0, rememberDays: 90, contactCapture: 'never' },
	signInUrl: '',
	ai: { showLabel: true },
	proactive: { idleMinutes: 7, dismissDays: 7, pageRules: [] },
	flows: [],
	leads: { fields: ['name', 'email'], customFields: [], consentText: '' },
	customFields: [],
	attachments: { visitors: 'off', types: [], maxBytes: 0, storage: false },
	ratings: { scale: 5, askWhen: 'on_resolve', comment: false },
	queuePosition: false,
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
 * The first message of a `validation_failed` problem, or ''.
 * @param {Answer} answer
 */
export const invalidText = (answer) => {
	const data = answer.data ?? {};
	const text = data.errors?.[0]?.message ?? data.detail;
	return problemCode(data) === 'validation_failed' && typeof text === 'string' ? text : '';
};

/**
 * A JSON call; never throws.
 * @param {typeof globalThis.fetch} fetch
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: unknown }} [init]
 * @returns {Promise<Answer>}
 */
export const requestJson = async (fetch, url, { method = 'GET', headers = {}, body } = {}) => {
	try {
		const response = await fetch(url, {
			method,
			headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		const data = response.status === 204 ? null : await response.json().catch(() => null);
		return { ok: response.ok, status: response.status, data };
	} catch {
		return { ok: false, status: 0, data: null };
	}
};

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
 * A short date and time.
 * @param {unknown} value
 */
export const when = (value) => {
	const time = Date.parse(String(value));
	return Number.isNaN(time) ? '' : new Date(time).toLocaleString();
};

/**
 * A button that does not submit.
 * @param {Document} doc @param {string} text @param {Record<string, string>} [attributes]
 */
export const buttonOf = (doc, text, attributes = {}) =>
	/** @type {HTMLButtonElement} */ (element(doc, 'button', { type: 'button', ...attributes }, text));

/**
 * Builders of labelled fields with ids unique inside one widget.
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
		const input = /** @type {HTMLInputElement} */ (element(doc, 'input', { type: 'checkbox' }));
		const wrap = element(doc, 'label', { class: 'check' });
		wrap.append(input, doc.createTextNode(label));
		return { wrap, input };
	};
	return { field, check };
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
 * An attachment: images inline (linked), PDFs and anything else as a download link.
 * @param {Document} doc
 * @param {{ name: string, type: string, url: string }} attachment
 */
export const attachmentNode = (doc, attachment) => {
	const url = webAddress(attachment.url);
	if (!url) return element(doc, 'span', { class: 'meta' }, attachment.name);
	if (attachment.type.startsWith('image/')) {
		const link = element(doc, 'a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: 'file' });
		link.append(element(doc, 'img', { src: url, alt: attachment.name, loading: 'lazy' }));
		return link;
	}
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
 * @param {(body: unknown) => Promise<Answer>} ask the uploads route
 * @param {File} file
 * @returns {Promise<{ attachment: { key: string, name: string, type: string, size: number } } | { failed: Answer | null }>}
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
