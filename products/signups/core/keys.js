/**
 * Signing-key lifecycle of a website's issuer (pure). Keys are numbered by `generation`; the signing key is the
 * newest generation whose `activatesAt` has passed. A rotation **pre-publishes** the next key: it appears in the JWKS
 * `prepublishHours` before it signs anything, so every verifier (the Portal refreshes a JWKS URL at most hourly) knows
 * it before the first token signed with it arrives. A superseded key stays published until every access token it
 * signed has expired (`retainMs`). The JWKS never lists more than {@link MAX_PUBLISHED} keys (the Portal limit).
 * @module
 */
import { DAY_MS, HOUR_MS } from './limits.js';

/** At most this many keys are published (Portal identity issuers accept ≤ 5). */
export const MAX_PUBLISHED = 5;

/**
 * @typedef {object} KeyRecord
 * @property {number} generation
 * @property {string} kid
 * @property {Record<string, string>} publicJwk
 * @property {number} activatesAt epoch ms
 */

/**
 * The key that signs at `now` (newest active generation), or null.
 * @template {KeyRecord} K
 * @param {readonly K[]} keys
 * @param {number} now
 * @returns {K | null}
 */
export const signingKey = (keys, now) =>
	keys
		.filter((key) => key.activatesAt <= now)
		.reduce((best, key) => (best && best.generation > key.generation ? best : key), /** @type {K | null} */ (null));

/**
 * Keys to publish at `now`: pending (pre-published) keys, the signing key and superseded keys still inside the
 * retention window, newest first.
 * @template {KeyRecord} K
 * @param {readonly K[]} keys
 * @param {number} now
 * @param {number} retainMs how long a superseded key stays published (≥ the longest access-token lifetime)
 * @returns {K[]}
 */
export const publishedKeys = (keys, now, retainMs) => {
	const sorted = [...keys].sort((a, b) => b.generation - a.generation);
	const current = signingKey(keys, now);
	return sorted
		.filter((key, index) => {
			if (key.activatesAt > now || key === current) return true;
			if (!current || key.generation > current.generation) return false;
			const successor = sorted[index - 1];
			return successor !== undefined && successor.activatesAt <= now && now < successor.activatesAt + retainMs;
		})
		.slice(0, MAX_PUBLISHED);
};

/**
 * Whether a rotation should start: the signing key is older than `rotationDays` (0 = manual only) and no pending key
 * exists yet.
 * @param {readonly KeyRecord[]} keys
 * @param {number} now
 * @param {number} rotationDays
 */
export const rotationDue = (keys, now, rotationDays) => {
	if (keys.some((key) => key.activatesAt > now)) return false;
	const current = signingKey(keys, now);
	if (!current) return true;
	return rotationDays > 0 && now - current.activatesAt >= rotationDays * DAY_MS;
};

/**
 * When a newly created key may start signing: immediately for the first key of a website, else after the
 * pre-publication window.
 * @param {readonly KeyRecord[]} keys
 * @param {number} now
 * @param {number} prepublishHours
 */
export const activationFor = (keys, now, prepublishHours) => (keys.length === 0 ? now : now + prepublishHours * HOUR_MS);

/**
 * Next generation number.
 * @param {readonly KeyRecord[]} keys
 */
export const nextGeneration = (keys) => keys.reduce((max, key) => Math.max(max, key.generation), 0) + 1;

/**
 * Keys that may be deleted: superseded and outside the retention window, keeping the newest `keep` generations.
 * @template {KeyRecord} K
 * @param {readonly K[]} keys
 * @param {number} now
 * @param {number} retainMs
 * @param {number} [keep]
 * @returns {K[]}
 */
export const prunableKeys = (keys, now, retainMs, keep = MAX_PUBLISHED) => {
	const published = new Set(publishedKeys(keys, now, retainMs));
	const newest = new Set([...keys].sort((a, b) => b.generation - a.generation).slice(0, keep));
	return keys.filter((key) => !published.has(key) && !newest.has(key));
};
