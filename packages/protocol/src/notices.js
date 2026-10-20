/**
 * Notices (PLAN 0.4.12): signed Portal → product messages sent to `POST <product base>/.well-known/ss-events`.
 *
 * Headers:
 *   SS-Timestamp: <unix seconds>
 *   SS-Signature: v1;kid=<kid>;sig=<base64url Ed25519 signature>[, v1;kid=<kid2>;sig=<...>]
 *   SS-Key-Id:    <kid of the first signature>   (a hint only; never trusted for verification)
 *
 * Signed message (UTF-8, lines joined by `\n`): `ss-notice.v1`, the timestamp, the product id the notice is for (its
 * audience) and the hex SHA-256 of the raw body. The prefix separates notice signatures from JWS signing inputs and
 * from calls made with the same Portal key; the audience keeps a notice for one product from being replayed to
 * another; a newline cannot appear in any field. Several signatures let the Portal dual-sign while rotating keys; the
 * product accepts the notice if any signature verifies under a key it trusts.
 *
 * Verification: timestamp within ±toleranceSec, signature, replay check on `audience + timestamp + body hash`
 * (recorded until the tolerance window closes), then the body: `{ type, websiteId?, subject?, what? }` where `status.changed`, `token.revoked`,
 * `website.deleted` and `website.settings_changed` need `websiteId`, `sessions.revoked` needs `subject`, and only
 * `website.settings_changed` may carry `what` (`settings`, `connections` or `links`: which of the website's shared
 * values changed; none means all of them).
 */
import { createProtocolError } from './errors.js';
import { fromUtf8, sha256Hex, utf8 } from './encoding.js';
import { assertBody, checkSigningInputs, readTimestamp, signDetached, verifyDetached } from './detached.js';
import { isObject } from './jws.js';
import { isProductId } from './tokens.js';

/** @import { KeyResolver, Signer } from './keys.js' */
/** @typedef {import('./assertion.js').ReplayStore} ReplayStore */
/** @typedef {{ 'SS-Timestamp': string, 'SS-Signature': string, 'SS-Key-Id': string }} NoticeHeaders */

/** Path of the product's notice endpoint. */
export const NOTICE_PATH = '/.well-known/ss-events';

/** The five notice types. */
export const NOTICE_TYPES = Object.freeze(
	/** @type {const} */ (['status.changed', 'token.revoked', 'sessions.revoked', 'website.deleted', 'website.settings_changed']),
);

/** What a `website.settings_changed` notice may name as changed. */
export const NOTICE_WHAT = Object.freeze(/** @type {const} */ (['settings', 'connections', 'links']));

/** Default accepted clock difference, seconds. */
const NOTICE_TOLERANCE_SECONDS = 300;

const MAX_ID_LENGTH = 256;

/** @typedef {typeof NOTICE_TYPES[number]} NoticeType */
/** @typedef {typeof NOTICE_WHAT[number]} NoticeWhat */
/**
 * @typedef {{ type: 'status.changed' | 'token.revoked' | 'website.deleted', websiteId: string }
 *   | { type: 'website.settings_changed', websiteId: string, what?: NoticeWhat }
 *   | { type: 'sessions.revoked', subject: string }} Notice
 */

/**
 * @param {number} timestamp
 * @param {string} audience
 * @param {string | Uint8Array} body
 * @returns {Uint8Array}
 */
const signedMessage = (timestamp, audience, body) =>
	utf8(['ss-notice.v1', String(timestamp), audience, sha256Hex(body)].join('\n'));

/** @param {unknown} audience */
const assertAudience = (audience) => {
	if (!isProductId(audience)) throw createProtocolError('invalid_argument', 'audience must be a product id');
};

/**
 * @param {unknown} value
 * @returns {value is string}
 */
const isId = (value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;

/**
 * Parse and check a notice body. Throws `malformed` unless it is exactly `{ type, websiteId }` (status.changed,
 * token.revoked, website.deleted), `{ type, websiteId, what? }` (website.settings_changed) or `{ type, subject }`
 * (sessions.revoked).
 * @param {string | Uint8Array} rawBody
 * @returns {Notice}
 */
export const parseNotice = (rawBody) => {
	/** @type {unknown} */
	let parsed;
	try {
		parsed = JSON.parse(typeof rawBody === 'string' ? rawBody : fromUtf8(rawBody));
	} catch {
		throw createProtocolError('malformed', 'notice body is not JSON');
	}
	if (!isObject(parsed)) throw createProtocolError('malformed', 'notice body must be an object');
	const { type } = parsed;
	if (!(/** @type {readonly unknown[]} */ (NOTICE_TYPES).includes(type)))
		throw createProtocolError('malformed', 'unknown notice type');
	const member = type === 'sessions.revoked' ? 'subject' : 'websiteId';
	if (!isId(parsed[member])) throw createProtocolError('malformed', `${type} needs ${member}`);
	const takesWhat = type === 'website.settings_changed';
	if (Object.keys(parsed).some((key) => key !== 'type' && key !== member && !(takesWhat && key === 'what')))
		throw createProtocolError('malformed', 'notice body has unknown members');
	if (takesWhat && parsed.what !== undefined) {
		if (!(/** @type {readonly unknown[]} */ (NOTICE_WHAT).includes(parsed.what)))
			throw createProtocolError('malformed', 'unknown notice what');
		return /** @type {Notice} */ ({ type, websiteId: parsed.websiteId, what: parsed.what });
	}
	return /** @type {Notice} */ ({ type, [member]: parsed[member] });
};

/**
 * Sign a notice body (Portal side).
 * @param {{ signer?: Signer, signers?: Signer[], audience: string, body: string | Uint8Array, timestamp: number }} params
 *   `audience`: the product id the notice is for; `timestamp` in unix seconds (from the injected clock). Pass `signers`
 *   to dual-sign while rotating keys.
 * @returns {Promise<NoticeHeaders>}
 */
export const signNotice = async ({ signer, signers, audience, body, timestamp }) => {
	const all = checkSigningInputs({ signer, signers, timestamp });
	assertAudience(audience);
	assertBody(body);
	parseNotice(body);
	return signDetached(all, timestamp, signedMessage(timestamp, audience, body));
};

/**
 * Verify a notice (product side) and return its checked body.
 * @param {{
 *   headers: Record<string, string | string[] | undefined> | Headers, audience: string, rawBody: string | Uint8Array,
 *   keyResolver: KeyResolver, replayStore: ReplayStore, now?: () => number, toleranceSec?: number,
 * }} params `audience`: this product's own id; `rawBody` must be the exact bytes received; `keyResolver` is over the
 *   pinned Portal keys.
 * @returns {Promise<Notice>}
 */
export const verifyNotice = async ({
	headers,
	audience,
	rawBody,
	keyResolver,
	replayStore,
	now = Date.now,
	toleranceSec = NOTICE_TOLERANCE_SECONDS,
}) => {
	assertAudience(audience);
	if (!replayStore || typeof replayStore.seen !== 'function') {
		throw createProtocolError('invalid_argument', 'replayStore is required');
	}
	if (typeof rawBody !== 'string' && !(rawBody instanceof Uint8Array)) {
		throw createProtocolError('invalid_argument', 'rawBody is required');
	}
	const timestamp = readTimestamp(headers, now, toleranceSec);
	await verifyDetached(headers, signedMessage(timestamp, audience, rawBody), keyResolver);
	const notice = parseNotice(rawBody);
	if (await replayStore.seen(`notice|${audience}|${timestamp}|${sha256Hex(rawBody)}`, (timestamp + toleranceSec) * 1000)) {
		throw createProtocolError('replay', 'notice was already delivered');
	}
	return notice;
};
