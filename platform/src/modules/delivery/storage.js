/**
 * Platform asset storage — **our** software artefacts only (pack assets, compiled website bundles; PLAN §1a: our
 * artefacts may live on our infrastructure, client data may not). Three adapters behind one interface:
 *
 * - `s3`: an S3-compatible bucket we own (`PLATFORM_ASSET_STORAGE`), signed with `@ss/net` `signV4`, reached with
 *   `safeFetch` under the module's outbound policy (development allowlist only outside production).
 * - `file`: a directory (development).
 * - `memory`: a process-local map (tests, quick local runs).
 *
 * Keys are relative paths built by the delivery module (`packs/<appId>/<version>/<path>`,
 * `w/<websiteId>/<env>/<version>/loader.js`); adapters refuse anything else.
 * @module
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { objectUrl, safeFetch as netFetch, signV4 } from '@ss/net';

/** @typedef {import('../../infra/config.js').AssetStorageConfig} AssetStorageConfig */
/** @typedef {{ body: Uint8Array, contentType: string }} StoredObject */
/**
 * @typedef {object} AssetStorage
 * @property {'memory' | 'file' | 's3'} kind
 * @property {(key: string, body: Uint8Array, options: { contentType: string, cacheControl?: string }) => Promise<void>} put
 * @property {(key: string) => Promise<StoredObject | null>} get
 */

const KEY = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*(\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/;
/** Largest object the adapters read back (bundles and assets are far smaller). */
export const MAX_OBJECT_BYTES = 8 * 1024 * 1024;

/** @param {string} key */
const checkKey = (key) => {
	if (typeof key !== 'string' || key.length > 512 || !KEY.test(key) || key.split('/').includes('..'))
		throw new TypeError(`invalid storage key: ${key}`);
	return key;
};

/** @returns {AssetStorage} */
export const createMemoryStorage = () => {
	/** @type {Map<string, StoredObject>} */
	const objects = new Map();
	return Object.freeze({
		kind: /** @type {const} */ ('memory'),
		put: async (key, body, { contentType }) => {
			objects.set(checkKey(key), { body: new Uint8Array(body), contentType });
		},
		get: async (key) => {
			const found = objects.get(checkKey(key));
			return found ? { body: new Uint8Array(found.body), contentType: found.contentType } : null;
		},
	});
};

/**
 * @param {string} dir
 * @returns {AssetStorage}
 */
export const createFileStorage = (dir) => {
	const root = resolve(dir);
	/** @param {string} key */
	const pathOf = (key) => {
		const path = resolve(join(root, ...checkKey(key).split('/')));
		if (!path.startsWith(`${root}${sep}`)) throw new TypeError(`invalid storage key: ${key}`);
		return path;
	};
	return Object.freeze({
		kind: /** @type {const} */ ('file'),
		put: async (key, body, { contentType }) => {
			const path = pathOf(key);
			await mkdir(dirname(path), { recursive: true });
			const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
			await writeFile(temp, body);
			await writeFile(`${temp}.type`, contentType);
			await rename(`${temp}.type`, `${path}.type`);
			await rename(temp, path);
		},
		get: async (key) => {
			const path = pathOf(key);
			try {
				const [body, contentType] = await Promise.all([readFile(path), readFile(`${path}.type`, 'utf8')]);
				return { body: new Uint8Array(body), contentType };
			} catch (error) {
				if (/** @type {{ code?: string }} */ (error)?.code === 'ENOENT') return null;
				throw error;
			}
		},
	});
};

/**
 * @param {Extract<AssetStorageConfig, { kind: 's3' }>} config
 * @param {{ policy: import('@ss/net').OutboundPolicy, fetch?: typeof netFetch, now?: () => number }} options
 * @returns {AssetStorage}
 */
export const createS3Storage = (config, { policy, fetch = netFetch, now = Date.now }) => {
	const store = {
		region: config.region,
		bucket: config.bucket,
		...(config.endpoint ? { endpoint: config.endpoint } : {}),
		...(config.forcePathStyle === null ? {} : { forcePathStyle: config.forcePathStyle }),
	};
	const credentials = {
		region: config.region,
		accessKeyId: config.accessKeyId,
		secretAccessKey: config.secretAccessKey,
		...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
	};
	/** @param {string} key */
	const urlOf = (key) => objectUrl(store, `${config.prefix}${checkKey(key)}`);
	/** @param {string} what @param {number} status */
	const failure = (what, status) => Object.assign(new Error(`asset storage ${what} failed with ${status}`), { status });
	return Object.freeze({
		kind: /** @type {const} */ ('s3'),
		put: async (key, body, { contentType, cacheControl }) => {
			const url = urlOf(key);
			const headers = { 'content-type': contentType, ...(cacheControl ? { 'cache-control': cacheControl } : {}) };
			const payloadHash = createHash('sha256').update(body).digest('hex');
			const signed = signV4({ method: 'PUT', url, headers, payloadHash, ...credentials, now: now() });
			const response = await fetch(url, { method: 'PUT', headers: signed, body, redirect: 'error' }, policy);
			if (response.status < 200 || response.status >= 300) throw failure('put', response.status);
		},
		get: async (key) => {
			const url = urlOf(key);
			const signed = signV4({ method: 'GET', url, headers: {}, ...credentials, now: now() });
			const response = await fetch(
				url,
				{ method: 'GET', headers: signed, redirect: 'error', maxBytes: MAX_OBJECT_BYTES },
				policy,
			);
			if (response.status === 404) return null;
			if (response.status < 200 || response.status >= 300) throw failure('get', response.status);
			return {
				body: new Uint8Array(response.body),
				contentType: response.headers['content-type'] ?? 'application/octet-stream',
			};
		},
	});
};

/**
 * Build the configured adapter (null when none is configured).
 * @param {AssetStorageConfig | null} config
 * @param {{ policy: import('@ss/net').OutboundPolicy, fetch?: typeof netFetch, now?: () => number }} options
 * @returns {AssetStorage | null}
 */
export const createAssetStorage = (config, options) => {
	if (!config) return null;
	if (config.kind === 'memory') return createMemoryStorage();
	if (config.kind === 'file') return createFileStorage(config.dir);
	return createS3Storage(config, options);
};

/**
 * Read-through cache for immutable objects (bounded by count and bytes, least recently used evicted first).
 * @param {AssetStorage} storage
 * @param {{ maxEntries?: number, maxBytes?: number }} [limits]
 * @returns {AssetStorage & { cached: (key: string) => boolean }}
 */
export const withImmutableCache = (storage, { maxEntries = 256, maxBytes = 32 * 1024 * 1024 } = {}) => {
	/** @type {Map<string, StoredObject>} */
	const entries = new Map();
	let bytes = 0;
	/** @param {string} key @param {StoredObject} value */
	const remember = (key, value) => {
		if (value.body.byteLength > maxBytes) return;
		const previous = entries.get(key);
		if (previous) {
			bytes -= previous.body.byteLength;
			entries.delete(key);
		}
		entries.set(key, value);
		bytes += value.body.byteLength;
		while (entries.size > maxEntries || bytes > maxBytes) {
			const [oldest, entry] = /** @type {[string, StoredObject]} */ (entries.entries().next().value);
			entries.delete(oldest);
			bytes -= entry.body.byteLength;
		}
	};
	return Object.freeze({
		kind: storage.kind,
		put: async (key, body, options) => {
			await storage.put(key, body, options);
			remember(key, { body: new Uint8Array(body), contentType: options.contentType });
		},
		get: async (key) => {
			const hit = entries.get(key);
			if (hit) {
				entries.delete(key);
				entries.set(key, hit);
				return hit;
			}
			const found = await storage.get(key);
			if (found) remember(key, found);
			return found;
		},
		cached: (key) => entries.has(key),
	});
};
