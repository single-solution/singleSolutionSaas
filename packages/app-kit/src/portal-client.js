/**
 * Signed product → Portal client. Every call carries a fresh client assertion (`@ss/protocol` `signAssertion`,
 * audience = the pinned Portal URL); the Portal verifies it against the app's registered keys and a replay store.
 * The JWKS endpoint is the only unauthenticated call. Responses are JSON; non-2xx answers throw a `portal_error`
 * with `status` and the problem `code` (if the Portal sent an RFC 9457 body).
 * @module
 */
import { canonicalUrl, signAssertion } from '@ss/protocol';
import { isObject, kitError } from './util.js';

/** @typedef {import('@ss/protocol').Signer} Signer */
/** @typedef {import('./stores/types.js').UsageRecord} UsageRecord */
/** @typedef {'database' | 'storage' | 'ai' | 'messaging' | 'payments'} ResourceKind */
/** @typedef {{ kind: ResourceKind, descriptor: Record<string, unknown>, expiresAt: string }} ResolvedResource */

/**
 * @typedef {object} PortalClient
 * @property {string} baseUrl canonical pinned Portal URL
 * @property {string} jwksUrl
 * @property {() => Promise<unknown>} jwks
 * @property {(websiteId: string) => Promise<{ document: string }>} entitlements
 * @property {(options?: { since?: string | null }) => Promise<{ keyIds: string[], cursor: string | null }>} revocations
 * @property {(records: UsageRecord[], options?: { idempotencyKey?: string }) => Promise<{ results: Array<{ idempotencyKey: string, status: 'accepted' | 'duplicate' | 'rejected', reason?: string }> }>} usage
 * @property {(input: { jti: string, exp?: number }) => Promise<{ consumed: boolean }>} consumeLaunch
 * @property {(event: Record<string, unknown>) => Promise<unknown>} publishEvent send one complete envelope (as a batch of one)
 * @property {(events: Record<string, unknown>[]) => Promise<unknown>} publishEvents send complete envelopes `{ events: [...] }`
 * @property {(input: { websiteId: string, kind: ResourceKind }) => Promise<ResolvedResource>} resolveResource
 * @property {(input: IdentityIssuerRequest) => Promise<IdentityIssuerStatus>} requestIdentityIssuer ask to become the
 *   website's identity issuer (`PUT /v1/product/websites/:websiteId/identity`): `pending` until the merchant approves,
 *   `active` when the request equals the website's active issuer (safe to repeat)
 */

/**
 * A request to become a website's identity issuer (bring-your-own identity). Give exactly one of `jwksUrl` and
 * `publicJwks`; the product's manifest must declare `capabilities.identityIssuer: true` and the website must have an
 * active subscription to the product.
 * @typedef {object} IdentityIssuerRequest
 * @property {string} websiteId
 * @property {string} issuer the tokens' `iss`
 * @property {string | null} [jwksUrl] where the Portal fetches the public keys (must yield a usable key now)
 * @property {Record<string, unknown>[] | null} [publicJwks] inline public keys instead of a JWKS URL
 * @property {string | null} [audience] the tokens' `aud`, when checked
 * @property {{ subject?: string, email?: string, phone?: string }} [claimMap] claim names (default `{ subject: 'sub' }`)
 */
/**
 * @typedef {{ status: 'pending', request: Record<string, any> } | { status: 'active', issuer: Record<string, any> }} IdentityIssuerStatus
 */

/**
 * @param {{
 *   portalUrl: string,
 *   appId: () => Promise<string | null> | string | null,
 *   signer: Signer,
 *   fetch?: typeof globalThis.fetch,
 *   now?: () => number,
 *   randomBytes?: (length: number) => Uint8Array,
 *   timeoutMs?: number,
 *   audience?: string,
 *   userAgent?: string,
 * }} options `appId` may be a function so a product registered at runtime picks its id up lazily.
 * @returns {PortalClient}
 */
export const createPortalClient = ({
	portalUrl,
	appId,
	signer,
	fetch = globalThis.fetch,
	now = Date.now,
	randomBytes,
	timeoutMs = 10_000,
	audience,
	userAgent = 'ss-app-kit/0.1',
}) => {
	const baseUrl = canonicalUrl(portalUrl);
	const aud = audience ?? baseUrl;
	const jwksUrl = `${baseUrl}/.well-known/jwks.json`;

	/**
	 * @param {Response} response
	 * @returns {Promise<unknown>}
	 */
	const readJson = async (response) => {
		const text = await response.text();
		if (text.length === 0) return null;
		try {
			return JSON.parse(text);
		} catch {
			throw kitError('portal_error', 'Portal returned invalid JSON', { status: response.status });
		}
	};

	/**
	 * @param {'GET' | 'POST' | 'PUT'} method
	 * @param {string} path
	 * @param {{ body?: unknown, signed?: boolean, headers?: Record<string, string> }} [options]
	 * @returns {Promise<any>}
	 */
	const call = async (method, path, { body, signed = true, headers = {} } = {}) => {
		/** @type {Record<string, string>} */
		const h = { accept: 'application/json', 'user-agent': userAgent, ...headers };
		if (signed) {
			const id = await appId();
			if (!id) throw kitError('not_registered', 'appId is unknown: the product is not registered yet');
			const assertion = await signAssertion({
				signer,
				appId: id,
				audience: aud,
				now,
				...(randomBytes ? { randomBytes } : {}),
			});
			h.authorization = `Bearer ${assertion}`;
		}
		if (body !== undefined) h['content-type'] = 'application/json';
		/** @type {Response} */
		let response;
		try {
			response = await fetch(`${baseUrl}${path}`, {
				method,
				headers: h,
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: AbortSignal.timeout(timeoutMs),
				redirect: 'error',
			});
		} catch (error) {
			const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
			throw kitError(timeout ? 'portal_timeout' : 'portal_unreachable', `Portal ${method} ${path.split('?')[0]} failed`, {
				path: path.split('?')[0],
			});
		}
		const json = await readJson(response);
		if (!response.ok) {
			const code = isObject(json) && typeof json.type === 'string' ? json.type.split('/').pop() : undefined;
			throw kitError('portal_error', `Portal ${method} ${path.split('?')[0]} answered ${response.status}`, {
				status: response.status,
				...(code ? { problem: code } : {}),
			});
		}
		return json;
	};

	/**
	 * @param {unknown} value
	 * @param {string} what
	 * @returns {Record<string, any>}
	 */
	const expectObject = (value, what) => {
		if (!isObject(value)) throw kitError('portal_error', `Portal ${what} response is not an object`);
		return value;
	};

	return Object.freeze({
		baseUrl,
		jwksUrl,
		jwks: () => call('GET', '/.well-known/jwks.json', { signed: false }),
		entitlements: async (websiteId) => {
			const json = expectObject(
				await call('GET', `/v1/product/entitlements?websiteId=${encodeURIComponent(websiteId)}`),
				'entitlements',
			);
			if (typeof json.document !== 'string') throw kitError('portal_error', 'entitlement response has no document');
			return { document: json.document };
		},
		revocations: async ({ since } = {}) => {
			const query = since ? `?since=${encodeURIComponent(since)}` : '';
			const json = expectObject(await call('GET', `/v1/product/revocations${query}`), 'revocations');
			const keyIds = Array.isArray(json.keyIds) ? json.keyIds.filter((id) => typeof id === 'string') : [];
			return { keyIds, cursor: typeof json.cursor === 'string' ? json.cursor : (since ?? null) };
		},
		usage: async (records, { idempotencyKey } = {}) => {
			const json = expectObject(
				await call('POST', '/v1/product/usage', {
					body: { records },
					...(idempotencyKey ? { headers: { 'idempotency-key': idempotencyKey } } : {}),
				}),
				'usage',
			);
			return { results: Array.isArray(json.results) ? json.results : [] };
		},
		consumeLaunch: async (input) => {
			const json = expectObject(await call('POST', '/v1/product/launch/consume', { body: input }), 'launch');
			return { consumed: json.consumed === true };
		},
		publishEvent: (event) => call('POST', '/v1/product/events', { body: { events: [event] } }),
		publishEvents: (events) => call('POST', '/v1/product/events', { body: { events } }),
		resolveResource: async ({ websiteId, kind }) => {
			const json = expectObject(
				await call('POST', '/v1/product/resources/resolve', { body: { websiteId, kind } }),
				'resource',
			);
			if (json.kind !== kind || !isObject(json.descriptor) || typeof json.expiresAt !== 'string') {
				throw kitError('portal_error', 'resource descriptor is malformed');
			}
			return /** @type {ResolvedResource} */ (json);
		},
		requestIdentityIssuer: async ({ websiteId, ...input }) => {
			if (typeof websiteId !== 'string' || websiteId.length === 0)
				throw kitError('invalid_argument', 'requestIdentityIssuer needs a websiteId');
			const body = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
			const json = expectObject(
				await call('PUT', `/v1/product/websites/${encodeURIComponent(websiteId)}/identity`, { body }),
				'identity issuer',
			);
			if (json.status === 'pending' && isObject(json.request)) return { status: 'pending', request: json.request };
			if (json.status === 'active' && isObject(json.issuer)) return { status: 'active', issuer: json.issuer };
			throw kitError('portal_error', 'identity issuer response is malformed');
		},
	});
};
