import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { normaliseProduct, resolveEntitlement } from '@ss/entitlements';
import { createPortal } from '../../../src/portal.js';
import { configModule } from '../../../src/modules/config/index.js';
import { createClock, createTestLogger, startMongo, testConfig } from '../../helpers.js';
import { boot } from './boot.js';
import { createFakes } from './fakes/index.js';
import { APP, MER_A, MER_B, SUB_A1, SUB_A2, SUB_B1, WEB_A1, manifest } from './fixtures.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

/** @type {Awaited<ReturnType<typeof startMongo>>} */
let mongo;
let n = 0;
beforeAll(async () => {
	mongo = await startMongo();
}, 120_000);
afterAll(async () => {
	await mongo?.stop();
});

/** @param {Parameters<typeof createFakes>[0]} [options] */
const fresh = (options) => {
	n += 1;
	return boot({ db: mongo.db(`cfg_svc_${n}`), fakes: createFakes(options) });
};

const staff = /** @type {any} */ ({ type: 'staff', id: 'stf_admin', roles: ['admin'] });
const merchantA = /** @type {any} */ ({ type: 'merchant_user', id: 'usr_a', merchantId: MER_A, roles: ['owner'] });

/**
 * @param {Promise<unknown>} promise
 * @returns {Promise<any>}
 */
const rejection = async (promise) => {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error('expected a rejection');
};

/** @param {any} error */
const codes = (error) => (error.errors ?? []).map((/** @type {any} */ e) => e.code);

describe('validation against feature schemas', () => {
	it('accepts values within absolute bounds (plan max is commerce’s job) and rejects bad ones', async () => {
		const { service } = await fresh();
		const target = { subscriptionId: SUB_A1 };
		const ok = await service.applyChange({
			target,
			level: 'website',
			actor: merchantA,
			change: {
				elements: { codes: true },
				features: { 'codes.maxActive': { value: 80 } },
				config: { codes: { prefix: 'VIP', window: { days: 7 } } },
			},
		});
		expect(ok).toMatchObject({ version: 1, unchanged: false });

		const badType = await rejection(
			service.applyChange({
				target,
				level: 'website',
				actor: merchantA,
				change: { features: { 'codes.maxActive': { value: 'many' } } },
			}),
		);
		expect([badType.code, codes(badType)]).toEqual(['validation_failed', ['invalid_value']]);
		const range = await rejection(
			service.applyChange({
				target,
				level: 'website',
				actor: merchantA,
				change: { config: { codes: { maxActive: 200_000 } } },
			}),
		);
		expect(range.errors[0]).toMatchObject({ path: '/features/codes.maxActive', code: 'invalid_value' });
		const nested = await rejection(
			service.applyChange({
				target,
				level: 'website',
				actor: merchantA,
				change: { config: { codes: { window: { days: 0 } } } },
			}),
		);
		expect(codes(nested)).toEqual(['invalid_value']);
		const element = await rejection(
			service.applyChange({ target, level: 'website', actor: merchantA, change: { elements: { codes: 'on' } } }),
		);
		expect(codes(element)).toEqual(['invalid_change']);
		const unknown = await rejection(
			service.applyChange({
				target,
				level: 'website',
				actor: merchantA,
				change: {
					elements: { ghost: true },
					features: { 'codes.ghost': { value: 1 }, 'ghost.x': { value: 1 }, nodot: { value: 1 } },
				},
			}),
		);
		expect(codes(unknown).sort()).toEqual(['unknown_element', 'unknown_element', 'unknown_feature', 'unknown_feature']);
		expect((await service.getLayer({ target, level: 'website' })).version).toBe(1); // nothing was written
	});

	it('enforces locks: staff only, lockable features only, locked entries frozen for merchants', async () => {
		const { service } = await fresh();
		const target = { subscriptionId: SUB_A1 };
		const merchantLock = await rejection(
			service.applyChange({
				target,
				level: 'website',
				actor: merchantA,
				change: { features: { 'codes.prefix': { value: 'A', locked: true } } },
			}),
		);
		expect(codes(merchantLock)).toEqual(['locked']);
		const nonLockable = await rejection(
			service.applyChange({
				target,
				level: 'admin',
				actor: staff,
				reason: 'policy',
				change: { features: { 'codes.note': { value: 'x', locked: true } } },
			}),
		);
		expect(nonLockable.errors[0]).toMatchObject({ path: '/features/codes.note/locked', code: 'not_lockable' });
		const lockWithoutValue = await rejection(
			service.applyChange({
				target,
				level: 'website',
				actor: staff,
				change: { locks: { features: { 'codes.prefix': true } } },
			}),
		);
		expect(codes(lockWithoutValue)).toEqual(['lock_without_value']);

		// staff locks a website value; the merchant can no longer change or remove it, but may change other keys
		await service.applyChange({
			target,
			level: 'website',
			actor: staff,
			change: { features: { 'codes.prefix': { value: 'STAFF', locked: true } } },
		});
		const frozen = await rejection(
			service.applyChange({
				target,
				level: 'website',
				actor: merchantA,
				change: { features: { 'codes.prefix': { value: 'MINE' } } },
			}),
		);
		expect(codes(frozen)).toEqual(['locked']);
		const removal = await rejection(
			service.applyChange({ target, level: 'website', actor: merchantA, change: { features: { 'codes.prefix': null } } }),
		);
		expect(codes(removal)).toEqual(['locked']);
		const other = await service.applyChange({
			target,
			level: 'website',
			actor: merchantA,
			change: { features: { 'codes.maxActive': { value: 3 } } },
		});
		expect(other.version).toBe(2);
		const unlocked = await service.applyChange({
			target,
			level: 'website',
			actor: staff,
			change: { locks: { features: { 'codes.prefix': false } } },
		});
		expect(unlocked.diff).toEqual([
			{
				kind: 'features',
				key: 'codes.prefix',
				op: 'changed',
				before: { value: 'STAFF', locked: true },
				after: { value: 'STAFF' },
			},
		]);
	});

	it('restricts staff levels to staff and requires a staff reason there', async () => {
		const { service } = await fresh();
		const forbidden = await rejection(
			service.applyChange({
				target: { subscriptionId: SUB_A1 },
				level: 'admin',
				actor: merchantA,
				change: { elements: { codes: true } },
			}),
		);
		expect(forbidden.code).toBe('forbidden');
		const platform = await rejection(
			service.applyChange({ target: { appId: APP }, level: 'platform', actor: merchantA, change: {} }),
		);
		expect(platform.code).toBe('forbidden');
		const noReason = await rejection(
			service.applyChange({ target: { appId: APP }, level: 'platform', actor: staff, change: { elements: { codes: true } } }),
		);
		expect(codes(noReason)).toEqual(['invalid_reason']);
		const badTarget = await rejection(
			service.applyChange({ target: { subscriptionId: 'nope' }, level: 'website', actor: staff, change: {} }),
		);
		expect(codes(badTarget)).toEqual(['invalid_target']);
		const missing = await rejection(
			service.applyChange({
				target: { subscriptionId: 'sub_zzzzzzzzzzzzzzzzzzzzzzzzzz' },
				level: 'website',
				actor: staff,
				change: {},
			}),
		);
		expect(missing.code).toBe('not_found');
		const otherApp = await rejection(
			service.applyChange({
				target: { appId: 'app_other' },
				level: 'platform',
				actor: staff,
				reason: 'policy',
				change: { elements: { x: true } },
			}),
		);
		expect(otherApp.code).toBe('not_found');
	});

	it('setOverride covers switches, values, config objects, locks and removal', async () => {
		const { service } = await fresh();
		const base = { level: /** @type {const} */ ('admin'), target: SUB_A1, actor: staff, reason: 'support case 12' };
		expect((await service.setOverride({ ...base, elementKey: 'codes', value: true })).version).toBe(1);
		expect((await service.setOverride({ ...base, elementKey: 'banner', value: false, lock: true })).version).toBe(2);
		expect((await service.setOverride({ ...base, featureKey: 'codes.maxActive', value: 5000 })).version).toBe(3);
		expect(
			(await service.setOverride({ ...base, elementKey: 'codes', featureKey: 'prefix', value: 'X', lock: true })).version,
		).toBe(4);
		expect((await service.setOverride({ ...base, elementKey: 'banner', value: { text: 'Hey' }, lock: true })).version).toBe(5);
		expect((await service.setOverride({ ...base, featureKey: 'codes.maxActive', lock: true })).version).toBe(6);
		expect((await service.setOverride({ ...base, elementKey: 'codes', lock: true })).version).toBe(7);
		expect((await service.setOverride({ ...base, featureKey: 'codes.prefix', clear: true })).version).toBe(8);
		expect((await service.setOverride({ ...base, elementKey: 'banner', clear: true })).version).toBe(9);
		const { state } = await service.getLayer({ target: SUB_A1, level: 'admin' });
		expect(state).toEqual({
			elements: { codes: { enabled: true, locked: true } },
			features: { 'codes.maxActive': { value: 5000, locked: true }, 'banner.text': { value: 'Hey', locked: true } },
		});
		const none = await rejection(service.setOverride({ ...base, value: 1 }));
		expect(codes(none)).toEqual(['invalid_change']);
	});
});

describe('versioning and rollback', () => {
	it('records immutable versions with diffs, pages history and rolls back as a new version', async () => {
		const { service, fakes, portal } = await fresh();
		const target = { subscriptionId: SUB_A1 };
		const w = /** @type {const} */ ('website');
		await service.applyChange({ target, level: w, actor: merchantA, reason: 'first', change: { elements: { codes: true } } });
		await service.applyChange({ target, level: w, actor: merchantA, change: { config: { codes: { prefix: 'B' } } } });
		await service.applyChange({
			target,
			level: w,
			actor: merchantA,
			change: { config: { codes: { prefix: 'C', maxActive: 9 } } },
		});
		const same = await service.applyChange({
			target,
			level: w,
			actor: merchantA,
			change: { config: { codes: { prefix: 'C' } } },
		});
		expect(same).toMatchObject({ version: 3, unchanged: true, diff: [] });

		const page1 = await service.history(target, { level: w, limit: 2 });
		expect(page1.items.map((i) => i.version)).toEqual([3, 2]);
		expect(page1.items[0]).toMatchObject({
			kind: 'change',
			actor: { type: 'merchant_user', id: 'usr_a', merchantId: MER_A },
			manifestVersion: '1.4.0',
		});
		expect(page1.items[0]?.diff.map((/** @type {any} */ d) => d.key)).toEqual(['codes.maxActive', 'codes.prefix']);
		const page2 = await service.history(target, { level: w, limit: 2, cursor: page1.nextCursor });
		expect(page2.items.map((i) => [i.version, i.reason])).toEqual([[1, 'first']]);
		expect(page2.nextCursor).toBeNull();
		await expect(service.history(target, { level: w, cursor: 'x' })).rejects.toMatchObject({ code: 'bad_request' });

		const v1 = (await service.getLayer({ target, level: w })).state;
		const back = await service.rollback({ target, level: w, version: 1, actor: merchantA, reason: 'oops' });
		expect(back.version).toBe(4);
		const after = await service.getLayer({ target, level: w });
		expect(after.state).toEqual({ elements: { codes: { enabled: true } }, features: {} });
		expect(v1).not.toEqual(after.state);
		const history = await service.history(target, { level: w });
		expect(history.items[0]).toMatchObject({ version: 4, kind: 'rollback', rollbackOf: 1, reason: 'oops' });
		// round trip: rolling back to 3 restores v3 exactly
		await service.rollback({ target, level: w, version: 3, actor: merchantA });
		expect((await service.getLayer({ target, level: w })).state.features).toEqual({
			'codes.prefix': { value: 'C' },
			'codes.maxActive': { value: 9 },
		});
		await service.rollback({ target, level: w, version: 0, actor: merchantA });
		expect((await service.getLayer({ target, level: w })).state).toEqual({ elements: {}, features: {} });
		expect((await rejection(service.rollback({ target, level: w, version: 99, actor: merchantA }))).code).toBe('not_found');
		expect(codes(await rejection(service.rollback({ target, level: w, version: -1, actor: merchantA })))).toEqual([
			'invalid_version',
		]);

		expect(fakes.invalidated.filter((s) => s === SUB_A1).length).toBe(6);
		const audit = await portal.shared.audit.list({ merchantId: MER_A });
		expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['config.changed', 'config.rolled_back']));
	});

	it('serialises concurrent writers and repairs a materialised layer left behind', async () => {
		const { service, db } = await fresh();
		const target = { subscriptionId: SUB_A2 };
		const results = await Promise.all(
			[1, 2, 3, 4, 5].map((i) =>
				service.applyChange({ target, level: 'website', actor: merchantA, change: { config: { codes: { maxActive: i } } } }),
			),
		);
		expect(results.map((r) => r.version).sort()).toEqual([1, 2, 3, 4, 5]);
		const versions = await db
			.collection('config_versions')
			.find({ targetKey: `website:${SUB_A2}` })
			.toArray();
		expect(versions.map((/** @type {any} */ v) => v.version).sort()).toEqual([1, 2, 3, 4, 5]);
		// simulate a crash between the version insert and the materialisation
		await db
			.collection('config_layers')
			.updateOne({ _id: `website:${SUB_A2}` }, { $set: { version: 2, state: { elements: [], features: [] } } });
		const repaired = await service.getLayer({ target, level: 'website' });
		expect(repaired.version).toBe(5);
		const latest = versions.find((/** @type {any} */ v) => v.version === 5);
		expect(repaired.state.features['codes.maxActive']).toEqual(
			latest?.state.features[0] && { value: latest.state.features[0].value },
		);
		expect((await db.collection('config_layers').findOne({ _id: `website:${SUB_A2}` }))?.version).toBe(5);
	});

	it('validates against the pinned manifest for subscriptions and the current one for platform policies', async () => {
		const { service, fakes } = await fresh();
		fakes.setCurrentVersion('1.5.0');
		await service.applyChange({
			target: { subscriptionId: SUB_A1 },
			level: 'website',
			actor: merchantA,
			change: { elements: { codes: true } },
		});
		await service.applyChange({
			target: { appId: APP },
			level: 'platform',
			actor: staff,
			reason: 'policy',
			change: { elements: { codes: true } },
		});
		expect((await service.history({ subscriptionId: SUB_A1 }, { level: 'website' })).items[0]?.manifestVersion).toBe('1.4.0');
		expect((await service.history({ appId: APP }, { level: 'platform' })).items[0]?.manifestVersion).toBe('1.5.0');
		expect(fakes.invalidated).toEqual([SUB_A1]);
	});
});

describe('contract with @ss/entitlements', () => {
	it('layersFor output resolves with resolveEntitlement exactly as configured', async () => {
		const { service, clock } = await fresh();
		// platform policy: lock stacking off for every merchant
		await service.applyChange({
			target: { appId: APP },
			level: 'platform',
			actor: staff,
			reason: 'fraud policy',
			change: { features: { 'codes.allowStacking': { value: false, locked: true } } },
		});
		// website override (above plan max 50 → clamped by the resolver, not here; stacking is locked by the platform)
		await service.applyChange({
			target: { subscriptionId: SUB_A1 },
			level: 'website',
			actor: merchantA,
			change: {
				elements: { banner: true },
				config: { codes: { maxActive: 80, prefix: 'WEB', allowStacking: true }, banner: { text: 'Hello' } },
			},
		});
		// admin override may exceed the plan max and lock
		await service.applyChange({
			target: { subscriptionId: SUB_A1 },
			level: 'admin',
			actor: staff,
			reason: 'enterprise deal',
			change: { features: { 'codes.window': { value: { days: 90 }, locked: true } } },
		});
		const layers = await service.layersFor(SUB_A1);
		expect(Object.keys(layers)).toEqual(['platform', 'website', 'admin']);
		const resolved = resolveEntitlement({
			product: normaliseProduct(manifest()),
			subscription: { id: SUB_A1, plan: 'starter', status: 'active', websiteId: WEB_A1, merchantId: MER_A },
			layers,
			runtime: {},
			now: clock.now(),
		});
		expect(resolved.elements.banner).toMatchObject({ enabled: true, source: 'website' });
		expect(resolved.features['codes.allowStacking']).toMatchObject({
			value: false,
			source: 'platform',
			locked: true,
			lockedBy: 'platform',
		});
		expect(resolved.features['codes.maxActive']).toMatchObject({ value: 50, source: 'website', reason: 'clamped' });
		expect(resolved.features['codes.window']).toMatchObject({ value: { days: 90 }, source: 'admin', locked: true });
		expect(resolved.features['codes.prefix']).toMatchObject({ value: 'WEB', source: 'website' });
		expect(resolved.features['banner.text']).toMatchObject({ value: 'Hello', source: 'website' });
		expect(resolved.report).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ key: 'codes.allowStacking', layer: 'website', reason: 'locked', lockedBy: 'platform' }),
			]),
		);
		expect(resolved.report.some((r) => r.reason === 'unknown' || r.reason === 'invalid')).toBe(false);

		// commerce may pass what it knows to skip the subscription lookup
		expect(await service.layersFor(SUB_A1, { merchantId: MER_A, appId: APP })).toEqual(layers);
		// other merchants' subscriptions see the platform policy only
		const b = await service.layersFor(SUB_B1);
		expect(b.website).toEqual({ elements: {}, features: {} });
		expect(b.platform.features['codes.allowStacking']).toEqual({ value: false, locked: true });
	});
});

describe('preview and module wiring', () => {
	it('previews proposed layers through commerce.previewDocument when present', async () => {
		const { service } = await fresh();
		const result = await service.preview({
			subscriptionId: SUB_A1,
			change: { elements: { banner: true }, config: { codes: { maxActive: 70 } } },
			actor: merchantA,
		});
		expect(result.diff.map((d) => d.key)).toEqual(['banner', 'codes.maxActive']);
		expect(result.layers.website.features['codes.maxActive']).toEqual({ value: 70 });
		expect(/** @type {any} */ (result.preview).features['codes.maxActive']).toMatchObject({ value: 50, reason: 'clamped' });
		expect((await service.history(SUB_A1, { level: 'website' })).items).toEqual([]); // nothing written
		const platform = await service.preview({
			subscriptionId: SUB_A1,
			level: 'platform',
			change: { elements: { codes: true } },
			actor: staff,
		});
		expect(platform.layers.platform.elements).toEqual({ codes: { enabled: true } });
		const admin = await service.preview({
			subscriptionId: SUB_A1,
			level: 'admin',
			change: { elements: { codes: true } },
			actor: staff,
		});
		expect(admin.level).toBe('admin');
		expect(
			(await rejection(service.preview({ subscriptionId: SUB_A1, level: 'admin', change: {}, actor: merchantA }))).code,
		).toBe('forbidden');
		expect(
			(
				await rejection(
					service.preview({ subscriptionId: SUB_A1, change: {}, actor: merchantA, scope: { merchantId: MER_B } }),
				)
			).code,
		).toBe('not_found');
	});

	it('works without optional commerce functions and falls back to identity for the merchant', async () => {
		const { service, fakes, entries } = await fresh({
			withPreview: false,
			withInvalidateApp: false,
			merchantOnSubscription: false,
		});
		const result = await service.preview({ subscriptionId: SUB_A1, change: { elements: { codes: true } }, actor: merchantA });
		expect(result.preview).toBeNull();
		await service.applyChange({
			target: { appId: APP },
			level: 'platform',
			actor: staff,
			reason: 'policy',
			change: { elements: { codes: true } },
		});
		expect(entries.some((e) => e.msg === 'platform policy changed but commerce exposes no invalidateApp')).toBe(true);
		expect((await service.overview({ subscriptionId: SUB_A1 })).merchantId).toBe(MER_A);
		fakes.setFailInvalidate(true);
		const committed = await service.applyChange({
			target: { subscriptionId: SUB_A1 },
			level: 'website',
			actor: merchantA,
			change: { elements: { codes: true } },
		});
		expect(committed.version).toBe(1);
		expect(entries.some((e) => e.msg === 'commerce invalidation failed')).toBe(true);
	});

	it('platform changes invalidate the app in commerce', async () => {
		const { service, fakes } = await fresh();
		await service.applyChange({
			target: { appId: APP },
			level: 'platform',
			actor: staff,
			reason: 'policy',
			change: { elements: { codes: true } },
		});
		expect(fakes.invalidatedApps).toEqual([APP]);
		expect((await service.getLayer({ target: APP, level: 'platform' })).state.elements).toEqual({ codes: { enabled: true } });
	});

	it('answers unavailable when catalog or commerce are not registered', async () => {
		n += 1;
		const { logger } = createTestLogger();
		const portal = createPortal({
			config: await testConfig(),
			db: mongo.db(`cfg_svc_${n}`),
			modules: [configModule],
			logger,
			now: createClock().now,
		});
		const service = /** @type {any} */ (portal.modules.service('config'));
		expect((await rejection(service.layersFor(SUB_A1))).code).toBe('unavailable');
		expect(
			(
				await rejection(
					service.applyChange({ target: { appId: APP }, level: 'platform', actor: staff, reason: 'r', change: {} }),
				)
			).code,
		).toBe('unavailable');
	});

	it('maps manifests that cannot be found to not_found and subscriptions without facts to unavailable', async () => {
		const { service, fakes } = await fresh();
		fakes.manifests.delete('1.4.0');
		expect(
			(await rejection(service.applyChange({ target: SUB_A1, level: 'website', actor: merchantA, change: {} }))).code,
		).toBe('not_found');
		fakes.subscriptions.set(SUB_A1, { subscriptionId: SUB_A1, merchantId: MER_A });
		expect((await rejection(service.layersFor(SUB_A1))).code).toBe('unavailable');
	});
});
