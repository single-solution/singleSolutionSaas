/**
 * business.json (PLAN 0.4.9): `https://<exact domain>/.well-known/business.json`, read server-side through `@ss/net`
 * (no redirects to other hosts, 64 kB cap) when the dashboard opens for a website, from Refresh, and right after a
 * request whose copy is older than 24 hours (the old copy is used meanwhile). The last good copy is kept with a `found`
 * flag for the Overview checklist; every value is plain text.
 * @module
 */
import { validateBusinessJson } from '@ss/contracts';

/** @typedef {import('@ss/contracts').BusinessInfo} BusinessInfo */
/** @typedef {import('./stores/types.js').Store} Store */
/** @typedef {import('./connections.js').OutboundSend} OutboundSend */

/** A copy older than this is fetched again right after the next request. */
const BUSINESS_MAX_AGE_MS = 24 * 60 * 60_000;
/** Largest business.json read. */
const BUSINESS_MAX_BYTES = 64 * 1024;

/**
 * The defaults when the file or a field is missing: name = the domain, time zone UTC, other fields empty.
 * @param {string} domain
 * @returns {BusinessInfo}
 */
const businessDefaults = (domain) => ({
	name: domain,
	logo: null,
	email: null,
	phone: null,
	address: null,
	country: null,
	timeZone: 'UTC',
});

/**
 * @param {{ store: Store, send: OutboundSend, now: () => number, logger: import('./logger.js').Logger }} options
 */
export const createBusiness = ({ store, send, now, logger }) => {
	/**
	 * Fetch the file again and keep the result.
	 * @param {string} websiteId
	 * @param {string} domain the website's exact domain (from the status response)
	 * @returns {Promise<{ found: boolean, business: BusinessInfo }>}
	 */
	const refresh = async (websiteId, domain) => {
		const previous = await store.get('business', websiteId);
		/** @type {BusinessInfo | null} */
		let copy = null;
		try {
			const response = await send(`https://${domain}/.well-known/business.json`, {
				headers: { accept: 'application/json' },
				maxBytes: BUSINESS_MAX_BYTES,
			});
			if (response.status === 200) {
				const checked = validateBusinessJson(JSON.parse(response.body.toString('utf8')));
				if (checked.ok) copy = checked.value;
			}
		} catch (error) {
			logger.info('business.json not read', { websiteId, error });
		}
		const keep = copy ?? (previous?.domain === domain ? previous?.copy : null) ?? null;
		await store.put('business', websiteId, { websiteId, domain, copy: keep, found: copy !== null, fetchedAt: now() });
		return { found: copy !== null, business: withDefaults(keep, domain) };
	};

	/**
	 * @param {BusinessInfo | null} copy
	 * @param {string} domain
	 * @returns {BusinessInfo}
	 */
	const withDefaults = (copy, domain) => {
		const defaults = businessDefaults(domain);
		if (!copy) return defaults;
		return { ...copy, timeZone: copy.timeZone ?? defaults.timeZone };
	};

	return Object.freeze({
		refresh,
		/**
		 * The kept copy with defaults, and whether the last read found a valid file.
		 * @param {string} websiteId
		 * @param {string} domain
		 * @returns {Promise<{ found: boolean, fetchedAt: string | null, stale: boolean, business: BusinessInfo }>}
		 */
		get: async (websiteId, domain) => {
			const doc = await store.get('business', websiteId);
			const current = doc?.domain === domain ? doc : null;
			return {
				found: current?.found === true,
				fetchedAt: current ? new Date(current.fetchedAt).toISOString() : null,
				stale: !current || now() - current.fetchedAt >= BUSINESS_MAX_AGE_MS,
				business: withDefaults(current?.copy ?? null, domain),
			};
		},
	});
};

/** @typedef {ReturnType<typeof createBusiness>} Business */
