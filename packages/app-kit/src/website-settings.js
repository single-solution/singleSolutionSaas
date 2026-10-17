/**
 * The Portal's website settings in the product (settings-ownership design 8.2): the facts every product of a website
 * shares — business facts, brand and theme, region and Format, pages, team — are kept once in the Portal and arrive here.
 *
 * - **One signed pull, a version in the status answer, a notice to hurry it.** The status answer carries
 *   `settingsVersion`; a copy older than it is fetched again (`GET /v1/product/websites/:id/settings?since=`, the Portal
 *   sends the document only when it is newer) after the response. A `website.settings_changed` notice marks the same
 *   and the product fetches right after answering it; a lost notice is caught by the next status (at most 5 minutes).
 * - **Light on free plans.** The copy lives in the product database (`website_settings`, one small document per
 *   website) and in this instance's memory for {@link MEMORY_MS}. A request reads memory, then the database; it never
 *   calls the Portal while it holds a copy. A change costs one request per product, not per visitor.
 * - **A Portal outage changes nothing.** The last copy is used with no time limit (a stale brand color is harmless). Only
 *   a first use that has no copy at all waits for the Portal (at most {@link WAITED_FETCH_MS}); if that fails the product
 *   keeps its own values and tries again after a response.
 * - While the Portal holds nothing for a website (`settingsVersion` 0) there is no copy: `get` answers null and the
 *   product uses the built-in defaults (the Overview says "Needs setup: set your website settings in the Portal").
 * @module
 */
import { emptyWebsiteSettings } from '@ss/contracts/website-settings';
import { deepFreeze } from '@ss/contracts/util';
import { WAITED_FETCH_MS } from './status.js';

/** @typedef {import('@ss/contracts').WebsiteSettings} WebsiteSettings */
/** @typedef {import('./stores/types.js').Store} Store */
/** Runs work right after the response (a request's `after`). @typedef {(task: () => Promise<unknown>) => void} After */
/**
 * A held copy: the document, its version and when it was fetched.
 * @typedef {{ websiteId: string, version: number, settings: WebsiteSettings, fetchedAt: number }} Held
 */

/** How long an instance answers from its memory before reading the product database again. */
export const MEMORY_MS = 60_000;
/** An instance starts a fetch after a response at most this often per website (also after a failed one). */
const REFRESH_EVERY_MS = 30_000;
/** Websites an instance remembers at most (the oldest goes first). */
const MEMORY_LIMIT = 200;

/**
 * @param {{ store: Store, client: () => import('./portal-client.js').PortalClient, now: () => number,
 *   logger: import('./logger.js').Logger }} options
 */
export const createWebsiteSettings = ({ store, client, now, logger }) => {
	/**
	 * What this instance last knew: the held copy (or none) and the version the status copy asked for, as of `at`.
	 * @type {Map<string, { held: Held | null, needed: number, at: number }>}
	 */
	const memory = new Map();
	/** Fetches running on this instance, one per website. @type {Map<string, Promise<Held | null>>} */
	const fetching = new Map();
	/** When this instance last started a fetch after a response, per website. @type {Map<string, number>} */
	const startedAt = new Map();

	/**
	 * Remember what is known of a website. The document is frozen once here, so product code gets it as it is.
	 * @param {string} websiteId @param {Held | null} held @param {number} needed
	 */
	const remember = (websiteId, held, needed) => {
		if (held) deepFreeze(held.settings);
		memory.delete(websiteId);
		memory.set(websiteId, { held, needed: Math.max(needed, held?.version ?? 0), at: now() });
		if (memory.size > MEMORY_LIMIT) memory.delete(/** @type {string} */ (memory.keys().next().value));
	};

	/** @param {After | undefined} after @param {() => Promise<unknown>} task never throws */
	const later = (after, task) => {
		if (after) after(task);
		else void task();
	};

	/**
	 * The version the status copy of the website asks for (0: the Portal holds none, or no status was fetched yet).
	 * @param {string} websiteId
	 * @returns {Promise<number>}
	 */
	const neededOf = async (websiteId) => {
		const copy = await store.get('status', websiteId);
		const version = copy?.status?.settingsVersion;
		return Number.isSafeInteger(version) ? version : 0;
	};

	/**
	 * Fetch the copy again from the Portal and keep it; concurrent uses on an instance share one fetch. Never throws:
	 * a failure is logged and the held copy (or none) is the answer.
	 * @param {string} websiteId
	 * @param {{ timeoutMs?: number }} [options] a shorter deadline for a use that waits
	 * @returns {Promise<Held | null>}
	 */
	const refresh = (websiteId, { timeoutMs } = {}) => {
		let running = fetching.get(websiteId);
		if (!running) {
			running = (async () => {
				const stored = /** @type {Held | null} */ (await store.get('website_settings', websiteId));
				try {
					const answer = await client().websiteSettings(websiteId, {
						since: stored?.version ?? 0,
						...(timeoutMs ? { timeoutMs } : {}),
					});
					if (answer.settings === null) {
						remember(websiteId, stored, answer.version);
						return stored;
					}
					/** @type {Held} */
					const doc = { websiteId, version: answer.version, settings: answer.settings, fetchedAt: now() };
					await store.put('website_settings', websiteId, doc);
					remember(websiteId, doc, doc.version);
					return doc;
				} catch (error) {
					logger.warn('website settings not fetched', { websiteId, error });
					// remembered as behind, so the next uses answer from what is held and a fetch follows a response
					remember(websiteId, stored, (stored?.version ?? 0) + 1);
					return stored;
				}
			})().finally(() => fetching.delete(websiteId));
			fetching.set(websiteId, running);
		}
		return running;
	};

	/**
	 * A fetch after the response, at most every {@link REFRESH_EVERY_MS} per website on this instance.
	 * @param {string} websiteId
	 * @param {After | undefined} after
	 */
	const refreshLater = (websiteId, after) => {
		const t = now();
		if (t - (startedAt.get(websiteId) ?? -Infinity) < REFRESH_EVERY_MS) return;
		startedAt.set(websiteId, t);
		later(after, () => refresh(websiteId));
	};

	/**
	 * The website's settings as the Portal holds them, or null while it holds none (or none could be fetched yet). Memory,
	 * then the product database; the Portal is asked only when there is no copy yet and the status says it holds one
	 * (this use waits), or when the copy is older than the status says (after the response).
	 * @param {string} websiteId
	 * @param {{ after?: After }} [options] the request's `after`, for the fetch the request does not wait for
	 * @returns {Promise<WebsiteSettings | null>}
	 */
	const get = async (websiteId, { after } = {}) => {
		const known = memory.get(websiteId);
		if (known && now() - known.at < MEMORY_MS) {
			if (known.held && known.needed > known.held.version) refreshLater(websiteId, after);
			return known.held?.settings ?? null;
		}
		const [held, needed] = await Promise.all([
			/** @type {Promise<Held | null>} */ (store.get('website_settings', websiteId)),
			neededOf(websiteId),
		]);
		remember(websiteId, held, needed);
		if (held && held.version >= needed) return held.settings;
		if (held) {
			refreshLater(websiteId, after);
			return held.settings;
		}
		if (needed === 0) return null;
		// the Portal holds settings and this product holds none: this first use waits for them (as it waits for a status),
		// unless a fetch on this instance just failed (a Portal that is down is not asked on every request)
		if (now() - (startedAt.get(websiteId) ?? -Infinity) < REFRESH_EVERY_MS) return null;
		startedAt.set(websiteId, now());
		const fetched = await refresh(websiteId, { timeoutMs: WAITED_FETCH_MS });
		return fetched?.settings ?? null;
	};

	/**
	 * A status copy was fetched again after a response (a lost notice is caught here): when it asks for a newer version
	 * than the one held, fetch the settings (at most every {@link REFRESH_EVERY_MS} per website on this instance).
	 * @param {string} websiteId
	 * @param {{ settingsVersion?: number }} status
	 */
	const followStatus = async (websiteId, status) => {
		const needed = Number.isSafeInteger(status.settingsVersion) ? /** @type {number} */ (status.settingsVersion) : 0;
		const held = /** @type {Held | null} */ (await store.get('website_settings', websiteId));
		remember(websiteId, held, needed);
		if (needed === 0 || (held && held.version >= needed)) return;
		const t = now();
		if (t - (startedAt.get(websiteId) ?? -Infinity) < REFRESH_EVERY_MS) return;
		startedAt.set(websiteId, t);
		await refresh(websiteId);
	};

	return Object.freeze({
		get,
		refresh,
		followStatus,
		/**
		 * The settings for product code: the Portal's document, frozen; an empty one at version 0 while the Portal holds
		 * none (`version === 0` tells the product to use its own values).
		 * @param {string} websiteId
		 * @param {{ after?: After }} [options]
		 * @returns {Promise<Readonly<WebsiteSettings>>}
		 */
		document: async (websiteId, options) => (await get(websiteId, options)) ?? deepFreeze(emptyWebsiteSettings(websiteId)),
		/**
		 * A `website.settings_changed` notice: forget what this instance remembers, so the next use reads the database.
		 * @param {string} websiteId
		 */
		forget: (websiteId) => {
			memory.delete(websiteId);
			startedAt.delete(websiteId);
		},
	});
};

/** @typedef {ReturnType<typeof createWebsiteSettings>} WebsiteSettingsCache */
