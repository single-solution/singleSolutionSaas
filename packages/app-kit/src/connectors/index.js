/**
 * Connectors: thin adapters that obtain the merchant's credentials through `portal.resolveResource` (short-lived
 * descriptors, cached no longer than `expiresAt`) and execute with them. Built-in: S3-compatible storage, generic
 * HTTP AI and messaging. Payments is an interface only — register a provider adapter via `adapters.payments`.
 * Any kind can be overridden per provider: `adapters: { ai: { anthropic: (ctx) => adapter } }`.
 * @module
 */
import { createSingleFlight, kitError } from '../util.js';
import { createHttpAi, createHttpMessaging } from './http.js';
import { createS3Storage } from './storage.js';

/** @typedef {'ai' | 'messaging' | 'storage' | 'payments'} ConnectorKind */
/**
 * @typedef {object} AdapterContext
 * @property {Record<string, unknown>} descriptor merchant credentials — never log it
 * @property {string} websiteId
 * @property {string} slug
 * @property {typeof globalThis.fetch} fetch
 * @property {() => number} now
 */
/** @typedef {(context: AdapterContext) => any} AdapterFactory */

/**
 * The payments interface every payments adapter implements.
 * @typedef {object} PaymentsAdapter
 * @property {string} provider
 * @property {(input: { amount: number, currency: string, reference: string, idempotencyKey: string, returnUrl?: string, metadata?: Record<string, string> }) => Promise<{ id: string, status: string, redirectUrl?: string }>} createPayment
 * @property {(input: { id: string, idempotencyKey: string }) => Promise<{ id: string, status: string }>} capture
 * @property {(input: { id: string, amount?: number, idempotencyKey: string }) => Promise<{ id: string, status: string }>} refund
 * @property {(input: { id: string }) => Promise<{ id: string, status: string }>} status
 * @property {(input: { headers: Headers | Record<string, string>, rawBody: string }) => Promise<{ ok: boolean, event?: Record<string, unknown> }>} verifyWebhook
 */

/** Payment method names of the interface. */
export const PAYMENTS_METHODS = Object.freeze(['createPayment', 'capture', 'refund', 'status', 'verifyWebhook']);

/** @type {Record<ConnectorKind, Record<string, AdapterFactory>>} */
const BUILT_IN = {
	storage: {
		s3: ({ descriptor, websiteId, slug, fetch, now }) => createS3Storage({ descriptor, websiteId, slug, fetch, now }),
	},
	ai: { http: ({ descriptor, fetch }) => createHttpAi({ descriptor, fetch }) },
	messaging: { http: ({ descriptor, fetch }) => createHttpMessaging({ descriptor, fetch }) },
	payments: {},
};

/**
 * @param {{
 *   portal: { resolveResource: (input: { websiteId: string, kind: any }) => Promise<{ descriptor: Record<string, unknown>, expiresAt: string }> },
 *   slug: string,
 *   fetch: typeof globalThis.fetch,
 *   now?: () => number,
 *   adapters?: Partial<Record<ConnectorKind, Record<string, AdapterFactory>>>,
 * }} options
 */
export const createConnectors = ({ portal, slug, fetch, now = Date.now, adapters = {} }) => {
	/** @type {Map<string, { adapter: any, expiresAt: number }>} */
	const cache = new Map();
	const once = /** @type {(key: string, run: () => Promise<any>) => Promise<any>} */ (createSingleFlight());

	/**
	 * @param {ConnectorKind} kind
	 * @param {Record<string, unknown>} descriptor
	 */
	const providerOf = (kind, descriptor) => {
		if (typeof descriptor.provider === 'string') return descriptor.provider;
		return kind === 'storage' ? 's3' : 'http';
	};

	/**
	 * @param {ConnectorKind} kind
	 * @param {string} websiteId
	 */
	const get = async (kind, websiteId) => {
		if (typeof websiteId !== 'string' || websiteId === '') throw kitError('invalid_argument', 'websiteId is required');
		const key = `${kind}|${websiteId}`;
		const hit = cache.get(key);
		if (hit && hit.expiresAt - 5_000 > now()) return hit.adapter;
		return once(key, async () => {
			const { descriptor, expiresAt } = await portal.resolveResource({ websiteId, kind });
			const provider = providerOf(kind, descriptor);
			const factory = adapters[kind]?.[provider] ?? BUILT_IN[kind][provider];
			if (!factory) throw kitError('not_implemented', `no ${kind} adapter for provider '${provider}'`);
			const adapter = factory({ descriptor, websiteId, slug, fetch, now });
			if (kind === 'payments') {
				for (const method of PAYMENTS_METHODS) {
					if (typeof adapter?.[method] !== 'function')
						throw kitError('not_implemented', `payments adapter lacks ${method}()`);
				}
			}
			const parsed = Date.parse(expiresAt);
			cache.set(key, { adapter, expiresAt: Number.isNaN(parsed) ? now() : parsed });
			return adapter;
		});
	};

	return Object.freeze({
		/** @param {string} websiteId */
		ai: (websiteId) => get('ai', websiteId),
		/** @param {string} websiteId */
		messaging: (websiteId) => get('messaging', websiteId),
		/** @param {string} websiteId */
		storage: (websiteId) => get('storage', websiteId),
		/** @param {string} websiteId @returns {Promise<PaymentsAdapter>} */
		payments: (websiteId) => get('payments', websiteId),
		/** Drop cached credentials of a website (e.g. after `resource.revoked`). */
		forget: (/** @type {string} */ websiteId) => {
			for (const key of cache.keys()) if (key.endsWith(`|${websiteId}`)) cache.delete(key);
		},
	});
};
