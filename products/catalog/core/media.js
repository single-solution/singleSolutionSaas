/**
 * Media references (pure). The catalog stores no files: an item's images and videos point at an https URL or at a key
 * in the merchant's own storage (served under `media.storage_base_url`, or through short signed links when Media
 * uploads is on). Views add a responsive `srcset` from the size ladder and a URL template, and an alt text from the
 * template when the merchant gave none.
 * @module
 */
import { cleanText, fill, isId, isObject, issue } from './text.js';

export const MEDIA_KINDS = Object.freeze(/** @type {const} */ (['image', 'video']));
/** Storage keys: relative object keys (no `..`, no leading slash). */
export const KEY_PATTERN = /^(?!\/)(?!.*\.\.)[A-Za-z0-9!_.*'()/-]{1,512}$/;

/**
 * @typedef {object} Media
 * @property {string} id
 * @property {'image' | 'video'} kind
 * @property {string | null} url
 * @property {string | null} key
 * @property {string | null} alt
 * @property {string | null} role e.g. main, swatch, lifestyle
 * @property {number | null} width
 * @property {number | null} height
 * @property {string[]} variantIds empty = every variant
 * @property {number} position
 */

/**
 * @param {unknown} value
 * @param {readonly string[]} allowedHosts
 */
export const urlAllowed = (value, allowedHosts) => {
	if (typeof value !== 'string' || value.length > 2048 || !/^https:\/\/[^\s]+$/.test(value)) return false;
	try {
		const url = new URL(value);
		return url.username === '' && url.password === '' && (allowedHosts.length === 0 || allowedHosts.includes(url.hostname));
	} catch {
		return false;
	}
};

/**
 * Validate a media reference (create or patch over `current`).
 * @param {unknown} input
 * @param {{ current?: Media | null, kinds: readonly string[], allowedHosts: readonly string[] }} context
 * @returns {{ problems: Array<{ path: string, code: string }>, value: Omit<Media, 'id'> | null }}
 */
export const validateMedia = (input, { current = null, kinds, allowedHosts }) => {
	if (!isObject(input)) return { problems: [issue('', 'object_required')], value: null };
	const body = /** @type {Record<string, any>} */ (input);
	const has = (/** @type {string} */ key) => Object.hasOwn(body, key);
	/** @type {Array<{ path: string, code: string }>} */
	const problems = [];
	const kind = has('kind') ? body.kind : (current?.kind ?? 'image');
	if (!MEDIA_KINDS.includes(kind) || !kinds.includes(kind)) problems.push(issue('/kind', 'kind_invalid'));
	let url = current?.url ?? null;
	let key = current?.key ?? null;
	if (has('url') || has('key')) {
		url = has('url') ? body.url : null;
		key = has('key') ? body.key : null;
		if ((url === null) === (key === null)) problems.push(issue('/url', 'url_or_key_required'));
		else if (url !== null && !urlAllowed(url, allowedHosts)) problems.push(issue('/url', 'url_invalid'));
		else if (key !== null && !(typeof key === 'string' && KEY_PATTERN.test(key))) problems.push(issue('/key', 'key_invalid'));
	} else if (!current) problems.push(issue('/url', 'url_or_key_required'));
	let alt = current?.alt ?? null;
	if (has('alt')) {
		alt = body.alt === null || body.alt === '' ? null : cleanText(body.alt, 300);
		if (body.alt && alt === null) problems.push(issue('/alt', 'text_invalid'));
	}
	const role = has('role') ? body.role : (current?.role ?? null);
	if (role !== null && !(typeof role === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(role)))
		problems.push(issue('/role', 'role_invalid'));
	/** @param {string} name */
	const size = (name) => {
		const record = /** @type {Record<string, any> | null} */ (current);
		const value = has(name) ? body[name] : (record?.[name] ?? null);
		if (value !== null && !(Number.isSafeInteger(value) && value > 0 && value <= 100_000))
			problems.push(issue(`/${name}`, 'size_invalid'));
		return value;
	};
	const width = size('width');
	const height = size('height');
	const variantIds = has('variantIds') ? body.variantIds : (current?.variantIds ?? []);
	if (!Array.isArray(variantIds) || variantIds.length > 100 || !variantIds.every(isId))
		problems.push(issue('/variantIds', 'ids_invalid'));
	const position = has('position') ? body.position : (current?.position ?? 0);
	if (!Number.isSafeInteger(position) || position < 0 || position > 100_000)
		problems.push(issue('/position', 'position_invalid'));
	if (problems.length > 0) return { problems, value: null };
	return {
		problems,
		value: {
			kind,
			url,
			key,
			alt,
			role,
			width,
			height,
			variantIds: [...new Set(/** @type {string[]} */ (variantIds))],
			position,
		},
	};
};

/**
 * @typedef {object} MediaSettings
 * @property {string} storage_base_url
 * @property {number[]} ladder
 * @property {string} url_template
 * @property {string} alt_template
 */

/**
 * The public URL of a media reference: the URL itself, the storage base URL + key, or a signed link; null when a key
 * cannot be served.
 * @param {Pick<Media, 'url' | 'key'>} media
 * @param {{ baseUrl: string, signed?: ReadonlyMap<string, string> }} context
 */
export const mediaUrl = (media, { baseUrl, signed = new Map() }) => {
	if (media.url) return media.url;
	if (!media.key) return null;
	if (baseUrl) return `${baseUrl.replace(/\/+$/, '')}/${media.key.split('/').map(encodeURIComponent).join('/')}`;
	return signed.get(media.key) ?? null;
};

/**
 * A media view for readers: URL, srcset (images with a URL template), alt text (template fallback).
 * @param {Media} media
 * @param {{ settings: MediaSettings, index: number, title: string, brand?: string | null, variant?: string | null,
 *   signed?: ReadonlyMap<string, string> }} context
 */
export const mediaView = (media, { settings, index, title, brand = null, variant = null, signed }) => {
	const url = mediaUrl(media, { baseUrl: settings.storage_base_url, ...(signed ? { signed } : {}) });
	const template = settings.url_template;
	const srcset =
		url && media.kind === 'image' && template
			? [...settings.ladder]
					.sort((a, b) => a - b)
					.map((width) => `${fill(template, { url, width })} ${width}w`)
					.join(', ')
			: null;
	return {
		id: media.id,
		kind: media.kind,
		url,
		srcset,
		alt:
			media.alt ?? fill(settings.alt_template, { title, brand: brand ?? '', variant: variant ?? '', index: index + 1 }).trim(),
		role: media.role,
		width: media.width,
		height: media.height,
		variantIds: media.variantIds,
		position: media.position,
	};
};

/**
 * Media in display order.
 * @param {ReadonlyArray<Record<string, any>>} list
 * @returns {Media[]}
 */
export const orderedMedia = (list) =>
	/** @type {Media[]} */ ([...list]).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
