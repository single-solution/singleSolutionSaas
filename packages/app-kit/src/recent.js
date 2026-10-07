/**
 * Recent changes (PLAN 0.4.3): every change made in the product dashboard (features, prices, defaults, settings, widget
 * texts, theme, connections) with who, what and when, in the product database. Entries with `websiteId: null` are
 * global (prices, defaults) and are listed on the Defaults and Prices screens only.
 * @module
 */
import { randomToken } from './util.js';

/** @typedef {import('./stores/types.js').Store} Store */
/** @typedef {{ kind: 'merchant' | 'admin', id: string, name: string, role?: 'owner' | 'support' }} Who */
/** @typedef {{ websiteId: string | null, who: Who, what: string, detail: string, at: string }} RecentChange */

/** Entries a list returns. */
export const RECENT_CHANGES_LIMIT = 50;

/**
 * @param {{ store: Store, now: () => number, randomBytes: (length: number) => Uint8Array }} options
 */
export const createRecentChanges = ({ store, now, randomBytes }) =>
	Object.freeze({
		/**
		 * @param {{ websiteId: string | null, who: Who, what: string, detail: string }} entry
		 */
		record: async ({ websiteId, who, what, detail }) => {
			const t = now();
			const person = { kind: who.kind, id: who.id, name: who.name, ...(who.role ? { role: who.role } : {}) };
			await store.put('changes', `${t}-${randomToken(randomBytes, 9)}`, { websiteId, who: person, what, detail, at: t });
		},
		/**
		 * Newest first.
		 * @param {string | null} websiteId
		 * @returns {Promise<RecentChange[]>}
		 */
		list: async (websiteId) =>
			(await store.list('changes', { websiteId }, { limit: RECENT_CHANGES_LIMIT })).map((doc) => ({
				websiteId: doc.websiteId ?? null,
				who: doc.who,
				what: doc.what,
				detail: doc.detail,
				at: new Date(doc.at).toISOString(),
			})),
	});

/** @typedef {ReturnType<typeof createRecentChanges>} RecentChanges */
