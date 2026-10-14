/**
 * The other products as Notifications knows them, and their messages with their default templates (parity P1). The
 * products are the ones the Portal's directory lists (the kit's `products()`, kept 5 minutes), so a product made later
 * is served without a change here: its template keys are its own (`<productId>.`), work without the Merchant send API
 * feature, and its messages show in the dashboard. Each product declares the messages it sends with their US-English
 * defaults and serves them at `GET /v1/message-defaults` (public, the same for every website); Notifications reads that
 * list at the product's directory address, checked with `@ss/contracts` `validateMessageDefaults`, kept 10 minutes per
 * instance (the last good copy stays while a product cannot be reached). Sends never wait for these lists: a product's
 * send carries its defaults itself.
 * @module
 */
import { PATTERNS, validateMessageDefaults } from '@ss/contracts';
import { productOfKey } from '../core/templates.js';

/** @typedef {import('../core/templates.js').ProductMessage} ProductMessage */
/** @typedef {(url: string, init?: import('@ss/net').SafeFetchInit) => Promise<import('@ss/net').SafeResponse>} OutboundSend */
/** @typedef {{ productId: string, name: string, baseUrl: string }} DirectoryEntry */

/** How long a product's list is kept before it is read again. */
export const DEFAULTS_TTL_MS = 10 * 60_000;
/** Deadline of one read. */
const READ_TIMEOUT_MS = 5000;
/** A product id as the Portal's directory names it. */
const PRODUCT_ID = new RegExp(PATTERNS.productId);

/**
 * @param {{ products: () => Promise<ReadonlyArray<DirectoryEntry>>, self: string, send: OutboundSend, now: () => number,
 *   logger?: { info: (message: string, fields?: Record<string, unknown>) => void } }} options `products`: the Portal's
 *   directory (every connected product, this one too); `self`: this product's id
 */
export const createDefaults = ({ products, self, send, now, logger }) => {
	/** @type {Map<string, { at: number, messages: ProductMessage[] }>} */
	const cache = new Map();

	/** The other products, by id (throws when the Portal's directory was never read). */
	const others = async () => (await products()).filter((entry) => entry.productId !== self);

	/**
	 * One product's messages, read now.
	 * @param {DirectoryEntry} entry
	 * @returns {Promise<ProductMessage[]>}
	 */
	const read = async ({ productId, baseUrl }) => {
		const response = await send(`${baseUrl}/v1/message-defaults`, {
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
	 * The product a template key belongs to (another product's), or null for the merchant's own keys. While the Portal's
	 * directory has never answered this instance, a key whose first part could be a product id counts as that product's,
	 * so products' messages (sign-in codes, order updates) are never refused because the Portal is out of reach.
	 * @param {string} key
	 * @returns {Promise<string | null>}
	 */
	const ownerOf = async (key) => {
		const dot = key.indexOf('.');
		if (dot <= 0) return null;
		try {
			return productOfKey(
				key,
				(await others()).map((entry) => entry.productId),
			);
		} catch (error) {
			const id = key.slice(0, dot);
			logger?.info('product directory not read: the key counts as a product’s', {
				key,
				reason: error instanceof Error ? error.message : 'error',
			});
			return id !== self && PRODUCT_ID.test(id) ? id : null;
		}
	};

	/**
	 * Every other product's messages with their defaults, the other products by id with their names, and the products
	 * whose list cannot be read now (and was never read by this instance).
	 * @returns {Promise<{ messages: ProductMessage[], products: Array<{ productId: string, name: string }>,
	 *   unavailable: string[] }>}
	 */
	const all = async () => {
		const entries = await others();
		const lists = await Promise.all(
			entries.map(async (entry) => {
				const { productId } = entry;
				const kept = cache.get(productId);
				if (kept && now() - kept.at < DEFAULTS_TTL_MS) return { productId, messages: kept.messages };
				try {
					const messages = await read(entry);
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
			products: entries.map(({ productId, name }) => ({ productId, name })),
			unavailable: lists.filter((list) => list.messages === null).map((list) => list.productId),
		};
	};

	return Object.freeze({ ownerOf, all });
};

/** @typedef {ReturnType<typeof createDefaults>} Defaults */
