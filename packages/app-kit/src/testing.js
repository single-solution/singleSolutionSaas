/**
 * `@ss/app-kit/testing` — test doubles for products built on the kit:
 *
 * - `createFakePortal()`: the Portal side of the Product ↔ Portal contract (PLAN 0.4.12): connect, price and feature
 *   reports, status (settable), a website's settings (`setWebsiteSettings`, served at `GET /v1/product/websites/:id/settings`),
 *   websites, revocations, directory and launch consume, plus helpers that sign tokens,
 *   launches, notices and Portal calls (`signCall`, `callAsPortal`: `GET /v1/blueprint`, `POST /v1/blueprint/features`);
 * - `createAccountsDouble()`: Accounts as products see it: it receives activity copies, serves sign-in keys and the
 *   users with a permission (staff alerts), and calls a product's data-rights routes with a pasted server token;
 * - `createNetwork(handlers)`: routes `fetch` and outbound calls (`outboundSend`) to in-process handlers by origin;
 * - `productKeyOf({ store, encryptionKey })`: the product's own private key from its store (kept sealed, K-21), for
 *   tests that sign as the product;
 * - `apiChecker(apiJson)`: checks every answer a test sees against the product's `schemas/api.json` and the kit's own
 *   routes (`assert({ method, path, status, body })` throws on a mismatch), so the API descriptions cannot drift;
 * - `createMemoryStore()`.
 * @module
 */
import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import {
	databaseNameFor,
	validateActivityCopy,
	validateConnectionHealth,
	validateFeatureReport,
	validatePriceReport,
	validateWebsiteSettings,
} from '@ss/contracts';
import { emptyWebsiteSettings } from '@ss/contracts/website-settings';
import { netError } from '@ss/net';
import {
	NOTICE_PATH,
	createConnectRequest,
	createJwks,
	createKeyResolver,
	createSigner,
	generateSigningKey,
	issueLaunch,
	issueToken,
	signNotice,
	signPortalCall,
	toPublicJwk,
	verifyAssertion,
	verifyConnectResponse,
} from '@ss/protocol';
import { createMemoryReplayStore } from '@ss/protocol/testing';
import { KIT_API, apiEntries, checkApiDescription, parseRouteKey, sharedSchemas } from './api.js';
import { validateValue } from './api-schema.js';
import { PRODUCT_KEY_AAD } from './connection.js';
import { verifyIdentityToken } from './identity.js';
import { createSealer, openKey } from './sealing.js';
import { createMemoryStore } from './stores/memory.js';

export { createMemoryStore };

/**
 * The product's own private key as its product database keeps it (sealed with `ENCRYPTION_KEY`, K-21), for tests that
 * sign as the product; null before the first connect.
 * @param {{ store: import('./stores/types.js').Store, encryptionKey: string }} input
 * @returns {Promise<Record<string, any> | null>}
 */
export const productKeyOf = async ({ store, encryptionKey }) => {
	const doc = await store.get('state', 'productKey');
	return doc ? openKey(createSealer({ encryptionKey }), doc, PRODUCT_KEY_AAD) : null;
};

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
 * @property {import('@ss/contracts').WebsiteSettings | null} settings the website settings the Portal holds (null: none saved)
 * @property {{ version: number, database: string | null, storage: Record<string, unknown> | null, ai: Record<string, unknown> | null, dbNames: Record<string, string>,
 *   links: Array<{ caller: string, callee: string, scopes: string[], token: string, jti: string, on: boolean }> }} connections what
 *   the Portal holds of the website's connections and links (the one counter `version`)
 * @property {Record<string, Record<string, { version: number, ok: boolean, message?: string }>>} health what each product
 *   reported for each delivered connection
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
 * The website-settings sections a business makes, from the facts a test used to serve as business.json (`name`, `email`,
 * `phone`, `address` as text, `country`, `timeZone`, `currency`, `currencies`, `language`, `logo`): the Business, Brand
 * and Region sections to save in the Portal (`saveWebsiteSettings`). Facts left out stay empty.
 * @param {string} websiteId
 * @param {{ name?: string, email?: string | null, phone?: string | null, address?: string | null, country?: string | null,
 *   timeZone?: string | null, currency?: string | null, currencies?: readonly string[], language?: string | null,
 *   logo?: string | null }} info
 * @returns {Pick<import('@ss/contracts').WebsiteSettings, 'business' | 'brand' | 'region'>}
 */
export const portalSectionsOf = (websiteId, info) => {
	const empty = emptyWebsiteSettings(websiteId);
	const currency = (info.currency ?? '').toUpperCase();
	return {
		business: {
			...empty.business,
			name: info.name ?? '',
			email: info.email ?? '',
			phone: info.phone ?? '',
			address: { ...empty.business.address, line1: info.address ?? '' },
		},
		brand: { ...empty.brand, files: { ...empty.brand.files, logo: info.logo ?? '' } },
		region: {
			...empty.region,
			country: (info.country ?? '').toUpperCase(),
			timeZone: info.timeZone ?? '',
			currency,
			currencies: (info.currencies ?? (currency ? [currency] : [])).map((code) => code.toUpperCase()),
			language: info.language ?? '',
		},
	};
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
	/** The second each notice (to a product, by its body) was last signed for. @type {Map<string, number>} */
	const noticeStamps = new Map();
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
		settingsVersion: site.settings?.version ?? 0,
		connectionsVersion: site.connections.version,
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
			if (method === 'GET' && parts[4] === 'settings') {
				const since = Number(searchParams.get('since') ?? '0');
				const version = site.settings?.version ?? 0;
				return json(200, { version, settings: site.settings && version > since ? site.settings : null });
			}
			if (method === 'GET' && parts[4] === 'connections') {
				const needs = product.manifest.needs ?? { database: true, storage: 'none' };
				const held = site.connections;
				return json(200, {
					version: held.version,
					database:
						held.database && needs.database
							? { uri: held.database, dbName: held.dbNames[productId] ?? databaseNameFor(productId) }
							: null,
					storage: held.storage && needs.storage !== 'none' ? held.storage : null,
					shared: { ai: held.ai && /** @type {{ ai?: boolean }} */ (needs).ai === true ? held.ai : null },
					links: {
						out: held.links
							.filter((link) => link.caller === productId && link.on && link.scopes.length > 0)
							.map((link) => ({ to: link.callee, token: link.token, scopes: link.scopes })),
						in: held.links
							.filter((link) => link.callee === productId && link.on && link.scopes.length > 0)
							.map((link) => ({ from: link.caller, scopes: link.scopes })),
					},
				});
			}
			if (method === 'PUT' && parts[4] === 'connections' && parts[6] === 'health') {
				const checked = validateConnectionHealth(body);
				if (!checked.ok || (parts[5] !== 'database' && parts[5] !== 'storage' && parts[5] !== 'ai'))
					return fail(url, 'validation_failed', 422);
				site.health[productId] = { ...site.health[productId], [parts[5]]: checked.value };
				return json(200, { accepted: true });
			}
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
		if (method === 'GET' && pathname === '/v1/product/directory')
			return json(200, {
				items: [...products.values()]
					.map(({ productId, baseUrl, manifest }) => ({ productId, name: String(manifest.name), baseUrl }))
					.sort((a, b) => (a.productId < b.productId ? -1 : 1)),
			});
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

	const fakePortal = Object.freeze({
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
		/**
		 * Make another product known to the directory (its name defaults to its id).
		 * @param {{ productId: string, baseUrl: string, name?: string }} input
		 */
		addProduct: ({ productId, baseUrl, name = productId }) => {
			products.set(productId, {
				productId,
				baseUrl,
				publicJwk: null,
				manifest: { name },
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
				settings: null,
				connections: { version: 0, database: null, storage: null, ai: null, dbNames: {}, links: [] },
				health: {},
			});
			return id;
		},
		/** @param {string} websiteId @param {Partial<Pick<FakeWebsite, 'status' | 'graceEndsAt' | 'todayMillicredits'>>} patch */
		setStatus: (websiteId, patch) => {
			Object.assign(site(websiteId), patch);
		},
		/**
		 * Save website settings as the Portal does: the sections given replace the held ones, the version rises by one
		 * and the whole document must be valid. Products learn it from the status (`settingsVersion`) and a notice.
		 * @param {string} websiteId
		 * @param {Partial<Pick<import('@ss/contracts').WebsiteSettings, 'business' | 'brand' | 'region' | 'pages' | 'team'>>} sections
		 * @returns {number} the new version
		 */
		setWebsiteSettings: (websiteId, sections) => {
			const found = site(websiteId);
			const current = found.settings ?? emptyWebsiteSettings(websiteId);
			const next = {
				...current,
				...sections,
				version: current.version + 1,
				updatedAt: new Date(now()).toISOString(),
			};
			const checked = validateWebsiteSettings(next);
			if (!checked.ok) throw new Error(`invalid website settings: ${JSON.stringify(checked.problems)}`);
			found.settings = next;
			return next.version;
		},
		/**
		 * The merchant saves website settings in the Portal and every connected product is told (`website.settings_changed`),
		 * as `setWebsiteSettings` and the notice the Portal queues after a save; the products fetch them right after.
		 * @param {string} websiteId
		 * @param {Parameters<typeof fakePortal.setWebsiteSettings>[1]} sections
		 * @returns {Promise<number>} the new version
		 */
		saveWebsiteSettings: async (websiteId, sections) => {
			const version = fakePortal.setWebsiteSettings(websiteId, sections);
			for (const productId of products.keys())
				if (products.get(productId)?.handler)
					await fakePortal.sendNotice(productId, { type: 'website.settings_changed', websiteId, what: 'settings' });
			return version;
		},
		/**
		 * The merchant enters the website's connections once in the Portal (the database, the storage and the AI key, as the
		 * Portal keeps them) and every connected product is told (`website.settings_changed`, `what: connections`); the products fetch
		 * them right after. `undefined` leaves a connection as it is, `null` removes it.
		 * @param {string} websiteId
		 * @param {{ database?: string | null, storage?: Record<string, unknown> | null, ai?: Record<string, unknown> | null, dbNames?: Record<string, string> }} change
		 * @param {{ notify?: boolean }} [options] `notify: false` tells no product (a lost notice: the status catches up)
		 * @returns {Promise<number>} the new version
		 */
		saveConnections: async (websiteId, { database, storage, ai, dbNames }, { notify = true } = {}) => {
			const held = site(websiteId).connections;
			if (database !== undefined) held.database = database;
			if (storage !== undefined) held.storage = storage;
			if (ai !== undefined) held.ai = ai;
			if (dbNames !== undefined) held.dbNames = { ...dbNames };
			held.version += 1;
			if (notify) await fakePortal.tell(websiteId, 'connections');
			return held.version;
		},
		/**
		 * The Portal links two products of a website (a real link token, signed like the Portal's) with the scopes it grants,
		 * and tells the products. A link made again gets a new token and the old one is revoked.
		 * @param {string} websiteId @param {string} caller @param {string} callee @param {string[]} scopes
		 * @returns {Promise<{ token: string, jti: string }>}
		 */
		link: async (websiteId, caller, callee, scopes) => {
			const held = site(websiteId).connections;
			const old = held.links.find((link) => link.caller === caller && link.callee === callee);
			if (old) revoked.push(old.jti);
			held.links = held.links.filter((link) => link !== old);
			const { token, claims } = await issueToken({
				signer,
				issuer: url,
				websiteId,
				domain: site(websiteId).domain,
				productId: callee,
				kind: 'link',
				caller,
				now,
			});
			held.links.push({ caller, callee, scopes: [...scopes], token, jti: claims.jti, on: true });
			held.version += 1;
			await fakePortal.tell(websiteId, 'links');
			if (old && products.get(callee)?.handler) await fakePortal.sendNotice(callee, { type: 'token.revoked', websiteId });
			return { token, jti: claims.jti };
		},
		/**
		 * The Portal ends a link (a product left the website, or it was switched off): its token is revoked at once.
		 * @param {string} websiteId @param {string} caller @param {string} callee
		 */
		unlink: async (websiteId, caller, callee) => {
			const held = site(websiteId).connections;
			const old = held.links.find((link) => link.caller === caller && link.callee === callee);
			if (!old) return;
			revoked.push(old.jti);
			held.links = held.links.filter((link) => link !== old);
			held.version += 1;
			await fakePortal.tell(websiteId, 'links');
			if (products.get(callee)?.handler) await fakePortal.sendNotice(callee, { type: 'token.revoked', websiteId });
		},
		/**
		 * Tell every connected product that the connections or links changed.
		 * @param {string} websiteId @param {'connections' | 'links'} what
		 */
		tell: async (websiteId, what) => {
			for (const productId of products.keys())
				if (products.get(productId)?.handler)
					await fakePortal.sendNotice(productId, { type: 'website.settings_changed', websiteId, what });
		},
		/** What a product reported for a delivered connection. @param {string} websiteId @param {string} productId @param {'database' | 'storage' | 'ai'} name */
		health: (websiteId, productId, name) => site(websiteId).health[productId]?.[name] ?? null,
		/**
		 * Add a removed product to a website again, as the Portal does (PLAN 0.4.12 row 4): active, every feature off and
		 * `featuresVersion` one higher.
		 * @param {string} websiteId @param {string} productId
		 */
		addAgain: (websiteId, productId) => {
			const added = site(websiteId);
			added.status = 'active';
			added.features[productId] = { version: (added.features[productId]?.version ?? 0) + 1, on: [] };
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
				support: { channels: [{ type: /** @type {const} */ ('email'), label: 'Email', url: 'mailto:support@example.com' }] },
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
		 * @param {{ type: string, websiteId?: string, subject?: string, what?: string }} notice
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
		 * @param {{ type: string, websiteId?: string, subject?: string, what?: string }} notice
		 * @returns {Promise<Response>}
		 */
		sendNotice: async (productId, notice) => {
			const product = products.get(productId);
			if (!product?.handler) throw new Error(`product ${productId} is not connected`);
			const body = JSON.stringify(notice);
			// the same notice twice in one second would be taken for a replay: each carries a later second than the last
			const stamp = Math.max(Math.floor(now() / 1000), (noticeStamps.get(`${productId}|${body}`) ?? 0) + 1);
			noticeStamps.set(`${productId}|${body}`, stamp);
			const headers = {
				...(await signNotice({ signer, body, timestamp: stamp })),
				'content-type': 'application/json',
			};
			return product.handler(new Request(`${product.baseUrl}${NOTICE_PATH}`, { method: 'POST', headers, body }));
		},
		/**
		 * Sign a Portal call (`auth: 'portal'` routes such as `GET /v1/blueprint?websiteId=`) with the Portal key.
		 * @param {string} productId the product it is for
		 * @param {string} method
		 * @param {string} target the path and query
		 * @param {string} [body] the raw body
		 * @returns {Promise<Record<string, string>>} the headers
		 */
		signCall: (productId, method, target, body = '') =>
			signPortalCall({ signer, audience: productId, method, target, body, timestamp: Math.floor(now() / 1000) }),
		/**
		 * Make a signed Portal call to a connected product.
		 * @param {string} productId
		 * @param {string} method
		 * @param {string} target the path and query
		 * @param {unknown} [body] sent as JSON
		 * @returns {Promise<Response>}
		 */
		callAsPortal: async (productId, method, target, body) => {
			const product = products.get(productId);
			if (!product?.handler) throw new Error(`product ${productId} is not connected`);
			const text = body === undefined ? '' : JSON.stringify(body);
			const headers = await signPortalCall({
				signer,
				audience: productId,
				method,
				target,
				body: text,
				timestamp: Math.floor(now() / 1000),
			});
			return product.handler(
				new Request(`${product.baseUrl}${target}`, {
					method,
					headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
					...(body === undefined ? {} : { body: text }),
				}),
			);
		},
		/** What the products sent. */
		priceReports,
		featureReports,
		calls,
		/** @param {string} productId */
		prices: (productId) => products.get(productId)?.prices ?? null,
	});
	return fakePortal;
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

	/**
	 * The `SS-Sign-In` header of a staff member for a call from the merchant's server (tests): by default an Owner
	 * (`permissions: ['*']`). The acting user the tests used to name with `SS-Actor-*` headers
	 * (`SS-Actor-Id`, `-Name` (percent-encoded), `-Role`, `-Email`) becomes the sign-in's person, so those tests keep
	 * their meaning; the actor headers themselves are dropped (the kit ignores them).
	 * @param {{ websiteId: string, headers?: Record<string, string>, staff?: { id?: string, name?: string, role?: string,
	 *   email?: string, permissions?: string[] } & Record<string, unknown> }} input
	 * @returns {Promise<Record<string, string>>} the given headers with `ss-sign-in` (a header already given stays)
	 */
	const staffHeaders = async ({ websiteId, headers = {}, staff = {} }) => {
		const { 'ss-actor-id': id, 'ss-actor-name': name, 'ss-actor-role': role, 'ss-actor-email': email } = headers;
		const rest = withoutActor(headers);
		if (rest['ss-sign-in'] !== undefined) return rest;
		const decode = (/** @type {string | undefined} */ value) => (value === undefined ? undefined : decodeURIComponent(value));
		const { id: staffId, permissions = ['*'], ...more } = staff;
		const sub = staffId ?? id ?? 'usr_test_staff';
		const claims = {
			name: decode(name) ?? 'Test Staff',
			// (a person named by actor headers has the role they name, if any; otherwise an Owner is signed in)
			...(decode(role) !== undefined || id === undefined ? { role: decode(role) ?? 'owner' } : {}),
			email: email ?? 'staff@shop.example.com',
			permissions,
			...more,
		};
		return { ...rest, 'ss-sign-in': await signIn({ websiteId, sub, ...claims }) };
	};

	/**
	 * A product's own check of this double's sign-ins (`ownSignIns` of `createProduct`), for systems that run no Accounts:
	 * signed by this double's key, made for the website, not expired; the person and the permissions of their role are
	 * what the sign-in says.
	 * @param {{ websiteId: string, token: string }} input
	 * @returns {Promise<import('./identity.js').AccountsSignInResult>}
	 */
	const ownSignIns = async ({ websiteId, token }) => {
		const { privateJwk } = await keyOf();
		const checked = verifyIdentityToken(
			token,
			{ issuer: url, jwks: [{ ...toPublicJwk(privateJwk), alg: 'EdDSA', use: 'sig' }], audience: websiteId },
			{ now },
		);
		if (!checked.ok) return { ok: false, code: checked.code };
		const { claims } = checked.identity;
		return {
			ok: true,
			claims,
			user: {
				id: checked.identity.subject,
				...(checked.identity.email === undefined ? {} : { email: checked.identity.email }),
				...(typeof claims.name === 'string' ? { name: claims.name } : {}),
				...(typeof claims.role === 'string' ? { role: claims.role } : {}),
				...(Array.isArray(claims.permissions)
					? { permissions: claims.permissions.filter((p) => typeof p === 'string') }
					: {}),
			},
		};
	};

	return Object.freeze({
		url,
		handle,
		copies,
		signIn,
		staffHeaders,
		ownSignIns,
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
 * Headers without the old `SS-Actor-*` ones (the kit ignores them; tests that used them name the person by `staff`).
 * @param {Record<string, string>} headers
 * @returns {Record<string, string>}
 */
const withoutActor = (headers) => Object.fromEntries(Object.entries(headers).filter(([name]) => !name.startsWith('ss-actor-')));

/**
 * The staff sign-in of a test product's calls from the website's server (the same everywhere): the first use pastes the
 * website's Accounts token (`paste()`, the product's own way, for example through its dashboard), then each call gets
 * `ss-sign-in` of a staff member (an Owner unless `staff` says who; the old `ss-actor-*` headers name the person, see
 * `createAccountsDouble().staffHeaders`).
 * @param {{ accounts: ReturnType<typeof createAccountsDouble>, websiteId: string, paste: () => Promise<unknown> }} input
 * @returns {(input?: { headers?: Record<string, string>, staff?: Record<string, any> }) => Promise<Record<string, string>>}
 */
export const staffCaller = ({ accounts, websiteId, paste }) => {
	/** @type {Promise<boolean> | null} */
	let pasted = null;
	return async ({ headers = {}, staff } = {}) => {
		// (a Portal that cannot be reached cannot open the dashboard: the call goes without a sign-in then, and pastes next time)
		pasted ??= paste().then(
			() => true,
			() => false,
		);
		if (!(await pasted)) {
			pasted = null;
			return withoutActor(headers);
		}
		return accounts.staffHeaders({ websiteId, headers, ...(staff ? { staff } : {}) });
	};
};

/**
 * What a merchant does in the Portal for a test product, as the product then gets it: the one database of the website
 * (the product's own database is the one the connection string names, so a test can read it), the storage, the website's
 * AI provider key (when the manifest says `needs.ai`), and the link
 * to another product (with every scope the product's manifest needs of it). The Portal tells the product, which fetches
 * it right after answering; this waits until it holds the value. Anything else (a provider key of the product's own) is
 * left to the caller (`null`).
 * @param {{ portal: Awaited<ReturnType<typeof createFakePortal>>, websiteId: string, manifest: Record<string, any>,
 *   product: { connections: { value: (websiteId: string, name: string) => Promise<unknown> } },
 *   drain?: () => Promise<unknown>, view?: (name: string) => Promise<unknown> }} input `drain`: runs the work the product did
 *   after answering (the fetch); `view`: how the product shows a connection (its dashboard)
 * @returns {((name: string, value: unknown) => Promise<unknown | null>) & { tokens: Map<string, string>,
 *   disconnect: (name: string) => Promise<void> }} the link keys given so far are in `tokens` (by the other product's id);
 *   `disconnect` ends a link or removes the storage in the Portal
 */
export const portalConnector = ({ portal, websiteId, manifest, product, drain, view }) => {
	/** @type {Map<string, string[]>} */
	const scopes = new Map();
	for (const need of manifest.links?.needs ?? [])
		scopes.set(need.product, [...new Set([...(scopes.get(need.product) ?? []), ...need.scopes])]);
	/**
	 * @param {() => Promise<boolean>} held
	 */
	const until = async (held) => {
		for (let waited = 0; waited < 5000; waited += 5) {
			await drain?.();
			if (await held()) return;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		throw new Error('the product did not take what the Portal delivered');
	};
	/** @type {Map<string, string>} */
	const tokens = new Map();
	/** @type {(name: string, value: unknown) => Promise<unknown | null>} */
	const connect = async (name, value) => {
		if (name === 'database') {
			const uri = String(value);
			await portal.saveConnections(websiteId, { database: uri, dbNames: { [manifest.id]: new URL(uri).pathname.slice(1) } });
			await until(async () => (await product.connections.value(websiteId, 'database')) === uri);
		} else if (name === 'storage') {
			await portal.saveConnections(websiteId, { storage: /** @type {Record<string, unknown>} */ (value) });
			await until(async () => JSON.stringify(await product.connections.value(websiteId, 'storage')) === JSON.stringify(value));
		} else if (name === 'ai' && manifest.needs?.ai === true) {
			await portal.saveConnections(websiteId, { ai: /** @type {Record<string, unknown>} */ (value) });
			await until(async () => JSON.stringify(await product.connections.value(websiteId, 'ai')) === JSON.stringify(value));
		} else if (scopes.has(name)) {
			const { token } = await portal.link(websiteId, manifest.id, name, /** @type {string[]} */ (scopes.get(name)));
			tokens.set(name, token);
			await until(async () => (await product.connections.value(websiteId, `link_${name.replace(/-/g, '_')}`)) === token);
			return view ? view(`link_${name.replace(/-/g, '_')}`) : { name, set: true };
		} else return null;
		return view ? view(name) : { name, set: true };
	};
	return Object.assign(connect, {
		tokens,
		/** @param {string} name */
		disconnect: async (name) => {
			if (name === 'storage') {
				await portal.saveConnections(websiteId, { storage: null });
				await until(async () => (await product.connections.value(websiteId, 'storage')) === null);
			} else if (name === 'ai' && manifest.needs?.ai === true) {
				await portal.saveConnections(websiteId, { ai: null });
				await until(async () => (await product.connections.value(websiteId, 'ai')) === null);
			} else if (scopes.has(name)) {
				await portal.unlink(websiteId, manifest.id, name);
				tokens.delete(name);
				await until(async () => (await product.connections.value(websiteId, `link_${name.replace(/-/g, '_')}`)) === null);
			}
		},
	});
};

/** @typedef {import('./api.js').ApiDescription} ApiDescription */
/** @typedef {import('./api.js').ApiEntry} ApiEntry */

/**
 * One description from the kit's and a product's (the product's shared schemas next to the kit's).
 * @param {ApiDescription} kit
 * @param {ApiDescription} api
 * @returns {ApiDescription}
 */
const mergeApi = (kit, api) => ({
	...Object.fromEntries(apiEntries(kit)),
	...Object.fromEntries(apiEntries(api)),
	$schemas: { ...sharedSchemas(kit), ...sharedSchemas(api) },
});

/**
 * Checks answers against an API description, for a product's tests: hand it every answer the tests see. Routes the
 * description does not name (pages, the dashboard API) and answers other than 2xx are not checked.
 *
 *   const api = apiChecker(apiJson); // schemas/api.json, plus the kit's routes
 *   api.assert({ method: 'GET', path: '/v1/payments/pay_…', status: 200, body }); // throws on a mismatch
 * @param {unknown} api the product's description (`schemas/api.json`)
 * @param {{ kit?: boolean }} [options] `kit: false` leaves out the kit's own routes
 */
export const apiChecker = (api, { kit = true } = {}) => {
	const base = kit ? sharedSchemas(KIT_API) : {};
	const invalid = checkApiDescription(api, { schemas: base });
	if (invalid.length > 0)
		throw new TypeError(
			`the API description is invalid:\n${invalid.map((problem) => `${problem.pointer}: ${problem.message}`).join('\n')}`,
		);
	const description = kit ? mergeApi(KIT_API, /** @type {ApiDescription} */ (api)) : /** @type {ApiDescription} */ (api);
	const schemas = sharedSchemas(description);
	const routes = apiEntries(description).map(([key, entry]) => {
		const route = /** @type {{ method: string, path: string }} */ (parseRouteKey(key));
		const segments = route.path.split('/').filter(Boolean);
		return {
			...route,
			segments,
			literals: segments.filter((segment) => !segment.startsWith(':')).length,
			entry: /** @type {ApiEntry} */ (entry),
		};
	});

	/**
	 * The described route of a request, or null (literal segments win over parameters).
	 * @param {string} method
	 * @param {string} path a path or an address (the query is ignored)
	 */
	const routeOf = (method, path) => {
		const parts = new URL(path, 'http://localhost').pathname.split('/').filter(Boolean);
		const found = routes
			.filter(
				(route) =>
					route.method === method.toUpperCase() &&
					route.segments.length === parts.length &&
					route.segments.every((segment, index) => segment.startsWith(':') || segment === parts[index]),
			)
			.sort((a, b) => b.literals - a.literals);
		return found[0] ?? null;
	};

	/**
	 * What is wrong with an answer (an empty list when it fits, or when nothing describes it).
	 * @param {{ method: string, path: string, status: number, body: unknown }} answer `body`: the parsed JSON, or
	 *   null/undefined when the answer had none
	 * @returns {string[]}
	 */
	const check = ({ method, path, status, body }) => {
		const route = routeOf(method, path);
		if (!route || status < 200 || status > 299) return [];
		const name = `${route.method} ${route.path} (${status})`;
		const expected = route.entry.status ?? 200;
		/** @type {string[]} */
		const out = [];
		if (status !== expected) out.push(`${name}: answered ${status}, described ${expected}`);
		const has = body !== null && body !== undefined;
		if (route.entry.response === undefined) {
			if (has) out.push(`${name}: answered a JSON body, but the description has no response`);
			return out;
		}
		// a JSON `null` is an answer when the description allows it (e.g. "no notice right now")
		if (body === null && validateValue(route.entry.response, null, { schemas }).length === 0) return out;
		if (!has) return [...out, `${name}: answered no JSON body, but the description has a response`];
		for (const problem of validateValue(route.entry.response, body, { schemas }))
			out.push(`${name}: ${problem.path || '(the body)'} ${problem.message}`);
		return out;
	};

	return Object.freeze({
		check,
		/**
		 * Throw when an answer does not fit its description (for a test helper's `call()`).
		 * @param {Parameters<typeof check>[0]} answer
		 */
		assert: (answer) => {
			const problems = check(answer);
			if (problems.length > 0) throw new Error(`the answer does not fit schemas/api.json:\n${problems.join('\n')}`);
		},
		/** The described route of a request, or null. @param {string} method @param {string} path */
		described: (method, path) => {
			const route = routeOf(method, path);
			return route ? `${route.method} ${route.path}` : null;
		},
	});
};
