/**
 * Dashboard SSO: verify a Portal launch (`@ss/protocol` `verifyLaunch`, single use through the shared replay store),
 * then optionally exchange it for a product session (opaque random id in the session store; the product puts it in
 * an HttpOnly cookie). Impersonation sessions never outlive the launch's `impExp`.
 * @module
 */
import { consumeWith, isProtocolError, verifyLaunch } from '@ss/protocol';
import { randomToken } from './util.js';

/** @typedef {import('@ss/protocol').KeyResolver} KeyResolver */
/** @typedef {import('@ss/protocol').LaunchClaims} LaunchClaims */
/** @typedef {import('./stores/types.js').ReplayStore} ReplayStore */
/** @typedef {import('./stores/types.js').SessionStore} SessionStore */
/** @typedef {'merchant' | 'demo' | 'platform_admin' | 'impersonate' | 'partner' | 'developer'} LaunchRole */

/** Launch kind → dashboard role. */
export const ROLE_OF_KIND = Object.freeze({
	merchant: 'merchant',
	demo: 'demo',
	admin: 'platform_admin',
	impersonate: 'impersonate',
	partner: 'partner',
	developer: 'developer',
});

/**
 * @typedef {{ ok: true, claims: LaunchClaims, role: LaunchRole, scope: LaunchClaims['scope'] & { actor?: string } }
 *   | { ok: false, code: string }} LaunchVerification
 */

/**
 * @typedef {object} Session
 * @property {string} id
 * @property {LaunchRole} role
 * @property {string} subject
 * @property {LaunchClaims['user']} user
 * @property {LaunchClaims['scope'] & { actor?: string }} scope
 * @property {string} kind
 * @property {number} expiresAt epoch ms
 */

/**
 * @param {{
 *   keyResolver: KeyResolver,
 *   issuer: string,
 *   audience: () => Promise<string | null>,
 *   replay: ReplayStore,
 *   sessions: SessionStore,
 *   now?: () => number,
 *   randomBytes: (length: number) => Uint8Array,
 *   sessionTtlMs?: number,
 *   onlineConsume?: ((input: { jti: string, exp: number }) => Promise<{ consumed: boolean }>) | null,
 * }} options `onlineConsume` additionally burns the launch at the Portal (`POST /v1/product/launch/consume`).
 */
export const createLaunch = ({
	keyResolver,
	issuer,
	audience,
	replay,
	sessions,
	now = Date.now,
	randomBytes,
	sessionTtlMs = 8 * 60 * 60_000,
	onlineConsume = null,
}) => {
	const consumeLocal = consumeWith(replay, 'launch');

	/**
	 * @param {unknown} token
	 * @returns {Promise<LaunchVerification>}
	 */
	const verify = async (token) => {
		const aud = await audience();
		if (!aud) return { ok: false, code: 'not_registered' };
		try {
			const claims = await verifyLaunch({
				token,
				keyResolver,
				audience: aud,
				issuer,
				now,
				consume: async (jti, expiresAtMs) => {
					if (!(await consumeLocal(jti, expiresAtMs))) return false;
					if (!onlineConsume) return true;
					const { consumed } = await onlineConsume({ jti, exp: Math.floor(expiresAtMs / 1000) });
					return consumed === true;
				},
			});
			const role = /** @type {LaunchRole} */ (ROLE_OF_KIND[claims.kind]);
			const scope = claims.act ? { ...claims.scope, actor: claims.act.sub } : { ...claims.scope };
			return { ok: true, claims, role, scope };
		} catch (error) {
			return { ok: false, code: isProtocolError(error) ? error.code : 'error' };
		}
	};

	/**
	 * Verify a launch and create a product session for it.
	 * @param {unknown} token
	 * @param {{ ttlMs?: number }} [options]
	 * @returns {Promise<{ ok: true, session: Session } | { ok: false, code: string }>}
	 */
	const exchange = async (token, { ttlMs = sessionTtlMs } = {}) => {
		const result = await verify(token);
		if (!result.ok) return result;
		const { claims, role, scope } = result;
		const cap = claims.kind === 'impersonate' && typeof claims.impExp === 'number' ? claims.impExp * 1000 : Infinity;
		const expiresAt = Math.min(now() + ttlMs, cap);
		/** @type {Session} */
		const session = {
			id: `ses_${randomToken(randomBytes, 24)}`,
			role,
			subject: claims.sub,
			user: claims.user,
			scope,
			kind: claims.kind,
			expiresAt,
		};
		const { id, ...data } = session;
		await sessions.create(id, data, expiresAt);
		return { ok: true, session };
	};

	/**
	 * Look up a session id (from a cookie or bearer header).
	 * @param {string | null | undefined} id
	 * @returns {Promise<Session | null>}
	 */
	const session = async (id) => {
		if (typeof id !== 'string' || !/^ses_[A-Za-z0-9_-]{16,64}$/.test(id)) return null;
		const data = await sessions.get(id);
		if (!data || typeof data.expiresAt !== 'number' || data.expiresAt <= now()) return null;
		return /** @type {Session} */ ({ id, ...data });
	};

	return Object.freeze({ verify, exchange, session, logout: (/** @type {string} */ id) => sessions.delete(id) });
};
