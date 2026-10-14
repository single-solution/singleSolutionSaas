/**
 * Products' messages and their default templates as Notifications' dashboard shows them (parity P1): each product
 * declares the messages it sends with their US-English defaults and serves them at `GET /v1/message-defaults` (public,
 * the same for every website). Notifications finds each product's address in the Portal's directory and reads that
 * list, checked with `@ss/contracts` `validateMessageDefaults`, kept 10 minutes per instance (the last good copy stays
 * while a product cannot be reached). Sends never wait for this: a product's send carries its defaults itself.
 * @module
 */
import { validateMessageDefaults } from '@ss/contracts';
import { PRODUCT_IDS } from '../core/templates.js';

/** @typedef {import('../core/templates.js').ProductMessage} ProductMessage */
/** @typedef {(url: string, init?: import('@ss/net').SafeFetchInit) => Promise<import('@ss/net').SafeResponse>} OutboundSend */

/** How long a product's list is kept before it is read again. */
export const DEFAULTS_TTL_MS = 10 * 60_000;
/** Deadline of one read. */
const READ_TIMEOUT_MS = 5000;

/**
 * @param {{ addressOf: (productId: string) => Promise<string>, send: OutboundSend, now: () => number,
 *   logger?: { info: (message: string, fields?: Record<string, unknown>) => void } }} options
 */
export const createDefaults = ({ addressOf, send, now, logger }) => {
	/** @type {Map<string, { at: number, messages: ProductMessage[] }>} */
	const cache = new Map();

	/**
	 * One product's messages, read now.
	 * @param {string} productId
	 * @returns {Promise<ProductMessage[]>}
	 */
	const read = async (productId) => {
		const base = await addressOf(productId);
		const response = await send(`${base}/v1/message-defaults`, {
			method: 'GET',
			headers: { accept: 'application/json' },
			timeoutMs: READ_TIMEOUT_MS,
			redirect: 'error',
		});
		if (response.status !== 200) throw new Error(`answered HTTP ${response.status}`);
		const checked = validateMessageDefaults(JSON.parse(response.body.toString('utf8')));
		if (!checked.ok || checked.value.productId !== productId) throw new Error('the list does not fit the contract');
		return checked.value.messages.map((message) => ({ productId, ...message }));
	};

	/**
	 * Every product's messages with their defaults, and the products whose list cannot be read now (and was never read
	 * by this instance).
	 * @returns {Promise<{ messages: ProductMessage[], unavailable: string[] }>}
	 */
	const all = async () => {
		const lists = await Promise.all(
			PRODUCT_IDS.map(async (productId) => {
				const kept = cache.get(productId);
				if (kept && now() - kept.at < DEFAULTS_TTL_MS) return { productId, messages: kept.messages };
				try {
					const messages = await read(productId);
					cache.set(productId, { at: now(), messages });
					return { productId, messages };
				} catch (error) {
					logger?.info('message defaults not read', {
						productId,
						reason: error instanceof Error ? error.message : 'error',
					});
					return { productId, messages: kept?.messages ?? null };
				}
			}),
		);
		return {
			messages: lists.flatMap((list) => list.messages ?? []),
			unavailable: lists.filter((list) => list.messages === null).map((list) => list.productId),
		};
	};

	return Object.freeze({ all });
};

/** @typedef {ReturnType<typeof createDefaults>} Defaults */
