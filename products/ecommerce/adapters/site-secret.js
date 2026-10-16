/**
 * A random secret per website, kept in the product database next to the website's settings (so a removed website's
 * secret goes with them): deal locks (PLAN 0.8.10 E18) and the stable image addresses of the media route (SEO audit G1)
 * are signed with it. Made on first use; when two instances make one at once, the first written wins and both read it
 * back.
 *
 * It is kept sealed with `ENCRYPTION_KEY` (PLAN 0.4.8: the kit's sealer, label `ecommerce`, bound to the website). While
 * the owner changes the key, `ENCRYPTION_KEY_PREVIOUS` still opens it and the Owner's Re-seal (`reseal`, RT-14) moves it
 * to the new key. Lost `ENCRYPTION_KEY`: the secret no
 * longer opens and a new one is made (deal locks still open in shoppers' carts end; their carts take today's prices; the
 * media route's image addresses change once, and search engines read the new ones from the sitemap).
 * @module
 */
import { createSealer as createKitSealer, resealEach } from '@ss/app-kit';
import { randomBytes } from 'node:crypto';

/**
 * The sealer of Ecommerce's own secrets.
 * @param {string} encryptionKey `ENCRYPTION_KEY` (at least 32 characters)
 * @param {string | null} [previousKey] `ENCRYPTION_KEY_PREVIOUS`, set only while the key changes
 */
export const createSealer = (encryptionKey, previousKey = null) =>
	createKitSealer({ encryptionKey, previousKey, label: 'ecommerce' });

/** @typedef {import('@ss/app-kit').Sealer} Sealer */

/**
 * @param {{ store: import('@ss/app-kit').Store, sealer: Sealer, now: () => number }} options
 */
export const createSiteSecrets = ({ store, sealer, now }) => {
	/** @param {string} websiteId */
	const idOf = (websiteId) => `${websiteId}|ecommerce|secret.locks`;
	/** @param {string} websiteId */
	const aadOf = (websiteId) => `ecommerce|secret.locks|${websiteId}`;
	/** Secrets read on this instance. @type {Map<string, string>} */
	const known = new Map();

	/**
	 * The record of a website's secret.
	 * @param {string} websiteId @param {string} secret
	 */
	const recordOf = (websiteId, secret) => ({
		websiteId,
		kind: 'ecommerce',
		key: 'secret.locks',
		value: sealer.seal(secret, aadOf(websiteId)),
		at: now(),
	});

	/**
	 * The secret a stored value holds; null when there is none or it does not open.
	 * @param {string} websiteId @param {Record<string, any> | null} doc
	 */
	const secretOf = (websiteId, doc) => (doc ? sealer.open(doc.value, aadOf(websiteId)) : null);

	return Object.freeze({
		/**
		 * The website's lock secret.
		 * @param {string} websiteId
		 * @returns {Promise<string>}
		 */
		get: async (websiteId) => {
			const cached = known.get(websiteId);
			if (cached) return cached;
			const doc = await store.get('settings', idOf(websiteId));
			let secret = secretOf(websiteId, doc);
			if (secret === null) {
				const fresh = randomBytes(32).toString('base64url');
				// none yet: the first written wins; one that no longer opens (ENCRYPTION_KEY lost) is replaced
				if (doc) await store.put('settings', idOf(websiteId), recordOf(websiteId, fresh));
				else await store.insert('settings', idOf(websiteId), recordOf(websiteId, fresh));
				secret = secretOf(websiteId, await store.get('settings', idOf(websiteId))) ?? fresh;
			}
			known.set(websiteId, secret);
			return secret;
		},
		/**
		 * The Owner's Re-seal (RT-14): every website's lock secret sealed again with the current key.
		 * @returns {Promise<import('@ss/app-kit').ResealCounts>}
		 */
		reseal: async () => {
			const docs = await store.list('settings', { kind: 'ecommerce', key: 'secret.locks' }, { limit: 100_000 });
			/** Write a website's secret unless it changed meanwhile. @param {Record<string, any>} doc @param {string} next */
			const save = async (doc, next) => {
				const id = idOf(String(doc.websiteId));
				if ((await store.get('settings', id))?.value === doc.value) await store.put('settings', id, { ...doc, value: next });
			};
			return resealEach(
				sealer,
				docs.map((doc) => ({
					sealed: doc.value,
					aad: aadOf(String(doc.websiteId)),
					save: (/** @type {string} */ next) => save(doc, next),
				})),
			);
		},
	});
};

/** @typedef {ReturnType<typeof createSiteSecrets>} SiteSecrets */
