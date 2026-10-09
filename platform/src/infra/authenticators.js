/**
 * The Portal's authentication modes, as `http.js` authenticators. All cryptography is `@ss/protocol`'s.
 *
 * | mode       | credential                                 | verified by                                                               |
 * | ---------- | ------------------------------------------ | ------------------------------------------------------------------------- |
 * | `admin`    | `__Host-ss_admin` session cookie           | session store; a pending two-step setup only reaches `mfa: false` routes  |
 * | `merchant` | `__Host-ss_merchant` session cookie        | session store                                                             |
 * | `product`  | `Authorization: Bearer <client assertion>` | `verifyAssertion` (product keys port, shared replay store, aud = `PORTAL_URL`) |
 *
 * Ports (provided by modules, see `modules/README.md`): `sessionActor(session) → Actor | null` (default: the session
 * without a role) and `productKeys(productId) → KeyResolver | null` (default: none — every assertion is refused).
 * `productCalled(productId)` (optional) runs after every request a product made.
 * @module
 */
import { verifyAssertion } from '@ss/protocol';
import { actorFromSession, readCookie, sessionCookieName } from './auth.js';
import { problem } from './http.js';
import { memoize } from './request-scope.js';

/** @typedef {import('./http.js').Authenticator} Authenticator */
/** @typedef {import('./http.js').AuthMode} AuthMode */
/** @typedef {import('./auth.js').Session} Session */
/** @typedef {import('./auth.js').Sessions} Sessions */
/** @typedef {import('./rbac.js').Actor} Actor */
/** @typedef {import('@ss/protocol').KeyResolver} KeyResolver */
/** @typedef {import('@ss/protocol').ReplayStore} ReplayStore */

/**
 * @typedef {object} AuthPorts
 * @property {(session: Session) => Actor | null | Promise<Actor | null>} [sessionActor]
 * @property {(productId: string) => KeyResolver | null | undefined | Promise<KeyResolver | null | undefined>} [productKeys]
 * @property {(productId: string) => Promise<unknown>} [productCalled] runs right after a request a product made (its
 *   own pending notices; PLAN 0.10)
 */

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
 *   replayStore: ReplayStore,
 *   ports?: AuthPorts,
 *   portalUrl: string,
 *   cookieSecure: boolean,
 *   now?: () => number,
 * }} options `portalUrl` (`PORTAL_URL`) is the audience of client assertions; `cookieSecure` names the cookies
 * @returns {Record<Exclude<AuthMode, 'public'>, Authenticator>}
 */
export const createAuthenticators = ({ sessions, replayStore, ports = {}, portalUrl, cookieSecure, now = Date.now }) => {
	const sessionActor = ports.sessionActor ?? actorFromSession;

	/**
	 * @param {'admin' | 'merchant'} kind
	 * @returns {Authenticator}
	 */
	const sessionAuth = (kind) => async (request, route) => {
		const token = readCookie(request.headers.get('cookie'), sessionCookieName(kind, cookieSecure));
		if (token === undefined || token === '') return null;
		// once per console page render (its in-process reads share the memo); every other request looks it up
		const session = await memoize(`session|${kind}|${token}`, () => sessions.get(token));
		if (!session || session.kind !== kind) return problem('unauthorized', 'The session has expired. Sign in again.');
		const actor = await memoize(`actor|${kind}|${session.subject}`, () => sessionActor(session));
		if (!actor) return problem('unauthorized', 'The session has ended. Sign in again.');
		// Require two-step for admins (PLAN 0.2): until it is set up, only the setup routes open
		if (actor.twoStepRequired && route.mfa !== false)
			return problem('two_step_required', 'Set up two-step sign-in before anything else.');
		return { ok: true, actor, mode: kind, cookie: true, session };
	};

	/** @type {Authenticator} */
	const product = async (request) => {
		const token = bearerOf(request);
		if (token === null || token.split('.').length !== 3) return null;
		const productKeys = ports.productKeys;
		if (!productKeys) return problem('invalid_credentials', 'The client assertion is invalid.');
		try {
			const { productId } = await verifyAssertion({
				token,
				keyResolverForProduct: productKeys,
				audience: portalUrl,
				replayStore,
				now,
			});
			return { ok: true, mode: 'product', actor: { type: 'product', id: productId }, product: { productId } };
		} catch {
			return problem('invalid_credentials', 'The client assertion is invalid.');
		}
	};

	return Object.freeze({ admin: sessionAuth('admin'), merchant: sessionAuth('merchant'), product });
};
