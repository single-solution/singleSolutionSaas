/**
 * S3-compatible storage adapter executing with the merchant's own credentials (their bucket, their keys). Objects are
 * namespaced `<descriptor.prefix><slug>/<websiteId>/<key>` so a product can only reach its own area of the bucket.
 * @module
 */
import { kitError } from '../util.js';
import { presignUrl, signHeaders, uriEncode } from './sigv4.js';

/**
 * @typedef {object} StorageDescriptor
 * @property {string} bucket
 * @property {string} region
 * @property {string} accessKeyId
 * @property {string} secretAccessKey
 * @property {string} [sessionToken]
 * @property {string} [endpoint] e.g. `https://<account>.r2.cloudflarestorage.com`; default AWS S3 for `region`
 * @property {boolean} [forcePathStyle] default true with a custom endpoint, false for AWS
 * @property {string} [prefix] merchant-chosen key prefix
 */

/**
 * @param {unknown} key
 * @returns {string}
 */
const checkKey = (key) => {
	if (typeof key !== 'string' || key.length === 0 || key.length > 900)
		throw kitError('invalid_key', 'object key must be 1..900 characters');
	if (
		key.startsWith('/') ||
		[...key].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f || c === '\\') ||
		key.split('/').some((part) => part === '..' || part === '.' || part === '')
	) {
		throw kitError('invalid_key', 'object key must be a relative path without empty, "." or ".." segments');
	}
	return key;
};

/**
 * @param {Record<string, unknown>} descriptor
 * @returns {StorageDescriptor}
 */
const checkDescriptor = (descriptor) => {
	for (const name of ['bucket', 'region', 'accessKeyId', 'secretAccessKey']) {
		if (typeof descriptor[name] !== 'string' || descriptor[name] === '')
			throw kitError('resource_invalid', `storage descriptor needs ${name}`);
	}
	if (descriptor.endpoint !== undefined) {
		const url = new URL(String(descriptor.endpoint));
		const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
		if (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
			throw kitError('resource_invalid', 'storage endpoint must be https');
	}
	return /** @type {StorageDescriptor} */ (/** @type {unknown} */ (descriptor));
};

/**
 * @param {{ descriptor: Record<string, unknown>, websiteId: string, slug: string, fetch: typeof globalThis.fetch, now: () => number }} options
 */
export const createS3Storage = ({ descriptor, websiteId, slug, fetch, now }) => {
	const d = checkDescriptor(descriptor);
	const credentials = {
		accessKeyId: d.accessKeyId,
		secretAccessKey: d.secretAccessKey,
		...(d.sessionToken ? { sessionToken: d.sessionToken } : {}),
	};
	const base = `${d.prefix ?? ''}${slug}/${websiteId}/`;
	const pathStyle = d.forcePathStyle ?? d.endpoint !== undefined;

	/** @param {string} key */
	const keyFor = (key) => `${base}${checkKey(key)}`;

	/** @param {string} fullKey */
	const urlFor = (fullKey) => {
		const encoded = uriEncode(fullKey, true);
		if (d.endpoint) {
			const endpoint = new URL(d.endpoint);
			return pathStyle
				? `${endpoint.origin}/${uriEncode(d.bucket)}/${encoded}`
				: `${endpoint.protocol}//${d.bucket}.${endpoint.host}/${encoded}`;
		}
		return pathStyle
			? `https://s3.${d.region}.amazonaws.com/${uriEncode(d.bucket)}/${encoded}`
			: `https://${d.bucket}.s3.${d.region}.amazonaws.com/${encoded}`;
	};

	/** @param {number | undefined} expiresIn */
	const ttl = (expiresIn) => {
		const value = expiresIn ?? 300;
		if (!Number.isInteger(value) || value < 1 || value > 7 * 24 * 3600)
			throw kitError('invalid_argument', 'expiresIn must be 1..604800 seconds');
		return value;
	};

	return Object.freeze({
		kind: 'storage',
		provider: 's3',
		bucket: d.bucket,
		keyFor,
		/**
		 * Presigned PUT for a direct browser upload.
		 * @param {{ key: string, contentType?: string, expiresIn?: number }} input
		 */
		presignPut: ({ key, contentType, expiresIn }) => {
			const fullKey = keyFor(key);
			const seconds = ttl(expiresIn);
			/** @type {Record<string, string>} */
			const headers = contentType ? { 'content-type': contentType } : {};
			const url = presignUrl({
				method: 'PUT',
				url: urlFor(fullKey),
				credentials,
				region: d.region,
				now: now(),
				expiresIn: seconds,
				headers,
			});
			return { method: 'PUT', url, headers, key: fullKey, expiresAt: new Date(now() + seconds * 1000).toISOString() };
		},
		/**
		 * Presigned GET.
		 * @param {{ key: string, expiresIn?: number, downloadName?: string }} input
		 */
		presignGet: ({ key, expiresIn, downloadName }) => {
			const fullKey = keyFor(key);
			const seconds = ttl(expiresIn);
			/** @type {Record<string, string>} */
			const query = downloadName
				? { 'response-content-disposition': `attachment; filename="${downloadName.replace(/["\\\r\n]/g, '_')}"` }
				: {};
			const url = presignUrl({
				method: 'GET',
				url: urlFor(fullKey),
				credentials,
				region: d.region,
				now: now(),
				expiresIn: seconds,
				query,
			});
			return { method: 'GET', url, key: fullKey, expiresAt: new Date(now() + seconds * 1000).toISOString() };
		},
		/** @param {{ key: string }} input */
		headObject: async ({ key }) => {
			const url = urlFor(keyFor(key));
			const response = await fetch(url, {
				method: 'HEAD',
				headers: signHeaders({ method: 'HEAD', url, credentials, region: d.region, now: now() }),
			});
			if (response.status === 404) return { exists: false };
			if (!response.ok)
				throw kitError('upstream_error', `storage HEAD answered ${response.status}`, { status: response.status });
			return {
				exists: true,
				size: Number(response.headers.get('content-length') ?? 0),
				contentType: response.headers.get('content-type') ?? undefined,
				etag: response.headers.get('etag') ?? undefined,
			};
		},
		/** @param {{ key: string }} input */
		deleteObject: async ({ key }) => {
			const url = urlFor(keyFor(key));
			const response = await fetch(url, {
				method: 'DELETE',
				headers: signHeaders({ method: 'DELETE', url, credentials, region: d.region, now: now() }),
			});
			if (!response.ok && response.status !== 404) {
				throw kitError('upstream_error', `storage DELETE answered ${response.status}`, { status: response.status });
			}
			return { deleted: true };
		},
	});
};
