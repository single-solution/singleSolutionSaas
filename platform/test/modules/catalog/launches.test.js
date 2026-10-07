import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeMongoClients } from '../../../src/infra/db.js';
import { MERCHANT, PORTAL_URL, WEBSITE, startMongo } from '../../helpers.js';
import { bootPortal, problemOf } from './boot.js';
import { fakeCommerce } from './fakes/modules.js';
import { startFakeProduct } from './fakes/product.js';
import { renamedService, serviceManifest } from './fixtures.js';

/** @type {Awaited<ReturnType<typeof startMongo>>} */
let mongo;
/** @type {Array<{ close: () => Promise<unknown> }>} */
const products = [];

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

beforeAll(async () => {
	mongo = await startMongo();
}, 120_000);
afterAll(async () => {
	await Promise.all(products.map((p) => p.close()));
	await closeMongoClients();
	await mongo?.stop();
});

/**
 * Portal + connected fake product.
 * @param {Partial<Parameters<typeof bootPortal>[0]>} [options]
 * @param {any} [manifest]
 */
const setup = async (options = {}, manifest = serviceManifest()) => {
	const t = await bootPortal({ db: mongo.db('cat_launch'), ...options });
	const p = await startFakeProduct({ manifest, portalUrl: PORTAL_URL, now: t.clock.now });
	products.push(p);
	const res = await t.register(p);
	expect(res.status).toBe(201);
	const appId = /** @type {string} */ (res.json.appId);
	return { t, p, appId };
};

/** @param {any} t @param {string} appId */
const activate = (t, appId) => t.staff('POST', `/v1/admin/apps/${appId}/status`, { body: { status: 'active' } });

describe('launches', () => {
	it('issues merchant and admin launches, verifiable with @ss/protocol verifyLaunch', async () => {
		const { t, p, appId } = await setup({ modules: [fakeCommerce([])] });
		await activate(t, appId);

		/** @param {any} res */
		const tokenOf = (res) => {
			expect(res.status, JSON.stringify(res.json)).toBe(200);
			const url = new URL(res.json.url);
			expect(`${url.origin}${url.pathname}`).toBe(`${p.url}/sso`);
			return /** @type {string} */ (url.searchParams.get('launch'));
		};

		// merchant (merchant console)
		const merchantCookie = await t.session({ kind: 'merchant', merchantId: MERCHANT });
		const merchant = await t.call('POST', `/v1/merchants/${MERCHANT}/apps/${appId}/launch`, {
			cookie: merchantCookie,
			body: { websiteId: WEBSITE },
		});
		const m = await t.verify(tokenOf(merchant), appId);
		expect(m).toMatchObject({
			kind: 'merchant',
			sub: MERCHANT,
			iss: PORTAL_URL,
			aud: appId,
			scope: { merchantId: MERCHANT, websiteId: WEBSITE },
		});
		expect(m.exp - m.iat).toBe(60);
		problemOf(
			await t.call('POST', `/v1/merchants/mer_1123456789abcdefghjkmnpq/apps/${appId}/launch`, {
				cookie: merchantCookie,
				body: {},
			}),
			403,
		);

		// admin launches (Finance is refused, PLAN 0.2)
		const staffLaunch = (/** @type {any} */ body, /** @type {string} */ role = 'owner') =>
			t.staff('POST', `/v1/admin/apps/${appId}/launch`, { body, role });
		const admin = await t.verify(tokenOf(await staffLaunch({ kind: 'admin', merchantId: MERCHANT })), appId);
		expect(admin).toMatchObject({
			kind: 'admin',
			sub: 'adm_owner_alice',
			user: { id: 'adm_owner_alice', roles: ['owner'] },
			scope: { merchantId: MERCHANT },
		});
		// Open as admin with no website: Owner only
		const wide = await t.verify(tokenOf(await staffLaunch({ all: true })), appId);
		expect(wide).toMatchObject({ kind: 'admin', sub: 'adm_owner_alice', scope: { all: true } });
		expect(wide.scope).not.toHaveProperty('merchantId');
		problemOf(await staffLaunch({ all: true }, 'support'), 403, 'forbidden');
		problemOf(await staffLaunch({ merchantId: MERCHANT }, 'finance'), 403, 'forbidden');
		problemOf(await staffLaunch({ all: true, merchantId: MERCHANT }), 422, 'validation_failed');
		expect((await staffLaunch({ merchantId: MERCHANT, websiteId: WEBSITE }, 'support')).status).toBe(200);
		problemOf(await staffLaunch({ kind: 'impersonate', merchantId: MERCHANT }), 422, 'validation_failed');
		problemOf(await staffLaunch({}), 422, 'catalog_launch_refused');

		// admin launches are written to Activity
		const launches = (await t.audit(appId)).filter((a) => a.action === 'catalog.launch_issued');
		expect(launches.map((a) => a.after.kind)).toEqual(['admin', 'admin', 'admin']);
		expect(launches[0]).toMatchObject({ actor: { id: 'adm_owner_alice' }, merchantId: MERCHANT });
		expect(launches[1]).toMatchObject({ merchantId: null, after: { kind: 'admin', scope: 'all' } });
	});

	it('includes the website subscriptions from commerce in merchant launches', async () => {
		const SUB = 'sub_0123456789abcdefghjkmnpq';
		/** @type {any[]} */
		const subs = [];
		const { t, appId } = await setup({ modules: [fakeCommerce(subs)] });
		subs.push(
			{ subscriptionId: SUB, websiteId: WEBSITE, merchantId: MERCHANT, appId, status: 'active' },
			{ subscriptionId: 'sub_other', websiteId: WEBSITE, merchantId: MERCHANT, appId: 'app_other', status: 'active' },
		);
		await activate(t, appId);
		const cookie = await t.session({ kind: 'merchant', merchantId: MERCHANT });
		const res = await t.call('POST', `/v1/merchants/${MERCHANT}/apps/${appId}/launch`, {
			cookie,
			body: { websiteId: WEBSITE },
		});
		const claims = await t.verify(/** @type {string} */ (new URL(res.json.url).searchParams.get('launch')), appId);
		expect(claims.subscriptions).toEqual([{ subscriptionId: SUB, websiteId: WEBSITE, status: 'active' }]);
	});

	it('refuses merchant launches of inactive apps and launches of unknown apps', async () => {
		const { t, appId } = await setup();
		const cookie = await t.session({ kind: 'merchant', merchantId: MERCHANT });
		problemOf(
			await t.call('POST', `/v1/merchants/${MERCHANT}/apps/${appId}/launch`, { cookie, body: {} }),
			422,
			'catalog_launch_refused',
		);
		// staff can open an inactive product before listing it
		expect((await t.staff('POST', `/v1/admin/apps/${appId}/launch`, { body: { merchantId: MERCHANT } })).status).toBe(200);
		problemOf(await t.call('POST', `/v1/merchants/${MERCHANT}/apps/app_nope/launch`, { cookie, body: {} }), 404);
		await expect(
			t.service().issueLaunch({ kind: /** @type {any} */ ('demo'), appId, subject: 'usr_x', user: { id: 'usr_x' } }),
		).rejects.toMatchObject({ code: 'catalog_launch_refused' });
	});

	it('consumes launches once (shared replay store)', async () => {
		const { t, p, appId } = await setup();
		await activate(t, appId);
		const issue = () =>
			t
				.service()
				.issueLaunch({ kind: 'merchant', appId, subject: 'usr_x', user: { id: 'usr_x' }, scope: { merchantId: MERCHANT } });
		const launch = await issue();
		const consume = async (/** @type {string} */ jti, signer = p.signer, app = appId) =>
			t.call('POST', '/v1/product/launch/consume', { bearer: await t.assertion(signer, app), body: { jti, exp: 1 } });
		expect((await consume(launch.jti)).json).toEqual({ consumed: true });
		expect((await consume(launch.jti)).json).toEqual({ consumed: false });
		expect((await consume('unknown-jti-0123456789')).json).toEqual({ consumed: false });
		problemOf(await consume('x'), 422);

		// another app cannot consume this app's launch
		const other = await startFakeProduct({ manifest: renamedService('coupons-b'), portalUrl: PORTAL_URL, now: t.clock.now });
		products.push(other);
		const reg = await t.register(other);
		expect(reg.status, JSON.stringify(reg.json)).toBe(201);
		const second = await issue();
		expect((await consume(second.jti, other.signer, reg.json.appId)).json).toEqual({ consumed: false });

		// expired launches cannot be consumed
		t.clock.advance(2 * 60_000);
		expect((await consume(second.jti)).json).toEqual({ consumed: false });
	});
});
