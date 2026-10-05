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
	as.ownerA = await app.login({ kind: 'merchant', subject: 'usr_owner_a', merchantId: MER_A, roles: ['owner'] });
	as.ownerB = await app.login({ kind: 'merchant', subject: 'usr_owner_b', merchantId: MER_B, roles: ['owner'] });
	as.editorA1 = await app.login({
		kind: 'merchant',
		subject: 'usr_ed',
		merchantId: MER_A,
		roles: [],
		grants: [{ websiteId: WEB_A1, roles: ['editor'] }],
	});
	as.staff = await app.login({ kind: 'staff', subject: 'stf_admin', roles: ['admin'], mfa: true });
	as.support = await app.login({ kind: 'staff', subject: 'stf_support', roles: ['support'], mfa: true });
}, 120_000);
afterAll(async () => {
	await mongo?.stop();
});

const SUB = `/v1/merchants/${MER_A}/websites/${WEB_A1}/subscriptions/${SUB_A1}/config`;
const MERCHANT_APP = `/v1/merchants/${MER_A}/apps/${APP}/config`;
const TEMPLATES = `/v1/merchants/${MER_A}/config/templates`;
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
		await call('PATCH', SUB, { cookie: as.editorA1, body: { config: { codes: { prefix: 'R2' } } } });
		const invalid = await call('PATCH', SUB, { cookie: as.ownerA, body: { features: { 'codes.maxActive': { value: -1 } } } });
		expect(invalid.status).toBe(422);
		expect(invalid.json.errors[0]).toMatchObject({ path: '/features/codes.maxActive', code: 'invalid_value' });
		const notObject = await call('PATCH', SUB, { cookie: as.ownerA, body: [1] });
		expect(notObject.status).toBe(422);

		const overview = await call('GET', SUB, { cookie: as.editorA1 });
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
		const previewMerchant = await call('POST', `${SUB}/preview`, {
			cookie: as.ownerA,
			body: { level: 'merchant', change: {} },
		});
		expect(previewMerchant.json.level).toBe('merchant');
	});

	it('schedules, lists and cancels changes; manages experiments', async () => {
		const { call, clock } = app;
		const at = new Date(clock.now() + 3_600_000).toISOString();
		const scheduled = await call('POST', `${SUB}/schedules`, {
			cookie: as.ownerA,
			body: { change: { config: { codes: { prefix: 'LATER' } } }, at, reason: 'sale' },
		});
		expect(scheduled).toMatchObject({ status: 201, json: { status: 'pending' } });
		const noChange = await call('POST', `${SUB}/schedules`, { cookie: as.ownerA, body: { at } });
		expect(noChange.status).toBe(201);
		const list = await call('GET', `${SUB}/schedules`, { cookie: as.ownerA });
		expect(list.json.items).toHaveLength(2);
		const cancelled = await call('DELETE', `${SUB}/schedules/${scheduled.json.scheduleId}`, { cookie: as.ownerA });
		expect(cancelled.json.status).toBe('cancelled');

		const created = await call('POST', `${SUB}/experiments`, {
			cookie: as.ownerA,
			body: {
				element: 'codes',
				metric: 'order.placed@1',
				variants: [
					{ key: 'a', weight: 1, config: { prefix: 'A' } },
					{ key: 'b', weight: 1, config: { prefix: 'B' } },
				],
			},
		});
		expect(created.status).toBe(201);
		const id = created.json.experimentId;
		expect((await call('POST', `${SUB}/experiments/${id}/start`, { cookie: as.ownerA })).json.status).toBe('running');
		expect((await call('GET', `${SUB}/experiments`, { cookie: as.ownerA })).json.items[0].status).toBe('running');
		const stopped = await call('POST', `${SUB}/experiments/${id}/stop`, { cookie: as.ownerA, body: { applyVariant: 'a' } });
		expect(stopped.json).toMatchObject({ status: 'stopped', winner: 'a' });
	});

	it('manages merchant-wide app defaults and templates', async () => {
		const { call } = app;
		const patched = await call('PATCH', MERCHANT_APP, { cookie: as.ownerA, body: { config: { codes: { prefix: 'MER' } } } });
		expect(patched.json.version).toBe(1);
		await call('PATCH', MERCHANT_APP, { cookie: as.ownerA, body: { config: { codes: { prefix: 'MER2' } } } });
		expect((await call('GET', MERCHANT_APP, { cookie: as.ownerA })).json).toMatchObject({
			version: 2,
			state: { features: { 'codes.prefix': { value: 'MER2' } } },
		});
		expect((await call('GET', `${MERCHANT_APP}/history`, { cookie: as.ownerA })).json.items).toHaveLength(2);
		expect((await call('POST', `${MERCHANT_APP}/rollback`, { cookie: as.ownerA, body: { version: 1 } })).json.version).toBe(3);
		// a website-scoped editor cannot change merchant-wide defaults
		expect((await call('PATCH', MERCHANT_APP, { cookie: as.editorA1, body: {} })).status).toBe(403);

		const saved = await call('POST', TEMPLATES, {
			cookie: as.ownerA,
			body: { appId: APP, name: 'Base', settings: { config: { codes: { prefix: 'TPL' } } } },
		});
		expect(saved.status).toBe(201);
		const tid = saved.json.templateId;
		expect((await call('GET', `${TEMPLATES}?appId=${APP}`, { cookie: as.ownerA })).json.items).toHaveLength(1);
		expect((await call('GET', `${TEMPLATES}/${tid}`, { cookie: as.ownerA })).json.name).toBe('Base');
		const applied = await call('POST', `${TEMPLATES}/${tid}/apply`, {
			cookie: as.ownerA,
			body: { websiteIds: [WEB_A1, WEB_A2] },
		});
		expect(applied.json).toMatchObject({ applied: 2, failed: 0 });
		const put = await call('PUT', `${TEMPLATES}/${tid}`, {
			cookie: as.ownerA,
			body: { name: 'Base v2', settings: { config: { codes: { prefix: 'TPL2' } } } },
		});
		expect(put.json.version).toBe(2);
		const pushed = await call('POST', `${TEMPLATES}/${tid}/push`, { cookie: as.ownerA, body: {} });
		expect(pushed.json.applied).toBe(2);
	});

	it('applies templates only to websites the actor may write (website-scoped grants)', async () => {
		const { call } = app;
		const staffSaved = await app.service.saveTemplate({
			merchantId: MER_A,
			appId: APP,
			name: 'Scoped',
			settings: { elements: { codes: true } },
			actor: /** @type {any} */ ({ type: 'staff', id: 'stf_admin' }),
		});
		const limited = await app.login({
			kind: 'merchant',
			subject: 'usr_limited',
			merchantId: MER_A,
			roles: [],
			grants: [{ websiteId: WEB_A1, roles: ['editor'] }],
		});
		// merchant-level template routes need a merchant-wide grant
		expect(
			(await call('POST', `${TEMPLATES}/${staffSaved.templateId}/apply`, { cookie: limited, body: { websiteIds: [WEB_A1] } }))
				.status,
		).toBe(403);
		const merchantEditor = await app.login({ kind: 'merchant', subject: 'usr_med', merchantId: MER_A, roles: ['editor'] });
		const ok = await call('POST', `${TEMPLATES}/${staffSaved.templateId}/apply`, {
			cookie: merchantEditor,
			body: { websiteIds: [WEB_A1, WEB_A2] },
		});
		expect(ok.json.results.map((/** @type {any} */ r) => r.status)).toEqual(['unchanged', 'applied']); // codes was already on for WEB_A1
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
		expect(lockMerchant.json.target).toMatchObject({ level: 'merchant', merchantId: MER_A });
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
		['GET', '/schedules'],
		['POST', '/schedules', { change: {}, at: '2027-01-01T00:00:00Z' }],
		['DELETE', '/schedules/cfs_none'],
		['GET', '/experiments'],
		[
			'POST',
			'/experiments',
			{
				element: 'codes',
				metric: 'order.placed@1',
				variants: [
					{ key: 'a', weight: 1 },
					{ key: 'b', weight: 1 },
				],
			},
		],
		['POST', '/experiments/exp_none/start'],
		['POST', '/experiments/exp_none/stop'],
	];
	/** @type {Array<[string, string, unknown?]>} */
	const merchantRoutes = [
		['GET', MERCHANT_APP],
		['PATCH', MERCHANT_APP, {}],
		['GET', `${MERCHANT_APP}/history`],
		['POST', `${MERCHANT_APP}/rollback`, { version: 0 }],
		['GET', TEMPLATES],
		['POST', TEMPLATES, { appId: APP, name: 'x', settings: {} }],
		['GET', `${TEMPLATES}/cft_x`],
		['PUT', `${TEMPLATES}/cft_x`, {}],
		['POST', `${TEMPLATES}/cft_x/apply`, { websiteIds: [WEB_A1] }],
		['POST', `${TEMPLATES}/cft_x/push`, {}],
		...subRoutes.map(([m, p, b]) => /** @type {[string, string, unknown?]} */ ([m, `${SUB}${p}`, b])),
	];
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
		// a template of merchant A is invisible to merchant B, even with B's own paths
		const t = await app.service.saveTemplate({
			merchantId: MER_A,
			appId: APP,
			name: 'Secret',
			settings: {},
			actor: /** @type {any} */ ({ type: 'staff', id: 's' }),
		});
		const pathB = `/v1/merchants/${MER_B}/config/templates/${t.templateId}`;
		expect((await app.call('GET', pathB, { cookie: as.ownerB })).status).toBe(404);
		expect((await app.call('POST', `${pathB}/apply`, { cookie: as.ownerB, body: { websiteIds: [WEB_B1] } })).status).toBe(404);
		expect((await app.call('GET', `/v1/merchants/${MER_B}/apps/${APP}/config`, { cookie: as.ownerB })).json.state).toEqual({
			elements: {},
			features: {},
		});
	});

	it('a website-scoped editor is confined to its website', async () => {
		const other = `/v1/merchants/${MER_A}/websites/${WEB_A2}/subscriptions/${SUB_A2}/config`;
		for (const [method, path, body] of subRoutes) {
			const res = await app.call(method, `${other}${path}`, { cookie: as.editorA1, body });
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
