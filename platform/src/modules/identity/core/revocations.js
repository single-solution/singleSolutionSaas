/**
 * Revocation-list cursors for `GET /v1/product/revocations?since=` (PLAN 0.4.12 row 6: `{ tokenIds, cursor }`).
 *
 * A cursor is opaque base64url JSON `{ t, k }`: revocations after `(t, k)` in `(revokedAt, jti)` order are returned
 * next. A full page continues from its last entry. A partial page ends the scan: the next cursor is `now − LAG`, so a
 * revocation whose write committed late (its `revokedAt` was stamped before it became visible) is still returned on
 * the next fetch. Overlap only repeats token ids, which products merge as a set; nothing is skipped.
 * @module
 */

export const REVOCATION_PAGE = 1000;
const REVOCATION_LAG_MS = 30_000;

/** @typedef {{ t: number, k: string }} RevocationCursor */

/**
 * @param {RevocationCursor} cursor
 * @returns {string}
 */
export const encodeRevocationCursor = ({ t, k }) => Buffer.from(JSON.stringify({ t, k })).toString('base64url');

/**
 * Decode `since`: absent → the beginning; an opaque cursor; or (for convenience) an ISO-8601 timestamp.
 * @param {unknown} since
 * @returns {{ ok: true, value: RevocationCursor } | { ok: false }}
 */
export const decodeRevocationCursor = (since) => {
	if (since === undefined || since === null || since === '') return { ok: true, value: { t: 0, k: '' } };
	if (typeof since !== 'string' || since.length > 256) return { ok: false };
	if (/^\d{4}-\d{2}-\d{2}T/.test(since)) {
		const t = Date.parse(since);
		return Number.isFinite(t) ? { ok: true, value: { t, k: '' } } : { ok: false };
	}
	if (!/^[A-Za-z0-9_-]+$/.test(since)) return { ok: false };
	try {
		const parsed = JSON.parse(Buffer.from(since, 'base64url').toString('utf8'));
		if (
			typeof parsed === 'object' &&
			parsed !== null &&
			Number.isSafeInteger(parsed.t) &&
			parsed.t >= 0 &&
			typeof parsed.k === 'string' &&
			parsed.k.length <= 128
		)
			return { ok: true, value: { t: parsed.t, k: parsed.k } };
	} catch {
		// fall through
	}
	return { ok: false };
};

/**
 * Mongo filter for one product's revocations after the cursor.
 * @param {string} productId
 * @param {RevocationCursor} cursor
 */
export const revocationFilter = (productId, { t, k }) => ({
	productId,
	$or: [{ revokedAt: { $gt: new Date(t) } }, { revokedAt: new Date(t), _id: { $gt: k } }],
});

/**
 * The response for a page of `{ _id, revokedAt }` rows (sorted by revokedAt, _id; at most `limit + 1` rows).
 * @param {Array<{ _id: string, revokedAt: Date }>} rows
 * @param {RevocationCursor} since
 * @param {number} nowMs
 * @param {{ limit?: number, lagMs?: number }} [options]
 * @returns {{ tokenIds: string[], cursor: string }}
 */
export const revocationPage = (rows, since, nowMs, { limit = REVOCATION_PAGE, lagMs = REVOCATION_LAG_MS } = {}) => {
	const page = rows.slice(0, limit);
	const tokenIds = page.map((row) => row._id);
	const last = page[page.length - 1];
	if (rows.length > limit && last)
		return { tokenIds, cursor: encodeRevocationCursor({ t: last.revokedAt.getTime(), k: last._id }) };
	const t = Math.max(since.t, nowMs - lagMs);
	return { tokenIds, cursor: encodeRevocationCursor({ t, k: t === since.t ? since.k : '' }) };
};
