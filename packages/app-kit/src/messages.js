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
 * - `GET /v1/message-defaults` (public, the same for every website) answers `{ productId, messages }`, so Notifications'
 *   dashboard can show every product's messages with their defaults; a product without a declaration answers
 *   `messages: []`.
 * @module
 */
import { validateMessageDefaults } from '@ss/contracts';
import { isObject, kitError } from './util.js';

/** @typedef {import('@ss/contracts').DeclaredMessage} DeclaredMessage */
/** @typedef {{ subject?: string, text: string, required: boolean, urgent: boolean, sensitive: boolean }} DefaultWords */

/**
 * A value frozen all the way down.
 * @template T
 * @param {T} value
 * @returns {T}
 */
const deepFreeze = (value) => {
	if (typeof value === 'object' && value !== null) {
		for (const inner of Object.values(value)) deepFreeze(inner);
		Object.freeze(value);
	}
	return value;
};

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
	}
	const answer = Object.freeze({ productId, messages });

	/**
	 * The default words of a message on every channel that has them, or null when the product declares none.
	 * @param {string} key
	 * @returns {Readonly<Record<string, DefaultWords>> | null}
	 */
	const defaultsFor = (key) => defaults.get(key) ?? null;

	/**
	 * A call to another product with the defaults of its message added: only a send to Notifications whose template
	 * the product declares, when the caller gave none of its own.
	 * @template {{ method?: string, body?: unknown, headers?: Record<string, string> }} T
	 * @param {string} otherProductId
	 * @param {string} path
	 * @param {T} init
	 * @returns {T}
	 */
	const attach = (otherProductId, path, init) => {
		const { method = 'GET', body } = init;
		if (otherProductId !== 'notifications' || method !== 'POST' || !SEND_PATH.test(path)) return init;
		if (!isObject(body) || typeof body.template !== 'string' || body.defaults !== undefined) return init;
		const words = defaultsFor(body.template);
		return words ? { ...init, body: { ...body, defaults: words } } : init;
	};

	return Object.freeze({ declaration: answer, defaultsFor, attach });
};

/** @typedef {ReturnType<typeof createMessages>} Messages */
