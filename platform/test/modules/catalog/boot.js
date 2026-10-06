/**
 * Test harness: a Portal with the catalog module (and fake neighbours) on MongoMemoryReplSet.
 * @module
 */
import { randomUUID } from 'node:crypto';
import { createMemoryReplayStore, consumeWith, createKeyResolver, signAssertion, verifyLaunch } from '@ss/protocol';
import { createPortal } from '../../../src/portal.js';
import { createCatalogModule } from '../../../src/modules/catalog/index.js';
import { PORTAL_URL, createClock, createTestLogger, testConfig } from '../../helpers.js';
import { fakeIntegration } from './fakes/modules.js';

/** @type {Promise<any> | null} */
let sharedConfig = null;
/** Databases whose indexes exist already. */
const indexed = new Set();
/** One config (same Portal keys) for every Portal in a test file. */
export const config = () => (sharedConfig ??= testConfig());

/**
 * @param {{ db: import('mongodb').Db, allowlist?: string[], resolve?: any, fetch?: any, modules?: any[],
 *   clock?: ReturnType<typeof createClock>, integration?: ReturnType<typeof fakeIntegration> | null }} options
 */
export const bootPortal = async ({
	db,
	allowlist = ['127.0.0.1', 'localhost'],
	resolve,
	fetch,
	modules = [],
	clock = createClock(Date.now()),
	integration = fakeIntegration(),
}) => {
	const { logger, entries } = createTestLogger();
	const portal = createPortal({
		config: await config(),
		db,
		modules: [
			createCatalogModule({ allowHosts: allowlist, ...(resolve ? { resolve } : {}), ...(fetch ? { fetch } : {}) }),
			...(integration ? [integration.module] : []),
			...modules,
		],
		logger,
		now: clock.now,
	});
	if (indexed.has(db.databaseName)) {
		// reuse the indexed database of an earlier test: clear documents, keep indexes (ensureIndexes is slow)
		for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) await db.collection(name).deleteMany({});
	} else {
		await portal.ensureIndexes();
		indexed.add(db.databaseName);
	}

	/**
	 * @param {{ kind?: 'staff' | 'merchant', roles?: string[], subject?: string, merchantId?: string, via?: any }} [who]
	 */
	const session = async ({ kind = 'staff', roles = ['admin'], subject = 'stf_alice', merchantId, via } = {}) => {
		const { token } = await portal.shared.sessions.create({
			kind,
			subject,
			roles,
			mfa: true,
			...(merchantId ? { merchantId } : {}),
			...(via ? { via } : {}),
		});
		return `${portal.shared.cookies.name(kind)}=${token}`;
	};

	/**
	 * @param {string} method
	 * @param {string} path
	 * @param {{ body?: unknown, cookie?: string, bearer?: string, headers?: Record<string, string>, idempotencyKey?: string | null }} [init]
	 */
	const call = async (method, path, { body, cookie, bearer, headers = {}, idempotencyKey } = {}) => {
		const response = await portal.handle(
			new Request(`${PORTAL_URL}${path}`, {
				method,
				headers: {
					...(body === undefined ? {} : { 'content-type': 'application/json' }),
					...(cookie ? { cookie, origin: PORTAL_URL, 'sec-fetch-site': 'same-origin' } : {}),
					...(bearer ? { authorization: bearer.startsWith('Bearer ') ? bearer : `Bearer ${bearer}` } : {}),
					...(method === 'POST' && idempotencyKey !== null ? { 'idempotency-key': idempotencyKey ?? randomUUID() } : {}),
					...headers,
				},
				...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
			}),
		);
		const text = await response.text();
		return { status: response.status, headers: response.headers, json: text ? JSON.parse(text) : null };
	};

	/** @param {string} method @param {string} path @param {{ body?: unknown, roles?: string[] }} [init] */
	const staff = async (method, path, { body, roles } = {}) => call(method, path, { body, cookie: await session({ roles }) });

	/**
	 * Product client assertion.
	 * @param {any} signer
	 * @param {string} appId
	 */
	const assertion = (signer, appId) => signAssertion({ signer, appId, audience: PORTAL_URL, now: clock.now });

	/** Verify a launch token as the product would. @param {string} token @param {string} appId */
	const verify = (token, appId) =>
		verifyLaunch({
			token,
			keyResolver: createKeyResolver({ jwks: portal.shared.keys.jwks() }),
			audience: appId,
			issuer: PORTAL_URL,
			consume: consumeWith(createMemoryReplayStore({ now: clock.now })),
			now: clock.now,
		});

	/**
	 * Add a product the way staff do: Admin → Apps → Add product with its URL and connect secret. Answers like the old
	 * registration (201 with the app view and the product kid).
	 * @param {Awaited<ReturnType<typeof import('./fakes/product.js').startFakeProduct>>} p
	 */
	const register = async (p) => {
		const res = await staff('POST', '/v1/admin/apps/connect', { body: { url: p.url, secret: p.secret } });
		if (res.status !== 201) return res;
		const app = await staff('GET', `/v1/admin/apps/${res.json.appId}`);
		return { status: 201, headers: res.headers, json: { ...app.json, kid: p.publicJwk.kid } };
	};

	return {
		portal,
		clock,
		entries,
		integration,
		call,
		register,
		staff,
		session,
		assertion,
		verify,
		service: () =>
			/** @type {import('../../../src/modules/catalog/service.js').CatalogService} */ (portal.modules.service('catalog')),
		jwks: async () => portal.shared.keys.jwks(),
		audit: (/** @type {string} */ appId) =>
			db.collection('platform_audit').find({ 'target.id': appId }).sort({ $natural: 1 }).toArray(),
	};
};

/**
 * @param {{ status: number, json: any }} res
 * @param {number} status
 * @param {string} [code]
 */
export const problemOf = (res, status, code) => {
	if (res.status !== status || (code && !String(res.json?.type).endsWith(`/${code}`)))
		throw new Error(`expected ${status} ${code ?? ''}, got ${res.status} ${JSON.stringify(res.json)}`);
	return res.json;
};
