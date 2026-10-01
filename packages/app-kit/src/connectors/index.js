/**
 * Connectors: thin adapters that obtain the merchant's credentials through `portal.resolveResource` (short-lived
 * descriptors, cached no longer than `expiresAt`) and execute with them. Built-in (keyed by the descriptor's
 * `provider`, as the Portal resolves it): storage `s3`; ai `generic-http` / `http`; messaging `generic-http` / `http`
 * (JSON over HTTPS) and `smtp` (nodemailer, TLS required). A descriptor without `provider` uses `s3` / `http`. Payments is an interface only — register a provider adapter via `adapters.payments`.
 * Any kind can be overridden per provider: `adapters: { ai: { anthropic: (ctx) => adapter } }`.
 *
 * Every outbound call goes through `send` — by default `@ss/net` `safeFetch` under the outbound policy built from
 * `outbound` options (public https only; allowlisted development hosts may be private / plain http). Custom adapters
 * receive the same `send` and `policy` in their context and should use them instead of `fetch`.
 * @module
 */
import { createOutboundPolicy, safeFetch } from '@ss/net';
import { createSingleFlight, kitError } from '../util.js';
import { createHttpAi, createHttpMessaging } from './http.js';
import { createSmtpMessaging } from './smtp.js';
import { createS3Storage } from './storage.js';

/** @typedef {'ai' | 'messaging' | 'storage' | 'payments'} ConnectorKind */
/**
 * Outbound HTTP(S) call with `safeFetch` semantics (`@ss/net`): resolves `{ status, headers, body: Buffer, url }`,
 * rejects with a `NetError`.
 * @typedef {(url: string, init?: import('@ss/net').SafeFetchInit) => Promise<import('@ss/net').SafeResponse>} OutboundSend
 */
/**
 * @typedef {object} AdapterContext
 * @property {Record<string, unknown>} descriptor merchant credentials — never log it
 * @property {string} websiteId
 * @property {string} slug
 * @property {OutboundSend} send SSRF-guarded outbound HTTP (use this, not `fetch`)
 * @property {import('@ss/net').OutboundPolicy} policy the outbound policy `send` enforces
 * @property {typeof globalThis.fetch} fetch unguarded fetch (Portal calls only — never merchant-supplied URLs)
 * @property {() => number} now
 * @property {import('./smtp.js').CreateSmtpTransport} [createSmtpTransport] replaces nodemailer's transport (tests)
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

/** @type {AdapterFactory} */
const httpAi = ({ descriptor, send, policy }) => createHttpAi({ descriptor, send, policy });
/** @type {AdapterFactory} */
const httpMessaging = ({ descriptor, send, policy }) => createHttpMessaging({ descriptor, send, policy });

/**
 * Built-in adapters, keyed by the descriptor's `provider` exactly as the Portal resolves it.
 * @type {Record<ConnectorKind, Record<string, AdapterFactory>>}
 */
const BUILT_IN = {
	storage: {
		s3: ({ descriptor, websiteId, slug, send, now, policy }) =>
			createS3Storage({ descriptor, websiteId, slug, send, now, policy }),
	},
	// `http` is the default when a descriptor names no provider; `generic-http` is the name the Portal resolves
	ai: { http: httpAi, 'generic-http': httpAi },
	messaging: {
		http: httpMessaging,
		'generic-http': httpMessaging,
		smtp: ({ descriptor, policy, createSmtpTransport }) =>
			createSmtpMessaging({ descriptor, policy, ...(createSmtpTransport ? { createTransport: createSmtpTransport } : {}) }),
	},
	payments: {},
};

/**
 * @param {{
 *   portal: { resolveResource: (input: { websiteId: string, kind: any }) => Promise<{ descriptor: Record<string, unknown>, expiresAt: string }> },
 *   slug: string,
 *   fetch?: typeof globalThis.fetch,
 *   outbound?: import('@ss/net').OutboundPolicyOptions,
 *   send?: OutboundSend,
 *   now?: () => number,
 *   adapters?: Partial<Record<ConnectorKind, Record<string, AdapterFactory>>>,
 *   createSmtpTransport?: import('./smtp.js').CreateSmtpTransport,
 * }} options `outbound` builds the policy; `send` replaces `safeFetch` (tests); `createSmtpTransport` replaces
 *   nodemailer's transport factory of the built-in `smtp` adapter (tests)
 */
export const createConnectors = ({
	portal,
	slug,
	fetch = globalThis.fetch,
	outbound = {},
	send: injectedSend,
	now = Date.now,
	adapters = {},
	createSmtpTransport,
}) => {
	const policy = createOutboundPolicy(outbound);
	/** @type {OutboundSend} */
	const send = injectedSend ?? ((url, init) => safeFetch(url, init, policy));
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
			const adapter = factory({
				descriptor,
				websiteId,
				slug,
				send,
				policy,
				fetch,
				now,
				...(createSmtpTransport ? { createSmtpTransport } : {}),
			});
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
