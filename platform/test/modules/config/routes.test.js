import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startMongo } from '../../helpers.js';
import { boot } from './boot.js';
import { APP, MER_A, MER_B, SUB_A1, SUB_A2, SUB_B1, WEB_A1, WEB_A2, WEB_B1 } from './fixtures.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

/** @type {Awaited<ReturnType<typeof startMongo>>} */
let mongo;
/** @type {Awaited<ReturnType<typeof boot>>} */
let app;
/** @type {Record<string, string>} */
const as = {};

beforeAll(async () => {
	mongo = await startMongo();
	app = await boot({ db: mongo.db('cfg_routes') });
	as.ownerA = await app.login({ kind: 'merchant', subject: MER_A });
	as.ownerB = await app.login({ kind: 'merchant', subject: MER_B });
	as.staff = await app.login({ kind: 'admin', subject: 'adm_owner' });
	as.support = await app.login({ kind: 'admin', subject: 'adm_support' });
	as.finance = await app.login({ kind: 'admin', subject: 'adm_finance' });
}, 120_000);
afterAll(async () => {
	await mongo?.stop();
});

const SUB = `/v1/merchants/${MER_A}/websites/${WEB_A1}/subscriptions/${SUB_A1}/config`;
const ADMIN = `/v1/admin/subscriptions/${SUB_A1}/config`;
const PLATFORM = `/v1/admin/config/platform/${APP}`;

describe('merchant console routes', () => {
	it('reads, patches, pages history, rolls back and previews a website subscription', async () => {
		const { call } = app;
		const patched = await call('PATCH', SUB, {
			cookie: as.ownerA,
			body: { elements: { codes: true }, config: { codes: { prefix: 'R1' } }, reason: 'go live' },
		});
		expect(patched).toMatchObject({ status: 200, json: { version: 1, unchanged: false } });
		await call('PATCH', SUB, { cookie: as.support, body: { config: { codes: { prefix: 'R2' } } } });
		const invalid = await call('PATCH', SUB, { cookie: as.ownerA, body: { features: { 'codes.maxActive': { value: -1 } } } });
		expect(invalid.status).toBe(422);
		expect(invalid.json.errors[0]).toMatchObject({ path: '/features/codes.maxActive', code: 'invalid_value' });
		const notObject = await call('PATCH', SUB, { cookie: as.ownerA, body: [1] });
		expect(notObject.status).toBe(422);

		const overview = await call('GET', SUB, { cookie: as.support });
		expect(overview.json).toMatchObject({
			subscriptionId: SUB_A1,
			websiteId: WEB_A1,
			version: 2,
			layers: { website: { features: { 'codes.prefix': { value: 'R2' } } } },
		});
		const page = await call('GET', `${SUB}/history?limit=1`, { cookie: as.ownerA });
		expect(page.json.items.map((/** @type {any} */ i) => i.version)).toEqual([2]);
		const next = await call('GET', `${SUB}/history?limit=1&cursor=${page.json.nextCursor}`, { cookie: as.ownerA });
		expect(next.json.items[0]).toMatchObject({ version: 1, reason: 'go live' });
		expect((await call('GET', `${SUB}/history?limit=abc`, { cookie: as.ownerA })).json.items).toHaveLength(2);

		const back = await call('POST', `${SUB}/rollback`, { cookie: as.ownerA, body: { version: 1, reason: 'revert' } });
		expect(back.json).toMatchObject({ version: 3 });
		const preview = await call('POST', `${SUB}/preview`, {
			cookie: as.ownerA,
			body: { change: { config: { codes: { maxActive: 99 } } } },
		});
		expect(preview.status).toBe(200);
		expect(preview.json.preview.features['codes.maxActive']).toMatchObject({ value: 50, reason: 'clamped' });
		const previewPlatform = await call('POST', `${SUB}/preview`, {
			cookie: as.staff,
			body: { level: 'platform', change: {} },
		});
		expect(previewPlatform.json.level).toBe('platform');
	});
});

describe('admin console routes', () => {
	it('sets admin overrides and locks, policies across merchants, with reasons', async () => {
		const { call } = app;
		expect((await call('PATCH', ADMIN, { cookie: as.staff, body: { config: { codes: { maxActive: 5000 } } } })).status).toBe(
			422,
		); // reason required
		const override = await call('PATCH', ADMIN, {
			cookie: as.staff,
			body: { config: { codes: { maxActive: 5000 } }, reason: 'enterprise' },
		});
		expect(override.json).toMatchObject({ version: 1, target: { level: 'admin' } });
		const websiteLevel = await call('PATCH', ADMIN, {
			cookie: as.staff,
			body: { level: 'website', features: { 'codes.note': { value: 'staff' } } },
		});
		expect(websiteLevel.json.target.level).toBe('website');
		const lockWebsite = await call('PUT', `${ADMIN}/locks`, {
			cookie: as.staff,
			body: { level: 'website', features: { 'codes.prefix': true } },
		});
		expect(lockWebsite.status).toBe(200);
		const nonLockable = await call('PUT', `${ADMIN}/locks`, {
			cookie: as.staff,
			body: { level: 'website', features: { 'codes.note': true } },
		});
		expect(nonLockable.json.errors[0].code).toBe('not_lockable');
		const lockMerchant = await call('PUT', `${ADMIN}/locks`, {
			cookie: as.staff,
			body: { level: 'merchant', features: { 'codes.prefix': true }, elements: {} },
		});
		expect(lockMerchant.status).toBe(422);
		const lockAdmin = await call('PUT', `${ADMIN}/locks`, {
			cookie: as.staff,
			body: { features: { 'codes.maxActive': true }, reason: 'contract' },
		});
		expect(lockAdmin.json.target.level).toBe('admin');
		// the merchant now cannot change the locked website value
		const frozen = await call('PATCH', SUB, { cookie: as.ownerA, body: { config: { codes: { prefix: 'NOPE' } } } });
		expect(frozen.json.errors[0].code).toBe('locked');
		expect((await call('GET', ADMIN, { cookie: as.support })).json.layers.admin.features['codes.maxActive']).toEqual({
			value: 5000,
			locked: true,
		});
		expect((await call('PATCH', ADMIN, { cookie: as.support, body: {} })).status).toBe(403);
		expect((await call('GET', `${ADMIN}/history`, { cookie: as.staff })).json.items).toHaveLength(2);
		expect((await call('GET', `${ADMIN}/history?level=website`, { cookie: as.staff })).json.items.length).toBeGreaterThan(0);
		expect(
			(await call('POST', `${ADMIN}/rollback`, { cookie: as.staff, body: { version: 1, reason: 'unlock' } })).json.version,
		).toBe(3);
		expect((await call('POST', `${ADMIN}/rollback`, { cookie: as.staff, body: { level: 'website', version: 0 } })).status).toBe(
			200,
		);

		const policy = await call('PATCH', PLATFORM, {
			cookie: as.staff,
			body: { features: { 'codes.allowStacking': { value: false, locked: true } }, reason: 'fraud' },
		});
		expect(policy.json.version).toBe(1);
		expect((await call('GET', PLATFORM, { cookie: as.support })).json.state.features['codes.allowStacking']).toEqual({
			value: false,
			locked: true,
		});
		expect((await call('GET', `${PLATFORM}/history`, { cookie: as.staff })).json.items).toHaveLength(1);
		expect(
			(await call('POST', `${PLATFORM}/rollback`, { cookie: as.staff, body: { version: 0, reason: 'lift' } })).json.version,
		).toBe(2);
		expect((await call('PATCH', PLATFORM, { cookie: as.support, body: {} })).status).toBe(403);
	});
});

describe('tenant isolation', () => {
	const B_SUB_UNDER_A = `/v1/merchants/${MER_A}/websites/${WEB_B1}/subscriptions/${SUB_B1}/config`;
	const OTHER_WEBSITE = `/v1/merchants/${MER_A}/websites/${WEB_A1}/subscriptions/${SUB_A2}/config`;
	/** @type {Array<[string, string, unknown?]>} */
	const subRoutes = [
		['GET', ''],
		['PATCH', '', { elements: { codes: true } }],
		['GET', '/history'],
		['POST', '/rollback', { version: 0 }],
		['POST', '/preview', { change: {} }],
	];
	/** @type {Array<[string, string, unknown?]>} */
	const merchantRoutes = [...subRoutes.map(([m, p, b]) => /** @type {[string, string, unknown?]} */ ([m, `${SUB}${p}`, b]))];
	/** @type {Array<[string, string, unknown?]>} */
	const adminRoutes = [
		['GET', ADMIN],
		['PATCH', ADMIN, {}],
		['PUT', `${ADMIN}/locks`, {}],
		['GET', `${ADMIN}/history`],
		['POST', `${ADMIN}/rollback`, { version: 0 }],
		['GET', PLATFORM],
		['PATCH', PLATFORM, {}],
		['GET', `${PLATFORM}/history`],
		['POST', `${PLATFORM}/rollback`, { version: 0 }],
	];

	it("another merchant's users are refused on every merchant route", async () => {
		for (const [method, path, body] of merchantRoutes) {
			const res = await app.call(method, path, { cookie: as.ownerB, body });
			expect([method, path, res.status]).toEqual([method, path, 403]);
		}
	});

	it('a merchant cannot reach another merchant’s (or another website’s) subscription through its own paths', async () => {
		for (const base of [B_SUB_UNDER_A, OTHER_WEBSITE]) {
			for (const [method, path, body] of subRoutes) {
				const res = await app.call(method, `${base}${path}`, { cookie: as.ownerA, body });
				expect([method, `${base}${path}`, res.status]).toEqual([method, `${base}${path}`, 404]);
			}
		}
	});

	it('Finance never reads or edits settings (PLAN 0.2)', async () => {
		const other = `/v1/merchants/${MER_A}/websites/${WEB_A2}/subscriptions/${SUB_A2}/config`;
		for (const [method, path, body] of subRoutes) {
			const res = await app.call(method, `${other}${path}`, { cookie: as.finance, body });
			expect([method, path, res.status]).toEqual([method, path, 403]);
		}
	});

	it('merchant users never reach admin routes; unauthenticated calls are refused', async () => {
		for (const [method, path, body] of adminRoutes) {
			expect([path, (await app.call(method, path, { cookie: as.ownerA, body })).status]).toEqual([path, 401]);
			expect([path, (await app.call(method, path, { body })).status]).toEqual([path, 401]);
		}
		expect((await app.call('GET', SUB)).status).toBe(401);
	});
});
