import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createJwks, createSigner, generateSigningKey, signAssertion } from '@ss/protocol';
import { closeMongoClients } from '../../../src/infra/db.js';
import { runInRequestScope } from '../../../src/infra/request-scope.js';
import { createPortal } from '../../../src/portal.js';
import { createConnectorsModule } from '../../../src/modules/connectors/index.js';
import { MERCHANT, MERCHANT_2, PORTAL_URL, createClock, createTestLogger, startMongo, testConfig, b64 } from '../../helpers.js';
import { fakeModules } from './fakes/modules.js';
import { startFakeApi, startFakeS3 } from './fakes/servers.js';

const SAME_ORIGIN = { origin: PORTAL_URL, 'sec-fetch-site': 'same-origin' };
const WEB_A = 'web_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const WEB_B = 'web_bbbbbbbbbbbbbbbbbbbbbbbbbb';
const WEB_C = 'web_cccccccccccccccccccccccccc'; // merchant 2
const APP = 'app_chat';
const APP_OTHER = 'app_other';

const AI_KEY = 'test-ai-key-Qz7vT1mXc9Lr2Wd8Kp4Yh6Ns3Bf5Ge0Jt';
const AI_KEY_2 = 'test-ai-key-Hn5Rw2Ux8Ze4Qa7Vm1Tc3Yk9Lp6Sb0Dg';
const S3_SECRET = 'wJ9rXuTn/Fe2MkKd7Mz4BpQx/Rf8CiYu3Ws6Lq';
const S3_KEY_ID = 'AKIAEXAMPLEACCESSKEY';
const PAY_SECRET = 'test-pay-secret-51Hx7Qp2Vw9Lm4Tz8Nc6Rb3Ks5Yd1Ef';
const DB_PASSWORD = 'Zt8Qm3Wv6Xp1Ry4Lk7Nc2';
const SECRETS = [AI_KEY, AI_KEY_2, S3_SECRET, PAY_SECRET, DB_PASSWORD];

/** @type {Awaited<ReturnType<typeof startMongo>>} */
let mongo;
/** @type {Awaited<ReturnType<typeof startFakeApi>>} */
let ai;
/** @type {Awaited<ReturnType<typeof startFakeS3>>} */
let s3;
/** @type {string} */
let clientDbUri;
beforeAll(async () => {
	mongo = await startMongo();
	ai = await startFakeApi({ header: 'authorization', value: `Bearer ${AI_KEY}` });
	s3 = await startFakeS3({ accessKeyId: S3_KEY_ID });
	clientDbUri = `mongodb://${new URL(mongo.uri.replace('mongodb://', 'http://')).host}/client_shop?replicaSet=testset`;
}, 120_000);
afterAll(async () => {
	await ai?.close();
	await s3?.close();
	await closeMongoClients();
	await mongo?.stop();
}, 60_000);

let keys = 0;

/** Every non-resolve response body, scanned for secrets at the end. */
/** @type {string[]} */
const bodies = [];

/**
 * @param {string} dbName
 * @param {{ env?: Record<string, string> }} [options]
 */
const boot = async (dbName, { env = {} } = {}) => {
	const clock = createClock(Date.now());
	const state = {
		websites: new Map([
			[WEB_A, { websiteId: WEB_A, merchantId: MERCHANT }],
			[WEB_B, { websiteId: WEB_B, merchantId: MERCHANT }],
			[WEB_C, { websiteId: WEB_C, merchantId: MERCHANT_2 }],
		]),
		/** @type {Map<string, any[]>} */
		subscriptions: new Map(),
		/** @type {Map<string, unknown>} */
		manifests: new Map([
			[
				APP,
				{
					slug: 'chat',
					requires: { resources: ['database'] },
					elements: [{ key: 'bot', requires: { resources: ['ai', 'storage'] } }],
				},
			],
			[APP_OTHER, { slug: 'other', elements: [{ key: 'x' }] }],
		]),
		/** @type {Map<string, any>} */
		appJwks: new Map(),
		/** @type {Array<{ type: string, data: any, options: any }>} */
		emitted: [],
		/** @type {string[]} */
		invalidated: [],
		failEmit: { value: false },
	};
	const { privateJwk, publicJwk } = await generateSigningKey({ kid: 'chat-1' });
	state.appJwks.set(APP, createJwks([publicJwk]));
	state.appJwks.set(APP_OTHER, createJwks([publicJwk]));
	const signer = createSigner(privateJwk);
	const config = await testConfig(env);
	const { logger, entries } = createTestLogger();
	const portal = createPortal({
		config,
		db: mongo.db(dbName),
		modules: [...fakeModules(state), createConnectorsModule({ allowHosts: ['127.0.0.1'] })],
		logger,
		now: clock.now,
	});
	await portal.ensureIndexes();
	/**
	 * @param {string} method
	 * @param {string} path
	 * @param {{ headers?: Record<string, string>, body?: unknown }} [init]
	 */
	const call = async (method, path, { headers = {}, body } = {}) => {
		if (method === 'POST') headers = { 'idempotency-key': `k-${(keys += 1)}`, ...headers };
		const response = await portal.handle(
			new Request(`${PORTAL_URL}${path}`, {
				method,
				headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);
		const text = await response.text();
		if (!path.startsWith('/v1/product/resources/resolve')) bodies.push(text);
		return { status: response.status, headers: response.headers, json: text ? JSON.parse(text) : null, text };
	};
	/**
	 * @param {string} merchantId
	 * @param {string[]} [roles]
	 * @param {Array<{ websiteId: string, roles: string[] }>} [grants]
	 */
	const merchant = async (merchantId, roles = ['owner'], grants = []) => {
		const { token } = await portal.shared.sessions.create({
			kind: 'merchant',
			subject: `usr_${roles[0] ?? 'x'}`,
			merchantId,
			roles,
			grants,
		});
		return { cookie: `${portal.shared.cookies.name('merchant')}=${token}`, ...SAME_ORIGIN };
	};
	/** @param {string[]} roles */
	const staff = async (roles) => {
		const { token } = await portal.shared.sessions.create({ kind: 'staff', subject: 'stf_1', roles, mfa: true });
		return { cookie: `${portal.shared.cookies.name('staff')}=${token}`, ...SAME_ORIGIN };
	};
	/**
	 * @param {unknown} body
	 * @param {string} [appId]
	 */
	const resolve = async (body, appId = APP) => {
		const assertion = await signAssertion({ signer, appId, audience: PORTAL_URL, now: clock.now });
		return call('POST', '/v1/product/resources/resolve', { headers: { authorization: `Bearer ${assertion}` }, body });
	};
	return { portal, config, call, clock, state, entries, merchant, staff, resolve, db: mongo.db(dbName) };
};

const base = `/v1/merchants/${MERCHANT}/connectors`;
const aiBody = (/** @type {string[]} */ websiteIds = [WEB_A]) => ({
	kind: 'ai',
	provider: 'openai',
	label: 'OpenAI',
	credentials: { apiKey: AI_KEY, baseUrl: ai.baseUrl, model: 'gpt-test' },
	websiteIds,
});
const storageBody = () => ({
	kind: 'storage',
	provider: 'minio',
	credentials: {
		endpoint: s3.endpoint,
		region: 'us-east-1',
		bucket: 'shop-media',
		accessKeyId: S3_KEY_ID,
		secretAccessKey: S3_SECRET,
		prefix: 'site/',
	},
	websiteIds: [WEB_A],
});

/** @param {any} db */
const dumpDb = async (db) => {
	const names = (await db.listCollections().toArray()).map((/** @type {any} */ c) => c.name);
	const out = [];
	for (const name of names) out.push(JSON.stringify(await db.collection(name).find({}).toArray()));
	return out.join('\n');
};

/**
 * Every 10-character window of every secret (masked previews show at most the last 4 characters).
 * @param {string} text
 */
const leaks = (text) =>
	SECRETS.flatMap((secret) =>
		[...Array(secret.length - 9).keys()]
			.map((i) => secret.slice(i, i + 10))
			.filter((w) => text.includes(w))
			.slice(0, 1)
			.map((w) => `${secret}: …${text.slice(Math.max(0, text.indexOf(w) - 60), text.indexOf(w) + 30)}…`),
	);

describe('connectors: create, check, mask', () => {
	it('creates connectors of every kind, checks them and never returns secrets', async () => {
		const { call, merchant, state, portal, db } = await boot('cn_create');
		const owner = await merchant(MERCHANT);

		const created = await call('POST', base, { headers: owner, body: aiBody() });
		expect(created.status).toBe(201);
		const connector = created.json.connector;
		expect(connector).toMatchObject({
			kind: 'ai',
			provider: 'openai',
			label: 'OpenAI',
			websiteIds: [WEB_A],
			status: 'connected',
			preview: { apiKey: `…${AI_KEY.slice(-4)}`, model: 'gpt-test' },
			rollbackAvailableUntil: null,
		});
		expect(connector.connectorId).toMatch(/^con_/);
		expect(created.headers.get('location')).toBe(`${base}/${connector.connectorId}`);
		expect(created.json.report).toMatchObject({ ok: true, checks: [{ name: 'reachability' }, { name: 'auth', status: 200 }] });
		expect(state.emitted).toEqual([
			{
				type: 'resource.changed@1',
				data: { websiteId: WEB_A, kind: 'ai', status: 'connected', ref: connector.connectorId },
				options: { websiteId: WEB_A },
			},
		]);

		const storage = await call('POST', base, { headers: owner, body: storageBody() });
		expect(storage.json.connector).toMatchObject({
			status: 'connected',
			preview: { bucket: 'shop-media', accessKeyId: '…SKEY', prefix: 'site/' },
		});
		const database = await call('POST', base, {
			headers: owner,
			body: {
				kind: 'database',
				provider: 'mongodb',
				label: 'Atlas',
				credentials: { uri: clientDbUri },
				websiteIds: [WEB_A, WEB_B],
			},
		});
		expect(database.status).toBe(201);
		expect(database.json.connector).toMatchObject({
			status: 'connected',
			preview: { scheme: 'mongodb', dbName: 'client_shop', authenticated: false },
		});
		expect(database.json.report.warnings).toEqual(['unauthenticated']);
		const wrongDb = await call('POST', base, {
			headers: owner,
			body: {
				kind: 'database',
				provider: 'mongodb',
				credentials: { uri: clientDbUri.replace('mongodb://', `mongodb://app:${DB_PASSWORD}@`) },
			},
		});
		expect(wrongDb.json.connector.status).toBe('failing');
		expect(wrongDb.json.report.checks).toContainEqual({ name: 'auth', ok: false, code: 'auth_failed' });
		const payments = await call('POST', base, {
			headers: owner,
			body: { kind: 'payments', provider: 'stripe', credentials: { secretKey: PAY_SECRET }, websiteIds: [WEB_B] },
		});
		expect(payments.json).toMatchObject({
			connector: { status: 'connected', label: 'payments (stripe)', preview: { fields: ['secretKey'] } },
			report: { skipped: true },
		});

		const list = await call('GET', `${base}?limit=2`, { headers: owner });
		expect(list.json.items).toHaveLength(2);
		expect(list.json.hasMore).toBe(true);
		const rest = await call('GET', `${base}?limit=10&cursor=${list.json.nextCursor}`, { headers: owner });
		expect(rest.json.items).toHaveLength(3);
		expect((await call('GET', `${base}?kind=database&status=connected`, { headers: owner })).json.items).toHaveLength(1);
		expect((await call('GET', `${base}?websiteId=${WEB_B}`, { headers: owner })).json.items).toHaveLength(2);
		expect((await call('GET', `${base}?kind=NOPE!`, { headers: owner })).status).toBe(400);
		expect((await call('GET', `${base}/${connector.connectorId}`, { headers: owner })).json.connector.connectorId).toBe(
			connector.connectorId,
		);

		const resources = await call('GET', `/v1/merchants/${MERCHANT}/websites/${WEB_A}/resources`, { headers: owner });
		expect(resources.json).toEqual({
			websiteId: WEB_A,
			resources: [
				{ kind: 'database', ref: database.json.connector.connectorId, status: 'connected' },
				{ kind: 'storage', ref: storage.json.connector.connectorId, status: 'connected' },
				{ kind: 'ai', ref: connector.connectorId, status: 'connected' },
			],
		});
		const svc = /** @type {any} */ (portal.modules.service('connectors'));
		expect(await svc.statusFor(WEB_B)).toHaveLength(2);
		expect(await svc.statusFor(WEB_C)).toEqual([]);
		expect(await svc.statusFor('web_unknownunknownunknown00')).toEqual([]);
		expect(await svc.statusFor('nope')).toEqual([]);

		// the internal test(connectorId) form
		expect((await svc.test(connector.connectorId)).report.ok).toBe(true);
		await expect(svc.test('con_00000000000000000000000000')).rejects.toMatchObject({ code: 'not_found' });

		// storage: what was stored is sealed; plaintext appears nowhere in the control-plane database
		const stored = await db.collection('connectors_connectors').findOne({ _id: connector.connectorId });
		expect(String(stored?.sealed)).toMatch(/^ssenc1\.kek-2\./);
		expect(leaks(await dumpDb(db))).toEqual([]);
		const audit = await db.collection('platform_audit').find({ action: 'connectors.created' }).toArray();
		expect(audit).toHaveLength(5);
		expect(audit[0]).toMatchObject({ actor: { type: 'merchant_user' }, merchantId: MERCHANT, target: { type: 'connector' } });
	}, 60_000);

	it('validates credentials server-side, including the SSRF guard', async () => {
		const { call, merchant, db } = await boot('cn_validate');
		const owner = await merchant(MERCHANT);
		const bad = async (/** @type {any} */ body) => call('POST', base, { headers: owner, body });
		expect((await bad({ kind: 'crypto', provider: 'x', credentials: {} })).status).toBe(422);
		expect((await bad('x')).status).toBe(400);
		const metadata = await bad({ ...aiBody(), credentials: { apiKey: AI_KEY, baseUrl: 'https://169.254.169.254/latest' } });
		expect(metadata.status).toBe(422);
		expect(metadata.json.errors).toEqual([
			{ path: '/credentials/baseUrl', message: 'must point at a public address', code: 'address_refused' },
		]);
		expect(
			(await bad({ ...aiBody(), credentials: { apiKey: AI_KEY, baseUrl: 'http://llm.example.com' } })).json.errors[0].code,
		).toBe('https_required');
		expect((await bad({ ...aiBody(), credentials: { apiKey: AI_KEY, baseUrl: 'https://10.0.0.2' } })).status).toBe(422);
		expect(
			(
				await bad({
					kind: 'database',
					provider: 'mongodb',
					credentials: { uri: 'mongodb://u:p@192.168.0.4:27017/shop?tls=true' },
				})
			).json.errors[0].code,
		).toBe('address_refused');
		expect(
			(await bad({ kind: 'database', provider: 'mongodb', credentials: { uri: 'mongodb://u:p@db.example.com/shop' } })).json
				.errors[0].code,
		).toBe('tls_required');
		expect((await bad({ ...aiBody(), label: '' })).status).toBe(422);
		expect((await bad({ ...aiBody(), websiteIds: ['nope'] })).status).toBe(422);
		const foreign = await bad(aiBody([WEB_C])); // another merchant's website
		expect([foreign.status, foreign.json.errors]).toEqual([
			422,
			[{ path: '/websiteIds/0', message: 'is not a website of this merchant' }],
		]);
		expect((await bad(aiBody(['web_dddddddddddddddddddddddddd']))).status).toBe(422);
		expect(JSON.stringify(metadata.json)).not.toContain(AI_KEY);

		// one connector per website and kind
		expect((await bad(aiBody([WEB_A]))).status).toBe(201);
		const dup = await bad(aiBody([WEB_B, WEB_A]));
		expect(dup.status).toBe(409);
		expect(await db.collection('connectors_connectors').countDocuments({})).toBe(1);
		expect(await db.collection('connectors_assignments').countDocuments({})).toBe(1);
	}, 30_000);
});

describe('connectors: tenant isolation and permissions', () => {
	it('confines every merchant route to its merchant', async () => {
		const { call, merchant, staff } = await boot('cn_tenant');
		const owner = await merchant(MERCHANT);
		const other = await merchant(MERCHANT_2);
		const id = (await call('POST', base, { headers: owner, body: aiBody() })).json.connector.connectorId;
		const one = `${base}/${id}`;
		const routes = /** @type {Array<[string, string, unknown?]>} */ ([
			['GET', base],
			['POST', base, aiBody()],
			['GET', one],
			['PATCH', one, { label: 'x' }],
			['DELETE', one],
			['POST', `${one}/test`, {}],
			['POST', `${one}/rotate`, { credentials: { apiKey: AI_KEY_2 } }],
			['POST', `${one}/rollback`, {}],
			['POST', `${one}/revoke`, {}],
			['PUT', `${one}/websites`, { websiteIds: [] }],
			['GET', `/v1/merchants/${MERCHANT}/websites/${WEB_A}/resources`],
		]);
		for (const [method, path, body] of routes) {
			expect((await call(method, path, { headers: other, body })).status, `${method} ${path}`).toBe(403);
			expect((await call(method, path, { body })).status, `${method} ${path} anonymous`).toBe(401);
			expect(
				(await call(method, path, { headers: await staff(['superadmin']), body })).status,
				`${method} ${path} staff`,
			).toBe(401);
		}
		// merchant 2 naming merchant 1's connector under its own path: not found
		const mine = `/v1/merchants/${MERCHANT_2}/connectors/${id}`;
		for (const [method, path, body] of /** @type {Array<[string, string, unknown?]>} */ ([
			['GET', mine],
			['PATCH', mine, { label: 'x' }],
			['DELETE', mine],
			['POST', `${mine}/test`, {}],
			['POST', `${mine}/rotate`, { credentials: { apiKey: AI_KEY_2 } }],
			['POST', `${mine}/rollback`, {}],
			['POST', `${mine}/revoke`, {}],
			['PUT', `${mine}/websites`, { websiteIds: [] }],
			['GET', `/v1/merchants/${MERCHANT_2}/websites/${WEB_A}/resources`],
		]))
			expect((await call(method, path, { headers: other, body })).status, `${method} ${path}`).toBe(404);
		expect((await call('GET', `/v1/merchants/${MERCHANT_2}/connectors`, { headers: other })).json.items).toEqual([]);
		expect((await call('GET', `/v1/merchants/${MERCHANT_2}/connectors/not-an-id`, { headers: other })).status).toBe(404);
		// merchant 1's connector is untouched
		expect((await call('GET', one, { headers: owner })).json.connector).toMatchObject({ status: 'connected', label: 'OpenAI' });

		// roles: editors cannot manage; developers can; website-scoped grants cannot manage merchant connectors
		const editor = await merchant(MERCHANT, ['editor']);
		expect((await call('GET', base, { headers: editor })).status).toBe(403);
		expect((await call('POST', `${one}/revoke`, { headers: editor, body: {} })).status).toBe(403);
		const billing = await merchant(MERCHANT, ['billing']);
		expect((await call('GET', base, { headers: billing })).status).toBe(403);
		const scoped = await merchant(MERCHANT, ['editor'], [{ websiteId: WEB_A, roles: ['developer'] }]);
		expect((await call('POST', `${one}/revoke`, { headers: scoped, body: {} })).status).toBe(403);
		expect((await call('GET', `/v1/merchants/${MERCHANT}/websites/${WEB_A}/resources`, { headers: scoped })).status).toBe(200);
		const developer = await merchant(MERCHANT, ['developer']);
		expect((await call('PATCH', one, { headers: developer, body: { label: 'Main AI' } })).json.connector.label).toBe('Main AI');
		expect((await call('PATCH', one, { headers: developer, body: { label: '' } })).status).toBe(422);
		expect((await call('PATCH', one, { headers: developer, body: [] })).status).toBe(400);
		// CSRF on cookie mutations
		const noOrigin = { cookie: owner.cookie };
		expect((await call('POST', `${one}/revoke`, { headers: noOrigin, body: {} })).status).toBe(403);
	}, 60_000);

	it('admin consoles see status only', async () => {
		const { call, merchant, staff } = await boot('cn_admin');
		const owner = await merchant(MERCHANT);
		const id = (await call('POST', base, { headers: owner, body: aiBody() })).json.connector.connectorId;
		await call('POST', `/v1/merchants/${MERCHANT_2}/connectors`, {
			headers: await merchant(MERCHANT_2),
			body: {
				kind: 'analytics',
				provider: 'ga4',
				credentials: { ids: { measurementId: 'G-SECRETISH1' } },
				websiteIds: [WEB_C],
			},
		});
		const support = await staff(['support']);
		const list = await call('GET', '/v1/admin/connectors', { headers: support });
		expect(list.status).toBe(200);
		expect(list.json.items).toHaveLength(2);
		for (const item of list.json.items) {
			expect(item).not.toHaveProperty('preview');
			expect(item).not.toHaveProperty('sealed');
			expect(item).not.toHaveProperty('rollbackAvailableUntil');
		}
		expect(list.text).not.toContain('G-SECRETISH1');
		expect(
			(await call('GET', `/v1/admin/connectors?merchantId=${MERCHANT}&kind=ai&status=connected`, { headers: support })).json
				.items,
		).toHaveLength(1);
		const paged = await call('GET', '/v1/admin/connectors?limit=1', { headers: support });
		expect(
			(await call('GET', `/v1/admin/connectors?limit=1&cursor=${paged.json.nextCursor}`, { headers: support })).json.items,
		).toHaveLength(1);
		expect((await call('GET', '/v1/admin/connectors?merchantId=bad', { headers: support })).status).toBe(400);
		const single = await call('GET', `/v1/admin/connectors/${id}`, { headers: support });
		expect(single.json.connector).toMatchObject({ connectorId: id, status: 'connected', merchantId: MERCHANT });
		expect(single.json.connector).not.toHaveProperty('preview');
		expect((await call('GET', '/v1/admin/connectors/con_00000000000000000000000000', { headers: support })).status).toBe(404);
		expect((await call('GET', '/v1/admin/connectors/nope', { headers: support })).status).toBe(404);
		expect((await call('GET', '/v1/admin/connectors', { headers: await staff([]) })).status).toBe(403);
		expect((await call('GET', '/v1/admin/connectors', { headers: owner })).status).toBe(401);
	}, 30_000);
});

describe('connectors: rotation, rollback, revoke, assign, delete', () => {
	it('rotates with a 24 h rollback and revokes in one step', async () => {
		const { call, merchant, clock, state, db, resolve } = await boot('cn_rotate');
		let owner = await merchant(MERCHANT);
		const id = (await call('POST', base, { headers: owner, body: aiBody() })).json.connector.connectorId;
		const one = `${base}/${id}`;
		state.subscriptions.set(WEB_A, [{ subscriptionId: 'sub_chat_a', appId: APP, websiteId: WEB_A, status: 'active' }]);

		expect((await call('POST', `${one}/rollback`, { headers: owner, body: {} })).status).toBe(410);
		expect((await call('POST', `${one}/rotate`, { headers: owner, body: { credentials: { apiKey: 'x y' } } })).status).toBe(
			422,
		);
		expect((await call('POST', `${one}/rotate`, { headers: owner, body: [] })).status).toBe(400);
		// rotate to a key the provider does not accept: failing, previous kept
		const rotated = await call('POST', `${one}/rotate`, {
			headers: owner,
			body: { credentials: { apiKey: AI_KEY_2, baseUrl: ai.baseUrl } },
		});
		expect(rotated.status).toBe(200);
		expect(rotated.json.connector).toMatchObject({ status: 'failing', preview: { apiKey: `…${AI_KEY_2.slice(-4)}` } });
		expect(rotated.json.connector.rollbackAvailableUntil).toBe(new Date(clock.now() + 24 * 3600_000).toISOString());
		expect(state.emitted.at(-1)).toMatchObject({ data: { status: 'failing', ref: id } });
		expect(state.invalidated).toContain('sub_chat_a');
		const raw = await db.collection('connectors_connectors').findOne({ _id: id });
		expect(raw?.previous?.sealed).toMatch(/^ssenc1\./);
		expect((await resolve({ websiteId: WEB_A, kind: 'ai' })).json.descriptor.apiKey).toBe(AI_KEY_2);

		// roll back: the old key is restored and passes again
		const back = await call('POST', `${one}/rollback`, { headers: owner, body: {} });
		expect(back.json.connector).toMatchObject({
			status: 'connected',
			rollbackAvailableUntil: null,
			preview: { apiKey: `…${AI_KEY.slice(-4)}` },
		});
		expect((await resolve({ websiteId: WEB_A, kind: 'ai' })).json.descriptor.apiKey).toBe(AI_KEY);
		expect((await call('POST', `${one}/rollback`, { headers: owner, body: {} })).status).toBe(410);

		// the rollback copy expires after 24 h
		await call('POST', `${one}/rotate`, { headers: owner, body: { credentials: { apiKey: AI_KEY_2, baseUrl: ai.baseUrl } } });
		clock.advance(24 * 3600_000 + 1);
		owner = await merchant(MERCHANT); // the idle session expired meanwhile
		expect((await call('POST', `${one}/rollback`, { headers: owner, body: {} })).status).toBe(410);
		expect((await call('GET', one, { headers: owner })).json.connector.rollbackAvailableUntil).toBeNull();

		// manual test
		const tested = await call('POST', `${one}/test`, { headers: owner, body: {} });
		expect(tested.json).toMatchObject({ connector: { status: 'failing' }, report: { ok: false } });

		// revoke: sealed material gone, assignment released, resolution stops, event emitted
		const revoked = await call('POST', `${one}/revoke`, { headers: owner, body: { reason: 'leaked' } });
		expect(revoked.json.connector).toMatchObject({ status: 'revoked', preview: null });
		expect(revoked.json.connector.revokedAt).not.toBeNull();
		const after = await db.collection('connectors_connectors').findOne({ _id: id });
		expect([after?.sealed, after?.previous]).toEqual([null, null]);
		expect(await db.collection('connectors_assignments').countDocuments({ connectorId: id })).toBe(0);
		expect(state.emitted.at(-1)).toEqual({
			type: 'resource.changed@1',
			data: { websiteId: WEB_A, kind: 'ai', status: 'revoked', ref: id },
			options: { websiteId: WEB_A },
		});
		expect((await resolve({ websiteId: WEB_A, kind: 'ai' })).status).toBe(424);
		expect((await call('POST', `${one}/revoke`, { headers: owner, body: {} })).json.connector.status).toBe('revoked');
		for (const [method, path, body] of /** @type {Array<[string, string, unknown]>} */ ([
			['POST', `${one}/test`, {}],
			['POST', `${one}/rotate`, { credentials: { apiKey: AI_KEY } }],
			['POST', `${one}/rollback`, {}],
			['PUT', `${one}/websites`, { websiteIds: [WEB_A] }],
		]))
			expect((await call(method, path, { headers: owner, body })).status).toBe(409);
		const audit = await db.collection('platform_audit').find({ 'target.id': id }).toArray();
		expect(audit.map((a) => a.action)).toEqual(
			expect.arrayContaining([
				'connectors.created',
				'connectors.rotated',
				'connectors.rolled_back',
				'connectors.tested',
				'connectors.revoked',
			]),
		);
		expect(audit.find((a) => a.action === 'connectors.revoked')?.reason).toBe('leaked');
		expect(
			(await call('GET', `/v1/merchants/${MERCHANT}/websites/${WEB_A}/resources`, { headers: owner })).json.resources,
		).toEqual([{ kind: 'ai', ref: id, status: 'revoked' }]);

		// a new connector may now take the website; status prefers the live one
		state.failEmit.value = true; // emit failures are logged, never fatal
		const fresh = await call('POST', base, { headers: owner, body: aiBody() });
		expect(fresh.status).toBe(201);
		state.failEmit.value = false;
		expect(
			(await call('GET', `/v1/merchants/${MERCHANT}/websites/${WEB_A}/resources`, { headers: owner })).json.resources,
		).toEqual([{ kind: 'ai', ref: fresh.json.connector.connectorId, status: 'connected' }]);
		expect(leaks(await dumpDb(db))).toEqual([]);
	}, 60_000);

	it('assigns websites and deletes connectors', async () => {
		const { call, merchant, state, db } = await boot('cn_assign');
		const owner = await merchant(MERCHANT);
		const a = (await call('POST', base, { headers: owner, body: aiBody([WEB_A]) })).json.connector.connectorId;
		const b = (await call('POST', base, { headers: owner, body: aiBody([]) })).json.connector.connectorId;
		state.emitted.length = 0;
		const put = (/** @type {string} */ id, /** @type {unknown} */ websiteIds) =>
			call('PUT', `${base}/${id}/websites`, { headers: owner, body: { websiteIds } });
		expect((await put(b, [WEB_A])).status).toBe(409); // A already has an ai connector
		expect((await put(b, [WEB_C])).status).toBe(422);
		expect((await put(b, 'x')).status).toBe(422);
		expect((await put(b, [WEB_B])).json.connector.websiteIds).toEqual([WEB_B]);
		expect((await put(a, [WEB_B])).status).toBe(409);
		expect((await put(a, [])).json.connector.websiteIds).toEqual([]);
		expect((await put(b, [WEB_B, WEB_A])).json.connector.websiteIds).toEqual([WEB_B, WEB_A]);
		expect(state.emitted.map((e) => `${e.data.websiteId}:${e.data.status}`)).toEqual([
			`${WEB_B}:connected`,
			`${WEB_A}:missing`,
			`${WEB_A}:connected`,
		]);
		expect(await db.collection('connectors_assignments').countDocuments({ connectorId: b })).toBe(2);
		const removed = await call('DELETE', `${base}/${b}`, { headers: owner });
		expect(removed.status).toBe(204);
		expect((await call('GET', `${base}/${b}`, { headers: owner })).status).toBe(404);
		expect(state.emitted.slice(-2).map((e) => e.data.status)).toEqual(['missing', 'missing']);
		expect(await db.collection('connectors_assignments').countDocuments({})).toBe(0);
		expect(await db.collection('platform_audit').find({ action: 'connectors.deleted' }).toArray()).toHaveLength(1);
	}, 30_000);
});

describe('connectors: resolve (F.9)', () => {
	it('enforces the authorisation matrix and audits every resolve without secrets', async () => {
		const { call, merchant, state, resolve, clock, db } = await boot('cn_resolve');
		const owner = await merchant(MERCHANT);
		const aiId = (await call('POST', base, { headers: owner, body: aiBody([WEB_A]) })).json.connector.connectorId;
		const storageId = (await call('POST', base, { headers: owner, body: storageBody() })).json.connector.connectorId;
		const dbId = (
			await call('POST', base, {
				headers: owner,
				body: { kind: 'database', provider: 'mongodb', credentials: { uri: clientDbUri }, websiteIds: [WEB_A] },
			})
		).json.connector.connectorId;

		// no subscription
		const none = await resolve({ websiteId: WEB_A, kind: 'ai' });
		expect([none.status, none.json.type.split('/').pop()]).toEqual([403, 'forbidden']);
		// paused subscription
		state.subscriptions.set(WEB_A, [{ subscriptionId: 'sub_1', appId: APP, websiteId: WEB_A, status: 'paused' }]);
		expect((await resolve({ websiteId: WEB_A, kind: 'ai' })).status).toBe(403);
		// active
		state.subscriptions.set(WEB_A, [
			{ subscriptionId: 'sub_1', appId: APP, websiteId: WEB_A, status: 'active' },
			{ subscriptionId: 'sub_2', appId: APP_OTHER, websiteId: WEB_A, status: 'active' },
		]);
		const granted = await resolve({ websiteId: WEB_A, kind: 'ai' });
		expect(granted.status).toBe(200);
		expect(granted.headers.get('cache-control')).toBe('no-store');
		expect(granted.json).toEqual({
			kind: 'ai',
			descriptor: { provider: 'openai', baseUrl: ai.baseUrl, apiKey: AI_KEY, model: 'gpt-test', authScheme: 'bearer' },
			expiresAt: new Date(clock.now() + 10 * 60_000).toISOString(),
		});
		expect((await resolve({ websiteId: WEB_A, kind: 'storage' })).json.descriptor).toEqual({
			bucket: 'shop-media',
			region: 'us-east-1',
			accessKeyId: S3_KEY_ID,
			secretAccessKey: S3_SECRET,
			endpoint: s3.endpoint,
			prefix: 'site/',
		});
		expect((await resolve({ websiteId: WEB_A, kind: 'database' })).json.descriptor).toEqual({ uri: clientDbUri });
		// subscribed, but the manifest does not require the kind
		expect((await resolve({ websiteId: WEB_A, kind: 'ai' }, APP_OTHER)).status).toBe(403);
		// required, but nothing connected
		expect((await resolve({ websiteId: WEB_A, kind: 'messaging' })).status).toBe(403); // not required by the manifest either
		state.manifests.set(APP, { requires: { resources: ['database', 'ai', 'storage', 'messaging'] } });
		const missing = await resolve({ websiteId: WEB_A, kind: 'messaging' });
		expect([missing.status, missing.json.type.split('/').pop()]).toEqual([424, 'resource_missing']);
		// another merchant's website: no subscription there → forbidden; with a subscription, merchant 1's connectors never serve it
		expect((await resolve({ websiteId: WEB_C, kind: 'ai' })).status).toBe(403);
		state.subscriptions.set(WEB_C, [{ subscriptionId: 'sub_c', appId: APP, websiteId: WEB_C, status: 'active' }]);
		expect((await resolve({ websiteId: WEB_C, kind: 'ai' })).status).toBe(424);
		// unknown website, unknown app manifest, bad input, wrong auth
		expect((await resolve({ websiteId: 'web_zzzzzzzzzzzzzzzzzzzzzzzzzz', kind: 'ai' })).status).toBe(403);
		state.manifests.delete(APP_OTHER);
		expect((await resolve({ websiteId: WEB_A, kind: 'ai' }, APP_OTHER)).status).toBe(403);
		expect((await resolve({ websiteId: 'nope', kind: 'gpu' })).json.errors).toHaveLength(2);
		expect((await resolve([])).status).toBe(400);
		expect(
			(await call('POST', '/v1/product/resources/resolve', { headers: owner, body: { websiteId: WEB_A, kind: 'ai' } })).status,
		).toBe(401);
		expect((await call('POST', '/v1/product/resources/resolve', { body: { websiteId: WEB_A, kind: 'ai' } })).status).toBe(401);
		// revoked connector
		await call('POST', `${base}/${aiId}/revoke`, { headers: owner, body: {} });
		expect((await resolve({ websiteId: WEB_A, kind: 'ai' })).status).toBe(424);

		// audit: every resolve, granted or denied, without secrets
		const resolved = await db.collection('platform_audit').find({ action: 'connectors.resolved' }).toArray();
		expect(resolved).toHaveLength(3);
		expect(resolved[0]).toMatchObject({
			actor: { type: 'product', id: APP },
			target: { type: 'connector', id: aiId, websiteId: WEB_A },
			after: { appId: APP, websiteId: WEB_A, connectorId: aiId, kind: 'ai', subscriptionId: 'sub_1' },
			merchantId: MERCHANT,
		});
		expect(resolved.map((r) => r.target.id).sort()).toEqual([aiId, dbId, storageId].sort());
		const denied = await db.collection('platform_audit').find({ action: 'connectors.resolve_denied' }).toArray();
		expect(denied.map((d) => d.reason)).toEqual([
			'no_subscription',
			'no_subscription',
			'not_required',
			'not_required',
			'resource_missing',
			'no_subscription',
			'resource_missing',
			'unknown_website',
			'not_required',
			'resource_missing',
		]);
		const auditText = JSON.stringify(await db.collection('platform_audit').find({}).toArray());
		expect(leaks(auditText)).toEqual([]);
		expect(auditText).not.toContain('client_shop?');
		// nothing secret in idempotency, rate-limit or any other control-plane collection
		expect(leaks(await dumpDb(db))).toEqual([]);
	}, 60_000);

	it('rate limits per app and website', async () => {
		const { call, merchant, state, resolve } = await boot('cn_rate');
		const owner = await merchant(MERCHANT);
		await call('POST', base, {
			headers: owner,
			body: { kind: 'payments', provider: 'stripe', credentials: { secretKey: PAY_SECRET }, websiteIds: [WEB_A] },
		});
		state.manifests.set(APP, { requires: { resources: ['payments'] } });
		state.subscriptions.set(WEB_A, [{ subscriptionId: 'sub_1', appId: APP, websiteId: WEB_A, status: 'active' }]);
		for (let i = 0; i < 60; i += 1) expect((await resolve({ websiteId: WEB_A, kind: 'payments' })).status).toBe(200);
		const limited = await resolve({ websiteId: WEB_A, kind: 'payments' });
		expect([limited.status, limited.headers.get('retry-after') !== null]).toEqual([429, true]);
		// another website has its own budget
		expect((await resolve({ websiteId: WEB_B, kind: 'payments' })).status).toBe(403);
		expect((await resolve({ websiteId: WEB_A, kind: 'payments' })).json.descriptor).toBeUndefined();
	}, 60_000);
});

describe('connectors: sealing', () => {
	it('binds sealed credentials to merchant and connector (aad)', async () => {
		const { call, merchant, portal, db, state, resolve } = await boot('cn_aad');
		const owner = await merchant(MERCHANT);
		const id = (await call('POST', base, { headers: owner, body: aiBody([WEB_A]) })).json.connector.connectorId;
		const raw = await db.collection('connectors_connectors').findOne({ _id: id });
		const sealed = String(raw?.sealed);
		const envelope = portal.shared.envelope;
		expect(JSON.parse(envelope.openText(sealed, { aad: { connector: `${MERCHANT}:${id}` } }))).toMatchObject({
			apiKey: AI_KEY,
		});
		expect(() => envelope.openText(sealed, { aad: { connector: `${MERCHANT_2}:${id}` } })).toThrow();
		expect(() => envelope.openText(sealed, { aad: { connector: `${MERCHANT}:con_00000000000000000000000000` } })).toThrow();

		// a sealed value copied into another connector record cannot be opened there
		const other = (await call('POST', base, { headers: owner, body: aiBody([WEB_B]) })).json.connector.connectorId;
		await db.collection('connectors_connectors').updateOne({ _id: other }, { $set: { sealed } });
		const tested = await call('POST', `${base}/${other}/test`, { headers: owner, body: {} });
		expect(tested.json).toMatchObject({
			connector: { status: 'failing' },
			report: { checks: [{ name: 'credentials', code: 'check_failed' }] },
		});
		state.subscriptions.set(WEB_B, [{ subscriptionId: 'sub_b', appId: APP, websiteId: WEB_B, status: 'active' }]);
		const refused = await resolve({ websiteId: WEB_B, kind: 'ai' });
		expect([refused.status, refused.json.type.split('/').pop()]).toEqual([503, 'unavailable']);
		expect(refused.text).not.toContain(AI_KEY);
		// a stored credential that no longer validates (e.g. stricter rules) fails the check without being used
		const bogus = envelope.seal(JSON.stringify({ apiKey: AI_KEY, baseUrl: 'https://10.0.0.1' }), {
			aad: { connector: `${MERCHANT}:${other}` },
		});
		await db.collection('connectors_connectors').updateOne({ _id: other }, { $set: { sealed: bogus } });
		expect((await call('POST', `${base}/${other}/test`, { headers: owner, body: {} })).json.report.checks[0].code).toBe(
			'invalid_credentials',
		);
	}, 30_000);
});

describe('connectors: health checks on demand and on resolve', () => {
	it('re-tests connectors, emits status changes, purges rollback copies and rewraps under the active KEK', async () => {
		const { call, merchant, portal, clock, state, db } = await boot('cn_health');
		const owner = await merchant(MERCHANT);
		const flaky = await startFakeApi({ header: 'authorization', value: `Bearer ${AI_KEY}` });
		const id = (
			await call('POST', base, {
				headers: owner,
				body: { ...aiBody([WEB_A]), credentials: { apiKey: AI_KEY, baseUrl: flaky.baseUrl } },
			})
		).json.connector.connectorId;
		const pay = (
			await call('POST', base, {
				headers: owner,
				body: { kind: 'payments', provider: 'stripe', credentials: { secretKey: PAY_SECRET }, websiteIds: [WEB_A] },
			})
		).json.connector.connectorId;
		await call('POST', `${base}/${pay}/rotate`, { headers: owner, body: { credentials: { secretKey: `${PAY_SECRET}2` } } });
		await flaky.close();
		const runHealth = () => portal.operations.run('connectors-health');

		// nothing is due within the interval
		expect(await runHealth()).toMatchObject({
			status: 'ok',
			stats: { checked: 0, remaining: false },
		});
		expect((await db.collection('connectors_connectors').findOne({ _id: id }))?.status).toBe('connected');

		clock.advance(25 * 3600_000);
		state.emitted.length = 0;
		// the admin operation checks inline (no job): what is due is checked within its deadline
		const health = /** @type {any} */ (await runHealth());
		expect(health.stats).toMatchObject({ checked: 2, changed: 1, remaining: false });
		const doc = await db.collection('connectors_connectors').findOne({ _id: id });
		expect(doc).toMatchObject({
			status: 'failing',
			lastCheckReport: { ok: false, checks: [{ name: 'reachability', ok: false, code: 'unreachable' }] },
		});
		expect(state.emitted).toEqual([
			{
				type: 'resource.changed@1',
				data: { websiteId: WEB_A, kind: 'ai', status: 'failing', ref: id },
				options: { websiteId: WEB_A },
			},
		]);
		expect((await db.collection('connectors_connectors').findOne({ _id: pay }))?.previous).toBeNull(); // expired rollback copy purged
		expect(
			await db.collection('platform_audit').countDocuments({ action: 'connectors.status_changed', 'actor.type': 'system' }),
		).toBe(1);

		// KEK rotation: a Portal with a new active KEK re-wraps on the next run
		const rotated = await boot('cn_health', {
			env: { SECRETS_KEK: `kek-3:${b64(32, 9)},kek-2:${b64(32, 2)},kek-1:${b64(32, 1)}` },
		});
		rotated.clock.set(clock.now() + 2 * 3600_000);
		const svc = /** @type {any} */ (rotated.portal.modules.service('connectors'));
		const result = await svc.healthCheck({ deadline: rotated.clock.now() + 60_000 });
		expect(result).toMatchObject({ checked: 2, rewrapped: 2, remaining: false });
		expect(String((await db.collection('connectors_connectors').findOne({ _id: id }))?.sealed)).toMatch(/^ssenc1\.kek-3\./);
		expect(await svc.healthCheck({ deadline: rotated.clock.now() + 60_000 })).toMatchObject({ checked: 0, remaining: false });
		rotated.clock.advance(2 * 3600_000);
		expect(await svc.healthCheck({ deadline: rotated.clock.now() + 5_000 })).toMatchObject({ checked: 0, remaining: true }); // deadline too close
		// what is left stays due: the next run of the admin operation continues (no job, no timer)
		expect(await rotated.portal.operations.run('connectors-health')).toMatchObject({
			status: 'ok',
			stats: { checked: 2, remaining: false },
		});
		expect(await rotated.portal.shared.jobs.stats()).toMatchObject({ queued: 0 });

		// a resolve is a natural moment to re-check a connector whose last check is old: after the response
		rotated.clock.advance(2 * 3600_000);
		rotated.state.subscriptions.set(WEB_A, [{ subscriptionId: 'sub_a', appId: APP, websiteId: WEB_A, status: 'active' }]);
		/** @type {Array<() => Promise<unknown>>} */
		const deferred = [];
		const resolved = await runInRequestScope({ defer: (task) => void deferred.push(task) }, () =>
			svc.resolve({ appId: APP, websiteId: WEB_A, kind: 'ai' }),
		);
		expect(resolved.kind).toBe('ai');
		expect(deferred).toHaveLength(1);
		await deferred[0]?.();
		const checkedAt = (await db.collection('connectors_connectors').findOne({ _id: id }))?.lastCheckAt;
		expect(checkedAt?.getTime()).toBe(rotated.clock.now());
		// checked recently: the next resolve defers nothing
		await runInRequestScope({ defer: (task) => void deferred.push(task) }, () =>
			svc.resolve({ appId: APP, websiteId: WEB_A, kind: 'ai' }),
		);
		expect(deferred).toHaveLength(1);
	}, 60_000);
});

describe('connectors: responses', () => {
	it('never contained a secret outside resolve', () => {
		expect(bodies.length).toBeGreaterThan(100);
		expect(leaks(bodies.join('\n'))).toEqual([]);
	});
});
