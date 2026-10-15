/**
 * Default message templates (parity P1): every product declares the messages it sends through Notifications, with
 * their US-English default words, in `schemas/messages.json` (`{ messages: [...] }`, checked at start with
 * `@ss/contracts` `validateMessageDefaults`; every key starts with the product's id). So a new website gets its staff
 * alerts, sign-in codes and reset links before the merchant writes a single template.
 *
 * - The kit attaches a message's defaults to every send to Notifications (`POST /v1/messages/<channel>` through
 *   `callProduct` or the staff alerts), as `defaults: { <channel>: { subject?, text, required, urgent, sensitive } }`
 *   for each channel that has default words (never WhatsApp: it sends only templates approved at Meta). Notifications
 *   uses them when the website has no template of its own: no extra round trip, the words of the running product.
 * - A message with long values (`longValues`, for example a chat transcript) has them named on every send
 *   (`longValues: [...]`), so Notifications takes them up to 50,000 characters each.
 * - A send whose key the product does not declare but whose `fallbackTemplate` it does (a key made per case, such as
 *   Ecommerce's `ecommerce.order_status.<status key>` falling back to `ecommerce.order_status`) carries the fallback
 *   message's defaults and long values: Notifications tries the website's template for the key, then for the fallback
 *   key, then the defaults.
 * - `GET /v1/message-defaults` (public, the same for every website) answers `{ productId, messages }`, so Notifications'
 *   dashboard can show every product's messages with their defaults; a product without a declaration answers
 *   `messages: []`.
 * @module
 */
import { validateMessageDefaults } from '@ss/contracts';
import { deepFreeze, isObject, kitError } from './util.js';

/** @typedef {import('@ss/contracts').DeclaredMessage} DeclaredMessage */
/** @typedef {{ subject?: string, text: string, required: boolean, urgent: boolean, sensitive: boolean }} DefaultWords */

/** The send API path of each channel in Notifications. */
const SEND_PATH = /^\/v1\/messages\/(email|sms|whatsapp|push|staff-push)$/;

/**
 * @param {{ productId: string, declaration?: unknown }} options `declaration`: the product's `schemas/messages.json`
 */
export const createMessages = ({ productId, declaration }) => {
	const given = declaration === undefined ? { messages: [] } : declaration;
	const checked = validateMessageDefaults(isObject(given) ? { ...given, productId } : given);
	if (!checked.ok)
		throw kitError(
			'invalid_config',
			`messages are invalid: ${checked.problems.map((p) => `${p.path || '/'} ${p.message}`).join('; ')}`,
		);
	/** @type {ReadonlyArray<DeclaredMessage>} */
	const messages = deepFreeze(structuredClone(checked.value.messages));
	/** @type {Map<string, Readonly<Record<string, DefaultWords>>>} */
	const defaults = new Map();
	/** The long values of each message that has some. @type {Map<string, ReadonlyArray<string>>} */
	const longValues = new Map();
	for (const message of messages) {
		/** @type {Record<string, DefaultWords>} */
		const words = {};
		for (const [channel, given] of Object.entries(message.channels))
			if (given)
				words[channel] = {
					...given,
					required: message.required === true,
					urgent: message.urgent === true,
					sensitive: message.sensitive === true,
				};
		if (Object.keys(words).length > 0) defaults.set(message.key, deepFreeze(words));
		if (message.longValues?.length) longValues.set(message.key, message.longValues);
	}
	const answer = Object.freeze({ productId, messages });

	/**
	 * A call to another product with the defaults and long values of its message added: only a send to Notifications
	 * whose template (else whose `fallbackTemplate`) the product declares.
	 * @template {{ method?: string, body?: unknown, headers?: Record<string, string> }} T
	 * @param {string} otherProductId
	 * @param {string} path
	 * @param {T} init
	 * @returns {T}
	 */
	const attach = (otherProductId, path, init) => {
		const { method = 'GET', body } = init;
		if (otherProductId !== 'notifications' || method !== 'POST' || !SEND_PATH.test(path)) return init;
		if (!isObject(body) || typeof body.template !== 'string') return init;
		const key = body.template;
		const fallback = typeof body.fallbackTemplate === 'string' ? body.fallbackTemplate : null;
		/** @template V @param {Map<string, V>} map @returns {V | null} */
		const declared = (map) => map.get(key) ?? (fallback === null ? null : (map.get(fallback) ?? null));
		const words = declared(defaults);
		const long = declared(longValues);
		if (!words && !long) return init;
		return { ...init, body: { ...body, ...(words ? { defaults: words } : {}), ...(long ? { longValues: long } : {}) } };
	};

	return Object.freeze({ declaration: answer, attach });
};

/** @typedef {ReturnType<typeof createMessages>} Messages */
