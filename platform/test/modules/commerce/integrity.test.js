import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { closeMongoClients } from '../../../src/infra/db.js';
import { createCommerceService } from '../../../src/modules/commerce/service.js';
import { T0, createClock, startMongo } from '../../helpers.js';
import { APP, APP2, HOUR, M1, M2, STAFF, W1, W2, W3, bootCommerce } from './fixtures.js';

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

const MIN = 60_000;
const OWNER = { type: 'merchant_user', id: 'usr_owner', merchantId: M1, roles: ['owner'] };
const OWNER2 = { type: 'merchant_user', id: 'usr_owner2', merchantId: M2, roles: ['owner'] };

/**
 * A commerce service whose collections fail on demand (simulated crashes).
 * @param {any} ctx module context
 * @param {{ ledgerInsertsBeforeCrash?: number, accountUpdatesToFail?: number }} faults
 */
const faultyService = (ctx, { ledgerInsertsBeforeCrash = Number.POSITIVE_INFINITY, accountUpdatesToFail = 0 }) => {
	let inserts = 0;
	let accountFailures = accountUpdatesToFail;
	return createCommerceService({
		...ctx,
		collection: (/** @type {string} */ name) => {
			const repo = ctx.collection(name);
			if (name === 'commerce_ledger')
				return {
					...repo,
					forMerchant: (/** @type {string} */ m) => {
						const ops = repo.forMerchant(m);
						return {
							...ops,
							insertOne: async (/** @type {any} */ doc, /** @type {any} */ options) => {
								inserts += 1;
								if (inserts > ledgerInsertsBeforeCrash) throw new Error('simulated crash');
								return ops.insertOne(doc, options);
							},
						};
					},
				};
			if (name === 'commerce_accounts')
				return {
					...repo,
					forMerchant: (/** @type {string} */ m) => {
						const ops = repo.forMerchant(m);
						return {
							...ops,
							updateOne: async (/** @type {any[]} */ ...args) => {
								if (accountFailures > 0) {
									accountFailures -= 1;
									throw new Error('simulated crash after the ledger insert');
								}
								return ops.updateOne(...args);
							},
						};
					},
				};
			return repo;
		},
	});
};

/**
 * @param {any} h @param {string} [merchantId]
 * @returns {Promise<any[]>}
 */
const ledgerMap = async (h, merchantId) => {
	const rows = await h.db
		.collection('commerce_ledger')
		.find({ ...(merchantId ? { merchantId } : {}), periodKey: { $type: 'string' } })
		.toArray();
	return rows;
};

describe('ledger integrity', () => {
	it('concurrent appends keep one linear chain and an exact balance', async () => {
		const h = await bootCommerce({ mongo, dbName: 'cm_concurrent' });
		const amounts = Array.from({ length: 25 }, (_, i) => (i + 1) * 100);
		const results = await Promise.all(amounts.map((a, i) => h.credit(M1, a, `c-${i}`)));
		expect(results.every((r) => r.duplicate === false)).toBe(true);
		const verify = await h.service.verifyChain(M1);
		expect(verify).toMatchObject({ ok: true, entries: 25, seq: 25, balance: amounts.reduce((s, a) => s + a, 0) });
		expect((await h.service.balance(M1)).balanceMillicredits).toBe(verify.balance);
		// the same reference concurrently → one entry
		const same = await Promise.all([h.credit(M1, 7, 'dup'), h.credit(M1, 7, 'dup'), h.credit(M1, 7, 'dup')]);
		expect(same.filter((r) => !r.duplicate)).toHaveLength(1);
		// concurrent subscribe to the same website × app → exactly one subscription
		const subs = await Promise.allSettled(
			[1, 2, 3].map(() => h.service.subscribe({ websiteId: W1, appId: APP, planCode: 'starter', actor: OWNER })),
		);
		expect(subs.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
		expect(subs.filter((s) => s.status === 'rejected').map((s) => /** @type {any} */ (s).reason.code)).toEqual([
			'conflict',
			'conflict',
		]);
		// staff only
		await expect(
			h.service.addCredits({ merchantId: M1, amountMillicredits: 5, reference: 'm', note: 'n', actor: OWNER }),
		).rejects.toMatchObject({
			code: 'forbidden',
		});
		await expect(
			h.service.addCredits({ merchantId: M1, amountMillicredits: 0, reference: 'm', note: 'n', actor: STAFF }),
		).rejects.toMatchObject({
			code: 'validation_failed',
		});
		await expect(h.credit('mer_zzzzzzzzzzzzzzzzzzzzzzzzzz', 5)).rejects.toMatchObject({ code: 'not_found' });
	});

	it('commits ledger entries and the account move atomically; still rolls forward entries left outside a transaction', async () => {
		const h = await bootCommerce({ mongo, dbName: 'cm_rollforward' });
		await h.credit(M1, 1000, 'first');
		const accountOf = () => h.db.collection('commerce_accounts').findOne({ _id: /** @type {any} */ (M1) });
		// a crash between the ledger insert and the account update aborts the whole transaction
		const faulty = faultyService(h.ctx, { accountUpdatesToFail: 1 });
		await expect(
			faulty.addCredits({ merchantId: M1, amountMillicredits: 500, reference: 'second', note: 'n', actor: STAFF }),
		).rejects.toThrow(/simulated crash/);
		expect((await h.service.balance(M1)).balanceMillicredits).toBe(1000);
		expect(await h.db.collection('commerce_ledger').countDocuments({ merchantId: M1 })).toBe(1);
		expect(await accountOf()).toMatchObject({ seq: 1, balance: 1000 });
		// so the retried request is applied, once
		expect((await h.credit(M1, 500, 'second')).duplicate).toBe(false);
		expect((await h.credit(M1, 500, 'second')).duplicate).toBe(true);
		expect(await accountOf()).toMatchObject({ seq: 2, balance: 1500 });

		// entries written without a transaction (an older writer) are still rolled into the account cache
		const legacy = faultyService(
			{ ...h.ctx, withTransaction: (/** @type {any} */ fn) => fn(undefined) },
			{ accountUpdatesToFail: 1 },
		);
		await expect(
			legacy.addCredits({ merchantId: M1, amountMillicredits: 500, reference: 'third', note: 'n', actor: STAFF }),
		).rejects.toThrow(/simulated crash/);
		expect((await h.service.balance(M1)).balanceMillicredits).toBe(2000); // pending entry counted
		expect(await accountOf()).toMatchObject({ seq: 2, balance: 1500 });
		expect((await h.credit(M1, 500, 'third')).duplicate).toBe(true);
		await h.credit(M1, 250, 'fourth');
		expect(await accountOf()).toMatchObject({ seq: 4, balance: 2250 });
		expect(await h.service.verifyChain(M1)).toMatchObject({ ok: true, balance: 2250 });
	});

	it('detects tampering, deletion and cache drift; reconciliation raises alerts and audit entries', async () => {
		const clock = createClock(T0);
		const h = await bootCommerce({ mongo, dbName: 'cm_tamper', clock });
		await h.credit(M1, 100_000);
		await h.credit(M2, 100_000);
		const sub = await h.service.subscribe({ websiteId: W1, appId: APP, planCode: 'starter', actor: OWNER });
		await h.service.subscribe({ websiteId: W3, appId: APP2, actor: OWNER2 });
		clock.set(T0 + 4 * HOUR + 5 * MIN);
		await h.service.runSettlement();
		const clean = await h.service.runReconciliation();
		expect(clean).toMatchObject({ complete: true, discrepancies: 0, subscriptions: 2, merchants: 2 });
		expect(await h.service.runReconciliation()).toMatchObject({ alreadyDone: true });

		const ledger = h.db.collection('commerce_ledger');
		await ledger.updateOne({ periodKey: `${sub.subscriptionId}:2026-10-01T11:00:00Z` }, { $set: { amount: -1 } });
		await ledger.deleteOne({ periodKey: `${sub.subscriptionId}:2026-10-01T12:00:00Z` });
		const verify = await h.service.verifyChain(M1);
		expect(verify.ok).toBe(false);
		expect(new Set(verify.problems.map((p) => p.kind))).toEqual(new Set(['hash', 'gap', 'link', 'account']));
		await h.db.collection('commerce_accounts').updateOne({ _id: /** @type {any} */ (M2) }, { $inc: { balance: 1 } });
		expect((await h.service.verifyChain(M2)).problems.map((p) => p.kind)).toEqual(['account']);

		clock.advance(24 * HOUR); // next night
		const report = await h.service.runReconciliation();
		expect(report).toMatchObject({ complete: true, discrepancies: 3 });
		const alerts = await h.service.alerts();
		expect(alerts.map((a) => a.kind).sort()).toEqual([
			'ledger_verification_failed',
			'ledger_verification_failed',
			'reconciliation_drift',
		]);
		const drift = alerts.find((a) => a.kind === 'reconciliation_drift');
		expect(drift?.details).toMatchObject({
			missing: [`${sub.subscriptionId}:2026-10-01T12:00:00Z`],
			mismatched: [{ periodKey: `${sub.subscriptionId}:2026-10-01T11:00:00Z`, expected: 1500, actual: 1 }],
		});
		const audit = await h.portal.shared.audit.list({ merchantId: M1 });
		expect(audit.map((a) => a.action)).toEqual(
			expect.arrayContaining(['commerce.reconciliation_drift', 'commerce.ledger_verification_failed']),
		);
		const reports = await h.service.reconciliationReports();
		expect(reports[0]).toMatchObject({ phase: 'done', subscriptions: 2, merchants: 2 });
		expect((await h.service.alerts({ merchantId: M2 })).map((a) => a.kind)).toEqual(['ledger_verification_failed']);
	});

	it('refuses to append onto a broken pending entry and raises an alert', async () => {
		const h = await bootCommerce({ mongo, dbName: 'cm_broken' });
		await h.credit(M1, 1000, 'a');
		const [entry] = await h.db.collection('commerce_ledger').find({ merchantId: M1 }).toArray();
		await h.db
			.collection('commerce_ledger')
			.insertOne({ ...entry, _id: /** @type {any} */ ('led_forged'), seq: 2, entryKey: 'forged', amount: 1e9 });
		await expect(h.credit(M1, 5, 'b')).rejects.toMatchObject({ code: 'internal_error' });
		expect((await h.service.alerts({ merchantId: M1 })).map((a) => a.kind)).toEqual(['ledger_chain_broken']);
		expect((await h.service.verifyChain(M1)).ok).toBe(false);
	});

	it('reconciliation and settlement resume across runs when the deadline is reached', async () => {
		const clock = createClock(T0);
		const h = await bootCommerce({ mongo, dbName: 'cm_deadline', clock });
		await h.credit(M1, 100_000);
		await h.service.subscribe({ websiteId: W1, appId: APP, planCode: 'starter', actor: OWNER });
		clock.set(T0 + 3 * HOUR + 5 * MIN);
		expect(await h.service.runSettlement({ deadline: clock.now() })).toMatchObject({ complete: false, subscriptions: 0 });
		const aborted = new AbortController();
		aborted.abort();
		expect(await h.service.runSettlement({ signal: aborted.signal })).toMatchObject({ complete: false });
		expect(await h.service.runReconciliation({ deadline: clock.now() })).toMatchObject({
			complete: false,
			phase: 'subscriptions',
		});
		const run = await h.portal.operations.run('settlement');
		expect(run).toMatchObject({ status: 'ok', stats: { subscriptions: 1, entries: 3, complete: true } });
		expect(await h.portal.operations.run('reconciliation')).toMatchObject({
			status: 'ok',
			stats: { complete: true, discrepancies: 0 },
		});
	});
});

describe('settlement idempotency (property)', () => {
	/**
	 * A scenario: actions at minute offsets on two merchants' subscriptions; settlement runs at some of them.
	 */
	const action = fc.oneof(
		fc.record({ kind: fc.constant('pause'), at: fc.integer({ min: 1, max: 9 * 60 }) }),
		fc.record({ kind: fc.constant('resume'), at: fc.integer({ min: 1, max: 9 * 60 }) }),
		fc.record({ kind: fc.constant('reports'), at: fc.integer({ min: 1, max: 9 * 60 }), on: fc.boolean() }),
		fc.record({
			kind: fc.constant('usage'),
			at: fc.integer({ min: 1, max: 9 * 60 }),
			quantity: fc.integer({ min: 0, max: 9 }),
		}),
		fc.record({
			kind: fc.constant('settle'),
			at: fc.integer({ min: 1, max: 9 * 60 }),
			crashAfter: fc.option(fc.integer({ min: 0, max: 4 }), { nil: null }),
			overlap: fc.boolean(),
		}),
	);

	/**
	 * @param {string} dbName
	 * @param {readonly any[]} actions sorted by `at`
	 * @param {'clean' | 'crashy' | 'single'} mode
	 */
	const play = async (dbName, actions, mode) => {
		const clock = createClock(T0);
		const h = await bootCommerce({ mongo, dbName, clock });
		await h.credit(M1, 10_000_000, 'seed');
		await h.credit(M2, 10_000_000, 'seed');
		const a = await h.service.subscribe({ websiteId: W1, appId: APP, planCode: 'starter', actor: OWNER });
		const b = await h.service.subscribe({ websiteId: W2, appId: APP2, actor: OWNER });
		const c = await h.service.subscribe({ websiteId: W3, appId: APP, planCode: 'pro', actor: OWNER2 });
		const names = new Map([
			[a.subscriptionId, 'A'],
			[b.subscriptionId, 'B'],
			[c.subscriptionId, 'C'],
		]);
		let usage = 0;
		for (const step of actions) {
			clock.set(T0 + step.at * MIN);
			if (step.kind === 'pause') await h.service.pause({ subscriptionId: a.subscriptionId, actor: OWNER });
			else if (step.kind === 'resume') await h.service.resume({ subscriptionId: a.subscriptionId, actor: OWNER });
			else if (step.kind === 'reports')
				await h.service.setElement({
					subscriptionId: a.subscriptionId,
					elementKey: 'reports',
					enabled: step.on,
					actor: OWNER,
				});
			else if (step.kind === 'usage') {
				usage += 1;
				await h.service.recordUsage({
					appId: APP,
					records: [
						{
							websiteId: W3,
							subscriptionId: c.subscriptionId,
							unit: 'redemption',
							quantity: step.quantity * 20,
							idempotencyKey: `u${usage}`,
							occurredAt: '2026-10-01T10:00:00Z',
						},
					],
				});
			} else if (mode !== 'single') {
				if (mode === 'crashy' && step.crashAfter !== null)
					await faultyService(h.ctx, { ledgerInsertsBeforeCrash: step.crashAfter }).runSettlement();
				if (mode === 'crashy' && step.overlap) await Promise.all([h.service.runSettlement(), h.service.runSettlement()]);
				else await h.service.runSettlement();
			}
		}
		clock.set(T0 + 10 * HOUR + 5 * MIN);
		await h.service.runSettlement();
		const rows = await ledgerMap(h);
		const map = Object.fromEntries(
			rows.map((r) => {
				const [sub, ...rest] = String(r.periodKey).split(':');
				return [`${names.get(sub)}:${rest.join(':')}`, r.amount];
			}),
		);
		const chains = [await h.service.verifyChain(M1), await h.service.verifyChain(M2)];
		const recon = await h.service.runReconciliation();
		return { map, chains, recon, count: rows.length };
	};

	it('repeated, overlapping and crashing runs settle every hour exactly once (same ledger as one catch-up run)', async () => {
		let run = 0;
		await fc.assert(
			fc.asyncProperty(fc.array(action, { minLength: 1, maxLength: 10 }), async (raw) => {
				run += 1;
				const actions = [...raw].sort((x, y) => x.at - y.at);
				const clean = await play(`cm_prop_${run}_a`, actions, 'clean');
				const crashy = await play(`cm_prop_${run}_b`, actions, 'crashy');
				const single = await play(`cm_prop_${run}_c`, actions, 'single');
				expect(crashy.map).toEqual(clean.map);
				expect(single.map).toEqual(clean.map);
				for (const result of [clean, crashy, single]) {
					expect(result.chains.every((ch) => ch.ok)).toBe(true);
					expect(result.recon).toMatchObject({ complete: true, discrepancies: 0 });
				}
				// B and C never pause: 10 complete hours each (zero amounts included); A skips fully paused hours only
				const base = Object.keys(clean.map).filter((k) => !k.endsWith(':metered'));
				expect(base.filter((k) => k.startsWith('B:'))).toHaveLength(10);
				expect(base.filter((k) => k.startsWith('C:'))).toHaveLength(10);
				expect(base.filter((k) => k.startsWith('A:')).length).toBeGreaterThanOrEqual(1);
			}),
			{ numRuns: 6 },
		);
	}, 600_000);
});
