import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { normaliseProduct, resolveEntitlement } from '@ss/entitlements';
import { createPortal } from '../../../src/portal.js';
import { configModule } from '../../../src/modules/config/index.js';
import { createClock, createTestLogger, startMongo, testConfig } from '../../helpers.js';
import { boot } from './boot.js';
import { createFakes } from './fakes/index.js';
import { APP, MER_A, MER_B, SUB_A1, SUB_A2, SUB_B1, WEB_A1, WEB_A2, WEB_A3, WEB_B1, manifest } from './fixtures.js';

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
				target: { merchantId: MER_A, appId: 'app_other' },
				level: 'merchant',
				actor: merchantA,
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

	it('validates against the pinned manifest for subscriptions and the current one for merchant defaults', async () => {
		const { service, fakes } = await fresh();
		fakes.setCurrentVersion('1.5.0');
		await service.applyChange({
			target: { subscriptionId: SUB_A1 },
			level: 'website',
			actor: merchantA,
			change: { elements: { codes: true } },
		});
		await service.applyChange({
			target: { merchantId: MER_A, appId: APP },
			level: 'merchant',
			actor: merchantA,
			change: { elements: { codes: true } },
		});
		expect((await service.history({ subscriptionId: SUB_A1 }, { level: 'website' })).items[0]?.manifestVersion).toBe('1.4.0');
		expect((await service.history({ merchantId: MER_A, appId: APP }, { level: 'merchant' })).items[0]?.manifestVersion).toBe(
			'1.5.0',
		);
		// merchant-level change invalidates every subscription of that merchant for the app, not other merchants
		expect(fakes.invalidated).toEqual(expect.arrayContaining([SUB_A1, SUB_A2]));
		expect(fakes.invalidated).not.toContain(SUB_B1);
	});
});

describe('templates', () => {
	it('applies across websites with per-website results and re-pushes updates', async () => {
		const { service } = await fresh();
		const settings = { elements: { codes: true }, config: { codes: { prefix: 'TPL', maxActive: 30 } } };
		const badLock = await rejection(
			service.saveTemplate({ merchantId: MER_A, appId: APP, name: 'x', settings: { locks: {} }, actor: merchantA }),
		);
		expect(codes(badLock)).toEqual(['lock_forbidden']);
		const lockedEntry = await rejection(
			service.saveTemplate({
				merchantId: MER_A,
				appId: APP,
				name: 'x',
				settings: { features: { 'codes.prefix': { value: 'A', locked: true } } },
				actor: merchantA,
			}),
		);
		expect(codes(lockedEntry)).toEqual(['lock_forbidden']);
		const invalid = await rejection(
			service.saveTemplate({
				merchantId: MER_A,
				appId: APP,
				name: 'x',
				settings: { features: { 'codes.ghost': { value: 1 } } },
				actor: merchantA,
			}),
		);
		expect(invalid.errors[0]).toMatchObject({ path: '/settings/features/codes.ghost', code: 'unknown_feature' });
		const shape = await rejection(
			service.saveTemplate({ merchantId: MER_A, appId: APP, name: 'x', settings: 'x', actor: merchantA }),
		);
		expect(shape.errors[0].path).toBe('/settings');
		expect(
			codes(
				await rejection(service.saveTemplate({ merchantId: MER_A, appId: APP, name: '', settings: {}, actor: merchantA })),
			),
		).toEqual(['invalid_name']);
		expect(
			codes(await rejection(service.saveTemplate({ merchantId: 'x', appId: APP, name: 'n', settings: {}, actor: merchantA }))),
		).toEqual(['invalid_target']);
		expect(
			(
				await rejection(
					service.saveTemplate({
						merchantId: MER_A,
						appId: APP,
						name: 'n',
						settings: {},
						actor: /** @type {any} */ ({ type: 'product', id: 'p' }),
					}),
				)
			).code,
		).toBe('forbidden');

		const template = await service.saveTemplate({ merchantId: MER_A, appId: APP, name: 'Summer', settings, actor: merchantA });
		expect(template).toMatchObject({ name: 'Summer', version: 1, settings: { elements: { codes: { enabled: true } } } });

		// staff lock on WEB_A2's prefix makes that website fail; WEB_A3 has no subscription; WEB_B1 is another merchant's
		await service.applyChange({
			target: { subscriptionId: SUB_A2 },
			level: 'website',
			actor: staff,
			change: { features: { 'codes.prefix': { value: 'LOCK', locked: true } } },
		});
		const applied = await service.applyTemplate({
			merchantId: MER_A,
			templateId: template.templateId,
			websiteIds: [WEB_A1, WEB_A2, WEB_A3, WEB_B1, 'web_unknown0000000000000000'],
			actor: merchantA,
		});
		expect(applied).toMatchObject({ applied: 1, failed: 4 });
		expect(applied.results.map((r) => [r.websiteId, r.status, /** @type {any} */ (r.error)?.code ?? null])).toEqual([
			[WEB_A1, 'applied', null],
			[WEB_A2, 'failed', 'validation_failed'],
			[WEB_A3, 'failed', 'not_found'],
			[WEB_B1, 'failed', 'not_found'],
			['web_unknown0000000000000000', 'failed', 'not_found'],
		]);
		const website = await service.getLayer({ target: SUB_A1, level: 'website' });
		expect(website.state.features['codes.prefix']).toEqual({ value: 'TPL' });
		expect((await service.history(SUB_A1, { level: 'website' })).items[0]).toMatchObject({
			kind: 'template',
			templateId: template.templateId,
			templateVersion: 1,
		});
		const again = await service.applyTemplate({ templateId: template.templateId, websiteIds: [WEB_A1], actor: merchantA }); // any-merchant lookup
		expect(again.results[0]?.status).toBe('unchanged');
		const denied = await service.applyTemplate({
			merchantId: MER_A,
			templateId: template.templateId,
			websiteIds: [WEB_A1],
			canWrite: () => false,
			actor: merchantA,
		});
		expect(denied.results[0]).toMatchObject({ status: 'failed', error: { code: 'forbidden' } });
		expect(
			codes(
				await rejection(
					service.applyTemplate({ merchantId: MER_A, templateId: template.templateId, websiteIds: [], actor: merchantA }),
				),
			),
		).toEqual(['invalid_websites']);
		expect(
			(
				await rejection(
					service.applyTemplate({
						merchantId: MER_B,
						templateId: template.templateId,
						websiteIds: [WEB_B1],
						actor: merchantA,
					}),
				)
			).code,
		).toBe('not_found');

		// update → push re-applies to websites on older versions
		const nothing = await service.pushTemplate({ merchantId: MER_A, templateId: template.templateId, actor: merchantA });
		expect(nothing.results).toEqual([]);
		const updated = await service.updateTemplate({
			merchantId: MER_A,
			templateId: template.templateId,
			name: 'Summer 2',
			settings: { config: { codes: { prefix: 'TPL2' } } },
			version: 1,
			actor: merchantA,
		});
		expect(updated).toMatchObject({ version: 2, name: 'Summer 2' });
		expect(
			(
				await rejection(
					service.updateTemplate({ merchantId: MER_A, templateId: template.templateId, version: 1, actor: merchantA }),
				)
			).code,
		).toBe('conflict');
		expect(
			(await rejection(service.updateTemplate({ merchantId: MER_A, templateId: 'cft_none', actor: merchantA }))).code,
		).toBe('not_found');
		expect(
			codes(
				await rejection(
					service.updateTemplate({ merchantId: MER_A, templateId: template.templateId, name: '', actor: merchantA }),
				),
			),
		).toEqual(['invalid_name']);
		const pushed = await service.pushTemplate({ merchantId: MER_A, templateId: template.templateId, actor: merchantA });
		expect(pushed.results.map((r) => [r.websiteId, r.status])).toEqual([[WEB_A1, 'applied']]);
		expect((await service.getLayer({ target: SUB_A1, level: 'website' })).state.features['codes.prefix']).toEqual({
			value: 'TPL2',
		});
		const all = await service.pushTemplate({ merchantId: MER_A, templateId: template.templateId, all: true, actor: merchantA });
		expect(all.results[0]?.status).toBe('unchanged');
		expect((await service.getTemplate({ merchantId: MER_A, templateId: template.templateId })).applications).toEqual([
			expect.objectContaining({ websiteId: WEB_A1, templateVersion: 2, subscriptionId: SUB_A1 }),
		]);
		expect((await service.listTemplates({ merchantId: MER_A, appId: APP })).items).toHaveLength(1);
		expect((await service.listTemplates({ merchantId: MER_B })).items).toHaveLength(0);
		expect((await rejection(service.getTemplate({ merchantId: MER_B, templateId: template.templateId }))).code).toBe(
			'not_found',
		);
		expect(
			(await rejection(service.pushTemplate({ merchantId: MER_B, templateId: template.templateId, actor: merchantA }))).code,
		).toBe('not_found');
	});
});

describe('scheduled changes', () => {
	it('applies exactly once (idempotent job and change key) and can be cancelled', async () => {
		const { service, portal, clock } = await fresh();
		const at = new Date(clock.now() + 3_600_000).toISOString();
		const change = {
			target: { subscriptionId: SUB_A1 },
			level: 'website',
			config: { codes: { prefix: 'LATER' } },
			reason: 'launch',
		};
		const scheduled = await service.schedule({ change, at, actor: merchantA });
		expect(scheduled).toMatchObject({
			status: 'pending',
			change: { config: { codes: { prefix: 'LATER' } } },
			reason: 'launch',
		});
		const drain = () => portal.shared.jobs.runBatch({ handlers: portal.modules.jobs, deadlineMs: 60_000 });
		expect((await drain()).leased).toBe(0); // not due yet
		clock.advance(3_600_000);
		expect((await drain()).succeeded).toBe(1);
		expect((await service.getLayer({ target: SUB_A1, level: 'website' })).state.features['codes.prefix']).toEqual({
			value: 'LATER',
		});
		// the job may run again (retries, replays): no second version
		expect(await service.applyScheduled({ scheduleId: scheduled.scheduleId, merchantId: MER_A })).toEqual({
			status: 'applied',
		});
		expect((await service.history(SUB_A1, { level: 'website' })).items).toHaveLength(1);
		// a crash after the version was written but before the schedule was marked applied
		const second = await service.schedule({
			change: { ...change, config: { codes: { prefix: 'TWICE' } } },
			at: clock.now() + 1000,
			actor: merchantA,
		});
		clock.advance(2000);
		expect(await service.applyScheduled({ scheduleId: second.scheduleId, merchantId: MER_A })).toMatchObject({
			status: 'applied',
			version: 2,
		});
		await mongo
			.db(`cfg_svc_${n}`)
			.collection('config_schedules')
			.updateOne({ _id: /** @type {any} */ (second.scheduleId) }, { $set: { status: 'applying' } });
		expect(await service.applyScheduled({ scheduleId: second.scheduleId, merchantId: MER_A })).toMatchObject({
			status: 'applied',
			version: 2,
		});
		expect((await service.history(SUB_A1, { level: 'website' })).items).toHaveLength(2);

		const third = await service.schedule({ change, at: clock.now() + 60_000, actor: merchantA });
		const cancelled = await service.cancelSchedule({ merchantId: MER_A, scheduleId: third.scheduleId, actor: merchantA });
		expect(cancelled.status).toBe('cancelled');
		expect(
			(await rejection(service.cancelSchedule({ merchantId: MER_A, scheduleId: third.scheduleId, actor: merchantA }))).code,
		).toBe('conflict');
		expect(
			(await rejection(service.cancelSchedule({ merchantId: MER_B, scheduleId: third.scheduleId, actor: merchantA }))).code,
		).toBe('not_found');
		expect(
			(
				await rejection(
					service.cancelSchedule({
						merchantId: MER_A,
						scheduleId: third.scheduleId,
						scope: { websiteId: WEB_A2 },
						actor: merchantA,
					}),
				)
			).code,
		).toBe('not_found');
		clock.advance(120_000);
		expect((await drain()).succeeded).toBe(2); // the second schedule's own job (already applied) and the cancelled one: both no-ops
		expect(await service.applyScheduled({ scheduleId: third.scheduleId, merchantId: MER_A })).toEqual({ status: 'cancelled' });
		expect((await service.history(SUB_A1, { level: 'website' })).items).toHaveLength(2);
		expect(await service.applyScheduled({ scheduleId: 'cfs_missing', merchantId: MER_A })).toEqual({ status: 'missing' });
		const list = await service.listSchedules({ target: SUB_A1, level: 'website' });
		expect(list.items.map((s) => s.status)).toEqual(['applied', 'applied', 'cancelled']);
		expect((await service.listSchedules({ target: { appId: APP }, level: 'platform' })).items).toEqual([]);
	});

	it('validates at schedule time and fails (without retry) when the change became invalid', async () => {
		const { service, portal, clock } = await fresh();
		const target = { subscriptionId: SUB_A1 };
		const past = await rejection(
			service.schedule({ change: { target, level: 'website' }, at: clock.now() - 1, actor: merchantA }),
		);
		expect(codes(past)).toEqual(['invalid_at']);
		const invalid = await rejection(
			service.schedule({
				change: { target, level: 'website', elements: { ghost: true } },
				at: clock.now() + 1000,
				actor: merchantA,
			}),
		);
		expect(codes(invalid)).toEqual(['unknown_element']);
		expect(codes(await rejection(service.schedule({ change: 'x', at: clock.now() + 1000, actor: merchantA })))).toEqual([
			'invalid_change',
		]);
		const platform = await rejection(
			service.schedule({
				change: { target: { appId: APP }, level: 'platform', reason: 'r' },
				at: clock.now() + 1000,
				actor: staff,
			}),
		);
		expect(codes(platform)).toEqual(['invalid_target']);

		const s = await service.schedule({
			change: { target, level: 'website', config: { codes: { prefix: 'LATE' } } },
			at: clock.now() + 1000,
			actor: merchantA,
		});
		await service.applyChange({
			target,
			level: 'website',
			actor: staff,
			change: { features: { 'codes.prefix': { value: 'NOW', locked: true } } },
		});
		clock.advance(2000);
		const stats = await portal.shared.jobs.runBatch({ handlers: portal.modules.jobs, deadlineMs: 60_000 });
		expect(stats).toMatchObject({ succeeded: 1, retried: 0 });
		const [failed] = (await service.listSchedules({ target, level: 'website' })).items;
		expect(failed).toMatchObject({ status: 'failed', error: { code: 'validation_failed' } });
		await expect(portal.modules.jobs['config.apply_scheduled']?.({}, /** @type {any} */ ({}))).rejects.toThrow(/scheduleId/);
		expect(s.status).toBe('pending');
	});
});

describe('experiments', () => {
	it('stores definitions, exposes running ones in layersFor and applies a winner', async () => {
		const { service, fakes } = await fresh();
		const definition = {
			element: 'codes',
			metric: 'order.placed@1',
			variants: [
				{ key: 'a', weight: 1, config: { prefix: 'AAA' } },
				{ key: 'b', weight: 1, config: { prefix: 'BBB', allowStacking: true } },
			],
		};
		const bad = await rejection(
			service.createExperiment({ subscriptionId: SUB_A1, experiment: { ...definition, element: 'banner' }, actor: merchantA }),
		);
		expect(codes(bad)).toContain('not_experimentable');
		const one = await service.createExperiment({ subscriptionId: SUB_A1, experiment: definition, actor: merchantA });
		const two = await service.createExperiment({ subscriptionId: SUB_A1, experiment: definition, actor: merchantA });
		expect(one).toMatchObject({ status: 'draft', element: 'codes', metric: 'order.placed@1' });
		expect((await service.layersFor(SUB_A1)).experiments).toEqual([]);
		const started = await service.startExperiment({ subscriptionId: SUB_A1, experimentId: one.experimentId, actor: merchantA });
		expect(started.status).toBe('running');
		expect(
			(await rejection(service.startExperiment({ subscriptionId: SUB_A1, experimentId: two.experimentId, actor: merchantA })))
				.code,
		).toBe('conflict');
		expect(
			(await rejection(service.startExperiment({ subscriptionId: SUB_A1, experimentId: one.experimentId, actor: merchantA })))
				.code,
		).toBe('conflict');
		expect(
			(await rejection(service.startExperiment({ subscriptionId: SUB_A2, experimentId: one.experimentId, actor: merchantA })))
				.code,
		).toBe('not_found');
		const layers = await service.layersFor(SUB_A1);
		expect(layers.experiments).toEqual([
			{
				id: one.experimentId,
				element: 'codes',
				variants: [
					{ key: 'a', weight: 1, values: { prefix: 'AAA' } },
					{ key: 'b', weight: 1, values: { prefix: 'BBB', allowStacking: true } },
				],
			},
		]);
		expect(
			codes(
				await rejection(
					service.stopExperiment({
						subscriptionId: SUB_A1,
						experimentId: one.experimentId,
						applyVariant: 'zzz',
						actor: merchantA,
					}),
				),
			),
		).toEqual(['invalid_variant']);
		const stopped = await service.stopExperiment({
			subscriptionId: SUB_A1,
			experimentId: one.experimentId,
			applyVariant: 'b',
			actor: merchantA,
		});
		expect(stopped).toMatchObject({ status: 'stopped', winner: 'b', applied: { version: 1 } });
		expect((await service.getLayer({ target: SUB_A1, level: 'website' })).state.features).toEqual({
			'codes.prefix': { value: 'BBB' },
			'codes.allowStacking': { value: true },
		});
		const plain = await service.stopExperiment({ subscriptionId: SUB_A1, experimentId: two.experimentId, actor: merchantA });
		expect(plain).toMatchObject({ status: 'stopped' });
		expect((await service.listExperiments({ subscriptionId: SUB_A1 })).items.map((e) => e.status)).toEqual([
			'stopped',
			'stopped',
		]);
		expect(fakes.invalidated).toContain(SUB_A1);
		expect(
			(
				await rejection(
					service.createExperiment({
						subscriptionId: SUB_A1,
						experiment: definition,
						actor: /** @type {any} */ ({ type: 'product', id: 'x' }),
					}),
				)
			).code,
		).toBe('forbidden');
		expect(
			(
				await rejection(
					service.stopExperiment({
						subscriptionId: SUB_A1,
						experimentId: one.experimentId,
						actor: /** @type {any} */ ({ type: 'product', id: 'x' }),
					}),
				)
			).code,
		).toBe('forbidden');
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
		// merchant default and website override (website above plan max 50 → clamped by the resolver, not here)
		await service.applyChange({
			target: { merchantId: MER_A, appId: APP },
			level: 'merchant',
			actor: merchantA,
			change: { config: { codes: { prefix: 'MER', allowStacking: true } } },
		});
		await service.applyChange({
			target: { subscriptionId: SUB_A1 },
			level: 'website',
			actor: merchantA,
			change: { elements: { banner: true }, config: { codes: { maxActive: 80 }, banner: { text: 'Hello' } } },
		});
		// admin override may exceed the plan max and lock
		await service.applyChange({
			target: { subscriptionId: SUB_A1 },
			level: 'admin',
			actor: staff,
			reason: 'enterprise deal',
			change: { features: { 'codes.window': { value: { days: 90 }, locked: true } } },
		});
		const experiment = await service.createExperiment({
			subscriptionId: SUB_A1,
			experiment: {
				element: 'codes',
				metric: 'order.placed@1',
				variants: [
					{ key: 'only', weight: 1, config: { prefix: 'EXP' } },
					{ key: 'same', weight: 1, config: { prefix: 'EXP' } },
				],
			},
			actor: merchantA,
		});
		await service.startExperiment({ subscriptionId: SUB_A1, experimentId: experiment.experimentId, actor: merchantA });

		const { experiments, ...layers } = await service.layersFor(SUB_A1);
		expect(Object.keys(layers)).toEqual(['platform', 'merchant', 'website', 'admin']);
		const resolved = resolveEntitlement({
			product: normaliseProduct(manifest()),
			subscription: { id: SUB_A1, plan: 'starter', status: 'active', websiteId: WEB_A1, merchantId: MER_A },
			layers,
			runtime: { experiments },
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
		expect(resolved.features['codes.prefix']).toMatchObject({ value: 'EXP', source: 'experiment' });
		expect(resolved.features['banner.text']).toMatchObject({ value: 'Hello', source: 'website' });
		expect(resolved.experiments[experiment.experimentId]).toMatchObject({ element: 'codes' });
		expect(resolved.report).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ key: 'codes.allowStacking', layer: 'merchant', reason: 'locked', lockedBy: 'platform' }),
			]),
		);
		expect(resolved.report.some((r) => r.reason === 'unknown' || r.reason === 'invalid')).toBe(false);

		// commerce may pass what it knows to skip the subscription lookup
		expect(await service.layersFor(SUB_A1, { merchantId: MER_A, appId: APP })).toEqual({ ...layers, experiments });
		// other merchants' subscriptions see the platform policy only
		const b = await service.layersFor(SUB_B1);
		expect(b.merchant).toEqual({ elements: {}, features: {} });
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
		const merchant = await service.preview({
			subscriptionId: SUB_A1,
			level: 'merchant',
			change: { config: { codes: { prefix: 'M' } } },
			actor: merchantA,
		});
		expect(merchant.level).toBe('merchant');
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
