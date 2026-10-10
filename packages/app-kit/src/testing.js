/**
 * `@ss/app-kit/testing` — test doubles for products built on the kit:
 *
 * - `createFakePortal()`: the Portal side of the Product ↔ Portal contract (PLAN 0.4.12): connect, price and feature
 *   reports, status (settable), websites, revocations, directory and launch consume, plus helpers that sign tokens,
 *   launches and notices;
 * - `createAccountsDouble()`: Accounts as products see it: it receives activity copies, serves sign-in keys and the
 *   users with a permission (staff alerts), and calls a product's data-rights routes with a pasted server token;
 * - `createNotificationsDouble()`: Notifications as products see it: it takes events (`POST /v1/events`) and messages
 *   (`POST /v1/messages/<channel>`) and keeps them;
 * - `createNetwork(handlers)`: routes `fetch` and outbound calls (`outboundSend`) to in-process handlers by origin;
 * - `createMemoryStore()`.
 * @module
 */
import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { validateActivityCopy, validateFeatureReport, validatePriceReport } from '@ss/contracts';
import { netError } from '@ss/net';
import {
	createConnectRequest,
	createJwks,
	createKeyResolver,
	createMemoryReplayStore,
	createSigner,
	generateSigningKey,
	issueLaunch,
	issueToken,
	signNotice,
	toPublicJwk,
	verifyAssertion,
	verifyConnectResponse,
} from '@ss/protocol';
import { createMemoryStore } from './stores/memory.js';

export { createMemoryStore };

/** @typedef {(request: Request) => Promise<Response>} Handler */
/**
 * @typedef {object} FakeWebsite
 * @property {string} websiteId
 * @property {string} domain
 * @property {string} merchantId
 * @property {string} merchantName
 * @property {'active' | 'grace' | 'stopped' | 'suspended' | 'removed'} status
 * @property {string | null} graceEndsAt
 * @property {number} todayMillicredits
 * @property {Record<string, { version: number, on: string[] }>} features by product id
 */

/**
 * @param {number} status
 * @param {unknown} [body]
 * @returns {Response}
 */
const json = (status, body) =>
	new Response(body === undefined ? null : JSON.stringify(body), {
		status,
		headers: body === undefined ? {} : { 'content-type': 'application/json' },
	});

/**
 * @param {string} base
 * @param {string} code
 * @param {number} status
 */
const fail = (base, code, status) =>
	new Response(JSON.stringify({ type: `${base}/problems/${code}`, title: code, status }), {
		status,
		headers: { 'content-type': 'application/problem+json' },
	});

/**
 * Route `fetch` and outbound calls to in-process handlers by origin. Unknown origins fail like an unreachable host.
 * @param {Record<string, Handler>} handlers origin → handler
 */
export const createNetwork = (handlers) => {
	/** @type {typeof globalThis.fetch} */
	const fetch = async (input, init) => {
		const request = new Request(input, init);
		const handler = handlers[new URL(request.url).origin];
		if (!handler) throw new TypeError('fetch failed');
		return handler(request);
	};
	/** @type {import('./connections.js').OutboundSend} */
	const send = async (url, init = {}) => {
		const handler = handlers[new URL(url).origin];
		if (!handler) throw netError('network', 'unreachable', 'the host cannot be reached');
		const response = await handler(
			new Request(url, {
				method: init.method ?? 'GET',
				...(init.headers ? { headers: init.headers } : {}),
				...(init.body === undefined ? {} : { body: /** @type {BodyInit} */ (init.body) }),
			}),
		);
		const body = Buffer.from(await response.arrayBuffer());
		if (init.maxBytes !== undefined && body.length > init.maxBytes)
			throw netError('too_large', 'body_length', 'the response is too large');
		return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body, url };
	};
	return { fetch, send };
};

/**
 * A fake Portal implementing the Portal side of PLAN 0.4.12.
 * @param {{ url?: string, now?: () => number, pageSize?: number }} [options]
 */
export const createFakePortal = async ({ url = 'https://portal.test', now = Date.now, pageSize = 100 } = {}) => {
	const { privateJwk, publicJwk } = await generateSigningKey({ kid: 'portal-1' });
	const signer = createSigner(privateJwk);
	const jwks = createJwks([publicJwk]);
	const replayStore = createMemoryReplayStore({ now });
	/** @type {Map<string, { productId: string, baseUrl: string, publicJwk: any, manifest: any, prices: { version: number, features: any[] }, handler: Handler | null }>} */
	const products = new Map();
	/** @type {Map<string, FakeWebsite>} */
	const websites = new Map();
	/** @type {Map<string, { name: string, role: 'owner' | 'support' | 'finance' }>} */
	const admins = new Map();
	/** @type {string[]} */
	const revoked = [];
	/** @type {Set<string>} */
	const consumed = new Set();
	/** @type {Array<{ productId: string, body: any }>} */
	const priceReports = [];
	/** @type {Array<{ productId: string, websiteId: string, body: any }>} */
	const featureReports = [];
	/** @type {Array<{ method: string, path: string, productId: string | null }>} */
	const calls = [];
	let reachable = true;
	let websiteSeq = 0;

	/** @param {Request} request */
	const productOf = async (request) => {
		const token = /^Bearer\s+(\S+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
		try {
			const { productId } = await verifyAssertion({
				token,
				keyResolverForProduct: (id) => {
					const product = products.get(id);
					return product ? createKeyResolver({ jwks: { keys: [product.publicJwk] }, now }) : null;
				},
				audience: url,
				replayStore,
				now,
			});
			return productId;
		} catch {
			return null;
		}
	};

	/** @param {FakeWebsite} site @param {string} productId */
	const statusOf = (site, productId) => ({
		websiteId: site.websiteId,
		merchantId: site.merchantId,
		merchantName: site.merchantName,
		domain: site.domain,
		status: site.status,
		graceEndsAt: site.status === 'grace' ? site.graceEndsAt : null,
		todayMillicredits: site.todayMillicredits,
		featuresVersion: site.features[productId]?.version ?? 0,
		validUntil: new Date(now() + 5 * 60_000).toISOString(),
	});

	/** @type {Handler} */
	const handle = async (request) => {
		const { pathname, searchParams } = new URL(request.url);
		const method = request.method;
		if (method === 'GET' && pathname === '/.well-known/jwks.json') return json(200, jwks);
		const productId = await productOf(request);
		calls.push({ method, path: pathname, productId });
		if (!productId) return fail(url, 'unauthorized', 401);
		const product = /** @type {NonNullable<ReturnType<typeof products.get>>} */ (products.get(productId));
		const body = method === 'GET' ? null : await request.json().catch(() => null);
		const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
		if (method === 'PUT' && pathname === '/v1/product/prices') {
			const checked = validatePriceReport(body);
			if (!checked.ok) return fail(url, 'validation_failed', 422);
			if (checked.value.version <= product.prices.version) return fail(url, 'conflict', 409);
			product.prices = structuredClone(checked.value);
			priceReports.push({ productId, body: checked.value });
			return json(200, { version: checked.value.version });
		}
		if (parts[0] === 'v1' && parts[1] === 'product' && parts[2] === 'websites' && parts[3] !== undefined) {
			const site = websites.get(parts[3]);
			if (!site) return fail(url, 'website_not_found', 404);
			if (method === 'GET' && parts[4] === 'status') return json(200, statusOf(site, productId));
			if (method === 'PUT' && parts[4] === 'features') {
				const checked = validateFeatureReport(body);
				if (!checked.ok) return fail(url, 'validation_failed', 422);
				const report = checked.value;
				const priced = new Map(product.prices.features.map((f) => [f.key, f]));
				const admin = admins.get(report.adminId);
				const depsOff = report.on.some((key) =>
					(priced.get(key)?.dependsOn ?? []).some((/** @type {string} */ dep) => !report.on.includes(dep)),
				);
				if (report.on.some((key) => !priced.has(key)) || depsOff || !admin || admin.role === 'finance')
					return fail(url, 'validation_failed', 422);
				if (report.version <= (site.features[productId]?.version ?? 0)) return fail(url, 'conflict', 409);
				site.features[productId] = { version: report.version, on: [...report.on] };
				featureReports.push({ productId, websiteId: site.websiteId, body: report });
				return json(200, { version: report.version });
			}
		}
		if (method === 'GET' && pathname === '/v1/product/websites') {
			const rows = [...websites.values()].filter((site) => site.status !== 'removed');
			const start = Number(searchParams.get('cursor') ?? '0');
			const items = rows.slice(start, start + pageSize).map(({ websiteId, domain, merchantId, merchantName, status }) => ({
				websiteId,
				domain,
				merchantId,
				merchantName,
				status,
			}));
			return json(200, { items, cursor: start + pageSize < rows.length ? String(start + pageSize) : null });
		}
		if (method === 'GET' && pathname === '/v1/product/revocations') {
			const since = Number(searchParams.get('since') ?? '0');
			return json(200, { tokenIds: revoked.slice(since), cursor: revoked.length > 0 ? String(revoked.length) : null });
		}
		if (method === 'GET' && parts[2] === 'directory' && parts[3] !== undefined) {
			const other = products.get(parts[3]);
			return other ? json(200, { baseUrl: other.baseUrl }) : fail(url, 'not_found', 404);
		}
		if (method === 'POST' && pathname === '/v1/product/launch/consume') {
			const jti = String(body?.jti ?? '');
			const first = !consumed.has(jti);
			consumed.add(jti);
			return json(200, { consumed: first });
		}
		return fail(url, 'not_found', 404);
	};

	/** @param {string} websiteId */
	const site = (websiteId) => {
		const found = websites.get(websiteId);
		if (!found) throw new Error(`unknown website ${websiteId}`);
		return found;
	};

	return Object.freeze({
		url,
		jwks,
		/** The Portal's request handler (for `createNetwork`). */
		handle,
		/** @type {typeof globalThis.fetch} `fetch` to this Portal; refuses like a dead network while unreachable */
		fetch: async (input, init) => {
			if (!reachable) throw new TypeError('fetch failed');
			return handle(new Request(input, init));
		},
		/** @param {boolean} value */
		setReachable: (value) => {
			reachable = value;
		},
		/**
		 * Connect (or reconnect) a product: the signed handshake against its handler.
		 * @param {{ handler: Handler, baseUrl: string, secret: string, priceListVersion?: number }} input
		 */
		connect: async ({ handler, baseUrl, secret, priceListVersion }) => {
			const known = [...products.values()].find((p) => p.baseUrl === baseUrl);
			const request = createConnectRequest({
				secret,
				productUrl: baseUrl,
				portalUrl: url,
				jwks,
				priceListVersion: priceListVersion ?? known?.prices.version ?? 0,
				now,
			});
			const response = await handler(
				new Request(request.url, { method: 'POST', headers: request.headers, body: request.body }),
			);
			if (response.status !== 200) throw new Error(`connect failed with ${response.status}: ${await response.text()}`);
			const answer = verifyConnectResponse({
				secret,
				headers: response.headers,
				body: await response.text(),
				nonce: request.nonce,
				now,
			});
			const prices = /** @type {{ version: number, features: any[] }} */ (/** @type {unknown} */ (answer.prices));
			products.set(answer.productId, {
				productId: answer.productId,
				baseUrl: request.baseUrl,
				publicJwk: answer.publicJwk,
				manifest: answer.manifest,
				prices,
				handler,
			});
			return { productId: answer.productId, manifest: answer.manifest, prices };
		},
		/** Make another product known to the directory. @param {{ productId: string, baseUrl: string }} input */
		addProduct: ({ productId, baseUrl }) => {
			products.set(productId, {
				productId,
				baseUrl,
				publicJwk: null,
				manifest: null,
				prices: { version: 0, features: [] },
				handler: null,
			});
		},
		/**
		 * @param {{ domain: string, websiteId?: string, merchantId?: string, merchantName?: string,
		 *   status?: FakeWebsite['status'], graceEndsAt?: string | null, todayMillicredits?: number }} input
		 * @returns {string} the website id
		 */
		addWebsite: ({
			domain,
			websiteId,
			merchantId = 'mer_0123456789abcdefghjkmnpq',
			merchantName = 'Example Shop',
			status = 'active',
			graceEndsAt = null,
			todayMillicredits = 0,
		}) => {
			websiteSeq += 1;
			const id = websiteId ?? `web_${String(websiteSeq).padStart(26, '0')}`;
			websites.set(id, {
				websiteId: id,
				domain,
				merchantId,
				merchantName,
				status,
				graceEndsAt,
				todayMillicredits,
				features: {},
			});
			return id;
		},
		/** @param {string} websiteId @param {Partial<Pick<FakeWebsite, 'status' | 'graceEndsAt' | 'todayMillicredits'>>} patch */
		setStatus: (websiteId, patch) => {
			Object.assign(site(websiteId), patch);
		},
		/** Delete a website (its status answers 404 afterwards). @param {string} websiteId */
		deleteWebsite: (websiteId) => {
			websites.delete(websiteId);
		},
		/** @param {string} websiteId @param {string} productId */
		features: (websiteId, productId) => site(websiteId).features[productId] ?? { version: 0, on: [] },
		/** @param {{ id: string, name: string, role: 'owner' | 'support' | 'finance' }} admin */
		addAdmin: ({ id, name, role }) => {
			admins.set(id, { name, role });
		},
		/**
		 * Sign a browser or server token.
		 * @param {{ websiteId: string, productId: string, kind: 'browser' | 'server' }} input
		 * @returns {Promise<{ token: string, jti: string }>}
		 */
		issueToken: async ({ websiteId, productId, kind }) => {
			const { token, claims } = await issueToken({
				signer,
				issuer: url,
				websiteId,
				domain: site(websiteId).domain,
				productId,
				kind,
				now,
			});
			return { token, jti: claims.jti };
		},
		/** Revoke a token id (as regenerating does). @param {string} jti */
		revoke: (jti) => {
			revoked.push(jti);
		},
		/**
		 * Sign a launch. Merchant launches name the merchant's websites; admin launches register the admin.
		 * @param {{ productId: string, kind: 'merchant' | 'admin', websiteId?: string | null, role?: 'owner' | 'support',
		 *   adminId?: string, adminName?: string, sessionExpiresAt?: string }} input
		 * @returns {Promise<string>}
		 */
		issueLaunch: async ({
			productId,
			kind,
			websiteId = null,
			role = 'owner',
			adminId = 'adm_0123456789abcdefghjkmnpq',
			adminName = 'Ada Admin',
			sessionExpiresAt,
		}) => {
			const common = {
				signer,
				issuer: url,
				audience: productId,
				kind,
				sessionExpiresAt: sessionExpiresAt ?? new Date(now() + 8 * 60 * 60_000).toISOString(),
				branding: { name: 'Single Solution', accent: '#2563eb', logoUrl: null },
				support: { email: 'support@example.com', phone: '+1 555 0100' },
				now,
			};
			if (kind === 'admin') {
				admins.set(adminId, { name: adminName, role });
				return (await issueLaunch({ ...common, admin: { id: adminId, name: adminName, role, websiteId } })).token;
			}
			const own = site(/** @type {string} */ (websiteId));
			const list = [...websites.values()].filter((w) => w.merchantId === own.merchantId && w.status !== 'removed');
			const merchant = {
				id: own.merchantId,
				name: own.merchantName,
				websites: list.map((w) => ({ websiteId: w.websiteId, domain: w.domain })),
				websiteId: own.websiteId,
			};
			return (await issueLaunch({ ...common, merchant })).token;
		},
		/**
		 * Sign a notice body.
		 * @param {{ type: string, websiteId?: string, subject?: string }} notice
		 * @returns {Promise<{ headers: Record<string, string>, body: string }>}
		 */
		signNotice: async (notice) => {
			const body = JSON.stringify(notice);
			return {
				headers: {
					...(await signNotice({ signer, body, timestamp: Math.floor(now() / 1000) })),
					'content-type': 'application/json',
				},
				body,
			};
		},
		/**
		 * Sign and deliver a notice to a connected product.
		 * @param {string} productId
		 * @param {{ type: string, websiteId?: string, subject?: string }} notice
		 * @returns {Promise<Response>}
		 */
		sendNotice: async (productId, notice) => {
			const product = products.get(productId);
			if (!product?.handler) throw new Error(`product ${productId} is not connected`);
			const body = JSON.stringify(notice);
			const headers = {
				...(await signNotice({ signer, body, timestamp: Math.floor(now() / 1000) })),
				'content-type': 'application/json',
			};
			return product.handler(new Request(`${product.baseUrl}/.well-known/ss-events`, { method: 'POST', headers, body }));
		},
		/** What the products sent. */
		priceReports,
		featureReports,
		calls,
		/** @param {string} productId */
		prices: (productId) => products.get(productId)?.prices ?? null,
	});
};

/**
 * Accounts as products see it (PLAN 0.4.6, 0.4.11): receives activity copies at `POST /v1/activity-copies`, serves a
 * website's sign-in keys at `GET /v1/websites/:websiteId/keys` (`{ issuer, keys }`) and the users whose role grants a
 * permission at `GET /v1/users?permission=&blocked=false` (`setUsers`; staff alerts, PLAN 0.8.10 K6), signs sign-ins
 * (`signIn({ websiteId, sub, … })`, 15 minutes) and calls a product's data-rights routes with a pasted server token.
 * @param {{ url?: string, now?: () => number }} [options]
 */
export const createAccountsDouble = ({ url = 'https://accounts.test', now = Date.now } = {}) => {
	/** @type {Array<{ token: string, copy: import('@ss/contracts').ActivityCopy }>} */
	const copies = [];
	let failing = false;
	/** @type {Array<{ id: string, name?: string, email?: string, phone?: string, blocked?: boolean, permissions: string[] }>} */
	let users = [];
	/** Users reads (`permission` asked), for cache tests. @type {string[]} */
	const userReads = [];
	/** @type {Promise<{ privateJwk: Record<string, any>, signer: import('@ss/protocol').Signer }> | null} */
	let key = null;
	const keyOf = () => {
		key ??= generateSigningKey({ kid: 'accounts-double' }).then(({ privateJwk }) => ({
			privateJwk,
			signer: createSigner(privateJwk),
		}));
		return key;
	};

	/** @type {Handler} */
	const handle = async (request) => {
		const token = /^Bearer\s+(\S+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
		const path = new URL(request.url).pathname;
		if (request.method === 'GET' && /^\/v1\/websites\/[^/]+\/keys$/.test(path)) {
			if (failing) return fail(url, 'unavailable', 503);
			const { privateJwk } = await keyOf();
			return json(200, { issuer: url, keys: [{ ...toPublicJwk(privateJwk), alg: 'EdDSA', use: 'sig' }] });
		}
		if (request.method === 'GET' && path === '/v1/users') {
			if (!token) return fail(url, 'invalid_token', 401);
			if (failing) return fail(url, 'unavailable', 503);
			const query = new URL(request.url).searchParams;
			const permission = query.get('permission') ?? '';
			userReads.push(permission);
			const items = users.filter(
				(user) =>
					(permission === '' || user.permissions.includes(permission) || user.permissions.includes('*')) &&
					(query.get('blocked') !== 'false' || user.blocked !== true),
			);
			return json(200, { items, nextCursor: null, hasMore: false });
		}
		if (request.method !== 'POST' || path !== '/v1/activity-copies') return fail(url, 'not_found', 404);
		if (!token) return fail(url, 'invalid_token', 401);
		if (failing) return fail(url, 'unavailable', 503);
		const checked = validateActivityCopy(await request.json().catch(() => null));
		if (!checked.ok) return fail(url, 'validation_failed', 422);
		copies.push({ token, copy: checked.value });
		return json(201, { received: true });
	};

	/**
	 * @param {'export' | 'delete'} kind
	 * @returns {(input: { handler: Handler, baseUrl: string, token: string, user: { id?: string, email?: string, phone?: string } }) => Promise<{ status: number, body: any }>}
	 */
	const dataRights =
		(kind) =>
		async ({ handler, baseUrl, token, user }) => {
			const response = await handler(
				new Request(`${baseUrl}/v1/data-rights/${kind}`, {
					method: 'POST',
					headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
					body: JSON.stringify({ user }),
				}),
			);
			return { status: response.status, body: await response.json() };
		};

	/**
	 * A sign-in as Accounts issues it (EdDSA, `aud` = the website, 15 minutes unless `ttlSeconds`).
	 * @param {{ websiteId: string, sub: string, ttlSeconds?: number } & Record<string, unknown>} input
	 */
	const signIn = async ({ websiteId, sub, ttlSeconds = 900, ...extra }) => {
		const { privateJwk } = await keyOf();
		const iat = Math.floor(now() / 1000);
		/** @param {unknown} value */
		const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
		const input = `${b64({ alg: 'EdDSA', typ: 'JWT', kid: privateJwk.kid })}.${b64({ iss: url, aud: websiteId, sub, iat, exp: iat + ttlSeconds, ...extra })}`;
		const signature = cryptoSign(
			null,
			Buffer.from(input),
			createPrivateKey({ key: /** @type {import('node:crypto').JsonWebKey} */ ({ ...privateJwk }), format: 'jwk' }),
		);
		return `${input}.${signature.toString('base64url')}`;
	};

	return Object.freeze({
		url,
		handle,
		copies,
		signIn,
		/** @param {boolean} value answer 503 to copies while true */
		setFailing: (value) => {
			failing = value;
		},
		/**
		 * The users `GET /v1/users` answers (each with the permissions its role grants, `*` for all).
		 * @param {Array<{ id: string, name?: string, email?: string, phone?: string, blocked?: boolean, permissions: string[] }>} list
		 */
		setUsers: (list) => {
			users = list.map((user) => ({ ...user }));
		},
		userReads,
		exportUser: dataRights('export'),
		deleteUser: dataRights('delete'),
	});
};

/**
 * Notifications as products see it (PLAN 0.3, 0.8.10 K5, K6): `POST /v1/events` (an event to the merchant's webhook
 * URLs; a repeated `Idempotency-Key` answers 409) and `POST /v1/messages/<channel>` (a template to a recipient). It
 * keeps what it was sent; `setFailing(true)` answers 503.
 * @param {{ url?: string }} [options]
 */
export const createNotificationsDouble = ({ url = 'https://notifications.test' } = {}) => {
	/** @type {Array<{ token: string, key: string | null, body: any }>} */
	const events = [];
	/** @type {Array<{ token: string, channel: string, body: any }>} */
	const messages = [];
	const keys = new Set();
	let failing = false;

	/** @type {Handler} */
	const handle = async (request) => {
		const token = /^Bearer\s+(\S+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
		const path = new URL(request.url).pathname;
		if (request.method !== 'POST') return fail(url, 'not_found', 404);
		if (!token) return fail(url, 'invalid_token', 401);
		if (failing) return fail(url, 'unavailable', 503);
		const body = await request.json().catch(() => null);
		if (path === '/v1/events') {
			const key = request.headers.get('idempotency-key');
			if (key && keys.has(key)) return fail(url, 'duplicate_request', 409);
			if (key) keys.add(key);
			events.push({ token, key, body });
			return json(202, { queued: 1 });
		}
		const channel = /^\/v1\/messages\/([a-z-]+)$/.exec(path)?.[1];
		if (!channel) return fail(url, 'not_found', 404);
		messages.push({ token, channel, body });
		return json(202, { id: `msg_${messages.length}`, status: 'queued' });
	};

	return Object.freeze({
		url,
		handle,
		events,
		messages,
		/** @param {boolean} value answer 503 while true */
		setFailing: (value) => {
			failing = value;
		},
	});
};
