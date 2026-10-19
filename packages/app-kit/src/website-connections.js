/**
 * The Portal's connections in the product (settings-ownership design 8.3 and 8.4): the website's database, storage and AI
 * provider key (entered once in the Portal) and the links to other products (made by the Portal) arrive here over one
 * signed fetch.
 *
 * - **A version in the status answer, a notice to hurry it.** The status answer carries `connectionsVersion`; a copy older
 *   than it is fetched again (`GET /v1/product/websites/:id/connections`) after the response. A
 *   `website.settings_changed` notice with `what` `connections` or `links` does the same right after answering it; a lost
 *   notice is caught by the next status (at most 5 minutes). A product added to a website later has held nothing, so its
 *   first status already shows a newer version and it fetches.
 * - **Sealed on arrival, tested, reported.** `connections.adopt` seals each value with this product's own `ENCRYPTION_KEY`,
 *   tests the database, the storage and the AI key with the existing tests and keeps the result; the result goes back to the Portal
 *   (`PUT …/connections/:name/health`), which never opens the merchant's database or bucket.
 * - **Light on free plans.** What a request needs sits in the product database and, for the grants, in this instance's
 *   memory for {@link MEMORY_MS}. A request never calls the Portal while it holds a copy. A Portal outage changes nothing:
 *   the last values are used with no time limit; only new values and revocations wait for the Portal.
 * - **Who may call this product** (`links.in`: caller → scopes) is kept here too, and a route that takes link keys
 *   (`scope`) lets a call in only when the caller holds that scope (`allows`).
 * @module
 */
import { deliveredFor, portalNameOf } from './connections.js';
import { WAITED_FETCH_MS } from './status.js';

/** @typedef {import('./stores/types.js').Store} Store */
/** Runs work right after the response (a request's `after`). @typedef {(task: () => Promise<unknown>) => void} After */
/**
 * What this product holds of the Portal's connections for a website.
 * @typedef {{ websiteId: string, version: number, linksIn: Array<{ from: string, scopes: string[] }>, fetchedAt: number }} Held
 */

/** How long an instance answers grants from its memory before reading the product database again. */
export const MEMORY_MS = 60_000;
/** An instance starts a fetch after a response at most this often per website (also after a failed one). */
const REFRESH_EVERY_MS = 30_000;
/** Websites an instance remembers at most (the oldest goes first). */
const MEMORY_LIMIT = 200;

/**
 * @param {{ store: Store, client: () => import('./portal-client.js').PortalClient, connections: import('./connections.js').Connections,
 *   now: () => number, logger: import('./logger.js').Logger }} options
 */
export const createPortalConnections = ({ store, client, connections, now, logger }) => {
	/** @type {Map<string, { held: Held | null, needed: number, at: number }>} */
	const memory = new Map();
	/** Fetches running on this instance, one per website. @type {Map<string, Promise<Held | null>>} */
	const fetching = new Map();
	/** When this instance last started a fetch for a website. @type {Map<string, number>} */
	const startedAt = new Map();

	/** @param {string} websiteId @param {Held | null} held @param {number} needed */
	const remember = (websiteId, held, needed) => {
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
		const version = copy?.status?.connectionsVersion;
		return Number.isSafeInteger(version) ? version : 0;
	};

	/** @param {string} websiteId @returns {Promise<Held | null>} */
	const heldOf = async (websiteId) => /** @type {Held | null} */ (await store.get('portal_connections', websiteId));

	/**
	 * Fetch what the Portal holds for this product and adopt it; concurrent uses on an instance share one fetch. Never
	 * throws: a failure is logged and the held copy (or none) is the answer.
	 * @param {string} websiteId
	 * @param {{ timeoutMs?: number }} [options] a shorter deadline for a use that waits
	 * @returns {Promise<Held | null>}
	 */
	const sync = (websiteId, { timeoutMs } = {}) => {
		let running = fetching.get(websiteId);
		if (!running) {
			running = (async () => {
				const stored = await heldOf(websiteId);
				try {
					const bundle = await client().websiteConnections(websiteId, timeoutMs ? { timeoutMs } : {});
					const results = await connections.adopt(websiteId, bundle);
					/** @type {Held} */
					const doc = { websiteId, version: bundle.version, linksIn: bundle.links.in, fetchedAt: now() };
					await store.put('portal_connections', websiteId, doc);
					remember(websiteId, doc, doc.version);
					// the Portal learns how each delivered value worked (best effort: it shows "waiting" until it does)
					const reported = new Map(results.map((each) => [each.name, each]));
					for (const [name, def] of Object.entries(connections.definitions)) {
						const portalName = portalNameOf(def);
						if (!portalName || !deliveredFor(def, bundle)) continue;
						const view = (await connections.list(websiteId)).find((each) => each.name === name);
						const result =
							reported.get(name) ?? (view && view.set ? { ok: view.status === 'connected', message: view.message } : null);
						if (!result) continue;
						await client()
							.reportHealth(websiteId, portalName, {
								version: bundle.version,
								ok: result.ok,
								...(result.ok || !result.message ? {} : { message: result.message }),
							})
							.catch((error) => logger.warn('connection health not reported', { websiteId, name, error }));
					}
					return doc;
				} catch (error) {
					logger.warn('website connections not fetched', { websiteId, error });
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
	 * What this instance holds for a website: memory, then the product database.
	 * @param {string} websiteId
	 * @returns {Promise<Held | null>}
	 */
	const held = async (websiteId) => {
		const known = memory.get(websiteId);
		if (known && now() - known.at < MEMORY_MS) return known.held;
		const [stored, needed] = await Promise.all([heldOf(websiteId), neededOf(websiteId)]);
		remember(websiteId, stored, needed);
		return stored;
	};

	return Object.freeze({
		sync,

		/**
		 * Whether the caller holds the scope on the website. A call that is not allowed while the Portal is ahead of this copy
		 * (a link just made, its notice not here yet) is checked once more after catching up; it never fetches when this
		 * copy is as new as the status says, so a refused key cannot make this product call the Portal.
		 * @param {{ websiteId: string, caller: string, scope: string }} input
		 * @returns {Promise<boolean>}
		 */
		allows: async ({ websiteId, caller, scope }) => {
			const check = async () =>
				((await held(websiteId))?.linksIn ?? []).some((grant) => grant.from === caller && grant.scopes.includes(scope));
			if (await check()) return true;
			const [current, needed] = await Promise.all([heldOf(websiteId), neededOf(websiteId)]);
			if (needed === 0 || (current && current.version >= needed)) return false;
			const t = now();
			if (t - (startedAt.get(websiteId) ?? -Infinity) < REFRESH_EVERY_MS) return false;
			startedAt.set(websiteId, t);
			await sync(websiteId, { timeoutMs: WAITED_FETCH_MS });
			return check();
		},

		/**
		 * The website's database is not held: when the status says the Portal holds connections for it, this use fetches them
		 * (waits, at most {@link WAITED_FETCH_MS}), unless a fetch on this instance just ran. Never throws.
		 * @param {string} websiteId
		 * @returns {Promise<void>}
		 */
		ensure: async (websiteId) => {
			const [current, needed] = await Promise.all([heldOf(websiteId), neededOf(websiteId)]);
			const lost = current !== null && (await connections.unreadable(websiteId)).length > 0;
			if (!lost && (needed === 0 || (current && current.version >= needed))) return;
			const t = now();
			if (t - (startedAt.get(websiteId) ?? -Infinity) < REFRESH_EVERY_MS) return;
			startedAt.set(websiteId, t);
			await sync(websiteId, { timeoutMs: WAITED_FETCH_MS });
		},

		/**
		 * A status copy was fetched again after a response (a lost notice is caught here): when it asks for a newer version
		 * than the one held, fetch the connections (at most every {@link REFRESH_EVERY_MS} per website on this instance).
		 * @param {string} websiteId
		 * @param {{ connectionsVersion?: number }} status
		 */
		followStatus: async (websiteId, status) => {
			const needed = Number.isSafeInteger(status.connectionsVersion) ? /** @type {number} */ (status.connectionsVersion) : 0;
			const current = await heldOf(websiteId);
			remember(websiteId, current, needed);
			// values that no longer open (the key changed without the previous one) are fetched again, whatever the version
			const lost = current !== null && (await connections.unreadable(websiteId)).length > 0;
			if (!lost && (needed === 0 || (current && current.version >= needed))) return;
			const t = now();
			if (t - (startedAt.get(websiteId) ?? -Infinity) < REFRESH_EVERY_MS) return;
			startedAt.set(websiteId, t);
			await sync(websiteId);
		},

		/**
		 * A notice said the connections or links changed: forget what this instance remembers, so the next use reads the
		 * database, and fetch right after the answer.
		 * @param {string} websiteId
		 * @param {After | undefined} after
		 */
		onNotice: (websiteId, after) => {
			memory.delete(websiteId);
			startedAt.delete(websiteId);
			later(after, async () => {
				startedAt.set(websiteId, now());
				await sync(websiteId);
			});
		},

		/**
		 * A person pressed Test in the product on a delivered value: the result goes to the Portal too (at the version held).
		 * @param {string} websiteId
		 * @param {'database' | 'storage' | 'ai'} name
		 * @param {{ ok: boolean, message?: string }} result
		 */
		reportTest: async (websiteId, name, result) => {
			const doc = await heldOf(websiteId);
			if (!doc) return;
			await client()
				.reportHealth(websiteId, name, {
					version: doc.version,
					ok: result.ok,
					...(result.ok || !result.message ? {} : { message: result.message }),
				})
				.catch((error) => logger.warn('connection health not reported', { websiteId, name, error }));
		},

		/** @param {string} websiteId the website was removed: forget it */
		forget: (websiteId) => {
			memory.delete(websiteId);
			startedAt.delete(websiteId);
		},
	});
};

/** @typedef {ReturnType<typeof createPortalConnections>} PortalConnections */
