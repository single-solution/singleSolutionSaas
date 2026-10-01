import { beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
	createKeyResolver,
	createSigner,
	generateSigningKey,
	signAssertion,
	toPublicJwk,
	verifyEntitlementDocument,
	verifyLaunch,
	verifyWebsiteKey,
} from '@ss/protocol';
import { createPortal } from '../src/emulator/portal.js';
import { normaliseFixture } from '../src/emulator/fixture.js';
import { formatSettlement, simulateSettlement } from '../src/emulator/settle.js';
import { buildEnvelope, concreteEventType, withVersion } from '../src/emulator/events.js';
import { createDatabaseResolver, withDatabase } from '../src/emulator/mongo.js';
import { loadManifest } from '../src/manifest.js';
import { TEMPLATES_DIR, initApp } from '../src/init.js';
import { tempDir } from './helpers/util.js';

const PORTAL = 'http://localhost:4499';
const T0 = Date.parse('2026-10-01T12:30:00Z');

const manifestPromise = (async () => {
	const dir = path.join(await tempDir('ss-portal-'), 'p');
	await initApp({ dir, kind: 'service', slug: 'notes-app', name: 'Notes App', templatesDir: TEMPLATES_DIR });
	return /** @type {any} */ ((await loadManifest(dir)).manifest);
})();

/** @param {{ fixture?: unknown, now?: () => number, manifest?: (manifest: any) => any, fetch?: typeof fetch }} [options] */
const setup = async ({ fixture, now = () => T0, manifest: mutate = (manifest) => manifest, fetch } = {}) => {
	const manifest = mutate(structuredClone(await manifestPromise));
	/** @type {string[]} */
	const logs = [];
	let changes = 0;
	const portal = await createPortal({
		fixture: normaliseFixture(fixture ?? {}),
		portalUrl: PORTAL,
		now,
		...(fetch ? { fetch } : {}),
		database: {
			resolve: async ({ merchantId }) => ({
				uri: `mongodb://127.0.0.1:1/client_${merchantId}`,
				dbName: `client_${merchantId}`,
			}),
		},
		eventSchemas: {
			'notes_app.note_created@1': JSON.parse(
				await readFile(path.join(TEMPLATES_DIR, 'service/schemas/events/{{namespace}}.note_created@1.json'), 'utf8'),
			),
		},
		log: (line) => logs.push(line),
		onChange: () => {
			changes += 1;
		},
	});
	const { privateJwk } = await generateSigningKey({ kid: 'app-key-1' });
	const signer = createSigner(privateJwk);
	portal.adoptApp({
		appId: 'app_testapplication1',
		baseUrl: 'http://product.test',
		manifest,
		keys: [toPublicJwk(privateJwk)],
		thumbprint: 'x',
		registeredAt: new Date(T0).toISOString(),
	});
	const resolver = createKeyResolver({ jwks: portal.jwks(), now });
	/**
	 * @param {string} method
	 * @param {string} pathname
	 * @param {unknown} [body]
	 * @param {{ signer?: import('@ss/protocol').Signer, audience?: string }} [options]
	 */
	const call = async (method, pathname, body, options = {}) => {
		const url = new URL(pathname, PORTAL);
		const assertion = await signAssertion({
			signer: options.signer ?? signer,
			appId: 'app_testapplication1',
			audience: options.audience ?? PORTAL,
			now,
		});
		return portal.handleProduct({
			method,
			path: url.pathname,
			query: url.searchParams,
			headers: { authorization: `Bearer ${assertion}` },
			body,
		});
	};
	return { portal, call, resolver, logs, manifest, changes: () => changes, signer };
};

describe('emulated Portal: /v1/product/*', () => {
	/** @type {Awaited<ReturnType<typeof setup>>} */
	let ctx;
	beforeEach(async () => {
		ctx = await setup();
	});

	it('refuses calls without a valid client assertion', async () => {
		expect((await ctx.portal.handleProduct({ method: 'GET', path: '/v1/product/revocations' })).status).toBe(401);
		const { privateJwk } = await generateSigningKey({ kid: 'app-key-1' });
		expect((await ctx.call('GET', '/v1/product/revocations', undefined, { signer: createSigner(privateJwk) })).status).toBe(
			401,
		);
		expect((await ctx.call('GET', '/v1/product/revocations', undefined, { audience: 'https://other.test' })).status).toBe(401);
		const unknown = await ctx.call('GET', '/v1/product/nope');
		expect(unknown.status).toBe(404);
		expect(unknown.headers['content-type']).toBe('application/problem+json');
	});

	it('serves signed entitlement documents with stable versions', async () => {
		const response = await ctx.call('GET', '/v1/product/entitlements?websiteId=web_devwebsite01');
		expect(response.status).toBe(200);
		const body = /** @type {any} */ (response.body);
		const verified = await verifyEntitlementDocument({
			token: body.document,
			keyResolver: ctx.resolver,
			now: () => T0,
			expectedDomain: 'shop.example.com',
		});
		expect(Object.keys(body)).toEqual(['document']);
		expect(verified.payload).toMatchObject({
			websiteId: 'web_devwebsite01',
			productSlug: 'notes-app',
			planCode: 'starter',
			version: 1,
			elements: { notes: { enabled: true } },
		});
		expect(/** @type {any} */ (verified.payload).dataScope).toEqual({ prefix: 'ss_notes_app_' });
		expect(/** @type {any} */ (verified.payload).config.notes).toMatchObject({ max_notes: 50 });
		const again = /** @type {any} */ ((await ctx.call('GET', '/v1/product/entitlements?websiteId=web_devwebsite01')).body);
		expect(
			/** @type {any} */ (
				(await verifyEntitlementDocument({ token: again.document, keyResolver: ctx.resolver, now: () => T0 })).payload
			).version,
		).toBe(1);
		const changed = await ctx.portal.setEntitlement({ websiteId: 'web_devwebsite01', element: 'notes', enabled: false });
		expect(changed.deliveries).toEqual([{ appId: 'app_testapplication1', status: 0, error: expect.any(String) }]);
		const off = /** @type {any} */ ((await ctx.call('GET', '/v1/product/entitlements?websiteId=web_devwebsite01')).body);
		expect(
			/** @type {any} */ (
				(await verifyEntitlementDocument({ token: off.document, keyResolver: ctx.resolver, now: () => T0 })).payload
			).version,
		).toBe(2);
		const doc = await verifyEntitlementDocument({ token: off.document, keyResolver: ctx.resolver, now: () => T0 });
		expect(/** @type {any} */ (doc.payload).elements.notes).toEqual({ enabled: false, reason: 'website_override' });
		await ctx.portal.setEntitlement({
			websiteId: 'web_devwebsite01',
			element: 'notes',
			feature: 'max_notes',
			value: 5,
			layer: 'admin',
		});
		const clamped = await verifyEntitlementDocument({
			token: /** @type {any} */ ((await ctx.call('GET', '/v1/product/entitlements?websiteId=web_devwebsite01')).body).document,
			keyResolver: ctx.resolver,
			now: () => T0,
		});
		expect(/** @type {any} */ (clamped.payload).features['notes.max_notes']).toMatchObject({
			value: 5,
			source: 'admin_override',
		});
		expect((await ctx.call('GET', '/v1/product/entitlements?websiteId=web_unknownsite01')).status).toBe(404);
	});

	it('answers 410 for cancelled subscriptions and reports missing resources', async () => {
		const cancelled = await setup({
			fixture: {
				websites: [
					{ id: 'web_cancelled0001', domain: 'a.example.com' },
					{ id: 'web_nodatabase001', domain: 'b.example.com', resources: { database: 'missing' } },
				],
				subscriptions: [
					{ id: 'sub_cancelled0001', websiteId: 'web_cancelled0001', status: 'cancelled' },
					{ id: 'sub_nodatabase001', websiteId: 'web_nodatabase001' },
				],
			},
		});
		expect((await cancelled.call('GET', '/v1/product/entitlements?websiteId=web_cancelled0001')).status).toBe(410);
		const missing = /** @type {any} */ (
			(await cancelled.call('GET', '/v1/product/entitlements?websiteId=web_nodatabase001')).body
		);
		const doc = await verifyEntitlementDocument({ token: missing.document, keyResolver: cancelled.resolver, now: () => T0 });
		expect(/** @type {any} */ (doc.payload).elements.notes).toEqual({ enabled: false, reason: 'resource_missing:database' });
		expect(
			(await cancelled.call('POST', '/v1/product/resources/resolve', { websiteId: 'web_nodatabase001', kind: 'database' }))
				.status,
		).toBe(424);
	});

	it('stores usage idempotently (per record and per batch Idempotency-Key) and prints it', async () => {
		const record = {
			websiteId: 'web_devwebsite01',
			subscriptionId: 'sub_devsubscript01',
			unit: 'note_created',
			quantity: 2,
			idempotencyKey: 'u-1',
			occurredAt: '2026-10-01T11:10:00Z',
		};
		const batch = {
			records: [
				record,
				{ ...record, idempotencyKey: 'u-2' },
				{ websiteId: 'web_unknownsite01', unit: 'x', quantity: 1, idempotencyKey: 'u-3' },
				{ ...record, idempotencyKey: 'u-4', subscriptionId: 'sub_otherone00001' },
				{ unit: 'x' },
			],
		};
		const post = async () =>
			ctx.portal.handleProduct({
				method: 'POST',
				path: '/v1/product/usage',
				headers: {
					authorization: `Bearer ${await signAssertion({ signer: ctx.signer, appId: 'app_testapplication1', audience: PORTAL, now: () => T0 })}`,
					'idempotency-key': 'batch-1',
				},
				body: batch,
			});
		const first = /** @type {any} */ ((await post()).body);
		expect(first.results.map((/** @type {any} */ result) => result.status)).toEqual([
			'accepted',
			'accepted',
			'rejected',
			'rejected',
			'rejected',
		]);
		expect(first.results[2].reason).toBe('not_subscribed');
		expect(first.results[3].reason).toBe('subscription_mismatch');
		expect((await post()).body).toEqual(first);
		expect(/** @type {any} */ ((await ctx.call('POST', '/v1/product/usage', { records: [record] })).body).results).toEqual([
			{ idempotencyKey: 'u-1', status: 'duplicate' },
		]);
		expect((await ctx.call('POST', '/v1/product/usage', [record])).status).toBe(400);
		expect(ctx.portal.usage()).toHaveLength(2);
		expect(ctx.logs.some((line) => line.includes('note_created +2'))).toBe(true);
	});

	it('consumes launches once, records heartbeats, lists revocations', async () => {
		expect((await ctx.call('POST', '/v1/product/launch/consume', { jti: 'jti-1234567890abcdef' })).body).toEqual({
			consumed: true,
		});
		expect((await ctx.call('POST', '/v1/product/launch/consume', { jti: 'jti-1234567890abcdef' })).body).toEqual({
			consumed: false,
		});
		expect((await ctx.call('POST', '/v1/product/launch/consume', {})).status).toBe(400);
		expect((await ctx.call('POST', '/v1/product/heartbeat', { version: '0.1.0' })).body).toMatchObject({ ok: true });
		expect(ctx.portal.heartbeats().app_testapplication1).toMatchObject({ version: '0.1.0' });
		const [key] = await ctx.portal.issueKeys({ websiteId: 'web_devwebsite01' });
		await ctx.portal.revokeKey(/** @type {any} */ (key).keyId);
		await ctx.portal.revokeKey(/** @type {any} */ (key).keyId);
		const revocations = /** @type {any} */ (
			(await ctx.call('GET', `/v1/product/revocations?since=${new Date(T0 - 1000).toISOString()}`)).body
		);
		expect(revocations).toEqual({ keyIds: [key?.keyId], cursor: new Date(T0).toISOString() });
		expect(
			/** @type {any} */ ((await ctx.call('GET', `/v1/product/revocations?since=${new Date(T0 + 1000).toISOString()}`)).body)
				.keyIds,
		).toEqual([]);
		await expect(ctx.portal.revokeKey('key_nope')).rejects.toThrow(/no key/);
	});

	it('stores identity-issuer requests pending until approved, then answers active and signs the issuer in', async () => {
		const route = '/v1/product/websites/web_devwebsite01/identity';
		const { publicJwk } = await generateSigningKey({ kid: 'site-1' });
		const body = {
			issuer: 'https://login.example.com/',
			publicJwks: [publicJwk],
			audience: 'shop',
			claimMap: { email: 'email' },
		};
		// the capability is required
		const refused = await ctx.call('PUT', route, body);
		expect(refused.status).toBe(403);
		expect(JSON.stringify(refused.body)).toContain('capabilities.identityIssuer');
		const capable = await setup({
			manifest: (m) => ({ ...m, capabilities: { ...m.capabilities, identityIssuer: true } }),
			fetch: /** @type {any} */ (
				async (/** @type {string} */ url) =>
					url === 'https://login.example.com/jwks.json'
						? new Response(JSON.stringify({ keys: [{ ...publicJwk, extra: 'dropped' }] }))
						: new Response('{}', { status: 404 })
			),
		});
		const { call, portal, logs } = capable;
		expect((await call('PUT', '/v1/product/websites/web_unknown000001/identity', body)).status).toBe(403);
		expect((await call('PUT', route, { ...body, jwksUrl: 'https://x.example/' })).status).toBe(422);
		expect((await call('PUT', route, { issuer: 'x', publicJwks: [] })).status).toBe(422);
		expect((await call('PUT', route, { ...body, claimMap: { other: 'x' } })).status).toBe(422);
		expect((await call('PUT', route, { ...body, extra: 1 })).status).toBe(422);
		const pending = await call('PUT', route, body);
		expect(pending.status).toBe(202);
		expect(pending.body).toMatchObject({
			status: 'pending',
			request: { websiteId: 'web_devwebsite01', appId: 'app_testapplication1', status: 'pending' },
		});
		expect(/** @type {any} */ ((await call('PUT', route, body)).body).request.requestedAt).toBe(new Date(T0).toISOString());
		expect(logs.some((line) => line.includes('requests issuer https://login.example.com/'))).toBe(true);
		await expect(portal.decideIdentityRequest({ websiteId: 'web_devwebsite01', decision: 'maybe' })).rejects.toThrow(
			/approve or reject/,
		);
		const decided = await portal.decideIdentityRequest({ websiteId: 'web_devwebsite01', decision: 'approve' });
		expect(decided.request.status).toBe('approved');
		expect(decided.issuer).toEqual({
			issuer: 'https://login.example.com/',
			jwks: [publicJwk],
			audience: 'shop',
			claimMap: { subject: 'sub', email: 'email' },
		});
		await expect(portal.decideIdentityRequest({ websiteId: 'web_devwebsite01', decision: 'approve' })).rejects.toThrow(
			/no pending/,
		);
		const active = await call('PUT', route, body);
		expect(active).toMatchObject({ status: 200, body: { status: 'active', issuer: { issuer: 'https://login.example.com/' } } });
		const doc = /** @type {any} */ ((await call('GET', '/v1/product/entitlements?websiteId=web_devwebsite01')).body);
		const verified = await verifyEntitlementDocument({
			token: doc.document,
			keyResolver: capable.resolver,
			now: () => T0,
			expectedDomain: 'shop.example.com',
		});
		expect(/** @type {any} */ (verified.payload).identity).toEqual(decided.issuer);
		// a JWKS URL is fetched at approval (unknown members dropped); an unusable one fails; rejection keeps the issuer
		const viaUrl = { issuer: 'https://login.example.com/', jwksUrl: 'https://login.example.com/jwks.json' };
		expect((await call('PUT', route, viaUrl)).status).toBe(202);
		const approved = await portal.decideIdentityRequest({ websiteId: 'web_devwebsite01', decision: 'approve' });
		expect(approved.issuer?.jwks).toEqual([publicJwk]);
		expect((await call('PUT', route, { ...viaUrl, jwksUrl: 'https://login.example.com/missing.json' })).status).toBe(202);
		await expect(portal.decideIdentityRequest({ websiteId: 'web_devwebsite01', decision: 'approve' })).rejects.toThrow(
			/no usable key/,
		);
		const rejected = await portal.decideIdentityRequest({ websiteId: 'web_devwebsite01', decision: 'reject' });
		expect(rejected).toMatchObject({ request: { status: 'rejected' }, deliveries: [] });
		expect(portal.identityIssuers().web_devwebsite01?.jwks).toEqual([publicJwk]);
		expect(portal.identityRequests()).toHaveLength(1);
		const restored = await createPortal({
			fixture: normaliseFixture({}),
			snapshot: JSON.parse(JSON.stringify(portal.snapshot())),
		});
		expect(restored.identityIssuers()).toEqual(portal.identityIssuers());
	});

	it('rotates product keys with an overlap window', async () => {
		const { privateJwk } = await generateSigningKey({ kid: 'app-key-2' });
		const rotated = await ctx.call('POST', '/v1/product/keys/rotate', { publicJwk: toPublicJwk(privateJwk) });
		expect(rotated.body).toMatchObject({ kid: 'app-key-2', kids: ['app-key-1', 'app-key-2'] });
		expect((await ctx.call('GET', '/v1/product/revocations', undefined, { signer: createSigner(privateJwk) })).status).toBe(
			200,
		);
		expect((await ctx.call('GET', '/v1/product/revocations')).status).toBe(200);
		expect((await ctx.call('POST', '/v1/product/keys/rotate', { publicJwk: toPublicJwk(privateJwk) })).status).toBe(409);
		expect((await ctx.call('POST', '/v1/product/keys/rotate', { publicJwk: { kty: 'RSA' } })).status).toBe(400);
	});

	it('accepts declared, valid product events only', async () => {
		const event = buildEnvelope({
			type: 'notes_app.note_created',
			websiteId: 'web_devwebsite01',
			env: 'test',
			data: { noteId: 'note_1' },
			now: T0,
		});
		const undeclared = buildEnvelope({ type: 'order.placed', websiteId: 'web_devwebsite01', env: 'test', now: T0 });
		const batch = await ctx.call('POST', '/v1/product/events', {
			events: [event, { ...event, data: { wrong: 1 } }, undeclared, { ...event, websiteId: 'web_unknownsite01' }, 'nope'],
		});
		expect(batch.status).toBe(202);
		expect(/** @type {any} */ (batch.body).results.map((/** @type {any} */ result) => result.status)).toEqual([
			'accepted',
			'rejected',
			'rejected',
			'rejected',
			'rejected',
		]);
		expect(/** @type {any} */ (batch.body).results[3].reason).toBe('not_subscribed');
		expect((await ctx.call('POST', '/v1/product/events', { event: { ...event, data: { wrong: 1 } } })).status).toBe(422);
		expect((await ctx.call('POST', '/v1/product/events', event)).status).toBe(202);
		expect((await ctx.call('POST', '/v1/product/events', { events: [] })).status).toBe(400);
		expect(ctx.portal.published()).toHaveLength(2);
	});

	it('resolves the client database per merchant', async () => {
		const resolved = await ctx.call('POST', '/v1/product/resources/resolve', {
			websiteId: 'web_devwebsite01',
			kind: 'database',
		});
		expect(resolved.body).toMatchObject({ kind: 'database', descriptor: { dbName: 'client_mer_devmerchant01' } });
		expect(
			(await ctx.call('POST', '/v1/product/resources/resolve', { websiteId: 'web_devwebsite01', kind: 'ai' })).status,
		).toBe(403);
		expect(
			(await ctx.call('POST', '/v1/product/resources/resolve', { websiteId: 'web_unknownsite01', kind: 'database' })).status,
		).toBe(404);
	});

	it('resolves a kind only an element requires (product-level requires lists the always-required kinds)', async () => {
		const own = await setup({
			manifest: (manifest) => {
				delete manifest.requires;
				manifest.elements[0].requires = { resources: ['database'] };
				return manifest;
			},
		});
		const resolved = await own.call('POST', '/v1/product/resources/resolve', {
			websiteId: 'web_devwebsite01',
			kind: 'database',
		});
		expect(resolved.status).toBe(200);
		expect(
			(await own.call('POST', '/v1/product/resources/resolve', { websiteId: 'web_devwebsite01', kind: 'ai' })).status,
		).toBe(403);
	});
});

describe('emulated Portal: admin operations', () => {
	it('issues website keys that verify offline', async () => {
		const { portal, resolver } = await setup();
		const keys = await portal.websiteKeys();
		expect(keys.map((key) => key.kind)).toEqual(['pk', 'sk']);
		expect((await portal.websiteKeys()).length).toBe(2);
		const sk = /** @type {any} */ (keys[1]);
		expect(sk.key).toMatch(/^sk_test_/);
		const claims = await verifyWebsiteKey({ key: sk.key, keyResolver: resolver, revocations: [], now: () => T0 });
		expect(claims).toMatchObject({
			websiteId: 'web_devwebsite01',
			merchantId: 'mer_devmerchant01',
			domain: 'shop.example.com',
			env: 'test',
		});
		await expect(portal.issueKeys({ websiteId: 'web_nope000000001' })).rejects.toThrow(/no website/);
	});

	it('generates launches of every kind that verify', async () => {
		const { portal, resolver } = await setup();
		for (const kind of /** @type {const} */ (['merchant', 'demo', 'admin', 'impersonate', 'partner', 'developer'])) {
			const launched = await portal.launch({ kind, ...(kind === 'admin' ? { scope: 'mer_devmerchant01' } : {}) });
			expect(launched.url).toMatch(/^http:\/\/product\.test\/sso\?launch=/);
			const claims = await verifyLaunch({
				token: launched.token,
				keyResolver: resolver,
				audience: 'app_testapplication1',
				issuer: PORTAL,
				consume: () => true,
				now: () => T0,
			});
			expect(claims.kind).toBe(kind);
			if (kind === 'impersonate') expect(claims.act?.sub).toBe('usr_devstaff01');
			if (kind === 'merchant')
				expect(claims.subscriptions).toEqual([{ id: 'sub_devsubscript01', websiteId: 'web_devwebsite01' }]);
		}
		await expect(portal.launch({ kind: /** @type {any} */ ('root') })).rejects.toThrow(/kind must be/);
		const foreign = await portal.launch({ kind: 'merchant', appId: 'app_foreignapp0001', baseUrl: 'http://x.test' });
		expect(foreign.claims.aud).toBe('app_foreignapp0001');
		await expect(portal.launch({ kind: 'merchant', appId: 'app_foreignapp0001' })).rejects.toThrow(/no registered app/);
	});

	it('refuses to emit undeclared or invalid events and requires a registered app', async () => {
		const { portal } = await setup();
		await expect(portal.emit({ type: 'cart.updated' })).rejects.toMatchObject({ code: 'not_subscribed' });
		await expect(portal.emit({ type: 'order.placed', websiteId: 'web_nope000000001' })).rejects.toMatchObject({
			code: 'unknown_website',
		});
		await expect(portal.emit({ type: 'order.placed', data: { wrong: true } })).rejects.toMatchObject({ code: 'invalid_event' });
		const empty = await createPortal({ fixture: normaliseFixture({}), portalUrl: PORTAL });
		await expect(empty.emit({ type: 'order.placed' })).rejects.toMatchObject({ code: 'not_registered' });
		empty.adoptApp({ .../** @type {any} */ (portal.apps()[0]), appId: 'app_one00000000001' });
		empty.adoptApp({ .../** @type {any} */ (portal.apps()[0]), appId: 'app_two00000000001' });
		await expect(empty.emit({ type: 'order.placed' })).rejects.toMatchObject({ code: 'ambiguous_app' });
	});

	it('round-trips state through snapshots', async () => {
		const { portal, changes } = await setup();
		await portal.websiteKeys();
		await portal.setEntitlement({ websiteId: 'web_devwebsite01', element: 'notes', enabled: false });
		expect(changes()).toBeGreaterThan(0);
		const snapshot = JSON.parse(JSON.stringify(portal.snapshot()));
		const restored = await createPortal({ fixture: normaliseFixture({}), snapshot });
		expect(restored.jwks()).toEqual(portal.jwks());
		expect(restored.apps().map((app) => app.appId)).toEqual(['app_testapplication1']);
		expect(restored.fixture().subscriptions[0]?.layers).toEqual({
			website: { elements: { notes: { enabled: false } }, features: {} },
		});
		await expect(restored.setEntitlement({ websiteId: 'web_nope000000001', element: 'x' })).rejects.toThrow(/no subscription/);
	});

	it('simulates hourly settlement with metered overage', async () => {
		const { portal, call } = await setup({ now: () => T0 });
		const records = Array.from({ length: 3 }, (_, index) => ({
			websiteId: 'web_devwebsite01',
			unit: 'note_created',
			quantity: 60,
			idempotencyKey: `n-${index}`,
			occurredAt: `2026-10-01T1${index}:15:00Z`,
		}));
		await call('POST', '/v1/product/usage', { records });
		const run = portal.settle({ hours: 3 });
		expect(run.from).toBe('2026-10-01T09:00:00.000Z');
		expect(run.entries.filter((entry) => entry.kind === 'hourly').map((entry) => entry.amount)).toEqual([10, 10, 10]);
		const metered = run.entries.filter((entry) => entry.kind === 'metered');
		expect(metered.map((entry) => entry.amount)).toEqual([0, 2]);
		expect(run.total).toBe(32);
		expect(run.balances.mer_devmerchant01).toEqual({ before: 100_000_000, charged: 32, after: 99_999_968 });
		const text = formatSettlement(run);
		expect(text).toContain('sub_devsubscript01:2026-10-01T09:00:00Z');
		expect(text).toContain('Total 32 mc');
	});
});

describe('settlement, fixture, events, database helpers', () => {
	it('skips paused hours, foreign products and validates hours', async () => {
		const manifest = await manifestPromise;
		const { normaliseProduct } = await import('@ss/entitlements');
		const fixture = normaliseFixture({
			websites: [
				{ id: 'web_devwebsite01', domain: 'a.example.com' },
				{ id: 'web_devwebsite02', domain: 'b.example.com' },
			],
			subscriptions: [
				{ id: 'sub_paused000001', websiteId: 'web_devwebsite01', status: 'paused', plan: 'starter' },
				{ id: 'sub_foreign00001', websiteId: 'web_devwebsite02', product: 'other' },
			],
		});
		const run = simulateSettlement({
			product: normaliseProduct(manifest),
			fixture,
			enabledElements: () => ['notes'],
			now: T0,
			hours: 2,
		});
		expect(run.entries).toEqual([]);
		expect(run.skipped.map((skip) => skip.reason)).toEqual(['paused', 'paused']);
		expect(formatSettlement(run)).toContain('skipped paused');
		expect(formatSettlement({ ...run, skipped: [] })).toContain('(no billable hours)');
		expect(() =>
			simulateSettlement({ product: normaliseProduct(manifest), fixture, enabledElements: () => [], now: T0, hours: 0 }),
		).toThrow(RangeError);
	});

	it('normalises fixtures and rejects bad references', () => {
		const fixture = normaliseFixture({
			subscriptions: [{ id: 'sub_devsubscript01', websiteId: 'web_devwebsite01', plan: null }],
		});
		expect(fixture.portal.url).toBe('http://localhost:4400');
		expect(fixture.subscriptions[0]?.plan).toBeNull();
		expect(normaliseFixture({}).subscriptions[0]?.plan).toBeUndefined();
		expect(() => normaliseFixture([])).toThrow(/JSON object/);
		expect(() => normaliseFixture({ merchants: [{ id: 'bad' }] })).toThrow(/merchants\[0\]\.id/);
		expect(() =>
			normaliseFixture({ websites: [{ id: 'web_devwebsite01', merchantId: 'mer_unknown00001', domain: 'x.com' }] }),
		).toThrow(/unknown merchant/);
		expect(() => normaliseFixture({ websites: [{ id: 'web_devwebsite01' }] })).toThrow(/domain is required/);
		expect(() => normaliseFixture({ subscriptions: [{ id: 'sub_devsubscript01', websiteId: 'web_unknown00001' }] })).toThrow(
			/unknown website/,
		);
		expect(() =>
			normaliseFixture({ subscriptions: [{ id: 'sub_devsubscript01', websiteId: 'web_devwebsite01', status: 'odd' }] }),
		).toThrow(/status/);
	});

	it('maps consumed globs to concrete event types and delivers events matching a consumed glob', async () => {
		expect(concreteEventType('order.placed@1')).toBe('order.placed@1');
		expect(concreteEventType('order.*@1')).toBe('order.placed@1');
		expect(concreteEventType('inventory.*')).toBe('inventory.changed@1');
		expect(concreteEventType('custom.*')).toBe('custom.ss_probe@1');
		expect(concreteEventType('notes_app.*')).toBeNull();
		/** @type {string[]} */
		const delivered = [];
		const fetch = /** @type {typeof globalThis.fetch} */ (
			async (_url, init) => {
				delivered.push(JSON.parse(String(init?.body)).type);
				return new Response(null, { status: 204 });
			}
		);
		const portal = await createPortal({ fixture: normaliseFixture({}), portalUrl: PORTAL, now: () => T0, fetch });
		const manifest = await manifestPromise;
		portal.adoptApp({
			appId: 'app_globconsumer01',
			baseUrl: 'http://product.test',
			manifest: { ...manifest, events: { ...manifest.events, consumes: ['custom.*', 'order.*@1'] } },
			keys: [],
			thumbprint: 'x',
			registeredAt: new Date(T0).toISOString(),
		});
		expect((await portal.emit({ type: 'custom.points_bonus', data: { a: 1 } })).status).toBe(204);
		expect((await portal.emit({ type: 'order.completed' })).status).toBe(204);
		await expect(portal.emit({ type: 'order.completed@2' })).rejects.toMatchObject({ code: 'not_subscribed' });
		await expect(portal.emit({ type: 'cart.updated' })).rejects.toMatchObject({ code: 'not_subscribed' });
		expect(delivered).toEqual(['custom.points_bonus@1', 'order.completed@1']);
	});

	it('builds envelopes and database URIs', async () => {
		expect(withVersion('order.placed')).toBe('order.placed@1');
		expect(withVersion('order.placed@2')).toBe('order.placed@2');
		const event = buildEnvelope({
			type: 'page.viewed',
			websiteId: 'web_devwebsite01',
			env: 'live',
			now: T0,
			id: 'evt_fixed0000001',
		});
		expect(event).toMatchObject({
			id: 'evt_fixed0000001',
			type: 'page.viewed@1',
			idempotencyKey: 'evt_fixed0000001',
			data: { path: '/' },
		});
		expect(buildEnvelope({ type: 'custom.thing', websiteId: 'web_devwebsite01', env: 'test', now: T0 }).data).toEqual({});
		expect(withDatabase('mongodb://u:p@h:1/old?tls=true', 'db')).toBe('mongodb://u:p@h:1/db?tls=true');
		expect(withDatabase('mongodb+srv://c.example.net', 'db')).toBe('mongodb+srv://c.example.net/db');
		expect(() => withDatabase('http://x', 'db')).toThrow(TypeError);
		let started = 0;
		const resolver = createDatabaseResolver({
			start: async () => ({ uri: `mongodb://127.0.0.1:${(started += 1)}`, stop: async () => {} }),
		});
		expect(await resolver.resolve({ merchantId: 'mer_a', websiteId: 'web_a' })).toEqual({
			uri: 'mongodb://127.0.0.1:1/client_mer_a',
			dbName: 'client_mer_a',
		});
		await resolver.resolve({ merchantId: 'mer_b', websiteId: 'web_b' });
		expect(started).toBe(1);
		await resolver.stop();
		await resolver.stop();
		expect((await createDatabaseResolver({ uri: 'mongodb://db.test' }).resolve({ merchantId: 'm', websiteId: 'w' })).uri).toBe(
			'mongodb://db.test/client_m',
		);
	});

	it('starts a real MongoMemoryServer for the client database', async () => {
		const resolver = createDatabaseResolver();
		const { uri } = await resolver.resolve({ merchantId: 'mer_real', websiteId: 'web_real' });
		expect(uri).toMatch(/^mongodb:\/\/127\.0\.0\.1:\d+\/client_mer_real/);
		await resolver.stop();
	}, 60_000);
});
