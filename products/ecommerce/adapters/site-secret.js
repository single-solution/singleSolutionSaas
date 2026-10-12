/**
 * A random secret per website, kept in the product database next to the website's settings (so a removed website's
 * secret goes with them): deal locks are signed with it (PLAN 0.8.10 E18). Made on first use; when two instances make
 * one at once, the first written wins and both read it back.
 * @module
 */
import { randomBytes } from 'node:crypto';

/**
 * @param {{ store: import('@ss/app-kit').Store, now: () => number }} options
 */
export const createSiteSecrets = ({ store, now }) => {
	/** @param {string} websiteId */
	const idOf = (websiteId) => `${websiteId}|ecommerce|secret.locks`;
	/** Secrets read on this instance. @type {Map<string, string>} */
	const known = new Map();

	return Object.freeze({
		/**
		 * The website's lock secret.
		 * @param {string} websiteId
		 * @returns {Promise<string>}
		 */
		get: async (websiteId) => {
			const cached = known.get(websiteId);
			if (cached) return cached;
			let doc = await store.get('settings', idOf(websiteId));
			if (!doc || typeof doc.value !== 'string') {
				await store.insert('settings', idOf(websiteId), {
					websiteId,
					kind: 'ecommerce',
					key: 'secret.locks',
					value: randomBytes(32).toString('base64url'),
					at: now(),
				});
				doc = await store.get('settings', idOf(websiteId));
			}
			const secret = String(doc?.value ?? '');
			known.set(websiteId, secret);
			return secret;
		},
	});
};

/** @typedef {ReturnType<typeof createSiteSecrets>} SiteSecrets */
