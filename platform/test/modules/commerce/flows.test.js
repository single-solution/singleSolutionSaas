import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createKeyResolver, verifyEntitlementDocument } from '@ss/protocol';
import { closeMongoClients } from '../../../src/infra/db.js';
import { runInRequestScope } from '../../../src/infra/request-scope.js';
import { T0, createClock, startMongo } from '../../helpers.js';
import { APP, APP2, HOUR, M1, M2, STAFF, W1, W2, W3, bootCommerce, couponsManifest } from './fixtures.js';

// Mongo-backed tests share the machine with other suites: allow for slow replica-set start-up and I/O.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

/** @type {Awaited<ReturnType<typeof startMongo>>} */
let mongo;
beforeAll(async () => {
	mongo = await startMongo();
}, 120_000);
afterAll(async () => {
	await closeMongoClients();
	await mongo?.stop();
});

const MERCHANT_ACTOR = { type: 'merchant_user', id: 'usr_owner', merchantId: M1, roles: ['owner'] };

/**
 * @param {any} h @param {string} jws
 * @returns {Promise<any>}
 */
const decode = async (h, jws) =>
	(
		await verifyEntitlementDocument({
			token: jws,
			keyResolver: createKeyResolver({ jwks: h.portal.shared.keys.jwks() }),
			now: h.clock.now,
		})
	).payload;

describe('subscribe, documents and settlement', () => {
	it('requires credits, pins the price book, signs documents and settles started hours', async () => {
		const clock = createClock(T0 + 30 * 60_000); // 10:30
		const h = await bootCommerce({ mongo, dbName: 'cm_flow_basic', clock });
		await expect(
			h.service.subscribe({ websiteId: W1, appId: APP, planCode: 'starter', actor: MERCHANT_ACTOR }),
		).rejects.toMatchObject({
			code: 'credits_exhausted',
		});
		await h.credit(M1, 1000); // less than one hour (1500)
		await expect(
			h.service.subscribe({ websiteId: W1, appId: APP, planCode: 'starter', actor: MERCHANT_ACTOR }),
		).rejects.toMatchObject({
			code: 'credits_exhausted',
		});
		await h.credit(M1, 100_000);
		const sub = await h.service.subscribe({ websiteId: W1, appId: APP, planCode: 'starter', actor: MERCHANT_ACTOR });
		expect(sub).toMatchObject({ status: 'active', planCode: 'starter', priceBookVersion: '2026-01', manifestVersion: 1 });
		await expect(h.service.subscribe({ websiteId: W1, appId: APP, actor: MERCHANT_ACTOR })).rejects.toMatchObject({
			code: 'conflict',
		});

		const jws = await h.service.documentFor({ websiteId: W1, appId: APP });
		const doc = await decode(h, jws);
		expect(doc).toMatchObject({
			subscriptionId: sub.subscriptionId,
			domain: 'shop.example.com',
			env: 'live',
			version: 1,
			planCode: 'starter',
			dataScope: { prefix: 'ss_coupon_box_' },
			runtime: { state: 'active' },
			resources: [{ kind: 'database', ref: 'con_db1', status: 'connected' }],
		});
		expect(doc.elements).toMatchObject({ codes: { enabled: true }, apply_box: { enabled: true }, reports: { enabled: false } });
		expect(await h.service.documentFor({ websiteId: W1, appId: APP })).toBe(jws); // cached
		expect(h.world.events.map((e) => e.type)).toEqual(['subscription.activated@1', 'entitlement.changed@1']);

		// 12:05 → hours 10 and 11 settle (10 started at 10:30 and is billed in full)
		clock.set(T0 + 2 * HOUR + 5 * 60_000);
		const stats = await h.service.runSettlement();
		expect(stats).toMatchObject({ subscriptions: 1, entries: 2, failures: 0 });
		const statement = await h.service.statement(M1, { from: T0 - HOUR, to: clock.now() + 1 });
		expect(statement.totals).toMatchObject({ deposit: 101_000, settlement: -3000 });
		expect(statement.closingBalanceMillicredits).toBe(98_000);
		expect((await h.service.balance(M1)).balanceMillicredits).toBe(98_000);
		// a second run settles nothing new
		expect(await h.service.runSettlement()).toMatchObject({ entries: 0 });
		expect((await h.service.verifyChain(M1)).ok).toBe(true);
	});
});

const MIN = 60_000;
/** @param {any} h @param {string} merchantId @param {string} [type] */
const ledgerRows = (h, merchantId, type) =>
	h.db
		.collection('commerce_ledger')
		.find({ merchantId, ...(type ? { type } : {}) })
		.sort({ seq: 1 })
		.toArray();
/** @param {any[]} rows */
const keysOf = (rows) => rows.map((r) => `${String(r.periodKey).split(':').slice(1).join(':')}=${r.amount}`);

describe('billing semantics (F.1)', () => {
	it('pauses are free only for fully paused hours; started hours bill in full', async () => {
		const clock = createClock(T0);
		const h = await bootCommerce({ mongo, dbName: 'cm_pause', clock });
		await h.credit(M1, 100_000);
		const sub = await h.service.subscribe({ websiteId: W1, appId: APP, planCode: 'starter', actor: MERCHANT_ACTOR });
		clock.set(T0 + 20 * MIN);
		const paused = await h.service.pause({ subscriptionId: sub.subscriptionId, actor: MERCHANT_ACTOR, reason: 'holiday' });
		expect(paused).toMatchObject({ status: 'paused', holds: ['paused'] });
		expect(await h.service.pause({ subscriptionId: sub.subscriptionId, actor: MERCHANT_ACTOR })).toMatchObject({
			status: 'paused',
		});
		const doc = await decode(h, await h.service.documentFor({ websiteId: W1, appId: APP }));
		expect(doc.runtime).toEqual({ state: 'paused', reason: 'paused' });
		expect(doc.elements.codes).toEqual({ enabled: false, reason: 'paused' });
		clock.set(T0 + 3 * HOUR + 40 * MIN); // 13:40
		expect(await h.service.resume({ subscriptionId: sub.subscriptionId, actor: MERCHANT_ACTOR })).toMatchObject({
			status: 'active',
		});
		clock.set(T0 + 4 * HOUR + 10 * MIN); // 14:10 pause and resume within one hour → billed once
		await h.service.pause({ subscriptionId: sub.subscriptionId, actor: MERCHANT_ACTOR });
		clock.set(T0 + 4 * HOUR + 20 * MIN);
		await h.service.resume({ subscriptionId: sub.subscriptionId, actor: MERCHANT_ACTOR });
		clock.set(T0 + 5 * HOUR + 5 * MIN); // 15:05
		await h.service.runSettlement();
		expect(keysOf(await ledgerRows(h, M1, 'settlement'))).toEqual([
			'2026-10-01T10:00:00Z=-1500',
			'2026-10-01T13:00:00Z=-1500',
			'2026-10-01T14:00:00Z=-1500',
		]);
		const types = h.world.events.map((e) => `${e.type}:${e.data.reason ?? ''}`);
		expect(types).toEqual(expect.arrayContaining(['subscription.paused@1:holiday', 'subscription.resumed@1:paused_released']));
		await expect(
			h.service.pause({ subscriptionId: 'sub_zzzzzzzzzzzzzzzzzzzzzzzzzz', actor: MERCHANT_ACTOR }),
		).rejects.toMatchObject({
			code: 'not_found',
		});
	});

	it('element switches bill from the next hour; merchants stay within the plan, staff may exceed it', async () => {
		const clock = createClock(T0);
		const h = await bootCommerce({ mongo, dbName: 'cm_elements', clock });
		await h.credit(M1, 100_000);
		const { subscriptionId } = await h.service.subscribe({
			websiteId: W1,
			appId: APP,
			planCode: 'starter',
			actor: MERCHANT_ACTOR,
		});
		clock.set(T0 + 15 * MIN);
		await h.service.setElement({ subscriptionId, elementKey: 'reports', enabled: true, actor: MERCHANT_ACTOR });
		await expect(
			h.service.setElement({ subscriptionId, elementKey: 'ai_copy', enabled: true, actor: MERCHANT_ACTOR }),
		).rejects.toMatchObject({
			code: 'forbidden',
		});
		await expect(
			h.service.setElement({ subscriptionId, elementKey: 'nope', enabled: true, actor: MERCHANT_ACTOR }),
		).rejects.toMatchObject({
			code: 'not_found',
		});
		const staffSwitch = await h.service.setElement({ subscriptionId, elementKey: 'ai_copy', enabled: true, actor: STAFF });
		expect(staffSwitch.switches).toEqual({ website: { reports: true }, admin: { ai_copy: true } });
		let doc = await decode(h, await h.service.documentFor({ websiteId: W1, appId: APP }));
		expect(doc.elements.reports).toEqual({ enabled: true });
		expect(doc.elements.ai_copy).toEqual({ enabled: false, reason: 'resource_missing:ai' });
		clock.set(T0 + HOUR + 30 * MIN); // ai connected at 11:30
		h.world.resources.set(W1, [
			{ kind: 'database', ref: 'con_db1', status: 'connected' },
			{ kind: 'ai', ref: 'con_ai1', status: 'connected' },
		]);
		expect(await h.service.invalidateWebsite(W1)).toEqual({ invalidated: 1 });
		doc = await decode(h, await h.service.documentFor({ websiteId: W1, appId: APP }));
		expect(doc.elements.ai_copy).toEqual({ enabled: true });
		clock.set(T0 + 3 * HOUR + 10 * MIN); // 13:10: codes off → apply_box and reports stop by dependency
		await h.service.setElement({ subscriptionId, elementKey: 'codes', enabled: false, actor: MERCHANT_ACTOR });
		await expect(
			h.service.setElement({ subscriptionId, elementKey: 'reports', enabled: true, actor: MERCHANT_ACTOR }),
		).rejects.toMatchObject({
			code: 'conflict',
		});
		doc = await decode(h, await h.service.documentFor({ websiteId: W1, appId: APP }));
		expect(doc.elements).toMatchObject({
			apply_box: { enabled: false, reason: 'dependency:codes' },
			reports: { enabled: false },
		});
		clock.set(T0 + 5 * HOUR + 5 * MIN);
		await h.service.runSettlement();
		expect(keysOf(await ledgerRows(h, M1, 'settlement'))).toEqual([
			'2026-10-01T10:00:00Z=-1500', // reports from 10:15 → next hour
			'2026-10-01T11:00:00Z=-1750',
			'2026-10-01T12:00:00Z=-3750', // ai_copy from 11:30
			'2026-10-01T13:00:00Z=-3750', // codes off at 13:10 still billed for 13
			'2026-10-01T14:00:00Z=-2000',
		]);
	});

	it('plan changes pin the current price book and are validated against switches and dependencies', async () => {
		const clock = createClock(T0);
		const h = await bootCommerce({ mongo, dbName: 'cm_plan', clock });
		await h.credit(M1, 100_000);
		const { subscriptionId } = await h.service.subscribe({
			websiteId: W1,
			appId: APP,
			planCode: 'starter',
			actor: MERCHANT_ACTOR,
		});
		const v2 = couponsManifest({
			version: '2.0.0',
			priceBook: '2026-10',
			effectiveFrom: '2026-09-30T00:00:00Z',
			codesHourly: 2000,
		});
		v2.plans.push({ code: 'basic', name: 'Basic', elements: ['codes'] });
		const app = /** @type {any} */ (h.world.apps.get(APP));
		app.versions.set(2, v2);
		app.app.currentVersion = 2;
		clock.set(T0 + 5 * MIN);
		await h.service.setElement({ subscriptionId, elementKey: 'reports', enabled: true, actor: MERCHANT_ACTOR });
		clock.set(T0 + 30 * MIN);
		await expect(h.service.changePlan({ subscriptionId, planCode: 'basic', actor: MERCHANT_ACTOR })).rejects.toMatchObject({
			code: 'conflict',
			errors: [{ path: '/elements/reports' }],
		});
		await expect(h.service.changePlan({ subscriptionId, planCode: 'gold', actor: MERCHANT_ACTOR })).rejects.toMatchObject({
			code: 'validation_failed',
		});
		const pro = await h.service.changePlan({ subscriptionId, planCode: 'pro', actor: MERCHANT_ACTOR });
		expect(pro).toMatchObject({ planCode: 'pro', priceBookVersion: '2026-10', manifestVersion: 2, productVersion: '2.0.0' });
		expect(pro.pins.map((/** @type {any} */ p) => p.version)).toEqual(['2026-01', '2026-10']);
		const doc = await decode(h, await h.service.documentFor({ websiteId: W1, appId: APP }));
		expect(doc).toMatchObject({ planCode: 'pro', priceBookVersion: '2026-10' });
		clock.set(T0 + 2 * HOUR + 5 * MIN);
		await h.service.runSettlement();
		expect(keysOf(await ledgerRows(h, M1, 'settlement'))).toEqual([
			'2026-10-01T10:00:00Z=-1500', // starter on book 2026-01 (sampled at 10:00, before reports was switched on)
			'2026-10-01T11:00:00Z=-2750', // pro on book 2026-10 (ai_copy has no ai resource → not billed)
		]);
		await h.service.setElement({ subscriptionId, elementKey: 'codes', enabled: false, actor: MERCHANT_ACTOR });
		await expect(h.service.changePlan({ subscriptionId, planCode: 'starter', actor: MERCHANT_ACTOR })).rejects.toMatchObject({
			code: 'conflict',
		});
		expect(await h.service.changePlan({ subscriptionId, planCode: null, actor: STAFF })).toMatchObject({ planCode: null });
	});

	it('records usage exactly once, settles metered overage on cumulative usage and blocks exhausted quotas', async () => {
		const clock = createClock(T0);
		const h = await bootCommerce({ mongo, dbName: 'cm_usage', clock });
		await h.credit(M1, 100_000);
		const { subscriptionId } = await h.service.subscribe({
			websiteId: W1,
			appId: APP,
			planCode: 'starter',
			actor: MERCHANT_ACTOR,
		});
		await h.credit(M2, 100_000);
		const other = await h.service.subscribe({
			websiteId: W3,
			appId: APP2,
			actor: { type: 'staff', id: 'stf_1', roles: ['admin'] },
		});
		const auth = await h.productAuth(APP);
		const record = (/** @type {string} */ key, /** @type {number} */ quantity, extra = {}) => ({
			websiteId: W1,
			subscriptionId,
			unit: 'redemption',
			quantity,
			idempotencyKey: key,
			occurredAt: '2026-10-01T10:00:00Z',
			...extra,
		});
		clock.set(T0 + 10 * MIN);
		const body = {
			records: [
				record('a', 3),
				record('b', 5),
				record('a', 3),
				record('c', 1, { websiteId: W2 }),
				record('d', 1, { unit: 'sms' }),
				record('e', 1, { subscriptionId: 'sub_zzzzzzzzzzzzzzzzzzzzzzzzzz' }),
				record('f', -1),
				record('g', 1, { subscriptionId: other.subscriptionId, websiteId: W3 }),
			],
		};
		const first = await h.call('POST', '/v1/product/usage', {
			headers: { ...(await auth()), 'idempotency-key': 'batch-1' },
			body,
		});
		expect(first.status).toBe(200);
		expect(first.json.results.map((/** @type {any} */ r) => `${r.idempotencyKey}:${r.status}:${r.reason ?? ''}`)).toEqual([
			'a:accepted:',
			'b:accepted:',
			'a:duplicate:',
			'c:rejected:subscription_mismatch',
			'd:rejected:unknown_unit',
			'e:rejected:not_subscribed',
			'f:rejected:invalid_quantity',
			'g:rejected:subscription_mismatch',
		]);
		const replay = await h.call('POST', '/v1/product/usage', {
			headers: { ...(await auth()), 'idempotency-key': 'batch-1' },
			body,
		});
		expect(replay.headers.get('idempotent-replayed')).toBe('true');
		const again = await h.call('POST', '/v1/product/usage', {
			headers: { ...(await auth()), 'idempotency-key': 'batch-2' },
			body,
		});
		expect(again.json.results.slice(0, 2).map((/** @type {any} */ r) => r.status)).toEqual(['duplicate', 'duplicate']);
		expect(
			(
				await h.call('POST', '/v1/product/usage', {
					headers: { ...(await auth()), 'idempotency-key': 'x' },
					body: { records: [] },
				})
			).status,
		).toBe(422);
		expect(await h.db.collection('commerce_usage').countDocuments({ subscriptionId })).toBe(2);

		const v1 = (await decode(h, await h.service.documentFor({ websiteId: W1, appId: APP }))).version;
		clock.set(T0 + HOUR + 10 * MIN); // 11:10: 15 more → 23 ≥ quota 20 (starter x-plan default)
		const more = await h.service.recordUsage({ appId: APP, records: [record('h', 15)] });
		expect(more.results[0]?.status).toBe('accepted');
		const doc = await decode(h, await h.service.documentFor({ websiteId: W1, appId: APP }));
		expect(doc.version).toBe(v1 + 1);
		expect(doc.features['codes.redemptions']).toMatchObject({ value: 20, reason: 'quota_exhausted' });
		expect(doc.elements.codes).toEqual({ enabled: true });
		expect(
			h.world.events.filter((e) => e.type === 'entitlement.changed@1' && e.data.subscriptionId === subscriptionId),
		).toHaveLength(2);

		clock.set(T0 + 2 * HOUR + 5 * MIN);
		await h.service.runSettlement();
		const metered = await ledgerRows(h, M1, 'metered');
		expect(keysOf(metered)).toEqual(['2026-10-01T10:00:00Z:metered=-30', '2026-10-01T11:00:00Z:metered=-150']);
		expect(metered[1]?.details.lines).toEqual([{ unit: 'redemption', quantity: 15, billableQuantity: 15, amount: 150 }]);
		// counters were repaired from the records (the source of truth)
		const counters = await h.db.collection('commerce_usage_counters').find({ subscriptionId }).sort({ hour: 1 }).toArray();
		expect(counters.map((c) => c.quantity)).toEqual([8, 15]);
		await expect(h.service.recordUsage({ appId: APP, records: [record('i', 1)] })).resolves.toMatchObject({
			results: [{ status: 'accepted' }],
		});
	});

	it('pauses everything when the balance reaches zero and resumes automatically on top-up', async () => {
		const clock = createClock(T0);
		const h = await bootCommerce({ mongo, dbName: 'cm_credits', clock });
		await h.credit(M1, 3000);
		const sub = await h.service.subscribe({ websiteId: W1, appId: APP, planCode: 'starter', actor: MERCHANT_ACTOR });
		const free = await h.service.subscribe({ websiteId: W2, appId: APP2, actor: MERCHANT_ACTOR });
		clock.set(T0 + 2 * HOUR + 5 * MIN);
		await h.service.runSettlement();
		expect((await h.service.balance(M1)).balanceMillicredits).toBe(0);
		expect(await h.service.getSubscription(sub.subscriptionId)).toMatchObject({
			status: 'paused',
			holds: ['insufficient_credits'],
		});
		expect(await h.service.getSubscription(free.subscriptionId)).toMatchObject({ status: 'paused' });
		const doc = await decode(h, await h.service.documentFor({ websiteId: W1, appId: APP }));
		expect(doc.runtime.state).toBe('paused');
		await expect(h.service.subscribe({ websiteId: W2, appId: APP, actor: MERCHANT_ACTOR })).rejects.toMatchObject({
			code: 'credits_exhausted',
		});
		// the merchant cannot lift an insufficient-credits hold by resuming
		expect(await h.service.resume({ subscriptionId: sub.subscriptionId, actor: MERCHANT_ACTOR })).toMatchObject({
			status: 'paused',
		});
		clock.set(T0 + 4 * HOUR + 5 * MIN);
		await h.service.runSettlement();
		// hour 12 had active minutes before the pause at 12:05 (F.1: negative by at most one hour); hour 13 is free
		expect((await h.service.balance(M1)).balanceMillicredits).toBe(-1500);
		clock.set(T0 + 4 * HOUR + 30 * MIN);
		await h.credit(M1, 10_000);
		expect(await h.service.getSubscription(sub.subscriptionId)).toMatchObject({ status: 'active', holds: [] });
		clock.set(T0 + 6 * HOUR + 5 * MIN);
		await h.service.runSettlement();
		expect(keysOf(await ledgerRows(h, M1, 'settlement')).filter((k) => !k.endsWith('=0'))).toEqual([
			'2026-10-01T10:00:00Z=-1500',
			'2026-10-01T11:00:00Z=-1500',
			'2026-10-01T12:00:00Z=-1500',
			'2026-10-01T14:00:00Z=-1500',
			'2026-10-01T15:00:00Z=-1500',
		]);
		expect((await h.service.balance(M1)).balanceMillicredits).toBe(5500);
		const reasons = h.world.events
			.filter((e) => e.data.subscriptionId === sub.subscriptionId)
			.map((e) => `${e.type}:${e.data.reason ?? ''}`);
		expect(reasons).toEqual(
			expect.arrayContaining([
				'subscription.paused@1:insufficient_credits',
				'subscription.resumed@1:insufficient_credits_released',
			]),
		);
		// a negative adjustment that empties the balance pauses at once
		await h.service.adjust({
			merchantId: M1,
			amountMillicredits: -5500,
			reference: 'chargeback-1',
			note: 'chargeback',
			actor: STAFF,
		});
		expect(await h.service.getSubscription(sub.subscriptionId)).toMatchObject({ holds: ['insufficient_credits'] });
	});

	it('the monthly spend cap pauses before it would be exceeded and resumes when the month ends or the cap rises', async () => {
		const clock = createClock(T0);
		const h = await bootCommerce({ mongo, dbName: 'cm_caps', clock });
		await h.credit(M1, 100_000);
		const sub = await h.service.subscribe({ websiteId: W1, appId: APP, planCode: 'starter', actor: MERCHANT_ACTOR });
		expect(await h.service.spendCap(M1)).toEqual({
			limit: null,
			spent: 0,
			remaining: null,
			reached: false,
			periodStart: '2026-10-01T00:00:00.000Z',
			periodEnd: '2026-11-01T00:00:00.000Z',
		});
		const set = await h.service.setSpendCap(M1, { limit: 4000 }, { actor: MERCHANT_ACTOR });
		expect(set).toMatchObject({ limit: 4000, spent: 0, remaining: 4000, reached: false });
		clock.set(T0 + HOUR + 5 * MIN); // 11:05: spent 1500 + 2 × 1500 > 4000 → pause until the month ends
		await h.service.runSettlement();
		expect(await h.service.getSubscription(sub.subscriptionId)).toMatchObject({ status: 'paused', holds: ['spend_cap'] });
		const doc = await decode(h, await h.service.documentFor({ websiteId: W1, appId: APP }));
		expect(doc.runtime).toEqual({ state: 'spend_cap', reason: 'spend_cap' });
		clock.set(T0 + 3 * HOUR + 5 * MIN);
		await h.service.runSettlement();
		expect((await h.service.statement(M1, { from: T0, to: clock.now() + 1 })).totals.settlement).toBe(-3000); // within the cap
		expect(await h.service.spendCap(M1)).toMatchObject({ limit: 4000, spent: 3000, remaining: 1000, reached: false });
		expect((await h.service.setSpendCap(M1, { limit: 20_000 }, { actor: MERCHANT_ACTOR })).limit).toBe(20_000);
		expect(await h.service.getSubscription(sub.subscriptionId)).toMatchObject({ status: 'active' });
		await h.service.setSpendCap(M1, { limit: 3000 }, { actor: MERCHANT_ACTOR });
		expect(await h.service.getSubscription(sub.subscriptionId)).toMatchObject({ holds: ['spend_cap'] });
		expect(await h.service.spendCap(M1)).toMatchObject({ remaining: 0, reached: true });
		for (const body of [{ limit: -1 }, { limit: 0 }, { limit: 1.5 }, { limit: 5, other: 1 }, 'x'])
			await expect(h.service.setSpendCap(M1, body, { actor: MERCHANT_ACTOR })).rejects.toMatchObject({
				code: 'validation_failed',
			});
		// next month: the period resets → resume
		clock.set(Date.parse('2026-11-01T00:05:00Z'));
		await h.service.runSettlement();
		expect(await h.service.getSubscription(sub.subscriptionId)).toMatchObject({ status: 'active', holds: [] });
		// removing the cap releases a hold
		await h.service.setSpendCap(M1, { limit: 1 }, { actor: MERCHANT_ACTOR });
		expect(await h.service.getSubscription(sub.subscriptionId)).toMatchObject({ holds: ['spend_cap'] });
		await h.service.removeSpendCap(M1, { actor: MERCHANT_ACTOR });
		expect(await h.service.getSubscription(sub.subscriptionId)).toMatchObject({ holds: [] });
		expect((await h.service.spendCap(M1)).limit).toBeNull();
		await expect(h.service.removeSpendCap(M1, { actor: MERCHANT_ACTOR })).rejects.toMatchObject({ code: 'not_found' });
		const audit = await h.portal.shared.audit.list({ merchantId: M1 });
		expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['spend_cap.updated', 'spend_cap.removed']));
	});

	it('merchant suspension suspends every subscription; cancellation settles through the cancelled hour', async () => {
		const clock = createClock(T0);
		const h = await bootCommerce({ mongo, dbName: 'cm_suspend', clock });
		await h.credit(M1, 100_000);
		const a = await h.service.subscribe({ websiteId: W1, appId: APP, planCode: 'starter', actor: MERCHANT_ACTOR });
		await h.service.subscribe({ websiteId: W2, appId: APP2, actor: MERCHANT_ACTOR });
		clock.set(T0 + 30 * MIN);
		expect(await h.service.onMerchantStatus({ merchantId: M1, status: 'suspended' })).toEqual({ changed: 2 });
		expect(await h.service.getSubscription(a.subscriptionId)).toMatchObject({ status: 'suspended' });
		expect((await decode(h, await h.service.documentFor({ websiteId: W2, appId: APP2 }))).runtime.state).toBe('suspended');
		h.world.merchants.set(M1, { .../** @type {any} */ (h.world.merchants.get(M1)), status: 'suspended' });
		await expect(h.service.subscribe({ websiteId: W2, appId: APP, actor: MERCHANT_ACTOR })).rejects.toMatchObject({
			code: 'forbidden',
		});
		clock.set(T0 + 2 * HOUR + 30 * MIN);
		expect(await h.service.onMerchantStatus({ merchantId: M1, status: 'active' })).toEqual({ changed: 2 });
		clock.set(T0 + 3 * HOUR + 10 * MIN);
		const cancelled = await h.service.cancel({
			subscriptionId: a.subscriptionId,
			actor: MERCHANT_ACTOR,
			reason: 'too_expensive',
		});
		expect(cancelled.status).toBe('cancelled');
		expect(await h.service.cancel({ subscriptionId: a.subscriptionId, actor: MERCHANT_ACTOR })).toMatchObject({
			status: 'cancelled',
		});
		await expect(h.service.documentFor({ websiteId: W1, appId: APP })).rejects.toMatchObject({ code: 'gone' });
		await expect(
			h.service.setElement({ subscriptionId: a.subscriptionId, elementKey: 'codes', enabled: true, actor: STAFF }),
		).rejects.toMatchObject({ code: 'gone' });
		await expect(h.service.pause({ subscriptionId: a.subscriptionId, actor: STAFF })).rejects.toMatchObject({ code: 'gone' });
		await expect(h.service.resume({ subscriptionId: a.subscriptionId, actor: STAFF })).rejects.toMatchObject({ code: 'gone' });
		await expect(
			h.service.changePlan({ subscriptionId: a.subscriptionId, planCode: null, actor: STAFF }),
		).rejects.toMatchObject({ code: 'gone' });
		expect(await h.service.invalidate(a.subscriptionId)).toEqual({ invalidated: true, version: null });
		clock.set(T0 + 6 * HOUR + 5 * MIN);
		await h.service.runSettlement();
		expect(keysOf(await ledgerRows(h, M1, 'settlement')).filter((k) => !k.endsWith('=0'))).toEqual([
			'2026-10-01T10:00:00Z=-1500', // suspended from 10:30 (hour 10 started) …
			'2026-10-01T12:00:00Z=-1500', // … to 12:30
			'2026-10-01T13:00:00Z=-1500', // cancelled at 13:10
		]);
		const doc = await h.db.collection('commerce_subscriptions').findOne({ _id: a.subscriptionId });
		expect(doc).toMatchObject({ settlementDone: true });
		expect(await h.service.runSettlement()).toMatchObject({ subscriptions: 0 }); // nothing due
		// a new subscription after cancellation is allowed
		h.world.merchants.set(M1, { .../** @type {any} */ (h.world.merchants.get(M1)), status: 'active' });
		expect(await h.service.subscribe({ websiteId: W1, appId: APP, planCode: 'starter', actor: MERCHANT_ACTOR })).toMatchObject({
			status: 'active',
		});
		expect(h.world.events.map((e) => e.type)).toEqual(expect.arrayContaining(['subscription.cancelled@1']));
		expect((await h.service.subscriptionsForWebsite(W1)).map((s) => s.status)).toEqual(['cancelled', 'active']);
		expect(await h.service.invalidate('sub_zzzzzzzzzzzzzzzzzzzzzzzzzz')).toEqual({ invalidated: false, version: null });
	});
});

describe('entitlement documents', () => {
	it('bumps the version only when the content hash changes and re-signs near validUntil', async () => {
		const clock = createClock(T0);
		const h = await bootCommerce({ mongo, dbName: 'cm_docs', clock });
		await h.credit(M1, 100_000);
		const { subscriptionId } = await h.service.subscribe({
			websiteId: W1,
			appId: APP,
			planCode: 'starter',
			actor: MERCHANT_ACTOR,
		});
		const changed = () => h.world.events.filter((e) => e.type === 'entitlement.changed@1').length;
		expect(changed()).toBe(1);
		expect(await h.service.invalidate(subscriptionId)).toEqual({ invalidated: true, version: 1 });
		expect(await h.service.invalidate(subscriptionId)).toEqual({ invalidated: true, version: 1 });
		expect(changed()).toBe(1);
		const first = await h.service.documentFor({ websiteId: W1, appId: APP });
		clock.advance(9 * MIN); // within 2 min of validUntil → re-signed, same version
		const resigned = await h.service.documentFor({ websiteId: W1, appId: APP });
		expect(resigned).not.toBe(first);
		expect((await decode(h, resigned)).version).toBe(1);
		h.world.layers.set(subscriptionId, { website: { features: { 'codes.redemptions': { value: 15 } } } });
		expect(await h.service.invalidate(subscriptionId)).toEqual({ invalidated: true, version: 2 });
		expect(changed()).toBe(2);
		const doc = await decode(h, await h.service.documentFor({ websiteId: W1, appId: APP }));
		expect(doc.features['codes.redemptions']).toMatchObject({ value: 15, source: 'website_override' });
		const event = h.world.events.at(-1);
		expect(event).toMatchObject({
			type: 'entitlement.changed@1',
			data: { version: 2, websiteId: W1 },
			target: { appIds: [APP], websiteId: W1 },
		});
		expect(event?.data.document).toBe(await h.service.documentFor({ websiteId: W1, appId: APP }));
		await expect(h.service.documentFor({ websiteId: W2, appId: APP })).rejects.toMatchObject({ code: 'not_found' });
		await expect(h.service.documentFor({ websiteId: /** @type {any} */ (5), appId: APP })).rejects.toMatchObject({
			code: 'not_found',
		});
	});

	it('carries the website identity issuer and bumps the version when it changes', async () => {
		const clock = createClock(T0);
		const h = await bootCommerce({ mongo, dbName: 'cm_identity', clock });
		await h.credit(M1, 100_000);
		const { subscriptionId } = await h.service.subscribe({
			websiteId: W1,
			appId: APP,
			planCode: 'starter',
			actor: MERCHANT_ACTOR,
		});
		const plain = await decode(h, await h.service.documentFor({ websiteId: W1, appId: APP }));
		expect(plain).not.toHaveProperty('identity');
		const identity = {
			issuer: 'https://login.shop.example.com/',
			jwks: [
				{ kty: 'OKP', crv: 'Ed25519', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo', kid: 'k1', alg: 'EdDSA', use: 'sig' },
			],
			claimMap: { subject: 'sub' },
		};
		h.world.identities.set(W1, identity);
		expect(await h.service.invalidate(subscriptionId)).toEqual({ invalidated: true, version: 2 });
		const doc = await decode(h, await h.service.documentFor({ websiteId: W1, appId: APP }));
		expect(doc.identity).toEqual(identity);
		expect(await h.service.invalidate(subscriptionId)).toEqual({ invalidated: true, version: 2 }); // unchanged
		h.world.identities.set(W1, { ...identity, audience: 'shop' });
		expect(await h.service.invalidate(subscriptionId)).toEqual({ invalidated: true, version: 3 });
		const preview = await h.service.previewDocument({ subscriptionId, layers: {} });
		expect(preview).toMatchObject({ version: 3, identity: { audience: 'shop' } });
		h.world.identities.delete(W1);
		expect(await h.service.invalidate(subscriptionId)).toEqual({ invalidated: true, version: 4 });
	});

	it('carries the website settings section, hashes it, and reports resource needs (F.16)', async () => {
		const clock = createClock(T0);
		const h = await bootCommerce({ mongo, dbName: 'cm_website', clock });
		await h.credit(M1, 100_000);
		const { subscriptionId } = await h.service.subscribe({
			websiteId: W1,
			appId: APP,
			planCode: 'starter',
			actor: MERCHANT_ACTOR,
		});
		const plain = await decode(h, await h.service.documentFor({ websiteId: W1, appId: APP }));
		expect(plain).not.toHaveProperty('website');
		const before = plain.version;
		const site = /** @type {any} */ (h.world.websites.get(W1));
		h.world.websites.set(W1, { ...site, timeZone: 'Europe/Berlin', language: 'de-DE', currency: 'EUR' });
		expect(await h.service.invalidate(subscriptionId)).toEqual({ invalidated: true, version: before + 1 });
		const doc = await decode(h, await h.service.documentFor({ websiteId: W1, appId: APP }));
		expect(doc.website).toEqual({ timeZone: 'Europe/Berlin', language: 'de-DE', currency: 'EUR' });
		expect(await h.service.invalidate(subscriptionId)).toEqual({ invalidated: true, version: before + 1 }); // unchanged
		h.world.websites.set(W1, { ...site, timeZone: 'Europe/Berlin', language: null, currency: null });
		expect(await h.service.invalidate(subscriptionId)).toEqual({ invalidated: true, version: before + 2 });
		expect((await decode(h, await h.service.documentFor({ websiteId: W1, appId: APP }))).website).toEqual({
			timeZone: 'Europe/Berlin',
		});

		// starter: reports (database) and ai_copy (ai) are off → their kinds are needed only if enabled
		const needs = await h.service.resourceNeeds(W1);
		expect(needs.map((/** @type {any} */ n) => [n.kind, n.scope, n.neededNow, n.elements])).toEqual([
			['ai', 'element', false, ['ai_copy']],
			['database', 'element', false, ['reports']],
		]);
		await h.service.setElement({ subscriptionId, elementKey: 'reports', enabled: true, actor: MERCHANT_ACTOR });
		const after = await h.service.resourceNeeds(W1);
		expect(after.find((/** @type {any} */ n) => n.kind === 'database')).toMatchObject({ neededNow: true, appId: APP });
		expect(await h.service.websitesOfApp(APP)).toEqual([W1]);
	});

	it('previews documents for configuration dry runs and invalidates every subscription of an app', async () => {
		const clock = createClock(T0);
		const h = await bootCommerce({ mongo, dbName: 'cm_preview', clock });
		await h.credit(M1, 100_000);
		await h.credit(M2, 100_000);
		const a = await h.service.subscribe({ websiteId: W1, appId: APP, planCode: 'starter', actor: MERCHANT_ACTOR });
		await h.service.subscribe({ websiteId: W3, appId: APP, actor: { type: 'staff', id: 'stf_1', roles: ['admin'] } });
		expect(h.world.calls.lastHint).toMatchObject({ appId: APP });
		const events = h.world.events.length;
		const preview = await h.service.previewDocument({
			subscriptionId: a.subscriptionId,
			layers: { website: { features: { 'codes.redemptions': { value: 7 } } } },
		});
		expect(preview).toMatchObject({
			subscriptionId: a.subscriptionId,
			version: 2,
			features: { 'codes.redemptions': { value: 7 } },
		});
		const same = await h.service.previewDocument({ subscriptionId: a.subscriptionId, layers: {} });
		expect(same.version).toBe(1);
		expect(h.world.events.length).toBe(events); // nothing emitted or stored
		expect(
			(await decode(h, await h.service.documentFor({ websiteId: W1, appId: APP }))).features['codes.redemptions'].value,
		).toBe(20);
		h.world.layers.set(a.subscriptionId, {
			platform: { features: { 'codes.redemptions': { value: 3, locked: true } } },
		});
		expect(await h.service.invalidateApp(APP)).toEqual({ invalidated: 2 });
		expect(
			(await decode(h, await h.service.documentFor({ websiteId: W1, appId: APP }))).features['codes.redemptions'],
		).toMatchObject({
			value: 3,
			locked: true,
			source: 'platform_policy',
		});
		await h.service.cancel({ subscriptionId: a.subscriptionId, actor: MERCHANT_ACTOR });
		await expect(h.service.previewDocument({ subscriptionId: a.subscriptionId, layers: {} })).rejects.toMatchObject({
			code: 'gone',
		});
		expect(await h.service.invalidateApp(APP)).toEqual({ invalidated: 1 });
		expect(await h.service.getSubscription(a.subscriptionId, M2).catch((e) => e.code)).toBe('not_found');
		expect((await h.service.subscriptionsOfMerchant(M1)).map((s) => s.status)).toEqual(['cancelled']);
		// an inactive app takes no new subscriptions; existing ones keep working
		const entry = /** @type {any} */ (h.world.apps.get(APP));
		h.world.apps.set(APP, { ...entry, app: { ...entry.app, status: 'inactive' } });
		await expect(
			h.service.subscribe({ websiteId: W1, appId: APP, planCode: 'starter', actor: MERCHANT_ACTOR }),
		).rejects.toMatchObject({ code: 'conflict' });
		expect(await h.service.documentFor({ websiteId: W3, appId: APP })).toBeTypeOf('string');
	});

	it('works without optional neighbours (no config, connectors or integration) and survives delivery failures', async () => {
		const h = await bootCommerce({
			mongo,
			dbName: 'cm_optional',
			options: { withConfig: false, withConnectors: false, withIntegration: false },
		});
		await h.credit(M1, 100_000);
		const sub = await h.service.subscribe({ websiteId: W1, appId: APP, planCode: 'pro', actor: MERCHANT_ACTOR });
		const doc = await decode(h, await h.service.documentFor({ websiteId: W1, appId: APP }));
		expect(doc.elements.reports).toEqual({ enabled: false, reason: 'resource_missing:database' });
		expect(doc.resources).toEqual([]);
		const g = await bootCommerce({ mongo, dbName: 'cm_emit_fail' });
		g.world.failEmit = true;
		await g.credit(M1, 100_000);
		await expect(g.service.subscribe({ websiteId: W1, appId: APP, actor: MERCHANT_ACTOR })).resolves.toMatchObject({
			status: 'active',
		});
		expect(g.logs.some((l) => l.msg === 'control event not emitted')).toBe(true);
		expect(sub.status).toBe('active');
	});
});

describe('lazy settlement and trials', () => {
	it('settles due hours on balance and meter reads, idempotently with the settlement operation', async () => {
		const clock = createClock(T0 + 30 * MIN); // 10:30
		const h = await bootCommerce({ mongo, dbName: 'cm_lazy', clock });
		await h.credit(M1, 100_000);
		await h.service.subscribe({ websiteId: W1, appId: APP, planCode: 'starter', actor: MERCHANT_ACTOR });
		// the current hour is not complete: nothing to settle yet
		expect((await h.service.balance(M1)).balanceMillicredits).toBe(100_000);
		clock.set(T0 + 2 * HOUR + 5 * MIN); // 12:05 → hours 10 and 11 are due
		expect((await h.service.balance(M1)).balanceMillicredits).toBe(97_000);
		expect((await h.service.meter(M1)).balanceMillicredits).toBe(97_000);
		expect(await h.service.runSettlement()).toMatchObject({ entries: 0 });
		clock.set(T0 + 3 * HOUR + 5 * MIN);
		expect((await h.service.meter(M1)).balanceMillicredits).toBe(95_500);
		expect((await h.service.balance(M1)).balanceMillicredits).toBe(95_500);
		expect(keysOf(await ledgerRows(h, M1, 'settlement'))).toEqual([
			'2026-10-01T10:00:00Z=-1500',
			'2026-10-01T11:00:00Z=-1500',
			'2026-10-01T12:00:00Z=-1500',
		]);
		// another merchant's read settles only its own subscriptions
		expect((await h.service.balance(M2)).balanceMillicredits).toBe(0);
		expect((await h.service.verifyChain(M1)).ok).toBe(true);
	});

	it('settles on the product document fetch, so an out-of-credit hold reaches the document (no cron)', async () => {
		const clock = createClock(T0);
		const h = await bootCommerce({ mongo, dbName: 'cm_doc_hold', clock });
		await h.credit(M1, 3000);
		await h.service.subscribe({ websiteId: W1, appId: APP, planCode: 'starter', actor: MERCHANT_ACTOR });
		expect((await decode(h, await h.service.documentFor({ websiteId: W1, appId: APP }))).runtime.state).not.toBe('paused');
		// two hours pass; nobody runs anything. The product's next document fetch settles the merchant first.
		clock.set(T0 + 2 * HOUR + 5 * MIN);
		const doc = await decode(h, await h.service.documentFor({ websiteId: W1, appId: APP }));
		expect(doc.runtime.state).toBe('paused');
		expect(keysOf(await ledgerRows(h, M1, 'settlement'))).toEqual(['2026-10-01T10:00:00Z=-1500', '2026-10-01T11:00:00Z=-1500']);
		// usage reported by a product settles its merchant right after the response
		clock.set(T0 + 3 * HOUR + 5 * MIN);
		/** @type {Array<() => Promise<unknown>>} */
		const deferred = [];
		const sub = /** @type {any} */ ((await h.service.subscriptionsForWebsite(W1))[0]);
		await runInRequestScope({ defer: (task) => void deferred.push(task) }, () =>
			h.service.recordUsage({
				appId: APP,
				records: [
					{
						websiteId: W1,
						subscriptionId: sub.subscriptionId,
						unit: 'redemption',
						quantity: 1,
						idempotencyKey: 'u-hold-1',
						occurredAt: new Date(clock.now()).toISOString(),
					},
				],
			}),
		);
		expect(deferred).toHaveLength(1);
		await deferred[0]?.();
		expect(keysOf(await ledgerRows(h, M1, 'settlement'))).toHaveLength(3);
	});

	it('survives a failing lazy settlement (the read still answers)', async () => {
		const clock = createClock(T0 + 30 * MIN);
		const h = await bootCommerce({ mongo, dbName: 'cm_lazy_fail', clock });
		await h.credit(M1, 100_000);
		const sub = await h.service.subscribe({ websiteId: W1, appId: APP, planCode: 'starter', actor: MERCHANT_ACTOR });
		// a subscription whose manifest version vanished cannot be planned: settlement logs, the read answers
		await h.db.collection('commerce_subscriptions').updateOne({ _id: sub.subscriptionId }, { $set: { pins: 'broken' } });
		clock.set(T0 + 2 * HOUR + 5 * MIN);
		expect((await h.service.balance(M1)).balanceMillicredits).toBe(100_000);
	});

	it('grants manifest trialHours once per website × app as an adjustment at the first subscribe', async () => {
		const clock = createClock(T0);
		const h = await bootCommerce({ mongo, dbName: 'cm_trial', clock });
		const manifest = /** @type {any} */ (couponsManifest());
		manifest.trialHours = 24;
		/** @type {any} */ (h.world.apps.get(APP)).versions.set(1, manifest);
		// no credits at all: the trial (24 h × 1500) covers the first hour
		const sub = await h.service.subscribe({ websiteId: W1, appId: APP, planCode: 'starter', actor: MERCHANT_ACTOR });
		expect(await ledgerRows(h, M1, 'adjustment')).toMatchObject([
			{ entryKey: `trial:${W1}:${APP}`, amount: 36_000, subscriptionId: sub.subscriptionId, websiteId: W1, appId: APP },
		]);
		expect((await h.service.balance(M1)).balanceMillicredits).toBe(36_000);
		// cancel and subscribe again: no second trial for the same website × app
		await h.service.cancel({ subscriptionId: sub.subscriptionId, actor: MERCHANT_ACTOR });
		await h.service.subscribe({ websiteId: W1, appId: APP, planCode: 'starter', actor: MERCHANT_ACTOR });
		expect(await ledgerRows(h, M1, 'adjustment')).toHaveLength(1);
		// another website of the merchant gets its own trial
		await h.service.subscribe({ websiteId: W2, appId: APP, planCode: 'starter', actor: MERCHANT_ACTOR });
		expect((await ledgerRows(h, M1, 'adjustment')).map((/** @type {any} */ r) => r.entryKey)).toEqual([
			`trial:${W1}:${APP}`,
			`trial:${W2}:${APP}`,
		]);
		const audits = await h.portal.shared.audit.list({ merchantId: M1 });
		expect(audits.filter((/** @type {any} */ a) => a.action === 'credits.trial_granted')).toHaveLength(2);
		// another merchant's website: its own trial in its own ledger
		await h.service.subscribe({ websiteId: W3, appId: APP, planCode: 'starter', actor: MERCHANT_ACTOR });
		expect(await ledgerRows(h, M2, 'adjustment')).toMatchObject([{ entryKey: `trial:${W3}:${APP}`, amount: 36_000 }]);
		expect((await h.service.verifyChain(M1)).ok).toBe(true);
	});
});
