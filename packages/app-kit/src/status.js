/**
 * Status of the product on each website (PLAN 0.4.7, 0.8.1) and the revocation list (0.4.4).
 *
 * - The status response is cached per website in the product database until its `validUntil`, at most 5 minutes. A use
 *   without a fresh copy fetches it again (the Portal settles the merchant at that moment), together with the
 *   revocation list.
 * - `status.changed` notices mark the copy stale, so the next use refetches it; the copy itself is kept for offline
 *   grace.
 * - While the Portal cannot be reached the last copy is used for up to {@link OFFLINE_GRACE_MS} (6 hours) after its
 *   fetch, then every use is refused with 503 `portal_unreachable` (PLAN 0.4.7, 0.10; shortened from 24 hours by the
 *   owner's decision 11, K-21). Revocations follow the same bound: when the revocation list could not be fetched for
 *   longer than that, every use is refused until it is fetched again. A `token.revoked` notice fetches it at once.
 * - `graceEndsAt` in the past turns `grace` into `stopped` without asking the Portal.
 * - A fetched `removed` status turns the website's feature switches off: a re-add starts with every feature off.
 * @module
 */
import { isKitError } from './util.js';
import { problem } from './http/results.js';

/** @typedef {import('@ss/contracts').StatusResponse} StatusResponse */
/** @typedef {import('./stores/types.js').Store} Store */
/** @typedef {import('./http/results.js').ProblemResult} ProblemResult */

/** Longest time a status copy is used without asking the Portal again. */
const STATUS_MAX_AGE_MS = 5 * 60_000;
/**
 * Offline grace: how long the last status copy (and the last revocation list) is trusted while the Portal cannot be
 * reached. Six hours ride out a Portal outage on free hosting (every merchant's shop depends on it) or a bad deploy
 * rolled back, while a website stopped, suspended or removed, or a token revoked, during an outage stops working within
 * six hours at most (24 hours before K-21). Notices still apply at once whenever the Portal is up.
 */
export const OFFLINE_GRACE_MS = 6 * 60 * 60_000;
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
 *   logger: import('./logger.js').Logger }} options
 */
export const createStatus = ({ store, client, now, logger }) => {
	/** @type {{ at: number | null, readAt: number } | null} when the revocation list was last fetched, as last read */
	let synced = null;

	/** Fetch revoked token ids added since the stored cursor. */
	const syncRevocations = async () => {
		const state = await store.get('state', 'revocations');
		/** @type {string | null} */
		let cursor = state?.cursor ?? null;
		for (let page = 0; page < REVOCATION_PAGES; page += 1) {
			const { tokenIds, cursor: next } = await client().revocations(cursor);
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
	 * A removed product is added again with every feature off (PLAN 0.5.9: the Portal resets its switches on the
	 * re-add), so the product turns its own switches off as soon as it sees `removed`; the version is kept.
	 * @param {string} websiteId
	 * @param {number} at
	 */
	const switchOff = async (websiteId, at) => {
		const switches = await store.get('switches', websiteId);
		if (switches && switches.on.length > 0)
			await store.put('switches', websiteId, { websiteId, on: [], featuresVersion: switches.featuresVersion, at });
	};

	/**
	 * The status of a website: the cached copy while fresh, else a new fetch (with the revocation list).
	 * @param {string} websiteId
	 * @param {{ fresh?: boolean }} [options] `fresh` always asks the Portal
	 * @returns {Promise<{ ok: true, status: StatusResponse, fetchedAt: number } | { ok: false, code: 'website_not_found' | 'portal_unreachable' }>}
	 */
	const lookup = async (websiteId, { fresh = false } = {}) => {
		const cached = await store.get('status', websiteId);
		const t = now();
		if (cached && !fresh && t < cached.validUntilMs) return { ok: true, status: cached.status, fetchedAt: cached.fetchedAt };
		try {
			const status = await client().status(websiteId);
			if (status.websiteId !== websiteId) throw new Error('status names another website');
			const validUntil = Date.parse(status.validUntil);
			const doc = {
				websiteId,
				status,
				fetchedAt: t,
				validUntilMs: Math.min(Number.isFinite(validUntil) ? validUntil : t, t + STATUS_MAX_AGE_MS),
			};
			await store.put('status', websiteId, doc);
			if (status.status === 'removed') await switchOff(websiteId, t);
			await syncRevocations().catch((error) => logger.warn('revocation list not fetched', { error }));
			return { ok: true, status, fetchedAt: t };
		} catch (error) {
			if (isKitError(error, 'portal_refused') && error.details?.status === 404) {
				await store.delete('status', websiteId);
				return { ok: false, code: 'website_not_found' };
			}
			logger.warn('status not fetched', { websiteId, error });
			if (cached && t - cached.fetchedAt < OFFLINE_GRACE_MS)
				return { ok: true, status: cached.status, fetchedAt: cached.fetchedAt };
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
	 * the revocation list is older than the offline grace.
	 * @param {string} websiteId
	 * @returns {Promise<{ ok: true, status: StatusResponse } | { ok: false, problem: ProblemResult }>}
	 */
	const serving = async (websiteId) => {
		const found = await lookup(websiteId);
		if (found.ok && (await revocationsStale())) {
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
		/** Mark a website's copy stale (`status.changed`); it is kept for offline grace. @param {string} websiteId */
		drop: async (websiteId) => {
			const cached = await store.get('status', websiteId);
			if (cached) await store.put('status', websiteId, { ...cached, validUntilMs: 0 });
		},
		/** @param {string} jti @returns {Promise<boolean>} */
		isRevoked: async (jti) => (await store.get('revoked', jti)) !== null,
	});
};

/** @typedef {ReturnType<typeof createStatus>} StatusCache */
