import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSigner, generateSigningKey } from '@ss/protocol';
import { closeMongoClients } from '../../../src/infra/db.js';
import { KEY_OVERLAP_MS, MAX_ACTIVE_KEYS } from '../../../src/modules/catalog/service.js';
import { MERCHANT, PORTAL_URL, WEBSITE, startMongo } from '../../helpers.js';
import { bootPortal, problemOf } from './boot.js';
import { fakeCommerce } from './fakes/modules.js';
import { startFakeProduct } from './fakes/product.js';
import { renamedService, serviceManifest } from './fixtures.js';

/** @type {Awaited<ReturnType<typeof startMongo>>} */
let mongo;
/** @type {Array<{ close: () => Promise<unknown> }>} */
const products = [];
const DAY = 86_400_000;

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
 * Portal + registered fake product.
 * @param {Partial<Parameters<typeof bootPortal>[0]>} [options]
 * @param {any} [manifest]
 */
const setup = async (options = {}, manifest = serviceManifest()) => {
	const t = await bootPortal({ db: mongo.db('cat_life'), ...options });
	const p = await startFakeProduct({ manifest, portalUrl: PORTAL_URL, now: t.clock.now });
	products.push(p);
	const res = await t.register(p);
	expect(res.status).toBe(201);
	const appId = /** @type {string} */ (res.json.appId);
	return { t, p, appId };
};

/** @param {any} t @param {string} appId @param {any} body */
const lifecycle = (t, appId, body) => t.staff('POST', `/v1/admin/apps/${appId}/lifecycle`, { body });

describe('manifest versions: refresh, diff, review', () => {
	it('refreshes, diffs, approves, rejects and emits manifest.accepted@1', async () => {
		const { t, p, appId } = await setup();
		// unchanged manifest → nothing stored
		const same = await t.staff('POST', `/v1/admin/apps/${appId}/refresh`);
		expect(same.json).toMatchObject({ changed: false, version: { version: 1, status: 'accepted' } });

		// activation publishes v1
		const active = await lifecycle(t, appId, { action: 'activate' });
		expect(active.json.status).toBe('active');
		expect(t.integration?.emitted).toEqual([
			{
				type: 'manifest.accepted@1',
				data: expect.objectContaining({ appId, slug: 'coupons', version: 1, breaking: false }),
				options: { appIds: [appId] },
			},
		]);

		// a price increase becomes a pending, breaking v2
		const v2 = serviceManifest();
		v2.product.version = '1.5.0';
		v2.elements[0].price.hourly = 2000;
		p.setManifest(v2);
		const refreshed = await t.staff('POST', `/v1/admin/apps/${appId}/refresh`);
		expect(refreshed.json).toMatchObject({
			changed: true,
			version: { version: 2, status: 'pending', breaking: true, source: 'refresh' },
		});
		expect(refreshed.json.version.diff.breaking).toEqual([expect.objectContaining({ code: 'price_increase' })]);
		expect((await t.staff('POST', `/v1/admin/apps/${appId}/refresh`)).json).toMatchObject({
			changed: false,
			version: { version: 2 },
		});
		expect((await t.service().getApp(appId)).pendingVersion).toBe(2);

		// the accepted manifest is still v1 until approval
		expect((await t.service().getManifest(appId)).elements[0]?.price.hourly).toBe(1000);
		expect((await t.service().getManifest(appId, 2)).elements[0]?.price.hourly).toBe(2000);

		const approved = await t.staff('POST', `/v1/admin/apps/${appId}/versions/2/approve`, { body: { reason: 'announced' } });
		expect(approved.json).toMatchObject({ version: 2, status: 'accepted', review: { by: 'stf_alice', reason: 'announced' } });
		expect(await t.service().getApp(appId)).toMatchObject({ currentVersion: 2, pendingVersion: null, productVersion: '1.5.0' });
		expect(t.integration?.emitted.at(-1)).toMatchObject({ data: { version: 2, breaking: true, productVersion: '1.5.0' } });
		expect((await t.staff('GET', `/v1/admin/apps/${appId}/versions/1`)).json.status).toBe('superseded');
		problemOf(await t.staff('POST', `/v1/admin/apps/${appId}/versions/2/approve`), 409, 'conflict');

		// v3 is superseded by v4 before review; v4 is rejected
		const v3 = structuredClone(v2);
		v3.trialHours = 24;
		p.setManifest(v3);
		await t.staff('POST', `/v1/admin/apps/${appId}/refresh`);
		const v4 = structuredClone(v3);
		v4.trialHours = 12;
		p.setManifest(v4);
		expect((await t.staff('POST', `/v1/admin/apps/${appId}/refresh`)).json.version).toMatchObject({
			version: 4,
			breaking: false,
		});
		expect((await t.staff('GET', `/v1/admin/apps/${appId}/versions/3`)).json.status).toBe('superseded');
		problemOf(await t.staff('POST', `/v1/admin/apps/${appId}/versions/4/reject`, { body: {} }), 422, 'validation_failed');
		const rejected = await t.staff('POST', `/v1/admin/apps/${appId}/versions/4/reject`, { body: { reason: 'typo' } });
		expect(rejected.json).toMatchObject({ status: 'rejected', review: { reason: 'typo' } });
		expect((await t.service().getApp(appId)).pendingVersion).toBeNull();
		problemOf(await t.staff('POST', `/v1/admin/apps/${appId}/versions/4/approve`), 409);
		problemOf(await t.staff('POST', `/v1/admin/apps/${appId}/versions/99/approve`), 404);
		problemOf(await t.staff('GET', `/v1/admin/apps/${appId}/versions/abc`), 404);
		problemOf(await t.staff('GET', `/v1/admin/apps/${appId}/versions/99`), 404);
		problemOf(await t.staff('POST', `/v1/admin/apps/${appId}/versions/4/approve`, { roles: ['support'] }), 403);

		// version list, newest first, paginated
		const page1 = await t.staff('GET', `/v1/admin/apps/${appId}/versions?limit=2`);
		expect(page1.json.items.map((/** @type {any} */ v) => [v.version, v.status])).toEqual([
			[4, 'rejected'],
			[3, 'superseded'],
		]);
		expect(page1.json.items[0]).not.toHaveProperty('manifest');
		const page2 = await t.staff('GET', `/v1/admin/apps/${appId}/versions?limit=2&cursor=${page1.json.nextCursor}`);
		expect(page2.json.items.map((/** @type {any} */ v) => v.version)).toEqual([2, 1]);
		expect(page2.json.hasMore).toBe(false);

		const actions = (await t.audit(appId)).map((a) => a.action);
		expect(actions).toEqual([
			'catalog.connection_code_created',
			'catalog.app_connected',
			'catalog.app_activated',
			'catalog.manifest_refreshed',
			'catalog.version_approved',
			'catalog.manifest_refreshed',
			'catalog.manifest_refreshed',
			'catalog.version_rejected',
		]);
	});

	it('requires a valid SS-Manifest-Signature on refreshes (rejected + alerted otherwise)', async () => {
		const { t, p, appId } = await setup();
		const v2 = serviceManifest();
		v2.product.version = '1.1.0';
		v2.trialHours = 48;
		p.setManifest(v2);
		/** @type {Array<[any, string]>} */
		const cases = [
			['omit', 'manifest_signature_missing'],
			['garbage', 'manifest_signature_malformed'],
			['other_app', 'manifest_signature_issuer'],
			['stale', 'manifest_signature_expired'],
			['other_manifest', 'manifest_signature_signature'],
			['foreign_key', 'manifest_signature_unknown_kid'],
		];
		let version = 1;
		for (const [tamper, reason] of cases) {
			p.tamper.signature = tamper;
			const res = await t.staff('POST', `/v1/admin/apps/${appId}/refresh`);
			version += 1;
			expect(res.json, tamper).toMatchObject({
				changed: false,
				rejected: true,
				reason,
				version: { version, status: 'rejected', source: 'refresh', review: { by: 'catalog', reason } },
			});
		}
		// the same refusal again is not stored twice
		const again = await t.staff('POST', `/v1/admin/apps/${appId}/refresh`);
		expect(again.json).toMatchObject({ rejected: true, version: { version } });
		expect(await t.service().getApp(appId)).toMatchObject({ currentVersion: 1, pendingVersion: null });
		expect(t.entries.filter((e) => e.msg === 'catalog alert: refreshed manifest refused')).toHaveLength(cases.length);
		expect((await t.audit(appId)).filter((a) => a.action === 'catalog.manifest_signature_rejected')).toHaveLength(cases.length);
		expect(await t.service().refreshAll()).toMatchObject({ checked: 1, rejected: 1 });
		// revoked app keys cannot sign either
		p.tamper.signature = undefined;
		await t.staff('POST', `/v1/admin/apps/${appId}/keys/product-k1/revoke`, { body: { reason: 'leaked' } });
		expect((await t.staff('POST', `/v1/admin/apps/${appId}/refresh`)).json).toMatchObject({
			rejected: true,
			reason: 'manifest_signature_no_keys',
		});
	});

	it('accepts a correctly signed refresh', async () => {
		const { t, p, appId } = await setup();
		const v2 = serviceManifest();
		v2.product.version = '1.1.0';
		p.setManifest(v2);
		expect((await t.staff('POST', `/v1/admin/apps/${appId}/refresh`)).json).toMatchObject({
			changed: true,
			version: { version: 2, status: 'pending' },
		});
	});

	it('refuses refreshes that change identity or reach invalid manifests, and survives integration failures', async () => {
		const { t, p, appId } = await setup();
		const renamed = serviceManifest();
		renamed.product.slug = 'coupons-two';
		p.setManifest(renamed);
		problemOf(await t.staff('POST', `/v1/admin/apps/${appId}/refresh`), 422, 'invalid_manifest');
		const broken = serviceManifest();
		broken.elements = [];
		p.setManifest(broken);
		problemOf(await t.staff('POST', `/v1/admin/apps/${appId}/refresh`), 422, 'invalid_manifest');
		problemOf(await t.staff('POST', '/v1/admin/apps/app_missing/refresh'), 404, 'not_found');

		t.integration?.failOnce();
		expect((await lifecycle(t, appId, { action: 'activate' })).status).toBe(200);
		expect(t.entries.some((e) => e.msg === 'manifest.accepted emission failed')).toBe(true);
	});

	it('works without an integration module', async () => {
		const { t, appId } = await setup({ integration: null });
		expect((await lifecycle(t, appId, { action: 'activate' })).json.status).toBe('active');
	});

	it('refreshes with the catalog_refresh admin operation, resumable with `after`', async () => {
		const { t, p, appId } = await setup();
		await lifecycle(t, appId, { action: 'activate' });
		const changed = serviceManifest();
		changed.trialHours = 72;
		p.setManifest(changed);
		const run = await t.staff('POST', '/v1/admin/operations/catalog_refresh');
		expect(run.json).toMatchObject({ status: 'ok', stats: { checked: 1, changed: 1, resumeAfter: null } });
		expect((await t.service().getApp(appId)).pendingVersion).toBe(2);
		// a pass cut by its deadline resumes after the last app it handled: the operation again with `after`
		expect(await t.service().refreshAll({ after: appId })).toMatchObject({ checked: 0, resumeAfter: null });
		const resumed = await /** @type {any} */ (t).portal.operations.run('catalog_refresh', { input: { after: '' } });
		expect(resumed.stats).toMatchObject({ checked: 1 });

		// failures are counted, not thrown; an exhausted deadline skips the rest
		p.setManifest({ ...changed, elements: [] });
		expect(await t.service().refreshAll()).toMatchObject({ checked: 1, failed: 1 });
		expect(await t.service().refreshAll({ deadline: 0 })).toMatchObject({ checked: 0, skipped: 1 });
		p.setManifest(changed);
		expect(await t.service().refreshAll()).toMatchObject({ checked: 1, unchanged: 1 });
	});
});

describe('lifecycle and environments', () => {
	it('deprecates with a sunset, retires on read after it and stops authenticating the product', async () => {
		const { t, p, appId } = await setup();
		problemOf(
			await lifecycle(t, appId, {
				action: 'deprecate',
				sunsetAt: new Date(t.clock.now() + 2 * DAY).toISOString(),
				reason: 'eol',
			}),
			409,
		);
		await lifecycle(t, appId, { action: 'activate' });
		problemOf(await lifecycle(t, appId, { action: 'retire', reason: 'eol' }), 409);
		problemOf(await lifecycle(t, appId, { action: 'deprecate', sunsetAt: 'soon', reason: 'eol' }), 409);
		const sunsetAt = new Date(t.clock.now() + 2 * DAY).toISOString();
		const deprecated = await lifecycle(t, appId, { action: 'deprecate', sunsetAt, reason: 'replaced by coupons v2' });
		expect(deprecated.json).toMatchObject({ status: 'deprecated', sunsetAt });
		problemOf(await lifecycle(t, appId, { action: 'retire', reason: 'early' }), 409);
		expect((await t.service().activeProducts()).map((e) => [e.slug, e.status])).toEqual([['coupons', 'deprecated']]);
		expect(await t.service().activeProducts({ includeDeprecated: false })).toEqual([]);

		t.clock.advance(3 * DAY);
		// retired on read once the sunset has passed (no job)
		expect((await t.service().getApp(appId)).status).toBe('retired');
		expect((await t.service().getApp(appId)).status).toBe('retired');
		expect(await t.service().activeProducts()).toEqual([]);
		problemOf(
			await t.call('POST', '/v1/product/heartbeat', {
				bearer: await t.assertion(p.signer, appId),
				body: { version: '1', status: 'ok' },
			}),
			401,
		);
		problemOf(await t.staff('POST', `/v1/admin/apps/${appId}/refresh`), 409);
		problemOf(await lifecycle(t, appId, { action: 'activate' }), 409);
		expect((await t.audit(appId)).at(-1)).toMatchObject({
			action: 'catalog.app_retired',
			actor: { type: 'system', id: 'catalog' },
		});
	});

	it('force-retires and retires pending apps', async () => {
		const a = await setup();
		await lifecycle(a.t, a.appId, { action: 'activate' });
		await lifecycle(a.t, a.appId, {
			action: 'deprecate',
			sunsetAt: new Date(a.t.clock.now() + 5 * DAY).toISOString(),
			reason: 'x',
		});
		expect((await lifecycle(a.t, a.appId, { action: 'retire', reason: 'incident', force: true })).json.status).toBe('retired');
		const b = await setup();
		expect((await lifecycle(b.t, b.appId, { action: 'retire', reason: 'never shipped' })).json.status).toBe('retired');
		problemOf(await lifecycle(b.t, b.appId, { action: 'nuke' }), 422, 'validation_failed');
	});

	it('manages environments with the same SSRF policy', async () => {
		const { t, p, appId } = await setup();
		const set = await t.staff('PUT', `/v1/admin/apps/${appId}/environments`, { body: { staging: `${p.url}/staging/` } });
		expect(set.json.environments).toEqual({ production: p.url, staging: `${p.url}/staging` });
		problemOf(
			await t.staff('PUT', `/v1/admin/apps/${appId}/environments`, { body: { production: 'https://10.0.0.1' } }),
			422,
			'catalog_target_refused',
		);
		problemOf(await t.staff('PUT', `/v1/admin/apps/${appId}/environments`, { body: {} }), 422, 'validation_failed');
		const cleared = await t.staff('PUT', `/v1/admin/apps/${appId}/environments`, {
			body: { staging: null, production: p.url },
		});
		expect(cleared.json.environments.staging).toBeNull();
		expect((await t.audit(appId)).filter((a) => a.action === 'catalog.environments_set')).toHaveLength(2);
	});
});

describe('product calls: heartbeat, key rotation, revocation', () => {
	it('rotates keys with a 7-day overlap and refuses duplicates', async () => {
		const { t, p, appId } = await setup();
		const { privateJwk, publicJwk } = await generateSigningKey({ kid: 'product-k2' });
		const k2 = createSigner(privateJwk);
		const rotated = await t.call('POST', '/v1/product/keys/rotate', {
			bearer: await t.assertion(p.signer, appId),
			body: { publicJwk },
		});
		expect(rotated.json).toEqual({
			kid: 'product-k2',
			kids: ['product-k1', 'product-k2'],
			previousValidUntil: new Date(t.clock.now() + KEY_OVERLAP_MS).toISOString(),
		});
		problemOf(
			await t.call('POST', '/v1/product/keys/rotate', { bearer: await t.assertion(k2, appId), body: { publicJwk } }),
			409,
		);
		problemOf(
			await t.call('POST', '/v1/product/keys/rotate', {
				bearer: await t.assertion(k2, appId),
				body: { publicJwk: { ...publicJwk, kid: 'same-key' } },
			}),
			409,
		);
		problemOf(
			await t.call('POST', '/v1/product/keys/rotate', {
				bearer: await t.assertion(k2, appId),
				body: { publicJwk: { kty: 'RSA' } },
			}),
			422,
		);
		problemOf(await t.call('POST', '/v1/product/keys/rotate', { bearer: await t.assertion(k2, appId), body: {} }), 422);
		// any authenticated product call marks the app as seen (no periodic heartbeat needed, F.19)
		expect((await t.service().getApp(appId)).health).toMatchObject({
			lastHeartbeatAt: null,
			lastSeenAt: new Date(t.clock.now()).toISOString(),
			stale: false,
		});

		const beat = { version: '1.4.0', status: 'ok' };
		// both keys verify during the overlap
		expect(
			(await t.call('POST', '/v1/product/heartbeat', { bearer: await t.assertion(p.signer, appId), body: beat })).status,
		).toBe(200);
		expect((await t.call('POST', '/v1/product/heartbeat', { bearer: await t.assertion(k2, appId), body: beat })).status).toBe(
			200,
		);
		t.clock.advance(KEY_OVERLAP_MS - 60_000);
		expect(
			(await t.call('POST', '/v1/product/heartbeat', { bearer: await t.assertion(p.signer, appId), body: beat })).status,
		).toBe(200);
		t.clock.advance(2 * 60_000);
		problemOf(await t.call('POST', '/v1/product/heartbeat', { bearer: await t.assertion(p.signer, appId), body: beat }), 401);
		expect((await t.call('POST', '/v1/product/heartbeat', { bearer: await t.assertion(k2, appId), body: beat })).status).toBe(
			200,
		);
		const keys = (await t.staff('GET', `/v1/admin/apps/${appId}`)).json.keys;
		expect(keys.map((/** @type {any} */ k) => [k.kid, k.usable, k.source])).toEqual([
			['product-k1', false, 'connection'],
			['product-k2', true, 'rotation'],
		]);

		// staff revocation wins immediately
		const revoked = await t.staff('POST', `/v1/admin/apps/${appId}/keys/product-k2/revoke`, { body: { reason: 'leaked' } });
		expect(revoked.json.keys.find((/** @type {any} */ k) => k.kid === 'product-k2')).toMatchObject({
			status: 'revoked',
			revoked: { reason: 'leaked' },
		});
		problemOf(await t.call('POST', '/v1/product/heartbeat', { bearer: await t.assertion(k2, appId), body: beat }), 401);
		problemOf(await t.staff('POST', `/v1/admin/apps/${appId}/keys/product-k2/revoke`, { body: { reason: 'again' } }), 404);
		problemOf(await t.staff('POST', `/v1/admin/apps/${appId}/keys/product-k2/revoke`, { body: {} }), 422);
		expect((await t.audit(appId)).map((a) => a.action)).toEqual([
			'catalog.connection_code_created',
			'catalog.app_connected',
			'catalog.key_rotated',
			'catalog.key_revoked',
		]);
	});

	it('caps the number of keys and validates heartbeats', async () => {
		const { t, p, appId } = await setup();
		let signer = p.signer;
		for (let i = 2; i <= MAX_ACTIVE_KEYS; i += 1) {
			const { privateJwk, publicJwk } = await generateSigningKey({ kid: `k${i}` });
			expect(
				(await t.call('POST', '/v1/product/keys/rotate', { bearer: await t.assertion(signer, appId), body: { publicJwk } }))
					.status,
			).toBe(200);
			signer = createSigner(privateJwk);
		}
		const { publicJwk } = await generateSigningKey({ kid: 'one-too-many' });
		problemOf(
			await t.call('POST', '/v1/product/keys/rotate', { bearer: await t.assertion(signer, appId), body: { publicJwk } }),
			409,
		);
		problemOf(
			await t.call('POST', '/v1/product/heartbeat', { bearer: await t.assertion(signer, appId), body: { status: 'OK!' } }),
			422,
		);
		problemOf(
			await t.call('POST', '/v1/product/heartbeat', {
				bearer: await t.assertion(signer, 'app_unknown'),
				body: { version: '1', status: 'ok' },
			}),
			401,
		);
		problemOf(
			await t.call('POST', '/v1/product/heartbeat', { bearer: 'not.a.jwt', body: { version: '1', status: 'ok' } }),
			401,
		);
		// the port ignores junk app ids
		expect(await t.service().appKeys('')).toBeNull();
	});
});

describe('launches', () => {
	it('issues every kind, verifiable with @ss/protocol verifyLaunch', async () => {
		const { t, p, appId } = await setup({ modules: [fakeCommerce([])] });
		await lifecycle(t, appId, { action: 'activate' });

		/** @param {any} res */
		const tokenOf = (res) => {
			expect(res.status, JSON.stringify(res.json)).toBe(200);
			const url = new URL(res.json.url);
			expect(`${url.origin}${url.pathname}`).toBe(`${p.url}/sso`);
			return /** @type {string} */ (url.searchParams.get('launch'));
		};

		// merchant (merchant console)
		const merchantCookie = await t.session({ kind: 'merchant', subject: 'usr_owner', roles: ['owner'], merchantId: MERCHANT });
		const merchant = await t.call('POST', `/v1/merchants/${MERCHANT}/apps/${appId}/launch`, {
			cookie: merchantCookie,
			body: { websiteId: WEBSITE },
		});
		const m = await t.verify(tokenOf(merchant), appId);
		expect(m).toMatchObject({
			kind: 'merchant',
			sub: 'usr_owner',
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

		// impersonation session in the merchant console → impersonate launch
		const viaCookie = await t.session({
			kind: 'merchant',
			subject: 'usr_owner',
			roles: ['owner'],
			merchantId: MERCHANT,
			via: { type: 'staff', id: 'stf_bob' },
		});
		const imp = await t.verify(
			tokenOf(await t.call('POST', `/v1/merchants/${MERCHANT}/apps/${appId}/launch`, { cookie: viaCookie, body: {} })),
			appId,
		);
		expect(imp).toMatchObject({ kind: 'impersonate', sub: 'usr_owner', act: { sub: 'stf_bob' } });

		// staff kinds
		const staffLaunch = (/** @type {any} */ body, /** @type {string[]} */ roles = ['admin']) =>
			t.staff('POST', `/v1/admin/apps/${appId}/launch`, { body, roles });
		const admin = await t.verify(tokenOf(await staffLaunch({ kind: 'admin', merchantId: MERCHANT })), appId);
		expect(admin).toMatchObject({
			kind: 'admin',
			sub: 'stf_alice',
			user: { id: 'stf_alice', roles: ['admin'] },
			scope: { merchantId: MERCHANT },
		});
		const impersonate = await t.verify(
			tokenOf(
				await staffLaunch({ kind: 'impersonate', merchantId: MERCHANT, subject: 'usr_owner', impersonationSeconds: 900 }),
			),
			appId,
		);
		expect(impersonate).toMatchObject({ kind: 'impersonate', sub: 'usr_owner', act: { sub: 'stf_alice' } });
		expect(/** @type {number} */ (impersonate.impExp) - impersonate.iat).toBe(900);
		expect(await t.verify(tokenOf(await staffLaunch({ kind: 'demo' })), appId)).toMatchObject({ kind: 'demo', scope: {} });
		expect(await t.verify(tokenOf(await staffLaunch({ kind: 'partner', partnerId: 'par_1' })), appId)).toMatchObject({
			kind: 'partner',
			scope: { partnerId: 'par_1' },
		});
		expect(await t.verify(tokenOf(await staffLaunch({ kind: 'developer', developerId: 'dev_1' })), appId)).toMatchObject({
			kind: 'developer',
		});
		// app-wide admin launch: platform.launch.admin plus the superadmin/admin role
		const wide = await t.verify(tokenOf(await staffLaunch({ kind: 'admin', all: true })), appId);
		expect(wide).toMatchObject({ kind: 'admin', sub: 'stf_alice', scope: { all: true } });
		expect(wide.scope).not.toHaveProperty('merchantId');
		problemOf(await staffLaunch({ kind: 'admin', all: true }, ['support']), 403, 'forbidden');
		problemOf(await staffLaunch({ kind: 'admin', all: true, merchantId: MERCHANT }), 422, 'validation_failed');

		// kind rules and permissions
		problemOf(await staffLaunch({ kind: 'impersonate', merchantId: MERCHANT, subject: 'usr_owner' }, ['support']), 403);
		expect((await staffLaunch({ kind: 'admin', merchantId: MERCHANT }, ['support'])).status).toBe(200);
		problemOf(await staffLaunch({ kind: 'merchant', merchantId: MERCHANT }), 403);
		problemOf(await staffLaunch({ kind: 'impersonate', merchantId: MERCHANT }), 422);
		problemOf(await staffLaunch({ kind: 'admin' }), 422, 'catalog_launch_refused');
		problemOf(await staffLaunch({ kind: 'demo', merchantId: MERCHANT }), 422, 'catalog_launch_refused');
		problemOf(
			await staffLaunch({ kind: 'admin', merchantId: MERCHANT, environment: 'staging' }),
			422,
			'catalog_launch_refused',
		);
		problemOf(
			await staffLaunch({ kind: 'impersonate', merchantId: MERCHANT, subject: 'stf_alice' }),
			422,
			'catalog_launch_refused',
		);
		problemOf(
			await staffLaunch({ kind: 'impersonate', merchantId: MERCHANT, subject: 'usr_owner', impersonationSeconds: 5000 }),
			422,
		);
		await t.staff('PUT', `/v1/admin/apps/${appId}/environments`, { body: { staging: `${p.url}/stg` } });
		const staging = await staffLaunch({ kind: 'admin', merchantId: MERCHANT, environment: 'staging' });
		expect(staging.json.url.startsWith(`${p.url}/stg/sso?launch=`)).toBe(true);

		// staff launches are audited
		const launches = (await t.audit(appId)).filter((a) => a.action === 'catalog.launch_issued');
		expect(launches.map((a) => a.after.kind)).toEqual([
			'impersonate',
			'admin',
			'impersonate',
			'demo',
			'partner',
			'developer',
			'admin',
			'admin',
			'admin',
		]);
		expect(launches[0]).toMatchObject({ actor: { id: 'stf_bob' }, merchantId: MERCHANT });
		expect(launches[6]).toMatchObject({ merchantId: null, after: { kind: 'admin', scope: 'all' } });
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
		await lifecycle(t, appId, { action: 'activate' });
		const cookie = await t.session({ kind: 'merchant', subject: 'usr_owner', roles: ['owner'], merchantId: MERCHANT });
		const res = await t.call('POST', `/v1/merchants/${MERCHANT}/apps/${appId}/launch`, {
			cookie,
			body: { websiteId: WEBSITE },
		});
		const claims = await t.verify(/** @type {string} */ (new URL(res.json.url).searchParams.get('launch')), appId);
		expect(claims.subscriptions).toEqual([{ subscriptionId: SUB, websiteId: WEBSITE, status: 'active' }]);
	});

	it('refuses launches for pending, retired and unknown apps', async () => {
		const { t, appId } = await setup();
		const cookie = await t.session({ kind: 'merchant', subject: 'usr_owner', roles: ['owner'], merchantId: MERCHANT });
		problemOf(
			await t.call('POST', `/v1/merchants/${MERCHANT}/apps/${appId}/launch`, { cookie, body: {} }),
			422,
			'catalog_launch_refused',
		);
		expect(
			(await t.staff('POST', `/v1/admin/apps/${appId}/launch`, { body: { kind: 'admin', merchantId: MERCHANT } })).status,
		).toBe(200);
		await lifecycle(t, appId, { action: 'retire', reason: 'x' });
		problemOf(await t.staff('POST', `/v1/admin/apps/${appId}/launch`, { body: { kind: 'admin', merchantId: MERCHANT } }), 422);
		problemOf(await t.call('POST', `/v1/merchants/${MERCHANT}/apps/app_nope/launch`, { cookie, body: {} }), 404);
	});

	it('consumes launches once (shared replay store)', async () => {
		const { t, p, appId } = await setup();
		await lifecycle(t, appId, { action: 'activate' });
		const launch = await t.service().issueLaunch({ kind: 'demo', appId, subject: 'usr_x', user: { id: 'usr_x' } });
		const consume = async (/** @type {string} */ jti, signer = p.signer, app = appId) =>
			t.call('POST', '/v1/product/launch/consume', { bearer: await t.assertion(signer, app), body: { jti, exp: 1 } });
		expect((await consume(launch.jti)).json).toEqual({ consumed: true });
		expect((await consume(launch.jti)).json).toEqual({ consumed: false });
		expect((await consume('unknown-jti-0123456789')).json).toEqual({ consumed: false });
		problemOf(await consume('x'), 422);

		// another app cannot consume this app's launch
		const other = await startFakeProduct({
			manifest: renamedService('coupons-b'),
			portalUrl: PORTAL_URL,
			now: t.clock.now,
		});
		products.push(other);
		const reg = await t.register(other);
		expect(reg.status, JSON.stringify(reg.json)).toBe(201);
		const second = await t.service().issueLaunch({ kind: 'demo', appId, subject: 'usr_x', user: { id: 'usr_x' } });
		expect((await consume(second.jti, other.signer, reg.json.appId)).json).toEqual({ consumed: false });

		// expired launches cannot be consumed
		t.clock.advance(2 * 60_000);
		expect((await consume(second.jti)).json).toEqual({ consumed: false });
	});
});
