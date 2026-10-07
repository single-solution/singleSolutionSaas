import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateSigningKey } from '@ss/protocol';
import { createMongoStores, createProduct, created, defineRoute, ok, standardRoutes } from '../src/index.js';
import { createFakePortal } from '../src/testing.js';
import { APP_ID, MERCHANT, PORTAL_URL, WEBSITE, createClock, entitle, manifest, websiteKey } from './helpers.js';
import { startMongo } from './mongo.js';

/** @type {Awaited<ReturnType<typeof startMongo>>} */
let mongo;
beforeAll(async () => {
	mongo = await startMongo();
}, 120_000);
afterAll(async () => {
	await mongo?.stop();
});

describe('two instances on shared MongoDB control stores', () => {
	it('shares duplicate refusal, replay, revocations, entitlements and usage exactly once', async () => {
		const clock = createClock();
		const portal = await createFakePortal({ url: PORTAL_URL, now: clock.now, appId: APP_ID });
		const { privateJwk, publicJwk } = await generateSigningKey({ kid: 'product-1' });
		portal.trustProductKey(publicJwk);
		await entitle(portal);
		portal.setResource(WEBSITE, 'database', { uri: mongo.uriFor('merchant_int') });
		const controlDb = mongo.client.db('control_int');

		const instance = () => {
			const product = createProduct({
				manifest: manifest(),
				portalUrl: PORTAL_URL,
				appId: APP_ID,
				signingKey: privateJwk,
				fetch: portal.fetch,
				now: clock.now,
				stores: createMongoStores({ db: controlDb, now: clock.now }),
				outbound: { allowHosts: ['127.0.0.1'] },
				data: {
					indexes: [{ collection: 'coupons', keys: { websiteId: 1, code: 1 }, unique: true }],
					migrations: [{ version: 1, up: async () => {} }],
				},
			});
			const handle = product.handler([
				...standardRoutes(product),
				defineRoute({
					method: 'POST',
					path: '/v1/coupons',
					auth: 'website',
					keyKind: 'sk',
					element: 'codes',
					idempotent: true,
					handler: async (ctx) => {
						const scope = await ctx.product.data.forWebsite(ctx.websiteId, {
							merchantId: ctx.website.merchantId,
							env: ctx.website.env,
						});
						const { insertedId } = await scope.collection('coupons').insertOne({ code: ctx.body.code });
						await ctx.product.usage.record({
							websiteId: ctx.websiteId,
							subscriptionId: ctx.entitlement.doc.subscriptionId,
							unit: 'redemption',
							quantity: 1,
							idempotencyKey: `create:${ctx.body.code}`,
						});
						await ctx.product.audit.record({
							websiteId: ctx.websiteId,
							actor: { type: 'product' },
							action: 'coupon.created',
							target: { type: 'coupon', id: String(insertedId) },
							requestId: ctx.requestId,
						});
						return created({ id: String(insertedId) });
					},
				}),
				defineRoute({
					method: 'GET',
					path: '/v1/coupons',
					auth: 'website',
					element: 'codes',
					handler: async (ctx) => {
						const scope = await ctx.product.data.forWebsite(ctx.websiteId);
						return ok({
							items: await scope
								.collection('coupons')
								.find({ websiteId: ctx.websiteId }, { projection: { _id: 0, code: 1 } })
								.toArray(),
						});
					},
				}),
			]);
			return { product, handle };
		};
		const a = instance();
		const b = instance();
		const sk = await websiteKey(portal, { kind: 'sk', keyId: 'key_int' });
		const post = (/** @type {any} */ inst, /** @type {string} */ code, /** @type {string} */ key) =>
			inst.handle(
				new Request('https://coupons.example.dev/v1/coupons', {
					method: 'POST',
					body: JSON.stringify({ code }),
					headers: { 'content-type': 'application/json', authorization: `Bearer ${sk}`, 'idempotency-key': key },
				}),
			);

		const first = await post(a, 'SAVE10', 'idem-1');
		expect(first.status).toBe(201);
		// the retry lands on the other instance and is refused from the shared store (no body is kept anywhere)
		const again = await post(b, 'SAVE10', 'idem-1');
		expect(again.status).toBe(409);
		expect((await again.json()).type).toMatch(/\/duplicate_request$/);
		const seen = await controlDb
			.collection('ss_kit_replay')
			.find({ _id: /** @type {any} */ ({ $regex: '^idem:' }) })
			.toArray();
		expect(seen).toHaveLength(1);
		expect(Object.keys(seen[0] ?? {}).sort()).toEqual(['_id', 'expireAt']);
		expect(String(seen[0]?._id)).toMatch(/^idem:[0-9a-f]{64}$/);
		expect(
			await mongo.client.db('merchant_int').collection('ss_coupon_box_coupons').countDocuments({ websiteId: WEBSITE }),
		).toBe(1);
		const doc = await mongo.client.db('merchant_int').collection('ss_coupon_box_coupons').findOne({});
		expect(doc).toMatchObject({ websiteId: WEBSITE, merchantId: MERCHANT, env: 'live', schemaVersion: 1 });
		expect(
			await mongo.client
				.db('merchant_int')
				.collection('ss_coupon_box_audit')
				.countDocuments({ websiteId: WEBSITE, action: 'coupon.created' }),
		).toBe(1);
		// unique index (websiteId first) from lazy preparation
		expect((await post(b, 'SAVE10', 'idem-2')).status).toBe(500);

		// usage: both instances flush concurrently, the Portal sees each key once
		await b.product.usage.record({
			websiteId: WEBSITE,
			subscriptionId: 'sub_0123456789abcdefghjkmnpq',
			unit: 'redemption',
			quantity: 3,
			idempotencyKey: 'batch-7',
		});
		await a.product.usage.record({
			websiteId: WEBSITE,
			subscriptionId: 'sub_0123456789abcdefghjkmnpq',
			unit: 'redemption',
			quantity: 3,
			idempotencyKey: 'batch-7',
		});
		const [fa, fb] = await Promise.all([a.product.usage.flush(), b.product.usage.flush()]);
		expect(fa.sent + fb.sent).toBe(2);
		expect([...portal.usage.keys()].sort()).toEqual(['batch-7', 'create:SAVE10']);
		expect(await a.product.usage.stats()).toEqual({ pending: 0, sent: 2, dead: 0 });

		// launch replay is shared: a launch used on A cannot be used on B
		const launch = await portal.issueLaunch({
			subject: 'usr_1',
			kind: 'merchant',
			user: { id: 'usr_1' },
			scope: { merchantId: MERCHANT },
		});
		expect((await a.product.launch.verify(launch.token)).ok).toBe(true);
		expect(await b.product.launch.verify(launch.token)).toEqual({ ok: false, code: 'replay' });

		// a key revoked by an event on A is refused by B
		const delivery = await portal.signEvent({
			id: 'evt_rev1',
			type: 'key.revoked@1',
			websiteId: WEBSITE,
			env: 'live',
			occurredAt: '2026-10-01T10:00:00Z',
			idempotencyKey: 'rev-1',
			actor: { type: 'system' },
			data: { keyId: 'key_int' },
		});
		expect((await a.product.events.handle({ headers: delivery.headers, rawBody: delivery.body })).status).toBe(200);
		clock.advance(5 * 60_000);
		const refused = await b.handle(
			new Request('https://coupons.example.dev/v1/coupons', { headers: { authorization: `Bearer ${sk}` } }),
		);
		expect(refused.status).toBe(401);

		// entitlement stored by A serves B during a Portal outage (stale)
		const pk = await websiteKey(portal, { keyId: 'key_pk' });
		portal.setDown(true);
		const c = instance();
		const stale = await c.handle(
			new Request('https://coupons.example.dev/v1/entitlement', {
				headers: { authorization: `Bearer ${pk}`, origin: 'https://shop.example.com' },
			}),
		);
		expect(stale.status).toBe(200);
		expect(stale.headers.get('ss-entitlement-stale')).toBe('true');
		expect((await c.handle(new Request('https://coupons.example.dev/.well-known/ss-app.json'))).status).toBe(200);
		await a.product.close();
	});
});
