/**
 * Re-seal (PLAN 0.4.8, 0.11; RT-14): after the owner changes `ENCRYPTION_KEY` (the old key set as
 * `ENCRYPTION_KEY_PREVIOUS`), an Owner presses Re-seal on the product dashboard (`POST /v1/dashboard/reseal`). Every
 * stored secret is sealed again with the current key: the Connections of every website, the product key and the
 * ticket key (K-21), and what the product keeps itself, through its hooks: `resealProduct` (its own secrets in the product database) and `resealWebsite` (secrets in
 * one website's merchant database, called for every website whose database is connected).
 *
 * Values already on the current key stay as they are; values neither key opens are counted and left alone, and
 * `unreadableIn` says where they are (`connections`: secrets typed in Connections; `keys`: the product and ticket
 * keys, made again by a Reconnect in the Portal; `product`: the product's own stored secrets). Pressing again is safe.
 * Only when nothing is unreadable and no website failed does the owner remove `ENCRYPTION_KEY_PREVIOUS`. No timer: it
 * runs only when pressed.
 * @module
 */

/** @typedef {{ resealed: number, current: number, unreadable: number }} ResealCounts */
/** @typedef {'connections' | 'keys' | 'product'} ResealPart */
/**
 * @typedef {ResealCounts & { keyId: string, previousKeyId: string | null, failedWebsites: string[],
 *   unreadableIn: Partial<Record<ResealPart, number>> }} ResealResult
 */

/**
 * Re-seal stored values and count them: `save` gets each value sealed with the current key; values already on it and
 * values no key opens are left alone.
 * @param {import('./sealing.js').Sealer} sealer
 * @param {Iterable<{ sealed: unknown, aad: string, save: (next: string) => Promise<unknown> }>} items
 * @returns {Promise<ResealCounts>}
 */
export const resealEach = async (sealer, items) => {
	let resealed = 0;
	let current = 0;
	let unreadable = 0;
	for (const { sealed, aad, save } of items) {
		const next = sealer.reseal(sealed, aad);
		if (next === null) unreadable += 1;
		else if (next === sealed) current += 1;
		else {
			resealed += 1;
			await save(next);
		}
	}
	return { resealed, current, unreadable };
};

/**
 * @param {ResealCounts[]} parts
 * @returns {ResealCounts}
 */
export const sumCounts = (parts) => ({
	resealed: parts.reduce((sum, part) => sum + part.resealed, 0),
	current: parts.reduce((sum, part) => sum + part.current, 0),
	unreadable: parts.reduce((sum, part) => sum + part.unreadable, 0),
});

/**
 * @param {{ sealer: import('./sealing.js').Sealer, parts: Array<{ part: ResealPart, reseal: () => Promise<ResealCounts> }>,
 *   hooks: import('./kit-routes.js').ProductHooks, websites: () => Promise<string[]>, data: import('./data.js').Data,
 *   logger: import('./logger.js').Logger }} options `parts`: the kit's parts in the product database (Connections,
 *   keys); `hooks` are read when pressed (products may attach them after `createProduct`)
 * @returns {() => Promise<ResealResult>}
 */
export const createReseal =
	({ sealer, parts, hooks, websites, data, logger }) =>
	async () => {
		/** @type {Array<{ part: ResealPart, counts: ResealCounts }>} */
		const done = [];
		for (const { part, reseal } of parts) done.push({ part, counts: await reseal() });
		if (hooks.resealProduct) done.push({ part: 'product', counts: await hooks.resealProduct() });
		/** @type {string[]} */
		const failedWebsites = [];
		const { resealWebsite } = hooks;
		if (resealWebsite) {
			for (const websiteId of await websites()) {
				try {
					done.push({ part: 'product', counts: await resealWebsite(await data.forWebsite(websiteId)) });
				} catch (error) {
					logger.warn('re-seal: the merchant database was not reached', { websiteId, error });
					failedWebsites.push(websiteId);
				}
			}
		}
		const counts = sumCounts(done.map((entry) => entry.counts));
		/** @type {Partial<Record<ResealPart, number>>} */
		const unreadableIn = {};
		for (const { part, counts: one } of done)
			if (one.unreadable > 0) unreadableIn[part] = (unreadableIn[part] ?? 0) + one.unreadable;
		logger.info('stored secrets re-sealed', { ...counts, failedWebsites: failedWebsites.length });
		return { keyId: sealer.keyId, previousKeyId: sealer.previousKeyId, ...counts, failedWebsites, unreadableIn };
	};
