/**
 * Accounts sign-ins (PLAN 0.4.6): a product trusts a website's Accounts sign-ins once the merchant pasted that
 * website's Accounts server token into the product's Connections (`product.accounts.verify`).
 *
 * A token is a compact JWS with `alg` EdDSA, ES256 or RS256 matching the key type (`none`, HMAC, header-borne keys and
 * `crit` refused), signed by a key of the issuer (by `kid`, or the only compatible key), with `iss` = issuer, `aud`
 * containing the website, `exp` (required) in the future, `nbf` reached and `iat` (required) not in the future and at
 * most 24 hours old (60 s skew). A sign-in only says who the person is; it never authorizes admin actions.
 * @module
 */
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { deepFreeze, isObject } from '@ss/contracts/util';

/** @typedef {{ issuer: string, jwks: Array<Record<string, any>>, audience: string }} IssuerSettings */

/** Tokens older than this (`now - iat`) are refused. */
export const IDENTITY_MAX_AGE_MS = 24 * 60 * 60_000;
const IDENTITY_SKEW_MS = 60_000;
const MAX_TOKEN_LENGTH = 8192;

/** `alg` → key type and node:crypto parameters. */
const ALGORITHMS = Object.freeze({
	EdDSA: { kty: 'OKP', hash: null, dsaEncoding: undefined },
	ES256: { kty: 'EC', hash: 'sha256', dsaEncoding: /** @type {const} */ ('ieee-p1363') },
	RS256: { kty: 'RSA', hash: 'sha256', dsaEncoding: undefined },
});
const REFUSED_HEADERS = Object.freeze(['jwk', 'jku', 'x5u', 'x5c', 'x5t', 'x5t#S256', 'crit']);
const SEGMENT = /^[A-Za-z0-9_-]*$/;

/**
 * @typedef {{ subject: string, email?: string, phone?: string, issuer: string, claims: Readonly<Record<string, unknown>> }} SignIn
 * @typedef {'identity_missing' | 'malformed' | 'algorithm' | 'unknown_key' | 'signature'
 *   | 'issuer' | 'audience' | 'expired' | 'not_yet_valid' | 'too_old' | 'subject'} IdentityFailure
 * @typedef {{ ok: true, identity: SignIn } | { ok: false, code: IdentityFailure }} IdentityResult
 */

/**
 * @param {string} segment
 * @returns {Record<string, any> | null}
 */
const decodeJson = (segment) => {
	try {
		const value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
		return isObject(value) ? value : null;
	} catch {
		return null;
	}
};

/**
 * A claim as a string (numbers are stringified), or undefined.
 * @param {Record<string, any>} claims
 * @param {string} name
 * @returns {string | undefined}
 */
const claimOf = (claims, name) => {
	if (!Object.hasOwn(claims, name)) return undefined;
	const value = claims[name];
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	return typeof value === 'string' && value.length > 0 && value.length <= 320 ? value : undefined;
};

/**
 * Verify one sign-in token against an issuer (pure apart from `now`): the person is `sub`, with `email` and `phone`.
 * @param {unknown} token
 * @param {IssuerSettings} section
 * @param {{ now?: () => number }} [options]
 * @returns {IdentityResult}
 */
export const verifyIdentityToken = (token, section, { now = Date.now } = {}) => {
	if (typeof token !== 'string' || token.length === 0) return { ok: false, code: 'identity_missing' };
	if (token.length > MAX_TOKEN_LENGTH) return { ok: false, code: 'malformed' };
	const parts = token.split('.');
	if (parts.length !== 3 || !parts.every((part) => SEGMENT.test(part)) || !parts[0] || !parts[1] || !parts[2])
		return { ok: false, code: 'malformed' };
	const [encodedHeader, encodedPayload, encodedSignature] = /** @type {[string, string, string]} */ (parts);
	const header = decodeJson(encodedHeader);
	const claims = decodeJson(encodedPayload);
	if (!header || !claims) return { ok: false, code: 'malformed' };
	if (REFUSED_HEADERS.some((name) => Object.hasOwn(header, name))) return { ok: false, code: 'malformed' };
	const alg = header.alg;
	if (typeof alg !== 'string' || !Object.hasOwn(ALGORITHMS, alg)) return { ok: false, code: 'algorithm' };
	const spec = ALGORITHMS[/** @type {keyof typeof ALGORITHMS} */ (alg)];
	const compatible = section.jwks.filter((key) => key.kty === spec.kty && (key.alg === undefined || key.alg === alg));
	const kid = header.kid;
	const key =
		typeof kid === 'string'
			? compatible.find((candidate) => candidate.kid === kid)
			: compatible.length === 1
				? compatible[0]
				: undefined;
	if (!key) return { ok: false, code: 'unknown_key' };
	let valid = false;
	try {
		const publicKey = createPublicKey({ key: /** @type {import('node:crypto').JsonWebKey} */ ({ ...key }), format: 'jwk' });
		valid = cryptoVerify(
			spec.hash,
			Buffer.from(`${encodedHeader}.${encodedPayload}`, 'ascii'),
			spec.dsaEncoding ? { key: publicKey, dsaEncoding: spec.dsaEncoding } : publicKey,
			Buffer.from(encodedSignature, 'base64url'),
		);
	} catch {
		valid = false;
	}
	if (!valid) return { ok: false, code: 'signature' };
	if (claims.iss !== section.issuer) return { ok: false, code: 'issuer' };
	const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	if (!audiences.includes(section.audience)) return { ok: false, code: 'audience' };
	const at = now();
	const seconds = (/** @type {unknown} */ value) => (typeof value === 'number' && Number.isFinite(value) ? value * 1000 : null);
	const exp = seconds(claims.exp);
	const iat = seconds(claims.iat);
	const nbf = seconds(claims.nbf);
	if (exp === null || at >= exp + IDENTITY_SKEW_MS) return { ok: false, code: 'expired' };
	if (claims.nbf !== undefined && (nbf === null || at + IDENTITY_SKEW_MS < nbf)) return { ok: false, code: 'not_yet_valid' };
	if (iat === null || at + IDENTITY_SKEW_MS < iat) return { ok: false, code: 'not_yet_valid' };
	if (at - iat > IDENTITY_MAX_AGE_MS) return { ok: false, code: 'too_old' };
	const subject = claimOf(claims, 'sub');
	if (subject === undefined || subject.length > 255) return { ok: false, code: 'subject' };
	const email = claimOf(claims, 'email');
	const phone = claimOf(claims, 'phone');
	return {
		ok: true,
		identity: {
			subject,
			...(email === undefined ? {} : { email }),
			...(phone === undefined ? {} : { phone }),
			issuer: section.issuer,
			claims: deepFreeze(claims),
		},
	};
};

/** Path of a website's Accounts sign-in keys at Accounts (PLAN 0.8.6): `{ issuer, keys }`. */
const accountsKeysPath = (/** @type {string} */ websiteId) => `/v1/websites/${websiteId}/keys`;
const ACCOUNTS_KEYS_TTL_MS = 10 * 60_000;
const ACCOUNTS_REFETCH_MS = 60_000;

/**
 * @typedef {{ id: string, email?: string, phone?: string, name?: string, role?: string, permissions?: string[] }} AccountsUser
 * @typedef {{ ok: true, user: AccountsUser, claims: Readonly<Record<string, unknown>> }
 *   | { ok: false, code: IdentityFailure | 'accounts_not_connected' | 'accounts_unavailable' }} AccountsSignInResult
 */

/**
 * Accounts sign-ins (PLAN 0.4.6): a product trusts them for a website only after the merchant pasted that website's
 * Accounts server token into the product's Connections. The website's public keys are fetched from Accounts with that
 * token (through `@ss/net`, cached 10 minutes; an unknown key id refetches them at most once a minute) and each sign-in
 * is verified offline: signed by Accounts, issued for this website (`aud`) and not expired (they last 15 minutes). A
 * sign-in only says who the person is; it never authorizes admin actions.
 * @param {{ connections: import('./connections.js').Connections, now: () => number }} options
 */
export const createAccountsSignIns = ({ connections, now }) => {
	/** @type {Map<string, { issuer: string, jwks: Array<Record<string, any>>, fetchedAt: number }>} */
	const cache = new Map();

	/**
	 * @param {string} websiteId
	 * @returns {Promise<{ issuer: string, jwks: Array<Record<string, any>>, fetchedAt: number } | 'not_connected' | null>}
	 */
	const fetchKeys = async (websiteId) => {
		const answer = await connections.callProduct(websiteId, 'accounts', accountsKeysPath(websiteId));
		if (!answer.ok) return answer.reason === 'not_connected' ? 'not_connected' : null;
		const body = answer.body;
		if (!isObject(body) || typeof body.issuer !== 'string' || !Array.isArray(body.keys)) return null;
		const entry = { issuer: body.issuer, jwks: body.keys.filter(isObject).slice(0, 10), fetchedAt: now() };
		cache.set(websiteId, entry);
		return entry;
	};

	return Object.freeze({
		/**
		 * Verify a visitor's Accounts sign-in for a website.
		 * @param {{ websiteId: string, token: unknown }} input
		 * @returns {Promise<AccountsSignInResult>}
		 */
		verify: async ({ websiteId, token }) => {
			if (typeof token !== 'string' || token.length === 0) return { ok: false, code: 'identity_missing' };
			let entry = cache.get(websiteId);
			if (!entry || now() - entry.fetchedAt >= ACCOUNTS_KEYS_TTL_MS) {
				const fetched = await fetchKeys(websiteId);
				if (fetched === 'not_connected') return { ok: false, code: 'accounts_not_connected' };
				if (fetched === null) return { ok: false, code: 'accounts_unavailable' };
				entry = fetched;
			}
			const check = (/** @type {{ issuer: string, jwks: Array<Record<string, any>> }} */ keys) =>
				verifyIdentityToken(token, { issuer: keys.issuer, jwks: keys.jwks, audience: websiteId }, { now });
			let result = check(entry);
			if (!result.ok && result.code === 'unknown_key' && now() - entry.fetchedAt >= ACCOUNTS_REFETCH_MS) {
				const fetched = await fetchKeys(websiteId);
				if (fetched !== null && fetched !== 'not_connected') result = check(fetched);
			}
			if (!result.ok) return result;
			const { claims } = result.identity;
			return {
				ok: true,
				claims,
				user: {
					id: result.identity.subject,
					...(result.identity.email === undefined ? {} : { email: result.identity.email }),
					...(result.identity.phone === undefined ? {} : { phone: result.identity.phone }),
					...(typeof claims.name === 'string' ? { name: claims.name } : {}),
					...(typeof claims.role === 'string' ? { role: claims.role } : {}),
					...(Array.isArray(claims.permissions)
						? { permissions: claims.permissions.filter((p) => typeof p === 'string') }
						: {}),
				},
			};
		},
	});
};

/** The header a visitor's Accounts sign-in travels in: from the browser next to the browser token, and from the merchant's server next to the server token. */
export const SIGN_IN_HEADER = 'ss-sign-in';

/**
 * @typedef {{ ok: true, token: string, user: AccountsUser, claims: Readonly<Record<string, unknown>> }
 *   | { ok: false, code: IdentityFailure | 'accounts_not_connected' | 'accounts_unavailable' }} RequestSignIn
 */

/**
 * The Accounts sign-in of one request (`ctx.signIn()`): read from `SS-Sign-In`, checked for the website of the request's
 * own token, never for one the header names (signature by the website's Accounts keys, `aud`, `exp`, `iat`, see
 * `verifyIdentityToken`), and checked once however often a route asks. Null when the request carries no sign-in.
 * A sign-in only says who the person is: it never grants more than a visitor's rights, and only a verified sign-in names
 * the shopper (a user id alone is never taken).
 * @param {{ accounts: ReturnType<typeof createAccountsSignIns>, websiteId: string | null, headers: Headers }} input
 * @returns {() => Promise<RequestSignIn | null>}
 */
export const requestSignIn = ({ accounts, websiteId, headers }) => {
	/** @type {Promise<RequestSignIn | null> | null} */
	let once = null;
	return () => {
		once ??= (async () => {
			const token = (headers.get(SIGN_IN_HEADER) ?? '').trim();
			if (token.length === 0 || websiteId === null) return null;
			const verified = await accounts.verify({ websiteId, token });
			return verified.ok ? { ok: true, token, user: verified.user, claims: verified.claims } : verified;
		})();
		return once;
	};
};
