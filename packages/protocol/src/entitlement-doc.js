/**
 * Signed entitlement documents (compact JWS, `typ: ss-entitlement+jws`).
 *
 * The Portal signs the effective entitlement state of a subscription; products verify it offline and cache it. The
 * payload schema belongs to `@ss/contracts`; this module only relies on `validUntil` (ISO-8601, required), and the
 * optional `validFrom` / `issuedAt` (ISO-8601) and `domain` fields.
 *
 * Offline grace: past `validUntil` a document is `stale` — products keep serving (the Portal may be down) and try to
 * refresh — until `validUntil + graceMs`, after which verification fails with `expired`.
 */
import { createProtocolError } from './errors.js';
import { isObject, signCompact, verifyCompact } from './jws.js';
import { normalizeDomain } from './website-keys.js';

/** @typedef {import('./keys.js').Signer} Signer */
/** @typedef {import('./keys.js').KeyResolver} KeyResolver */
/** @typedef {Record<string, unknown> & { validUntil: string, validFrom?: string, issuedAt?: string, domain?: string }} EntitlementPayload */

/** JOSE `typ` of entitlement documents. */
export const ENTITLEMENT_TYP = 'ss-entitlement+jws';
/** Default offline grace (24 h, the fixed grace products apply). */
export const DEFAULT_GRACE_MS = 24 * 60 * 60_000;
const MAX_DOCUMENT_LENGTH = 512 * 1024;

/**
 * @param {unknown} value
 * @param {string} name
 * @param {boolean} required
 * @returns {number | undefined} epoch milliseconds
 */
const parseInstant = (value, name, required) => {
	if (value === undefined && !required) return undefined;
	const ms = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : Number.NaN;
	if (Number.isNaN(ms)) throw createProtocolError('malformed', `${name} must be an ISO-8601 timestamp`);
	return ms;
};

/**
 * Sign an entitlement document.
 * @param {{ signer: Signer, payload: EntitlementPayload }} params
 * @returns {Promise<string>}
 */
export const signEntitlementDocument = async ({ signer, payload }) => {
	if (!isObject(payload)) throw createProtocolError('invalid_argument', 'payload must be an object');
	try {
		parseInstant(payload.validUntil, 'validUntil', true);
		parseInstant(payload.validFrom, 'validFrom', false);
		parseInstant(payload.issuedAt, 'issuedAt', false);
	} catch (error) {
		throw createProtocolError('invalid_argument', /** @type {Error} */ (error).message);
	}
	return signCompact({ signer, typ: ENTITLEMENT_TYP, payload });
};

/**
 * Verify an entitlement document offline.
 * @param {{ token: unknown, keyResolver: KeyResolver, now?: () => number, expectedDomain?: string, graceMs?: number,
 *   skewMs?: number }} params
 * @returns {Promise<{ payload: EntitlementPayload, stale: boolean, kid: string }>}
 */
export const verifyEntitlementDocument = async ({
	token,
	keyResolver,
	now = Date.now,
	expectedDomain,
	graceMs = DEFAULT_GRACE_MS,
	skewMs = 60_000,
}) => {
	if (!Number.isFinite(graceMs) || graceMs < 0) throw createProtocolError('invalid_argument', 'graceMs must be ≥ 0');
	const { payload, kid } = await verifyCompact({ token, keyResolver, typ: ENTITLEMENT_TYP, maxLength: MAX_DOCUMENT_LENGTH });
	const validUntil = /** @type {number} */ (parseInstant(payload.validUntil, 'validUntil', true));
	const validFrom = parseInstant(payload.validFrom, 'validFrom', false);
	const issuedAt = parseInstant(payload.issuedAt, 'issuedAt', false);
	const t = now();
	if (validFrom !== undefined && t + skewMs < validFrom) throw createProtocolError('not_yet_valid', 'document is not valid yet');
	if (issuedAt !== undefined && t + skewMs < issuedAt)
		throw createProtocolError('not_yet_valid', 'document was issued in the future');
	if (expectedDomain !== undefined) {
		/** @type {string} */
		let bound;
		try {
			bound = normalizeDomain(payload.domain);
		} catch {
			throw createProtocolError('domain_mismatch', 'document has no valid domain binding');
		}
		if (bound !== normalizeDomain(expectedDomain))
			throw createProtocolError('domain_mismatch', 'document is bound to another domain');
	}
	if (t > validUntil + graceMs) throw createProtocolError('expired', 'document is past its offline grace');
	return { payload: /** @type {EntitlementPayload} */ (payload), stale: t > validUntil, kid };
};
