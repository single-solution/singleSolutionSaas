/**
 * Resolved resource descriptors (pure): the exact F.9 shapes products receive from
 * `POST /v1/product/resources/resolve`. Built from opened credentials at resolve time only.
 * @module
 */
import { AI_PROVIDERS } from './schemas.js';

/** Descriptor lifetime (F.9: `expiresAt` ≤ 15 min). */
export const DESCRIPTOR_TTL_MS = 10 * 60_000;

/** @param {string} raw */
const trimSlash = (raw) => raw.replace(/\/+$/, '');

/**
 * HTTP-provider settings (base URL and authentication) of an AI provider.
 * @param {string} provider
 * @param {Record<string, any>} c
 * @returns {{ baseUrl: string, authScheme: 'bearer' | 'header', authHeader?: string, headers: Record<string, string> }}
 */
export const aiEndpoint = (provider, c) => {
	const baseUrl = trimSlash(
		c.baseUrl ?? /** @type {string} */ (AI_PROVIDERS[/** @type {keyof typeof AI_PROVIDERS} */ (provider)]),
	);
	if (provider === 'anthropic')
		return { baseUrl, authScheme: 'header', authHeader: 'x-api-key', headers: { 'anthropic-version': '2023-06-01' } };
	if (provider === 'google') return { baseUrl, authScheme: 'header', authHeader: 'x-goog-api-key', headers: {} };
	return { baseUrl, authScheme: 'bearer', headers: {} };
};

/**
 * @param {string} kind
 * @param {string} provider
 * @param {Record<string, any>} c credentials
 * @returns {Record<string, unknown>}
 */
export const descriptorOf = (kind, provider, c) => {
	switch (kind) {
		case 'database':
			return { uri: c.uri, ...(c.dbName ? { dbName: c.dbName } : {}) };
		case 'storage':
			return {
				bucket: c.bucket,
				region: c.region,
				accessKeyId: c.accessKeyId,
				secretAccessKey: c.secretAccessKey,
				...(c.endpoint ? { endpoint: trimSlash(c.endpoint) } : {}),
				...(c.forcePathStyle === undefined ? {} : { forcePathStyle: c.forcePathStyle }),
				...(c.prefix ? { prefix: c.prefix } : {}),
			};
		case 'ai': {
			const endpoint = aiEndpoint(provider, c);
			return {
				provider,
				baseUrl: endpoint.baseUrl,
				apiKey: c.apiKey,
				...(c.model ? { model: c.model } : {}),
				authScheme: endpoint.authScheme,
				...(endpoint.authHeader ? { authHeader: endpoint.authHeader } : {}),
				...(Object.keys(endpoint.headers).length > 0 ? { headers: endpoint.headers } : {}),
			};
		}
		case 'messaging':
			if (provider === 'smtp') {
				const secure = c.secure ?? true;
				const port = c.port ?? (secure ? 465 : 587);
				return {
					provider,
					baseUrl: `${secure ? 'smtps' : 'smtp'}://${c.host}:${port}`,
					apiKey: c.password,
					username: c.username,
					...(c.from ? { from: c.from } : {}),
				};
			}
			return {
				provider,
				baseUrl: trimSlash(c.baseUrl),
				apiKey: c.apiKey,
				authScheme: c.authScheme ?? 'bearer',
				...(c.authHeader ? { authHeader: c.authHeader } : {}),
				...(c.headers && Object.keys(c.headers).length > 0 ? { headers: { ...c.headers } } : {}),
			};
		case 'payments':
			return { provider, credentials: { ...c } };
		default:
			return { provider, ids: { ...c.ids } };
	}
};
