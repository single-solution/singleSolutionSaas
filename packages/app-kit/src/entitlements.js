/**
 * Entitlement cache: signed documents pulled from the Portal, verified offline (`verifyEntitlementDocument` with the
 * pinned Portal JWKS) and validated against the canonical `@ss/contracts` schema.
 *
 * - Fresh for `ttlMs` (default 5 min) after a successful fetch; then refreshed on the next read (single-flight per
 *   website, so a burst of requests makes one Portal call).
 * - Portal unreachable → the last verified document keeps being served, flagged `stale: true`, until its
 *   `validUntil + offlineGrace` (manifest `capabilities.offlineGrace`, default 24 h). After that: `{ ok: false }`.
 * - Portal says the subscription is gone (404/410) → cache dropped, `{ ok: false, reason: 'not_subscribed' }`.
 * - Versions are monotonic: an older document never replaces a newer one (rollback protection).
 * - `entitlement.changed` events call `refresh(websiteId)`.
 * @module
 */
import { validateEntitlementDocument } from '@ss/contracts';
import { isProtocolError, verifyEntitlementDocument } from '@ss/protocol';
import { collectionPrefix, createSingleFlight, isKitError } from './util.js';

/** @typedef {import('@ss/contracts').EntitlementDocument} EntitlementDocument */
/** @typedef {import('@ss/protocol').KeyResolver} KeyResolver */
/** @typedef {import('./stores/types.js').EntitlementStore} EntitlementStore */
/** @typedef {import('./logger.js').Logger} Logger */

/**
 * @typedef {{ ok: true, doc: EntitlementDocument, stale: boolean, version: number, fetchedAt: number }
 *   | { ok: false, reason: 'not_subscribed' | 'unavailable' | 'invalid', stale?: undefined, doc?: undefined }} EntitlementResult
 */

/** Runtime states in which no element may run. */
export const STOPPED_STATES = Object.freeze(['paused', 'suspended', 'spend_cap']);

/**
 * True when `elementKey` is enabled and the subscription is running.
 * @param {EntitlementDocument | null | undefined} doc
 * @param {string} elementKey
 * @returns {boolean}
 */
export const can = (doc, elementKey) => {
	if (!doc || typeof elementKey !== 'string') return false;
	if (STOPPED_STATES.includes(doc.runtime?.state)) return false;
	const element = Object.hasOwn(doc.elements ?? {}, elementKey) ? doc.elements[elementKey] : undefined;
	return element?.enabled === true;
};

/**
 * Resolved value of a feature, keyed `<element>.<featurePath>` (e.g. `codes.maxActive`); `undefined` when absent.
 * @param {EntitlementDocument | null | undefined} doc
 * @param {string} key
 * @returns {unknown}
 */
export const feature = (doc, key) => {
	if (!doc || typeof key !== 'string' || !Object.hasOwn(doc.features ?? {}, key)) return undefined;
	return doc.features[key]?.value;
};

/**
 * Element configuration from the document (`{}` when none).
 * @param {EntitlementDocument | null | undefined} doc
 * @param {string} elementKey
 * @returns {Record<string, unknown>}
 */
export const config = (doc, elementKey) => {
	if (!doc || typeof elementKey !== 'string' || !Object.hasOwn(doc.config ?? {}, elementKey)) return {};
	return doc.config[elementKey] ?? {};
};

/**
 * All features of one element as `{ featurePath: value }`.
 * @param {EntitlementDocument | null | undefined} doc
 * @param {string} elementKey
 * @returns {Record<string, unknown>}
 */
export const featuresOf = (doc, elementKey) => {
	/** @type {Record<string, unknown>} */
	const out = {};
	if (!doc) return out;
	const prefix = `${elementKey}.`;
	for (const [key, entry] of Object.entries(doc.features ?? {})) {
		if (key.startsWith(prefix)) out[key.slice(prefix.length)] = entry.value;
	}
	return out;
};

/**
 * @param {{
 *   portal: { entitlements: (websiteId: string) => Promise<{ document: string }> },
 *   keyResolver: KeyResolver,
 *   store: EntitlementStore,
 *   productSlug: string,
 *   graceMs: number,
 *   ttlMs?: number,
 *   now?: () => number,
 *   logger: Logger,
 * }} options
 */
export const createEntitlements = ({
	portal,
	keyResolver,
	store,
	productSlug,
	graceMs,
	ttlMs = 5 * 60_000,
	now = Date.now,
	logger,
}) => {
	/** @type {Map<string, { token: string, doc: EntitlementDocument, version: number, fetchedAt: number }>} */
	const memory = new Map();
	const singleFlight = /** @type {(key: string, run: () => Promise<EntitlementResult>) => Promise<EntitlementResult>} */ (
		createSingleFlight()
	);

	/**
	 * Verify a signed document for `websiteId` and validate its payload.
	 * @param {string} token
	 * @param {string} websiteId
	 * @returns {Promise<{ doc: EntitlementDocument, stale: boolean }>}
	 */
	const verify = async (token, websiteId) => {
		const { payload, stale } = await verifyEntitlementDocument({ token, keyResolver, now, graceMs });
		const checked = validateEntitlementDocument(payload);
		if (!checked.ok) throw Object.assign(new Error('entitlement document is invalid'), { code: 'invalid_document' });
		const doc = checked.value;
		if (
			doc.websiteId !== websiteId ||
			doc.productSlug !== productSlug ||
			doc.dataScope.prefix !== collectionPrefix(productSlug)
		) {
			throw Object.assign(new Error('entitlement document is for another website, product or data scope'), {
				code: 'wrong_subject',
			});
		}
		return { doc, stale };
	};

	/**
	 * Last verified document from memory or the shared store, re-checked for the offline grace.
	 * @param {string} websiteId
	 * @returns {Promise<{ token: string, doc: EntitlementDocument, version: number, fetchedAt: number, stale: boolean } | null>}
	 */
	const lastKnown = async (websiteId) => {
		const cached = memory.get(websiteId);
		if (cached) {
			try {
				// cheap re-check of the time window; the signature was verified when cached
				const { stale } = await verifyEntitlementDocument({ token: cached.token, keyResolver, now, graceMs });
				return { ...cached, stale };
			} catch {
				memory.delete(websiteId);
			}
		}
		const stored = await store.get(websiteId).catch(() => null);
		if (!stored) return null;
		try {
			const { doc, stale } = await verify(stored.token, websiteId);
			const entry = { token: stored.token, doc, version: doc.version, fetchedAt: stored.fetchedAt };
			memory.set(websiteId, entry);
			return { ...entry, stale };
		} catch {
			return null;
		}
	};

	/**
	 * @param {string} websiteId
	 * @returns {Promise<EntitlementResult>}
	 */
	const fetchFresh = (websiteId) =>
		singleFlight(websiteId, async () => {
			/** @type {string} */
			let token;
			try {
				({ document: token } = await portal.entitlements(websiteId));
			} catch (error) {
				const status = isKitError(error) ? /** @type {any} */ (error).details?.status : undefined;
				if (status === 404 || status === 410) {
					memory.delete(websiteId);
					await store.delete(websiteId).catch(() => {});
					return { ok: false, reason: 'not_subscribed' };
				}
				logger.warn('entitlement refresh failed; serving last known document', {
					websiteId,
					code: isKitError(error) ? error.code : 'error',
					...(status ? { status } : {}),
				});
				return fallback(websiteId);
			}
			/** @type {{ doc: EntitlementDocument, stale: boolean }} */
			let verified;
			try {
				verified = await verify(token, websiteId);
			} catch (error) {
				logger.error('Portal sent an entitlement document that failed verification', {
					websiteId,
					code: isProtocolError(error) ? error.code : /** @type {any} */ (error)?.code,
				});
				return fallback(websiteId);
			}
			const { doc, stale } = verified;
			const previous = memory.get(websiteId) ?? (await lastKnown(websiteId));
			if (previous && previous.version > doc.version) {
				logger.warn('ignoring an older entitlement document', { websiteId, version: doc.version, current: previous.version });
				memory.set(websiteId, { ...previous, fetchedAt: now() });
				return { ok: true, doc: previous.doc, stale: false, version: previous.version, fetchedAt: now() };
			}
			const fetchedAt = now();
			memory.set(websiteId, { token, doc, version: doc.version, fetchedAt });
			await store.put(websiteId, { token, version: doc.version, fetchedAt }).catch((error) => {
				logger.warn('could not persist entitlement document', { websiteId, code: /** @type {any} */ (error)?.code });
			});
			return { ok: true, doc, stale, version: doc.version, fetchedAt };
		});

	/**
	 * @param {string} websiteId
	 * @returns {Promise<EntitlementResult>}
	 */
	const fallback = async (websiteId) => {
		const known = await lastKnown(websiteId);
		if (!known) return { ok: false, reason: 'unavailable' };
		return { ok: true, doc: known.doc, stale: true, version: known.version, fetchedAt: known.fetchedAt };
	};

	/**
	 * Current entitlement of a website (fresh, cached, or stale within the offline grace).
	 * @param {string} websiteId
	 * @returns {Promise<EntitlementResult>}
	 */
	const forWebsite = async (websiteId) => {
		if (typeof websiteId !== 'string' || websiteId.length === 0) return { ok: false, reason: 'invalid' };
		const cached = memory.get(websiteId);
		if (cached && now() - cached.fetchedAt < ttlMs) {
			const known = await lastKnown(websiteId);
			if (known) return { ok: true, doc: known.doc, stale: known.stale, version: known.version, fetchedAt: known.fetchedAt };
		}
		if (!cached) {
			const stored = await lastKnown(websiteId);
			if (stored && now() - stored.fetchedAt < ttlMs) {
				return { ok: true, doc: stored.doc, stale: stored.stale, version: stored.version, fetchedAt: stored.fetchedAt };
			}
		}
		return fetchFresh(websiteId);
	};

	return Object.freeze({
		forWebsite,
		/** Force a Portal fetch (e.g. on `entitlement.changed`). */
		refresh: fetchFresh,
		/** Drop the in-process copy (the shared store keeps the last verified document for the offline grace). */
		invalidate: (/** @type {string} */ websiteId) => {
			memory.delete(websiteId);
		},
		can,
		feature,
		config,
		featuresOf,
	});
};
