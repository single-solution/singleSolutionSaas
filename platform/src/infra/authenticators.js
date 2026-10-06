/**
 * The Portal's authentication modes, as `http.js` authenticators. All cryptography is `@ss/protocol`'s.
 *
 * | mode         | credential                                   | verified by                                              |
 * | ------------ | -------------------------------------------- | -------------------------------------------------------- |
 * | `staff`      | `__Host-ss_staff` session cookie, or `Authorization: Bearer sst_…` (staff API token, F.18) | session store; MFA required (once enrolled) unless the route says `mfa: false` |
 * | `merchant`   | `__Host-ss_merchant` session cookie          | session store                                            |
 * | `websiteKey` | `Authorization: Bearer pk_…/sk_…`            | `verifyWebsiteKey` (website-key JWKS) + revocation port; `originAllowed` for pk_ |
 * | `product`    | `Authorization: Bearer <client assertion>`   | `verifyAssertion` (app keys port, shared replay store, aud = the request origin) |
 *
 * Ports (provided by modules, see `modules/README.md`): `sessionActor(session) → Actor | null` (default: roles stored
 * in the session), `appKeys(appId) → KeyResolver | null` (default: none — every assertion is refused) and
 * `websiteKeyRevoked(claims, rawKey) → boolean` (default: none — website keys fail closed with 503). The raw key is
 * passed so the provider can also check the stored HMAC of `sk_` keys. `productCalled(appId)` (optional) runs after
 * every request a product made.
 *
 * Website keys are verified by one implementation, {@link createWebsiteKeyVerifier}: the `websiteKey`
 * authenticator and `ctx.verifyWebsiteKey` (modules that authenticate keys carried in a body) share it.
 * @module
 */
import { isProtocolError, originAllowed, verifyAssertion, verifyWebsiteKey } from '@ss/protocol';
import { actorFromSession, readCookie, sessionCookieName } from './auth.js';
import { isProblem, problem } from './http.js';
import { requestOrigin } from './request-scope.js';

/** Staff API tokens (F.18): `sst_` + an opaque session token. */
const STAFF_TOKEN = /^sst_([A-Za-z0-9_-]{43})$/;

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
 * @property {(claims: WebsiteKeyClaims, rawKey: string) => boolean | Promise<boolean>} [websiteKeyRevoked]
 * @property {(appId: string) => Promise<unknown>} [productCalled] runs right after a request a product made (its own
 *   due work, e.g. pending event deliveries; F.19)
 */

/**
 * @typedef {object} WebsiteKeyCheck
 * @property {string} key the presented `pk_…` / `sk_…` key
 * @property {string | null} [origin] request `Origin` (authoritative for `pk_`)
 * @property {string | null} [referer] request `Referer` (used only without `Origin`)
 * @property {'pk' | 'sk'} [keyKind] restrict to one key kind
 * @property {ReadonlyArray<string>} [scopes] scopes the key must grant
 * @property {'live' | 'test'} [env] restrict to one key environment
 */

/** @typedef {(check: WebsiteKeyCheck) => Promise<WebsiteKeyClaims & { kid: string }>} WebsiteKeyVerifier */

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
 * The single website-key verification path: offline signature with the website-key resolver, the revocation port
 * (with the raw key), `originAllowed` for `pk_`, kind / env / scope restrictions. Resolves to the claims or throws
 * an infra problem (`invalid_credentials`, `forbidden`, `origin_not_allowed`, `scope_missing`, `unavailable`).
 * @param {{ keyResolver: KeyResolver, revoked: () => AuthPorts['websiteKeyRevoked'] | undefined, now?: () => number }} options
 * @returns {WebsiteKeyVerifier}
 */
export const createWebsiteKeyVerifier = ({ keyResolver, revoked, now = Date.now }) => {
	return async ({ key, origin = null, referer = null, keyKind, scopes = [], env }) => {
		if (typeof key !== 'string' || !/^(pk|sk)_/.test(key)) throw problem('invalid_credentials', 'The website key is invalid.');
		const isRevoked = revoked();
		if (!isRevoked) {
			throw problem('unavailable', 'Website key verification is not available.', { headers: { 'retry-after': '30' } });
		}
		/** @type {WebsiteKeyClaims & { kid: string }} */
		let claims;
		try {
			claims = await verifyWebsiteKey({
				key,
				keyResolver,
				revocations: [],
				now,
				...(keyKind ? { expectedKind: keyKind } : {}),
				...(env ? { expectedEnv: env } : {}),
			});
		} catch (error) {
			if (isProtocolError(error) && error.code === 'wrong_type')
				throw problem('forbidden', `This operation needs a ${keyKind}_ key.`);
			// the prefix names another environment than required (a prefix/payload mismatch stays invalid)
			if (isProtocolError(error) && error.code === 'env_mismatch' && env && key.split('_')[1] !== env)
				throw problem('forbidden', `This operation needs a ${env} key.`);
			throw problem('invalid_credentials', 'The website key is invalid.');
		}
		if (await isRevoked(claims, key)) throw problem('invalid_credentials', 'The website key is revoked.');
		if (claims.kind === 'pk') {
			const allowed = originAllowed({
				origin,
				referer,
				domain: claims.domain,
				allowSubdomains: claims.allowSubdomains,
				env: claims.env,
			});
			if (!allowed) throw problem('origin_not_allowed', 'This key cannot be used from this origin.');
		}
		const missing = scopes.filter((scope) => !scopeGranted(claims.scopes, scope));
		if (missing.length > 0) throw problem('scope_missing', `The key lacks ${missing.join(', ')}.`);
		return claims;
	};
};

/**
 * @param {{
 *   sessions: Sessions,
 *   verifyWebsiteKey: WebsiteKeyVerifier,
 *   replayStore: ReplayStore,
 *   ports?: AuthPorts,
 *   now?: () => number,
 * }} options
 * @returns {Record<Exclude<AuthMode, 'public'>, Authenticator>}
 */
export const createAuthenticators = ({ sessions, verifyWebsiteKey: verifyKey, replayStore, ports = {}, now = Date.now }) => {
	const sessionActor = ports.sessionActor ?? actorFromSession;

	/**
	 * @param {'staff' | 'merchant'} kind
	 * @returns {Authenticator}
	 */
	const sessionAuth = (kind) => async (request, route) => {
		const cookieToken = readCookie(
			request.headers.get('cookie'),
			sessionCookieName(kind, requestOrigin(request).startsWith('https:')),
		);
		const bearer = kind === 'staff' && !cookieToken ? STAFF_TOKEN.exec(bearerOf(request) ?? '')?.[1] : undefined;
		const token = cookieToken || bearer;
		if (token === undefined || token === '') return null;
		const session = await sessions.get(token);
		if (!session || session.kind !== kind) return problem('unauthorized', 'The session has expired. Sign in again.');
		// a bearer must be an API token, and an API token is never accepted from a cookie
		if (Boolean(bearer) !== (session.api === true)) return problem('unauthorized', 'The session has expired. Sign in again.');
		if (kind === 'staff' && !session.mfa && route.mfa !== false)
			return problem('forbidden', 'Two-factor authentication is required.');
		const actor = await sessionActor(session);
		if (!actor) return problem('unauthorized', 'The account is no longer active.');
		return { ok: true, actor, mode: kind, cookie: !bearer, session };
	};

	/** @type {Authenticator} */
	const websiteKey = async (request, route) => {
		const key = bearerOf(request);
		if (key === null || !/^(pk|sk)_/.test(key)) return null;
		const origin = request.headers.get('origin');
		/** @type {WebsiteKeyClaims & { kid: string }} */
		let claims;
		try {
			claims = await verifyKey({
				key,
				origin,
				referer: request.headers.get('referer'),
				...(route.keyKind ? { keyKind: route.keyKind } : {}),
				...(route.scopes ? { scopes: route.scopes } : {}),
			});
		} catch (error) {
			if (isProblem(error)) return error;
			throw error;
		}
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
			const { appId } = await verifyAssertion({
				token,
				keyResolverForApp: appKeys,
				audience: requestOrigin(request),
				replayStore,
				now,
			});
			return { ok: true, mode: 'product', actor: { type: 'product', id: appId }, app: { appId } };
		} catch {
			return problem('invalid_credentials', 'The client assertion is invalid.');
		}
	};

	return Object.freeze({ staff: sessionAuth('staff'), merchant: sessionAuth('merchant'), websiteKey, product });
};
