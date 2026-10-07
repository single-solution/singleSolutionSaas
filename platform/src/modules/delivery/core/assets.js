/**
 * Asset rules (pure): which files may be uploaded, how large, and how they are checked against the bundle descriptor
 * of the pack version or widget bundle (`assets: [{ path, sha256, size, contentType? }]`).
 * @module
 */
import { createHash } from 'node:crypto';

/** Allowed asset types: extension → canonical content type and size cap (bytes). */
export const ASSET_TYPES = Object.freeze({
	js: Object.freeze({ contentType: 'text/javascript', maxBytes: 512 * 1024 }),
	mjs: Object.freeze({ contentType: 'text/javascript', maxBytes: 512 * 1024 }),
	css: Object.freeze({ contentType: 'text/css', maxBytes: 256 * 1024 }),
	json: Object.freeze({ contentType: 'application/json', maxBytes: 256 * 1024 }),
	svg: Object.freeze({ contentType: 'image/svg+xml', maxBytes: 256 * 1024 }),
	png: Object.freeze({ contentType: 'image/png', maxBytes: 2 * 1024 * 1024 }),
	woff2: Object.freeze({ contentType: 'font/woff2', maxBytes: 1024 * 1024 }),
});

/** Largest single upload (the biggest type cap). */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
/** Deepest asset path the routes accept (segments). */
export const MAX_PATH_SEGMENTS = 8;

const PATH = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*(\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/;
const ALIASES = Object.freeze({ 'application/javascript': 'text/javascript', 'text/json': 'application/json' });

/**
 * @param {string} path
 * @returns {{ ext: string, contentType: string, maxBytes: number } | null}
 */
export const assetType = (path) => {
	const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
	const type = Object.hasOwn(ASSET_TYPES, ext) ? ASSET_TYPES[/** @type {keyof typeof ASSET_TYPES} */ (ext)] : null;
	return type ? { ext, ...type } : null;
};

/**
 * Media type without parameters, aliases mapped.
 * @param {string | null | undefined} value
 */
export const mediaType = (value) => {
	const base = String(value ?? '')
		.split(';')[0]
		?.trim()
		.toLowerCase();
	return (base && Object.hasOwn(ALIASES, base) ? ALIASES[/** @type {keyof typeof ALIASES} */ (base)] : base) ?? '';
};

/** @param {string} path */
export const isAssetPath = (path) =>
	typeof path === 'string' &&
	path.length > 0 &&
	path.length <= 200 &&
	PATH.test(path) &&
	!path.split('/').includes('..') &&
	path.split('/').length <= MAX_PATH_SEGMENTS;

/** @param {Uint8Array} bytes */
export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** @param {Uint8Array | string} bytes */
export const sha384Integrity = (bytes) => `sha384-${createHash('sha384').update(bytes).digest('base64')}`;

/**
 * Check an upload against the descriptor entry. Returns the field errors (empty when acceptable).
 * @param {{ path: string, bytes: Uint8Array, contentType: string | null,
 *   declared: { path: string, sha256: string, size: number, contentType?: string } | undefined }} input
 * @returns {{ errors: Array<{ path: string, message: string, code: string }>, contentType: string }}
 */
export const checkUpload = ({ path, bytes, contentType, declared }) => {
	/** @type {Array<{ path: string, message: string, code: string }>} */
	const errors = [];
	const type = assetType(path);
	if (!type) {
		errors.push({ path: '/path', code: 'type_not_allowed', message: `only ${Object.keys(ASSET_TYPES).join(', ')} files` });
		return { errors, contentType: '' };
	}
	if (!declared) {
		errors.push({ path: '/path', code: 'not_in_descriptor', message: `${path} is not listed in the descriptor` });
		return { errors, contentType: type.contentType };
	}
	const sent = mediaType(contentType);
	if (sent !== type.contentType)
		errors.push({ path: '/content-type', code: 'content_type', message: `send Content-Type: ${type.contentType}` });
	if (declared.contentType && mediaType(declared.contentType) !== type.contentType)
		errors.push({ path: '/content-type', code: 'content_type', message: `the descriptor declares ${declared.contentType}` });
	if (bytes.byteLength > type.maxBytes)
		errors.push({ path: '/body', code: 'too_large', message: `${type.ext} files are limited to ${type.maxBytes} bytes` });
	if (bytes.byteLength !== declared.size)
		errors.push({ path: '/body', code: 'size_mismatch', message: `the descriptor declares ${declared.size} bytes` });
	if (sha256Hex(bytes) !== declared.sha256)
		errors.push({ path: '/body', code: 'sha256_mismatch', message: 'the body does not match the declared sha256' });
	return { errors, contentType: type.contentType };
};
