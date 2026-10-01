/**
 * Masked previews of connector credentials (pure): what consoles may show. A preview never contains a secret —
 * only hosts, names, and the last four characters of long keys (`…abcd`, never for values shorter than 16).
 * @module
 */
import { parseMongoUri } from './mongo-uri.js';
import { AI_PROVIDERS } from './schemas.js';

/**
 * `…` + last four characters for values of ≥ 16 characters, `••••` otherwise.
 * @param {unknown} value
 * @returns {string}
 */
export const maskSecret = (value) => (typeof value === 'string' && value.length >= 16 ? `…${value.slice(-4)}` : '••••');

/**
 * @param {string | undefined} raw
 * @returns {string | null} origin + path, no query
 */
const safeUrl = (raw) => {
	if (raw === undefined) return null;
	try {
		const u = new URL(raw);
		return `${u.origin}${u.pathname === '/' ? '' : u.pathname}`;
	} catch {
		return null;
	}
};

/**
 * Preview of validated credentials.
 * @param {string} kind
 * @param {string} provider
 * @param {Record<string, any>} c
 * @returns {Record<string, unknown>}
 */
export const previewOf = (kind, provider, c) => {
	switch (kind) {
		case 'database': {
			const parsed = parseMongoUri(c.uri);
			if (!parsed.ok) return { scheme: null };
			const u = parsed.value;
			return {
				scheme: u.scheme,
				hosts: u.hosts.map(({ host, port }) => (port === null ? host : `${host}:${port}`)),
				dbName: c.dbName ?? u.dbName,
				authenticated: u.username !== null,
			};
		}
		case 'storage':
			return {
				endpoint: safeUrl(c.endpoint),
				region: c.region,
				bucket: c.bucket,
				prefix: c.prefix ?? '',
				accessKeyId: maskSecret(c.accessKeyId),
			};
		case 'ai':
			return {
				baseUrl: safeUrl(c.baseUrl) ?? AI_PROVIDERS[/** @type {keyof typeof AI_PROVIDERS} */ (provider)] ?? null,
				model: c.model ?? null,
				apiKey: maskSecret(c.apiKey),
			};
		case 'messaging':
			return provider === 'smtp'
				? {
						host: c.host,
						port: c.port ?? (c.secure === false ? 587 : 465),
						username: maskSecret(c.username),
						from: c.from ?? null,
					}
				: { baseUrl: safeUrl(c.baseUrl), apiKey: maskSecret(c.apiKey) };
		case 'payments':
			return { fields: Object.keys(c).sort() };
		default:
			return { ids: Object.fromEntries(Object.entries(c.ids ?? {}).map(([name, value]) => [name, maskSecret(value)])) };
	}
};
