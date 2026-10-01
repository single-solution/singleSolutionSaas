/**
 * The Portal's authentication modes, as `http.js` authenticators. All cryptography is `@ss/protocol`'s.
 *
 * | mode         | credential                                   | verified by                                              |
 * | ------------ | -------------------------------------------- | -------------------------------------------------------- |
 * | `staff`      | `__Host-ss_staff` session cookie             | session store; MFA required unless the route says `mfa: false` |
 * | `merchant`   | `__Host-ss_merchant` session cookie          | session store                                            |
 * | `websiteKey` | `Authorization: Bearer pk_…/sk_…`            | `verifyWebsiteKey` (Portal JWKS) + revocation port; `originAllowed` for pk_ |
 * | `product`    | `Authorization: Bearer <client assertion>`   | `verifyAssertion` (app keys port, shared replay store, aud = PORTAL_URL) |
 * | `cron`       | `Authorization: Bearer <CRON_SECRET>`        | constant-time comparison                                 |
 *
 * Ports (provided by modules, see `modules/README.md`): `sessionActor(session) → Actor | null` (default: roles stored
 * in the session), `appKeys(appId) → KeyResolver | null` (default: none — every assertion is refused) and
 * `websiteKeyRevoked(claims) → boolean` (default: none — website keys fail closed with 503).
 * @module
 */
import { isProtocolError, originAllowed, verifyAssertion, verifyWebsiteKey } from '@ss/protocol';
import { actorFromSession, readCookie, sessionCookieName } from './auth.js';
import { problem } from './http.js';
import { safeEqual } from './util.js';

/** @typedef {import('./http.js').Authenticator} Authenticator */
/** @typedef {import('./http.js').AuthMode} AuthMode */
/** @typedef {import('./auth.js').Session} Session */
/** @typedef {import('./auth.js').Sessions} Sessions */
/** @typedef {import('./rbac.js').Actor} Actor */
/** @typedef {import('@ss/protocol').KeyResolver} KeyResolver */
/** @typedef {import('@ss/protocol').WebsiteKeyClaims} WebsiteKeyClaims */
/** @typedef {import('@ss/protocol').ReplayStore} ReplayStore */

/**
 * @typedef {object} AuthPorts
 * @property {(session: Session) => Actor | null | Promise<Actor | null>} [sessionActor]
 * @property {(appId: string) => KeyResolver | null | undefined | Promise<KeyResolver | null | undefined>} [appKeys]
 * @property {(claims: WebsiteKeyClaims) => boolean | Promise<boolean>} [websiteKeyRevoked]
 */

/**
 * `true` when `granted` (patterns such as `config.*`) cover `required`.
 * @param {ReadonlyArray<string>} granted
 * @param {string} required
 */
export const scopeGranted = (granted, required) =>
	granted.some(
		(scope) => scope === '*' || scope === required || (scope.endsWith('.*') && required.startsWith(scope.slice(0, -1))),
	);

/**
 * @param {Request} request
 * @returns {string | null} bearer token, or null
 */
const bearerOf = (request) => {
	const header = request.headers.get('authorization');
	if (!header) return null;
	const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
	return match?.[1] ?? '';
};

/**
 * @param {{
 *   sessions: Sessions,
 *   cookieSecure: boolean,
 *   portalKeyResolver: KeyResolver,
 *   portalUrl: string,
 *   replayStore: ReplayStore,
 *   cronSecret: string,
 *   ports?: AuthPorts,
 *   now?: () => number,
 * }} options
 * @returns {Record<Exclude<AuthMode, 'public'>, Authenticator>}
 */
export const createAuthenticators = ({
	sessions,
	cookieSecure,
	portalKeyResolver,
	portalUrl,
	replayStore,
	cronSecret,
	ports = {},
	now = Date.now,
}) => {
	const sessionActor = ports.sessionActor ?? actorFromSession;

	/**
	 * @param {'staff' | 'merchant'} kind
	 * @returns {Authenticator}
	 */
	const sessionAuth = (kind) => async (request, route) => {
		const token = readCookie(request.headers.get('cookie'), sessionCookieName(kind, cookieSecure));
		if (token === undefined || token === '') return null;
		const session = await sessions.get(token);
		if (!session || session.kind !== kind) return problem('unauthorized', 'The session has expired. Sign in again.');
		if (kind === 'staff' && !session.mfa && route.mfa !== false)
			return problem('forbidden', 'Two-factor authentication is required.');
		const actor = await sessionActor(session);
		if (!actor) return problem('unauthorized', 'The account is no longer active.');
		return { ok: true, actor, mode: kind, cookie: true, session };
	};

	/** @type {Authenticator} */
	const websiteKey = async (request, route) => {
		const key = bearerOf(request);
		if (key === null || !/^(pk|sk)_/.test(key)) return null;
		if (!ports.websiteKeyRevoked) {
			return problem('unavailable', 'Website key verification is not available.', { headers: { 'retry-after': '30' } });
		}
		const isRevoked = ports.websiteKeyRevoked;
		/** @type {WebsiteKeyClaims & { kid: string }} */
		let claims;
		try {
			claims = await verifyWebsiteKey({
				key,
				keyResolver: portalKeyResolver,
				revocations: [],
				now,
				...(route.keyKind ? { expectedKind: route.keyKind } : {}),
			});
		} catch (error) {
			if (isProtocolError(error) && error.code === 'wrong_type')
				return problem('forbidden', `This operation needs a ${route.keyKind}_ key.`);
			return problem('invalid_credentials', 'The website key is invalid.');
		}
		if (await isRevoked(claims)) return problem('invalid_credentials', 'The website key is revoked.');
		const origin = request.headers.get('origin');
		if (claims.kind === 'pk') {
			const allowed = originAllowed({
				origin,
				referer: request.headers.get('referer'),
				domain: claims.domain,
				allowSubdomains: claims.allowSubdomains,
				env: claims.env,
			});
			if (!allowed) return problem('origin_not_allowed', 'This key cannot be used from this origin.');
		}
		const missing = (route.scopes ?? []).filter((scope) => !scopeGranted(claims.scopes, scope));
		if (missing.length > 0) return problem('scope_missing', `The key lacks ${missing.join(', ')}.`);
		return {
			ok: true,
			mode: 'websiteKey',
			actor: { type: 'website', id: claims.keyId, merchantId: claims.merchantId },
			website: claims,
			headers: route.cors && claims.kind === 'pk' && origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {},
		};
	};

	/** @type {Authenticator} */
	const product = async (request) => {
		const token = bearerOf(request);
		if (token === null || /^(pk|sk)_/.test(token) || token.split('.').length !== 3) return null;
		const appKeys = ports.appKeys;
		if (!appKeys) return problem('invalid_credentials', 'The client assertion is invalid.');
		try {
			const { appId } = await verifyAssertion({ token, keyResolverForApp: appKeys, audience: portalUrl, replayStore, now });
			return { ok: true, mode: 'product', actor: { type: 'product', id: appId }, app: { appId } };
		} catch {
			return problem('invalid_credentials', 'The client assertion is invalid.');
		}
	};

	/** @type {Authenticator} */
	const cron = async (request) => {
		const token = bearerOf(request);
		if (token === null) return null;
		if (!safeEqual(token, cronSecret)) return problem('unauthorized', 'Invalid cron credentials.');
		return { ok: true, mode: 'cron', actor: { type: 'system', id: 'cron' } };
	};

	return Object.freeze({ staff: sessionAuth('staff'), merchant: sessionAuth('merchant'), websiteKey, product, cron });
};
