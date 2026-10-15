/**
 * Visitor upload types (pure, C11): the merchant's list `upload_types` of the file types visitors may send, each
 * `{ type, maxMb }` from the safe set (`ATTACHMENT_TYPES`: images with HEIC/HEIF and AVIF, PDF, video, audio for
 * voice notes) with its own size cap. Seeded with today's five types at 5 MB.
 * @module
 */
import { ATTACHMENT_TYPES } from './widgets.js';

/** The largest cap of one type (MB), the hard cap of a visitor file. */
export const UPLOAD_MAX_MB = 100;

/** @typedef {{ type: string, maxMb: number }} UploadType */

/** What a website starts with: images (JPEG, PNG, WebP, GIF) and PDF, up to 5 MB each. */
export const UPLOAD_TYPE_SEED = Object.freeze(
	['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'].map((type) => Object.freeze({ type, maxMb: 5 })),
);

/** @param {unknown} value */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Check the upload types a merchant saves: each type once, from the safe set, with a whole cap of 1–100 MB.
 * @param {unknown} items
 * @returns {{ ok: true, value: UploadType[] } | { ok: false, errors: string[] }}
 */
export const checkUploadTypes = (items) => {
	if (!Array.isArray(items) || items.length > ATTACHMENT_TYPES.length)
		return { ok: false, errors: [`Up to ${ATTACHMENT_TYPES.length} file types.`] };
	/** @type {string[]} */
	const errors = [];
	/** @type {UploadType[]} */
	const value = [];
	const seen = new Set();
	items.forEach((item, index) => {
		const entry = isObject(item) ? /** @type {Record<string, unknown>} */ (item) : {};
		const type = typeof entry.type === 'string' ? entry.type : '';
		const maxMb = entry.maxMb;
		if (!ATTACHMENT_TYPES.includes(type) || seen.has(type))
			return void errors.push(`File type ${index + 1}: one of ${ATTACHMENT_TYPES.join(', ')}, once.`);
		if (!Number.isInteger(maxMb) || Number(maxMb) < 1 || Number(maxMb) > UPLOAD_MAX_MB)
			return void errors.push(`File type ${index + 1}: the largest file as whole MB, 1–${UPLOAD_MAX_MB}.`);
		seen.add(type);
		value.push({ type, maxMb: Number(maxMb) });
	});
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
};

/**
 * The visitor rules of a list: the types in the merchant's order, the cap of each (bytes) and the largest cap.
 * @param {readonly UploadType[]} list
 */
export const uploadLimits = (list) => {
	const kept = list.filter((entry) => ATTACHMENT_TYPES.includes(entry.type));
	/** @type {Record<string, number>} */
	const limits = Object.fromEntries(kept.map((entry) => [entry.type, Math.min(entry.maxMb, UPLOAD_MAX_MB) * 1024 * 1024]));
	return { types: kept.map((entry) => entry.type), limits, max: Math.max(0, ...Object.values(limits)) };
};
