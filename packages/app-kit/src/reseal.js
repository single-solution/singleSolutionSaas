/**
 * Re-seal (PLAN 0.4.8, 0.11; RT-14): after the owner changes `ENCRYPTION_KEY` (the old key set as
 * `ENCRYPTION_KEY_PREVIOUS`), an Owner presses Re-seal on the product dashboard (`POST /v1/dashboard/reseal`). Every
 * stored secret is sealed again with the current key: the Connections of every website and what the product keeps
 * itself, through its hooks: `resealProduct` (its own secrets in the product database) and `resealWebsite` (secrets in
 * one website's merchant database, called for every website whose database is connected).
 *
 * Values already on the current key stay as they are; values neither key opens are counted and left alone. Pressing
 * again is safe. When the answer shows nothing re-sealed, nothing unreadable and no failed website, the owner removes
 * `ENCRYPTION_KEY_PREVIOUS`. No timer: it runs only when pressed.
 * @module
 */

/** @typedef {{ resealed: number, current: number, unreadable: number }} ResealCounts */
/**
 * @typedef {ResealCounts & { keyId: string, previousKeyId: string | null, failedWebsites: string[] }} ResealResult
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
 * @param {{ sealer: import('./sealing.js').Sealer, parts: Array<() => Promise<ResealCounts>>,
 *   hooks: import('./kit-routes.js').ProductHooks, websites: () => Promise<string[]>, data: import('./data.js').Data,
 *   logger: import('./logger.js').Logger }} options `parts`: the kit's parts in the product database (Connections,
 *   keys); `hooks` are read when pressed (products may attach them after `createProduct`)
 * @returns {() => Promise<ResealResult>}
 */
export const createReseal =
	({ sealer, parts, hooks, websites, data, logger }) =>
	async () => {
		/** @type {ResealCounts[]} */
		const done = [];
		for (const part of parts) done.push(await part());
		if (hooks.resealProduct) done.push(await hooks.resealProduct());
		/** @type {string[]} */
		const failedWebsites = [];
		const { resealWebsite } = hooks;
		if (resealWebsite) {
			for (const websiteId of await websites()) {
				try {
					done.push(await resealWebsite(await data.forWebsite(websiteId)));
				} catch (error) {
					logger.warn('re-seal: the merchant database was not reached', { websiteId, error });
					failedWebsites.push(websiteId);
				}
			}
		}
		const counts = sumCounts(done);
		logger.info('stored secrets re-sealed', { ...counts, failedWebsites: failedWebsites.length });
		return { keyId: sealer.keyId, previousKeyId: sealer.previousKeyId, ...counts, failedWebsites };
	};
