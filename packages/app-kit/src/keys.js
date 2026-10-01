/**
 * Website-key verification: `@ss/protocol` `verifyWebsiteKey` (offline, Portal JWKS) + the revocation list (pulled
 * from the Portal at most every `syncIntervalMs` ≤ 5 min, pushed by `key.revoked` events, persisted in the shared
 * store) + `originAllowed` for `pk_` keys + required scopes.
 *
 * Revocation freshness is fail-closed: if the list could not be synced for longer than `maxStaleMs` (the offline
 * grace, default 24 h) — or was never synced and the Portal is unreachable — keys are refused with `unavailable`.
 * @module
 */
import { isProtocolError, originAllowed, verifyWebsiteKey } from '@ss/protocol';
import { createSingleFlight } from './util.js';

/** @typedef {import('@ss/protocol').KeyResolver} KeyResolver */
/** @typedef {import('./stores/types.js').RevocationStore} RevocationStore */
/** @typedef {import('./logger.js').Logger} Logger */

/**
 * @typedef {object} WebsiteBinding
 * @property {string} websiteId
 * @property {string} merchantId
 * @property {string} domain
 * @property {boolean} allowSubdomains
 * @property {'live' | 'test'} env
 * @property {string[]} scopes
 * @property {'pk' | 'sk'} kind
 * @property {string} keyId
 */

/**
 * @typedef {{ ok: true, website: WebsiteBinding }
 *   | { ok: false, code: 'unauthorized' | 'invalid_credentials' | 'origin_not_allowed' | 'scope_missing' | 'unavailable' | 'forbidden', detail: string }} KeyVerification
 */

/**
 * True when `granted` covers `required` (exact, or a granted `prefix.*` / `prefix:*` glob).
 * @param {readonly string[]} granted
 * @param {string} required
 * @returns {boolean}
 */
export const scopeGranted = (granted, required) =>
	granted.some((scope) => scope === required || (scope.endsWith('*') && required.startsWith(scope.slice(0, -1))));

/**
 * @param {{
 *   keyResolver: KeyResolver,
 *   portal: { revocations: (options?: { since?: string | null }) => Promise<{ keyIds: string[], cursor: string | null }> },
 *   store: RevocationStore,
 *   syncIntervalMs?: number,
 *   maxStaleMs?: number,
 *   now?: () => number,
 *   logger: Logger,
 * }} options
 */
export const createWebsiteKeys = ({
	keyResolver,
	portal,
	store,
	syncIntervalMs = 5 * 60_000,
	maxStaleMs = 24 * 60 * 60_000,
	now = Date.now,
	logger,
}) => {
	if (syncIntervalMs > 5 * 60_000) throw new RangeError('revocation syncIntervalMs must be ≤ 5 minutes');
	/** @type {Set<string>} */
	const revoked = new Set();
	/** @type {string | null} */
	let cursor = null;
	let syncedAt = -Infinity;
	let checkedAt = -Infinity;
	let loaded = false;
	const singleFlight = /** @type {(key: string, run: () => Promise<void>) => Promise<void>} */ (createSingleFlight());

	const load = async () => {
		const state = await store.get();
		for (const id of state.keyIds) revoked.add(id);
		cursor = state.cursor ?? cursor;
		if (state.syncedAt !== null && state.syncedAt > syncedAt) syncedAt = state.syncedAt;
		loaded = true;
	};

	/** Pull new revocations from the Portal (and pick up what other instances stored). */
	const sync = () =>
		singleFlight('sync', async () => {
			checkedAt = now();
			// merge what other instances stored (pushed `key.revoked` events land on one instance only)
			await load().catch(() => {});
			try {
				const result = await portal.revocations({ since: cursor });
				for (const id of result.keyIds) revoked.add(id);
				cursor = result.cursor;
				syncedAt = now();
				await store.add(result.keyIds, { cursor, syncedAt }).catch(() => {});
			} catch (error) {
				logger.warn('revocation sync failed', { code: /** @type {any} */ (error)?.code ?? 'error' });
			}
		});

	const ensureFresh = async () => {
		if (now() - syncedAt >= syncIntervalMs && now() - checkedAt >= Math.min(30_000, syncIntervalMs)) await sync();
		else if (!loaded) await load().catch(() => {});
	};

	/**
	 * Apply revocations pushed by a `key.revoked` event (effective immediately on this instance, persisted for others).
	 * @param {string[]} keyIds
	 */
	const revoke = async (keyIds) => {
		for (const id of keyIds) revoked.add(id);
		await store.add(keyIds);
	};

	/**
	 * Verify an `Authorization: Bearer pk_…|sk_…` header.
	 * @param {string | null | undefined} authorizationHeader
	 * @param {{ origin?: string | null, referer?: string | null, requiredScopes?: string[], expectedKind?: 'pk' | 'sk', expectedEnv?: 'live' | 'test' }} [options]
	 * @returns {Promise<KeyVerification>}
	 */
	const verify = async (authorizationHeader, { origin, referer, requiredScopes = [], expectedKind, expectedEnv } = {}) => {
		const match = /^Bearer\s+((?:pk|sk)_(?:live|test)_\S+)$/.exec(authorizationHeader ?? '');
		if (!match) return { ok: false, code: 'unauthorized', detail: 'A website key is required.' };
		await ensureFresh();
		if (now() - syncedAt > maxStaleMs) {
			return { ok: false, code: 'unavailable', detail: 'Key revocations could not be verified.' };
		}
		/** @type {import('@ss/protocol').WebsiteKeyClaims} */
		let claims;
		try {
			claims = await verifyWebsiteKey({
				key: match[1],
				keyResolver,
				revocations: revoked,
				now,
				...(expectedKind ? { expectedKind } : {}),
				...(expectedEnv ? { expectedEnv } : {}),
			});
		} catch (error) {
			const code = isProtocolError(error) ? error.code : 'error';
			if (code === 'jwks_unavailable') return { ok: false, code: 'unavailable', detail: 'Portal keys are unavailable.' };
			if (code === 'wrong_type')
				return { ok: false, code: 'forbidden', detail: `This operation needs a ${expectedKind}_ key.` };
			return { ok: false, code: 'invalid_credentials', detail: 'The website key is invalid, expired or revoked.' };
		}
		if (claims.kind === 'pk') {
			const allowed = originAllowed({
				origin: origin ?? undefined,
				referer: referer ?? undefined,
				domain: claims.domain,
				allowSubdomains: claims.allowSubdomains,
				env: claims.env,
			});
			if (!allowed) return { ok: false, code: 'origin_not_allowed', detail: 'This key is not valid for the request origin.' };
		}
		const missing = requiredScopes.filter((scope) => !scopeGranted(claims.scopes, scope));
		if (missing.length > 0) return { ok: false, code: 'scope_missing', detail: `Missing scope: ${missing.join(', ')}` };
		return {
			ok: true,
			website: Object.freeze({
				websiteId: claims.websiteId,
				merchantId: claims.merchantId,
				domain: claims.domain,
				allowSubdomains: claims.allowSubdomains,
				env: claims.env,
				scopes: [...claims.scopes],
				kind: claims.kind,
				keyId: claims.keyId,
			}),
		};
	};

	return Object.freeze({ verify, revoke, sync, isRevoked: (/** @type {string} */ keyId) => revoked.has(keyId) });
};
