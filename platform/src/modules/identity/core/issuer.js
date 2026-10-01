/**
 * Bring-your-own customer identity (PLAN §5.3), pure part: validation of a website's identity issuer
 * (`{ issuer, jwksUrl | publicJwks[], audience?, claimMap }`), normalisation of issuer public keys (JWKs) and the
 * `identity` section of the signed entitlement document (`@ss/contracts` `identitySectionSchema`).
 *
 * Keys: Ed25519 (`OKP`), P-256 (`EC`) and RSA ≥ 2048 bits, signature use only; private members are refused on input
 * and never stored; at most {@link IDENTITY_MAX_KEYS} keys (the document carries them inline). A JWKS fetched from
 * `jwksUrl` keeps only the usable keys (others are skipped and counted).
 * @module
 */
import { createPublicKey } from 'node:crypto';
import { CLAIM_NAME_PATTERN, IDENTITY_MAX_KEYS } from '@ss/contracts';

export { IDENTITY_MAX_KEYS };

/** @typedef {import('./inputs.js').FieldError} FieldError */
/** @typedef {import('@ss/contracts').IdentityJwk} IdentityJwk */
/** @typedef {import('@ss/contracts').IdentitySection} IdentitySection */

/**
 * @typedef {object} IssuerInput
 * @property {string} issuer
 * @property {string | null} jwksUrl
 * @property {IdentityJwk[] | null} publicJwks
 * @property {string | null} audience
 * @property {{ subject: string, email?: string, phone?: string }} claimMap
 */

/** A fetched JWKS is refreshed after this long (the document refresh picks the new keys up). */
export const JWKS_TTL_MS = 60 * 60_000;
/** After a failed JWKS fetch the next attempt waits this long (the last good keys stay in use). */
export const JWKS_RETRY_MS = 5 * 60_000;
/** JWKS documents larger than this are refused. */
export const JWKS_MAX_BYTES = 64 * 1024;

const PRINTABLE = /^[\x21-\x7e]{1,255}$/;
const CLAIM = new RegExp(CLAIM_NAME_PATTERN);
const B64URL = /^[A-Za-z0-9_-]+$/;
const PRIVATE_MEMBERS = Object.freeze(['d', 'p', 'q', 'dp', 'dq', 'qi', 'k', 'oth']);
/** @type {Readonly<Record<'OKP' | 'EC' | 'RSA', 'EdDSA' | 'ES256' | 'RS256'>>} */
const ALG_OF = Object.freeze({ OKP: 'EdDSA', EC: 'ES256', RSA: 'RS256' });
const ISSUER_FIELDS = Object.freeze(['issuer', 'jwksUrl', 'publicJwks', 'audience', 'claimMap']);
const CLAIM_FIELDS = Object.freeze(['subject', 'email', 'phone']);

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Normalise one public JWK: the usable signature members only, or the reason it cannot be used.
 * @param {unknown} jwk
 * @returns {{ ok: true, key: IdentityJwk } | { ok: false, reason: string }}
 */
export const normaliseJwk = (jwk) => {
	if (!isObject(jwk)) return { ok: false, reason: 'not an object' };
	if (PRIVATE_MEMBERS.some((member) => Object.hasOwn(jwk, member))) return { ok: false, reason: 'private key material' };
	const { kid, alg, use } = jwk;
	const kty = /** @type {unknown} */ (jwk.kty);
	if (kty !== 'OKP' && kty !== 'EC' && kty !== 'RSA') return { ok: false, reason: 'unsupported key type' };
	if (typeof kid !== 'string' || !PRINTABLE.test(kid) || kid.length > 128) return { ok: false, reason: 'kid missing' };
	if (use !== undefined && use !== 'sig') return { ok: false, reason: 'not a signature key' };
	if (alg !== undefined && alg !== ALG_OF[kty]) return { ok: false, reason: 'unsupported algorithm' };
	/** @param {unknown} v @param {number} max */
	const b64 = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max && B64URL.test(v);
	/** @type {IdentityJwk} */
	let key;
	if (kty === 'OKP') {
		if (jwk.crv !== 'Ed25519' || !b64(jwk.x, 64)) return { ok: false, reason: 'not an Ed25519 key' };
		key = { kty, crv: 'Ed25519', x: jwk.x, kid };
	} else if (kty === 'EC') {
		if (jwk.crv !== 'P-256' || !b64(jwk.x, 64) || !b64(jwk.y, 64)) return { ok: false, reason: 'not a P-256 key' };
		key = { kty, crv: 'P-256', x: jwk.x, y: jwk.y, kid };
	} else {
		if (!b64(jwk.n, 1400) || !b64(jwk.e, 12)) return { ok: false, reason: 'not an RSA key' };
		if (Buffer.from(jwk.n, 'base64url').length < 256) return { ok: false, reason: 'RSA keys need at least 2048 bits' };
		key = { kty, n: jwk.n, e: jwk.e, kid };
	}
	try {
		createPublicKey({ key: /** @type {import('node:crypto').JsonWebKey} */ ({ ...key }), format: 'jwk' });
	} catch {
		return { ok: false, reason: 'not a valid public key' };
	}
	return { ok: true, key: { ...key, alg: ALG_OF[kty], use: 'sig' } };
};

/**
 * Usable keys of a JWKS document (`{ keys: [...] }`): unusable keys are skipped, duplicate kids keep the first, at
 * most {@link IDENTITY_MAX_KEYS}.
 * @param {unknown} jwks
 * @returns {{ ok: true, keys: IdentityJwk[], skipped: number } | { ok: false, reason: string }}
 */
export const keysOfJwks = (jwks) => {
	if (!isObject(jwks) || !Array.isArray(jwks.keys)) return { ok: false, reason: 'not a JWKS document' };
	/** @type {IdentityJwk[]} */
	const keys = [];
	let skipped = 0;
	for (const candidate of jwks.keys.slice(0, 100)) {
		const normalised = normaliseJwk(candidate);
		if (!normalised.ok || keys.some((k) => k.kid === normalised.key.kid) || keys.length >= IDENTITY_MAX_KEYS) {
			skipped += 1;
			continue;
		}
		keys.push(normalised.key);
	}
	skipped += Math.max(0, jwks.keys.length - 100);
	if (keys.length === 0) return { ok: false, reason: 'no usable signature key' };
	return { ok: true, keys, skipped };
};

/**
 * Parse an identity-issuer body. Exactly one of `jwksUrl` (an `https:` URL; the caller applies the outbound policy)
 * and `publicJwks` (1–5 public keys). `claimMap.subject` defaults to `sub`.
 * @param {unknown} body
 * @returns {{ ok: true, value: IssuerInput } | { ok: false, errors: FieldError[] }}
 */
export const parseIssuer = (body) => {
	/** @type {FieldError[]} */
	const errors = [];
	if (!isObject(body)) return { ok: false, errors: [{ path: '', message: 'must be an object' }] };
	for (const name of Object.keys(body))
		if (!ISSUER_FIELDS.includes(name)) errors.push({ path: `/${name}`, message: 'is not allowed' });
	const { issuer, jwksUrl, publicJwks, audience, claimMap } = body;
	if (typeof issuer !== 'string' || !PRINTABLE.test(issuer))
		errors.push({ path: '/issuer', message: 'must be 1–255 printable characters (the tokens’ `iss`)' });
	const hasUrl = jwksUrl !== undefined && jwksUrl !== null;
	const hasKeys = publicJwks !== undefined && publicJwks !== null;
	if (hasUrl === hasKeys) errors.push({ path: '/jwksUrl', message: 'give exactly one of jwksUrl and publicJwks' });
	/** @type {string | null} */
	let url = null;
	if (hasUrl) {
		try {
			const parsed = new URL(String(jwksUrl));
			if (typeof jwksUrl !== 'string' || jwksUrl.length > 2048 || !['https:', 'http:'].includes(parsed.protocol))
				throw new TypeError('bad url');
			url = parsed.href;
		} catch {
			errors.push({ path: '/jwksUrl', message: 'must be an https URL' });
		}
	}
	/** @type {IdentityJwk[] | null} */
	let keys = null;
	if (hasKeys) {
		if (!Array.isArray(publicJwks) || publicJwks.length === 0 || publicJwks.length > IDENTITY_MAX_KEYS)
			errors.push({ path: '/publicJwks', message: `must list 1–${IDENTITY_MAX_KEYS} public keys` });
		else {
			keys = [];
			for (const [index, jwk] of publicJwks.entries()) {
				const normalised = normaliseJwk(jwk);
				if (!normalised.ok) errors.push({ path: `/publicJwks/${index}`, message: normalised.reason });
				else if (keys.some((k) => k.kid === normalised.key.kid))
					errors.push({ path: `/publicJwks/${index}/kid`, message: 'duplicate kid' });
				else keys.push(normalised.key);
			}
		}
	}
	if (audience !== undefined && audience !== null && (typeof audience !== 'string' || !PRINTABLE.test(audience)))
		errors.push({ path: '/audience', message: 'must be 1–255 printable characters' });
	/** @type {{ subject: string, email?: string, phone?: string }} */
	const claims = { subject: 'sub' };
	if (claimMap !== undefined && claimMap !== null) {
		if (!isObject(claimMap)) errors.push({ path: '/claimMap', message: 'must be an object' });
		else
			for (const [name, value] of Object.entries(claimMap)) {
				if (!CLAIM_FIELDS.includes(name)) errors.push({ path: `/claimMap/${name}`, message: 'is not allowed' });
				else if (value === null || value === undefined || value === '') continue;
				else if (typeof value !== 'string' || !CLAIM.test(value))
					errors.push({ path: `/claimMap/${name}`, message: 'must be a claim name' });
				else claims[/** @type {'subject' | 'email' | 'phone'} */ (name)] = value;
			}
	}
	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		value: {
			issuer: /** @type {string} */ (issuer),
			jwksUrl: url,
			publicJwks: keys,
			audience: typeof audience === 'string' ? audience : null,
			claimMap: claims,
		},
	};
};

/**
 * The entitlement-document `identity` section of a stored issuer, or null when it has no usable keys yet.
 * @param {{ issuer: string, keys?: IdentityJwk[] | null, audience?: string | null, claimMap: IdentitySection['claimMap'] } | null | undefined} doc
 * @returns {IdentitySection | null}
 */
export const identitySection = (doc) => {
	if (!doc || !Array.isArray(doc.keys) || doc.keys.length === 0) return null;
	return {
		issuer: doc.issuer,
		jwks: doc.keys.slice(0, IDENTITY_MAX_KEYS).map((key) => ({ ...key })),
		...(doc.audience ? { audience: doc.audience } : {}),
		claimMap: { ...doc.claimMap },
	};
};

/**
 * Whether a JWKS-URL issuer should be refetched now.
 * @param {{ jwksUrl?: string | null, keysFetchedAt?: Date | null, keysFailedAt?: Date | null } | null | undefined} doc
 * @param {number} now
 */
export const jwksDue = (doc, now) => {
	if (!doc?.jwksUrl) return false;
	if (doc.keysFailedAt instanceof Date && now - doc.keysFailedAt.getTime() < JWKS_RETRY_MS) return false;
	return !(doc.keysFetchedAt instanceof Date) || now - doc.keysFetchedAt.getTime() >= JWKS_TTL_MS;
};

/**
 * API view of a stored issuer (keys shown as public material only).
 * @param {Record<string, any>} doc
 */
export const presentIssuer = (doc) => ({
	websiteId: String(doc._id),
	issuer: doc.issuer,
	source: doc.jwksUrl ? 'jwks_url' : 'inline',
	jwksUrl: doc.jwksUrl ?? null,
	audience: doc.audience ?? null,
	claimMap: { ...doc.claimMap },
	keys: (doc.keys ?? []).map((/** @type {IdentityJwk} */ key) => ({ kid: key.kid, kty: key.kty, alg: key.alg ?? null })),
	keysFetchedAt: doc.keysFetchedAt instanceof Date ? doc.keysFetchedAt.toISOString() : null,
	lastError: doc.lastError ?? null,
	createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : null,
	updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt.toISOString() : null,
});
