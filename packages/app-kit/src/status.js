/**
 * Status of the product on each website (PLAN 0.4.7, 0.8.1) and the revocation list (0.4.4).
 *
 * - The status response is cached per website in the product database until its `validUntil`, at most 5 minutes.
 * - A request never waits for the Portal while it has a copy fetched within the offline grace (K-19): an older copy is
 *   used as it is and fetched again right after the response (the request's `after`; without one, at once without
 *   waiting for it), together with the revocation list. An instance runs one fetch per website at a time and starts
 *   one after a response at most every {@link REFRESH_EVERY_MS}, so a Portal that is down is not asked on every request.
 * - Only a use without a copy it may use (none, or one older than the offline grace) waits for the Portal, at most
 *   {@link WAITED_FETCH_MS}; dashboards (`wait`) also wait for a copy older than 5 minutes, since they show the status
 *   and today's charges. Notices and reports ask with `fresh`.
 * - `status.changed` notices mark the copy changed, so the next use waits for it to be fetched again (and the notice
 *   fetches it right after answering); the copy itself is kept for offline grace.
 * - While the Portal cannot be reached the last copy is used for up to {@link OFFLINE_GRACE_MS} (6 hours) after its
 *   fetch, then every use is refused with 503 `portal_unreachable` (PLAN 0.4.7, 0.10, K-21). Revocations follow the
 *   same bound: when the revocation list could not be fetched for longer than that, a use waits for it (at most
 *   {@link WAITED_FETCH_MS}, and not again within {@link REFRESH_EVERY_MS} of a failure on the instance) and is refused
 *   while it cannot be fetched. A `token.revoked` notice fetches it at once.
 * - `graceEndsAt` in the past turns `grace` into `stopped` without asking the Portal.
 * - A fetched `removed` status turns the website's feature switches off: a re-add starts with every feature off. A
 *   fetched `featuresVersion` above the switches' own means the Portal reset them without this product: a re-add while
 *   the product could not be reached (it never saw `removed`), which the Portal makes with every feature off and a
 *   higher version (PLAN 0.4.12 row 4); the switches turn off at that version.
 * @module
 */
import { isKitError } from './util.js';
import { problem } from './http/results.js';
import { reportingKey } from './reports.js';

/** @typedef {import('@ss/contracts').StatusResponse} StatusResponse */
/** @typedef {import('./stores/types.js').Store} Store */
/** @typedef {import('./http/results.js').ProblemResult} ProblemResult */
/** Runs work right after the response (a request's `after`). @typedef {(task: () => Promise<unknown>) => void} After */
/**
 * A status copy: `changed` when a `status.changed` notice marked it (the next use waits for the Portal).
 * @typedef {{ websiteId: string, status: StatusResponse, fetchedAt: number, validUntilMs: number, changed?: boolean }} StatusCopy
 */

/** Longest time a status copy is used without asking the Portal again. */
const STATUS_MAX_AGE_MS = 5 * 60_000;
/**
 * Offline grace: how long the last status copy (and the last revocation list) is trusted while the Portal cannot be
 * reached. Six hours ride out a Portal outage on free hosting (every merchant's shop depends on it) or a bad deploy
 * rolled back, while a website stopped, suspended or removed, or a token revoked, during an outage stops working within
 * six hours at most. Notices still apply at once whenever the Portal is up.
 */
export const OFFLINE_GRACE_MS = 6 * 60 * 60_000;
/** Deadline of a Portal call a use waits for (it has no status copy it may use), shorter than a call's usual 10 s. */
export const WAITED_FETCH_MS = 5_000;
/** An instance starts a fetch after a response at most this often per website (also after a failed one). */
const REFRESH_EVERY_MS = 30_000;
const REVOCATION_PAGES = 10;
/** How often an instance reads again when the revocation list was last fetched. */
const REVOCATIONS_RECHECK_MS = 30_000;
const REFUSED = Object.freeze(['removed', 'suspended', 'stopped']);

/**
 * The status a product obeys now: `grace` whose `graceEndsAt` has passed counts as `stopped`.
 * @param {StatusResponse} status
 * @param {number} nowMs
 * @returns {StatusResponse['status']}
 */
export const effectiveStatus = (status, nowMs) =>
	status.status === 'grace' && status.graceEndsAt !== null && Date.parse(status.graceEndsAt) <= nowMs
		? 'stopped'
		: status.status;

/**
 * @param {{ store: Store, client: () => import('./portal-client.js').PortalClient, now: () => number,
 *   logger: import('./logger.js').Logger, onRefreshed?: (websiteId: string, status: StatusResponse) => Promise<unknown> }} options
 *   `onRefreshed`: runs after a status copy fetched again after a response (the settings follow the status copy's version)
 */
export const createStatus = ({ store, client, now, logger, onRefreshed }) => {
	/** @type {{ at: number | null, readAt: number } | null} when the revocation list was last fetched, as last read */
	let synced = null;
	/** The shared revocation list fetch, if one runs (true when it was fetched). @type {Promise<boolean> | null} */
	let syncing = null;
	/** When a shared fetch of the revocation list last failed on this instance. */
	let syncFailedAt = -Infinity;
	/** Status fetches running on this instance, one per website. @type {Map<string, Promise<StatusCopy>>} */
	const fetching = new Map();
	/** When this instance last started a fetch after a response, per website. @type {Map<string, number>} */
	const refreshedAt = new Map();

	/**
	 * Run work after the response: with the request's `after`, else at once without waiting for it.
	 * @param {After | undefined} after
	 * @param {() => Promise<unknown>} task never throws
	 */
	const later = (after, task) => {
		if (after) after(task);
		else void task();
	};

	/**
	 * Fetch revoked token ids added since the stored cursor.
	 * @param {{ timeoutMs?: number }} [options]
	 */
	const syncRevocations = async ({ timeoutMs } = {}) => {
		const state = await store.get('state', 'revocations');
		/** @type {string | null} */
		let cursor = state?.cursor ?? null;
		for (let page = 0; page < REVOCATION_PAGES; page += 1) {
			const { tokenIds, cursor: next } = await client().revocations(cursor, timeoutMs ? { timeoutMs } : {});
			await Promise.all(tokenIds.map((jti) => store.put('revoked', jti, { at: now() })));
			const moved = next !== cursor;
			cursor = next;
			if (tokenIds.length === 0 || !moved) break;
		}
		const at = now();
		await store.put('state', 'revocations', { cursor, at });
		synced = { at, readAt: at };
	};

	/**
	 * Fetch the revocation list, one fetch at a time on an instance (after a response, or waited for when the list is
	 * older than the offline grace). Never throws.
	 * @param {number} [timeoutMs]
	 * @returns {Promise<boolean>} true when it was fetched
	 */
	const syncShared = (timeoutMs) => {
		syncing ??= syncRevocations(timeoutMs ? { timeoutMs } : {})
			.then(
				() => true,
				(error) => {
					syncFailedAt = now();
					logger.warn('revocation list not fetched', { error });
					return false;
				},
			)
			.finally(() => {
				syncing = null;
			});
		return syncing;
	};
	const syncLater = () => syncShared();

	/**
	 * The website's switches as a fetched status says. A removed product is added again with every feature off (PLAN
	 * 0.5.9: the Portal resets its switches on the re-add), so the product turns its own switches off as soon as it sees
	 * `removed`, keeping their version. The re-add also raises `featuresVersion`: a version above the switches' own (the
	 * product missed both the removal and the re-add) turns them off at the Portal's version, unless a feature report of
	 * this product is running (another instance between the Portal's acceptance and its save: the version is its own).
	 * @param {string} websiteId
	 * @param {StatusResponse} status
	 * @param {number} at
	 */
	const followSwitches = async (websiteId, status, at) => {
		const switches = await store.get('switches', websiteId);
		const version = switches?.featuresVersion ?? 0;
		if (status.featuresVersion > version) {
			if ((await store.get('state', reportingKey(websiteId))) === null)
				await store.put('switches', websiteId, { websiteId, on: [], featuresVersion: status.featuresVersion, at });
		} else if (status.status === 'removed' && switches && switches.on.length > 0)
			await store.put('switches', websiteId, { websiteId, on: [], featuresVersion: version, at });
	};

	/**
	 * Fetch a website's status from the Portal and keep the copy; concurrent uses on an instance share one fetch.
	 * @param {string} websiteId
	 * @param {number} [timeoutMs] a shorter deadline, for a use that waits
	 * @returns {Promise<StatusCopy>}
	 */
	const fetchStatus = (websiteId, timeoutMs) => {
		let running = fetching.get(websiteId);
		if (!running) {
			running = (async () => {
				const t = now();
				const status = await client().status(websiteId, timeoutMs ? { timeoutMs } : {});
				if (status.websiteId !== websiteId) throw new Error('status names another website');
				const validUntil = Date.parse(status.validUntil);
				const doc = {
					websiteId,
					status,
					fetchedAt: t,
					validUntilMs: Math.min(Number.isFinite(validUntil) ? validUntil : t, t + STATUS_MAX_AGE_MS),
				};
				await store.put('status', websiteId, doc);
				await followSwitches(websiteId, status, t);
				return doc;
			})().finally(() => fetching.delete(websiteId));
			fetching.set(websiteId, running);
		}
		return running;
	};

	/**
	 * After a failed fetch: a website the Portal does not know (404) loses its copy (true); anything else is logged.
	 * @param {string} websiteId
	 * @param {unknown} error
	 */
	const unknownWebsite = async (websiteId, error) => {
		if (isKitError(error, 'portal_refused') && error.details?.status === 404) {
			await store.delete('status', websiteId);
			return true;
		}
		logger.warn('status not fetched', { websiteId, error });
		return false;
	};

	/**
	 * Fetch a website's status (and the revocation list) again after the response, at most every
	 * {@link REFRESH_EVERY_MS} per website on this instance.
	 * @param {string} websiteId
	 * @param {After | undefined} after
	 */
	const refreshLater = (websiteId, after) => {
		const t = now();
		if (t - (refreshedAt.get(websiteId) ?? -Infinity) < REFRESH_EVERY_MS) return;
		refreshedAt.set(websiteId, t);
		later(after, async () => {
			try {
				const doc = await fetchStatus(websiteId);
				await syncLater();
				await onRefreshed?.(websiteId, doc.status).catch((error) =>
					logger.warn('work after the status copy failed', { websiteId, error }),
				);
			} catch (error) {
				await unknownWebsite(websiteId, error).catch(() => false);
			}
		});
	};

	/**
	 * The status of a website: the cached copy while fresh; a copy within the offline grace, fetched again after the
	 * response; else a fetch the use waits for.
	 * @param {string} websiteId
	 * @param {{ fresh?: boolean, wait?: boolean, after?: After }} [options] `fresh` always asks the Portal; `wait` asks it
	 *   when the copy is older than 5 minutes (dashboards); `after` runs the fetch after the response (default: at once,
	 *   not waited for)
	 * @returns {Promise<{ ok: true, status: StatusResponse, fetchedAt: number } | { ok: false, code: 'website_not_found' | 'portal_unreachable' }>}
	 */
	const lookup = async (websiteId, { fresh = false, wait = false, after } = {}) => {
		const cached = /** @type {StatusCopy | null} */ (await store.get('status', websiteId));
		const t = now();
		const usable = cached !== null && t - cached.fetchedAt < OFFLINE_GRACE_MS;
		// a copy a `status.changed` notice marked is not used as it is: the next use learns the change at once
		if (cached && !fresh && (t < cached.validUntilMs || (usable && !wait && cached.changed !== true))) {
			if (t >= cached.validUntilMs) refreshLater(websiteId, after);
			return { ok: true, status: cached.status, fetchedAt: cached.fetchedAt };
		}
		try {
			const doc = await fetchStatus(websiteId, fresh ? undefined : WAITED_FETCH_MS);
			later(after, syncLater);
			return { ok: true, status: doc.status, fetchedAt: doc.fetchedAt };
		} catch (error) {
			if (await unknownWebsite(websiteId, error)) return { ok: false, code: 'website_not_found' };
			if (cached && usable) return { ok: true, status: cached.status, fetchedAt: cached.fetchedAt };
			return { ok: false, code: 'portal_unreachable' };
		}
	};

	/**
	 * True when the revocation list was last fetched longer than the offline grace ago (never fetched: not stale). The
	 * time is read from the product database at most every {@link REVOCATIONS_RECHECK_MS} per instance.
	 */
	const revocationsStale = async () => {
		const t = now();
		if (!synced || t - synced.readAt >= REVOCATIONS_RECHECK_MS) {
			const state = await store.get('state', 'revocations');
			synced = { at: typeof state?.at === 'number' ? state.at : null, readAt: t };
		}
		return synced.at !== null && t - synced.at >= OFFLINE_GRACE_MS;
	};

	/**
	 * Whether the product serves this website now: `{ ok: true, status }`, or the problem to answer; also refused while
	 * the revocation list is older than the offline grace and cannot be fetched.
	 * @param {string} websiteId
	 * @param {{ after?: After }} [options] the request's `after`, for fetches the request does not wait for
	 * @returns {Promise<{ ok: true, status: StatusResponse } | { ok: false, problem: ProblemResult }>}
	 */
	const serving = async (websiteId, { after } = {}) => {
		const found = await lookup(websiteId, after ? { after } : {});
		// a list older than the offline grace is no copy to use: the use waits for it (short deadline), unless a fetch
		// failed on this instance in the last 30 seconds
		if (
			found.ok &&
			(await revocationsStale()) &&
			!(now() - syncFailedAt >= REFRESH_EVERY_MS && (await syncShared(WAITED_FETCH_MS)))
		) {
			logger.warn('the revocation list is older than the offline grace', { websiteId });
			return {
				ok: false,
				problem: problem('portal_unreachable', 'The Portal cannot be reached.', { headers: { 'retry-after': '60' } }),
			};
		}
		if (!found.ok) {
			return found.code === 'website_not_found'
				? { ok: false, problem: problem('invalid_token', 'The token is not valid.') }
				: {
						ok: false,
						problem: problem('portal_unreachable', 'The Portal cannot be reached.', { headers: { 'retry-after': '60' } }),
					};
		}
		const status = effectiveStatus(found.status, now());
		if (REFUSED.includes(status)) {
			return {
				ok: false,
				problem: problem('product_unavailable', `This product is ${status} for this website.`, {
					extensions: { reason: status },
				}),
			};
		}
		return { ok: true, status: found.status };
	};

	return Object.freeze({
		lookup,
		serving,
		syncRevocations,
		/**
		 * Mark a website's copy changed (`status.changed`): the next use waits for the Portal; the copy is kept for offline
		 * grace.
		 * @param {string} websiteId
		 */
		drop: async (websiteId) => {
			const cached = await store.get('status', websiteId);
			if (cached) await store.put('status', websiteId, { ...cached, validUntilMs: 0, changed: true });
		},
		/** @param {string} jti @returns {Promise<boolean>} */
		isRevoked: async (jti) => (await store.get('revoked', jti)) !== null,
	});
};

/** @typedef {ReturnType<typeof createStatus>} StatusCache */
