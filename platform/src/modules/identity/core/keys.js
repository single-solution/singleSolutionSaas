/**
 * Pure website-key rules: status, presentation (metadata only — never key material), rotation schedule and the
 * binding check between a verified key's claims and its stored record.
 * @module
 */

/** @typedef {'active' | 'revoking' | 'revoked' | 'expired'} KeyStatus */

/**
 * @typedef {object} KeyRecord
 * @property {string} _id keyId
 * @property {string} merchantId
 * @property {string} websiteId
 * @property {'pk' | 'sk'} kind
 * @property {'live' | 'test'} env
 * @property {string[]} scopes
 * @property {boolean} allowSubdomains
 * @property {string} kid signing key id
 * @property {string} hint recognisable, non-secret fragment
 * @property {string | null} secretHash `hashSecretKey` of an sk_ (null for pk_)
 * @property {Date | null} expiresAt
 * @property {Date | null} revokeAt effective revocation time (future during a rotation grace)
 * @property {string | null} revokeReason
 * @property {string | null} replacedBy
 * @property {string | null} rotatedFrom
 * @property {Date} createdAt
 */

/**
 * @param {Pick<KeyRecord, 'revokeAt' | 'expiresAt'>} key
 * @param {number} nowMs
 * @returns {KeyStatus}
 */
export const keyStatus = (key, nowMs) => {
	if (key.revokeAt && key.revokeAt.getTime() <= nowMs) return 'revoked';
	if (key.expiresAt && key.expiresAt.getTime() <= nowMs) return 'expired';
	if (key.revokeAt) return 'revoking';
	return 'active';
};

/**
 * A recognisable fragment for consoles: `sk_live_…` plus the last 6 characters.
 * @param {string} key
 */
export const keyHint = (key) => `${key.slice(0, 8)}…${key.slice(-6)}`;

/** @param {Date | null | undefined} d */
const iso = (d) => (d ? d.toISOString() : null);

/**
 * Metadata of a key (list/console). Never includes key material or hashes.
 * @param {KeyRecord} key
 * @param {number} nowMs
 */
export const presentKey = (key, nowMs) => ({
	keyId: key._id,
	websiteId: key.websiteId,
	kind: key.kind,
	env: key.env,
	scopes: [...key.scopes],
	allowSubdomains: key.allowSubdomains,
	hint: key.hint,
	kid: key.kid,
	status: keyStatus(key, nowMs),
	createdAt: iso(key.createdAt),
	expiresAt: iso(key.expiresAt),
	revokeAt: iso(key.revokeAt),
	revokeReason: key.revokeReason ?? null,
	replacedBy: key.replacedBy ?? null,
	rotatedFrom: key.rotatedFrom ?? null,
});

/**
 * Does a verified key's binding agree with its record? (Fails closed for unknown or relabelled keys.)
 * @param {Pick<KeyRecord, 'websiteId' | 'merchantId' | 'kind' | 'env'> | null | undefined} record
 * @param {{ websiteId: string, merchantId: string, kind: string, env: string }} claims
 */
export const claimsMatch = (record, claims) =>
	Boolean(record) &&
	record?.websiteId === claims.websiteId &&
	record?.merchantId === claims.merchantId &&
	record?.kind === claims.kind &&
	record?.env === claims.env;

/**
 * When the replaced key stops working after a rotation.
 * @param {number} nowMs
 * @param {number} graceSeconds
 */
export const rotationRevokeAt = (nowMs, graceSeconds) => new Date(nowMs + graceSeconds * 1000);

/**
 * `expiresAt` (ms) → integer seconds for `issueWebsiteKey`, or an error message.
 * @param {number | undefined} expiresAtMs
 * @param {number} nowMs
 * @returns {{ ok: true, value: number | undefined } | { ok: false, message: string }}
 */
export const expirySeconds = (expiresAtMs, nowMs) => {
	if (expiresAtMs === undefined) return { ok: true, value: undefined };
	const seconds = Math.floor(expiresAtMs / 1000);
	if (seconds <= Math.floor(nowMs / 1000) + 60) return { ok: false, message: 'expiresAt must be at least a minute ahead' };
	return { ok: true, value: seconds };
};
