/**
 * S3-compatible storage adapter executing with the merchant's own credentials (their bucket, their keys). Objects are
 * namespaced `<descriptor.prefix><slug>/<websiteId>/<key>` so a product can only reach its own area of the bucket.
 * Signing is `@ss/net` SigV4; server-side calls go through the outbound `send` (`@ss/net` `safeFetch` under the
 * product's outbound policy), so a descriptor cannot point the product at an internal address.
 * @module
 */
import { checkUrl, createOutboundPolicy, isNetError, objectUrl, presignV4, signV4 } from '@ss/net';
import { kitError } from '../util.js';

/** @typedef {import('./index.js').OutboundSend} OutboundSend */

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
 * @param {import('@ss/net').OutboundPolicy} policy
 * @returns {StorageDescriptor}
 */
const checkDescriptor = (descriptor, policy) => {
	for (const name of ['bucket', 'region', 'accessKeyId', 'secretAccessKey']) {
		if (typeof descriptor[name] !== 'string' || descriptor[name] === '')
			throw kitError('resource_invalid', `storage descriptor needs ${name}`);
	}
	if (descriptor.endpoint !== undefined) {
		const checked = checkUrl(String(descriptor.endpoint), policy);
		if (!checked.ok) throw kitError('resource_invalid', `storage endpoint refused (${checked.reason})`);
	}
	return /** @type {StorageDescriptor} */ (/** @type {unknown} */ (descriptor));
};

/**
 * @param {{ descriptor: Record<string, unknown>, websiteId: string, slug: string, send: OutboundSend, now: () => number,
 *   policy?: import('@ss/net').OutboundPolicy }} options `policy` vets the endpoint up front (default: public https only)
 */
export const createS3Storage = ({ descriptor, websiteId, slug, send, now, policy = createOutboundPolicy() }) => {
	const d = checkDescriptor(descriptor, policy);
	const credentials = {
		accessKeyId: d.accessKeyId,
		secretAccessKey: d.secretAccessKey,
		...(d.sessionToken ? { sessionToken: d.sessionToken } : {}),
	};
	const base = `${d.prefix ?? ''}${slug}/${websiteId}/`;
	const store = {
		region: d.region,
		bucket: d.bucket,
		...(d.endpoint === undefined ? {} : { endpoint: d.endpoint }),
		...(d.forcePathStyle === undefined ? {} : { forcePathStyle: d.forcePathStyle }),
	};

	/** @param {string} key */
	const keyFor = (key) => `${base}${checkKey(key)}`;

	/** @param {string} fullKey */
	const urlFor = (fullKey) => objectUrl(store, fullKey);

	/**
	 * Signed server-side request.
	 * @param {'HEAD' | 'DELETE'} method
	 * @param {string} url
	 */
	const call = async (method, url) => {
		try {
			return await send(url, { method, headers: signV4({ method, url, region: d.region, now: now(), ...credentials }) });
		} catch (error) {
			const timeout = isNetError(error, 'timeout');
			throw kitError(timeout ? 'timeout' : 'upstream_error', `storage ${method} failed`, {
				...(isNetError(error) ? { reason: error.code } : {}),
			});
		}
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
			const url = presignV4({
				method: 'PUT',
				url: urlFor(fullKey),
				...credentials,
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
			const url = presignV4({
				method: 'GET',
				url: urlFor(fullKey),
				...credentials,
				region: d.region,
				now: now(),
				expiresIn: seconds,
				query,
			});
			return { method: 'GET', url, key: fullKey, expiresAt: new Date(now() + seconds * 1000).toISOString() };
		},
		/** @param {{ key: string }} input */
		headObject: async ({ key }) => {
			const response = await call('HEAD', urlFor(keyFor(key)));
			if (response.status === 404) return { exists: false };
			if (response.status < 200 || response.status > 299)
				throw kitError('upstream_error', `storage HEAD answered ${response.status}`, { status: response.status });
			return {
				exists: true,
				size: Number(response.headers['content-length'] ?? 0),
				contentType: response.headers['content-type'],
				etag: response.headers.etag,
			};
		},
		/** @param {{ key: string }} input */
		deleteObject: async ({ key }) => {
			const response = await call('DELETE', urlFor(keyFor(key)));
			if ((response.status < 200 || response.status > 299) && response.status !== 404) {
				throw kitError('upstream_error', `storage DELETE answered ${response.status}`, { status: response.status });
			}
			return { deleted: true };
		},
	});
};
