import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeMongoClients } from '../../../src/testing.js';
import { createCommerceService } from '../../../src/modules/commerce/service.js';
import { T0, createClock, startMongo } from '../../helpers.js';
import { HOUR, M1, M2, OWNER_ADMIN, PRODUCT, STAFF, W1, bootCommerce } from './fixtures.js';

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
const ADMIN = /** @type {const} */ ({ type: 'admin', id: 'adm_owner', role: 'owner', name: 'Olivia' });

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
 * A commerce service whose billing-state collection misbehaves: `between` runs once right after the first read of a
 * merchant's billing state (an overlapping check), and `crash` makes every write of it fail.
 * @param {any} ctx module context
 * @param {{ between?: () => Promise<unknown>, crash?: boolean }} faults
 */
const billingFaults = (ctx, { between, crash = false }) => {
	let pending = between;
	return createCommerceService({
		...ctx,
		collection: (/** @type {string} */ name) => {
			const repo = ctx.collection(name);
			if (name !== 'commerce_billing') return repo;
			return {
				...repo,
				forMerchant: (/** @type {string} */ m) => {
					const ops = repo.forMerchant(m);
					const fail = async () => {
						throw new Error('simulated crash before the billing state');
					};
					return {
						...ops,
						findOne: async (/** @type {any[]} */ ...args) => {
							const doc = await ops.findOne(...args);
							const run = pending;
							pending = undefined;
							if (run) await run();
							return doc;
						},
						...(crash ? { insertOne: fail, updateOne: fail } : {}),
					};
				},
			};
		},
	});
};

/**
 * A commerce service whose money-history inserts fail while `failures.left` > 0 (one each).
 * @param {any} ctx module context
 */
const historyFaults = (ctx) => {
	const failures = { left: 0 };
	const service = createCommerceService({
		...ctx,
		collection: (/** @type {string} */ name) => {
			const repo = ctx.collection(name);
			if (name !== 'commerce_history') return repo;
			return {
				...repo,
				forMerchant: (/** @type {string} */ m) => {
					const ops = repo.forMerchant(m);
					return {
						...ops,
						insertOne: async (/** @type {any[]} */ ...args) => {
							if (failures.left > 0) {
								failures.left -= 1;
								throw new Error('simulated history failure');
							}
							return ops.insertOne(...args);
						},
					};
				},
			};
		},
	});
	return { service, failures };
};

/** @param {any} faulty @param {string} merchantId @param {number} amount */
const receiptVia = (faulty, merchantId, amount) =>
	faulty.addReceipt({ merchantId, amount, amountPaid: 'EUR 1', method: 'cash', reference: null, actor: STAFF });

/** @param {any} h @param {string} merchantId */
const accountOf = (h, merchantId) => h.db.collection('commerce_accounts').findOne({ _id: merchantId });

/**
 * Price list and one switched-on feature (1 credit per hour) on W1 from now.
 * @param {any} h
 */
const chargeHourly = async (h) => {
	await h.prices(PRODUCT, 1, { codes: 1000 });
	await h.service.addProduct({ merchantId: M1, websiteId: W1, productId: PRODUCT, actor: ADMIN });
	h.world.notices.splice(0);
	await h.service.recordSwitches({ merchantId: M1, websiteId: W1, productId: PRODUCT, on: ['codes'] });
};

describe('ledger integrity', () => {
	it('concurrent receipts keep one linear chain and an exact balance', async () => {
		const h = await bootCommerce({ mongo, dbName: 'cm_concurrent' });
		const amounts = Array.from({ length: 25 }, (_, i) => (i + 1) * 1000);
		await Promise.all(amounts.map((a) => h.credit(M1, a)));
		const verify = await h.service.verifyChain(M1);
		expect(verify).toMatchObject({ ok: true, entries: 25, seq: 25, balance: amounts.reduce((s, a) => s + a, 0) });
		expect(await accountOf(h, M1)).toMatchObject({ seq: 25, balance: verify.balance });
		await expect(h.credit('mer_zzzzzzzzzzzzzzzzzzzzzzzzzz', 1000)).rejects.toMatchObject({ code: 'not_found' });
		// concurrent adds of the same product to a website → exactly one product on the website
		const adds = await Promise.allSettled(
			[1, 2, 3].map(() => h.service.addProduct({ merchantId: M1, websiteId: W1, productId: PRODUCT, actor: ADMIN })),
		);
		expect(adds.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
		expect(adds.filter((s) => s.status === 'rejected').map((s) => /** @type {any} */ (s).reason.code)).toEqual([
			'conflict',
			'conflict',
		]);
	});

	it('concurrent checks write each day charge once and send one email per state', async () => {
		const clock = createClock(T0);
		const h = await bootCommerce({ mongo, dbName: 'cm_checks', clock });
		await h.credit(M1, 30_000);
		await chargeHourly(h);
		clock.set(T0 + 3 * 24 * HOUR + 5 * MIN);
		await Promise.all([h.service.check(M1), h.service.check(M1), h.service.check(M1)]);
		const days = await h.db
			.collection('commerce_ledger')
			.find({ merchantId: M1, type: 'day_charge' })
			.sort({ seq: 1 })
			.toArray();
		expect(days.map((d) => [d.day, d.amount])).toEqual([
			['2026-10-01', -14_000],
			['2026-10-02', -24_000],
			['2026-10-03', -24_000],
		]);
		expect(await h.service.verifyChain(M1)).toMatchObject({ ok: true });
		expect(await h.db.collection('commerce_history').countDocuments({ merchantId: M1, kind: 'grace_started' })).toBe(1);
		// the check that found grace told the product once (concurrent checks record it once)
		expect(h.world.notices).toEqual([{ productId: PRODUCT, body: { type: 'status.changed', websiteId: W1 } }]);
		expect(h.mails.filter((m) => m.template === 'grace_started').map((m) => m.to)).toEqual([
			`owner@${M1}.example`,
			'finance@portal.example',
		]);
		expect(await h.db.collection('commerce_billing').findOne({ _id: /** @type {any} */ (M1) })).toMatchObject({
			state: 'grace',
			settledThrough: new Date(Date.parse('2026-10-04T00:00:00Z')),
		});
	});

	it('commits ledger entries and the account move atomically; still rolls forward entries left outside a transaction', async () => {
		const h = await bootCommerce({ mongo, dbName: 'cm_rollforward' });
		await h.credit(M1, 1000);
		// a crash between the ledger insert and the account update aborts the whole transaction
		await expect(receiptVia(faultyService(h.ctx, { accountUpdatesToFail: 1 }), M1, 500)).rejects.toThrow(/simulated crash/);
		expect(await h.db.collection('commerce_ledger').countDocuments({ merchantId: M1 })).toBe(1);
		expect(await accountOf(h, M1)).toMatchObject({ seq: 1, balance: 1000 });
		// entries written without a transaction (a writer outside this path) are still rolled into the account cache
		const untransacted = faultyService(
			{ ...h.ctx, withTransaction: (/** @type {any} */ fn) => fn(undefined) },
			{ accountUpdatesToFail: 1 },
		);
		await expect(receiptVia(untransacted, M1, 500)).rejects.toThrow(/simulated crash/);
		expect(await accountOf(h, M1)).toMatchObject({ seq: 1, balance: 1000 });
		await h.credit(M1, 250);
		expect(await accountOf(h, M1)).toMatchObject({ seq: 3, balance: 1750 });
		expect(await h.service.verifyChain(M1)).toMatchObject({ ok: true, balance: 1750 });
		// a crash on the ledger insert leaves nothing behind
		await expect(receiptVia(faultyService(h.ctx, { ledgerInsertsBeforeCrash: 0 }), M1, 500)).rejects.toThrow(/simulated crash/);
		expect(await h.service.verifyChain(M1)).toMatchObject({ ok: true, entries: 3 });
	});

	it('detects tampering, deletion and cache drift', async () => {
		const clock = createClock(T0);
		const h = await bootCommerce({ mongo, dbName: 'cm_tamper', clock });
		await h.credit(M1, 100_000);
		await h.credit(M2, 100_000);
		await chargeHourly(h);
		clock.set(T0 + 3 * 24 * HOUR);
		await h.service.check(M1);
		expect(await h.service.verifyChain(M1)).toMatchObject({ ok: true, entries: 4 });
		const ledger = h.db.collection('commerce_ledger');
		await ledger.updateOne({ merchantId: M1, day: '2026-10-01' }, { $set: { amount: -1 } });
		await ledger.deleteOne({ merchantId: M1, day: '2026-10-02' });
		const verify = await h.service.verifyChain(M1);
		expect(verify.ok).toBe(false);
		expect(new Set(verify.problems.map((p) => p.kind))).toEqual(new Set(['hash', 'gap', 'link', 'account']));
		await h.db.collection('commerce_accounts').updateOne({ _id: /** @type {any} */ (M2) }, { $inc: { balance: 1 } });
		expect((await h.service.verifyChain(M2)).problems.map((p) => p.kind)).toEqual(['account']);
	});

	it('refuses to append onto a broken pending entry and logs it', async () => {
		const h = await bootCommerce({ mongo, dbName: 'cm_broken' });
		await h.credit(M1, 1000);
		const [entry] = await h.db.collection('commerce_ledger').find({ merchantId: M1 }).toArray();
		await h.db
			.collection('commerce_ledger')
			.insertOne({ ...entry, _id: /** @type {any} */ ('led_forged'), seq: 2, entryKey: 'forged', amount: 1e9 });
		await expect(h.credit(M1, 5000)).rejects.toMatchObject({ code: 'internal_error' });
		expect(h.logs.some((l) => l.msg === 'ledger chain broken')).toBe(true);
		expect((await h.service.verifyChain(M1)).ok).toBe(false);
	});
});

describe('the billing check never counts a day twice (BP-1)', () => {
	const DAY2 = Date.parse('2026-10-02T00:05:00Z');

	/** @typedef {Awaited<ReturnType<typeof bootCommerce>>} Harness */
	/** @param {Harness} h */
	const dayCharges = (h) =>
		h.db.collection('commerce_ledger').find({ merchantId: M1, type: 'day_charge' }).sort({ seq: 1 }).toArray();
	/** @param {Harness} h */
	const billingDoc = (h) => h.db.collection('commerce_billing').findOne({ _id: /** @type {any} */ (M1) });
	/** @param {Harness} h */
	const graceRows = (h) => h.db.collection('commerce_history').countDocuments({ merchantId: M1, kind: 'grace_started' });

	/**
	 * 20 credits; Codes at 1 credit/h on W1 from 10-01 10:00; the clock at 10-02 00:05: 10-01 is 14 credits and the
	 * current hour 1, so the real balance is 5 credits (low balance).
	 * @param {string} dbName
	 */
	const twentyCredits = async (dbName) => {
		const clock = createClock(T0);
		const h = await bootCommerce({ mongo, dbName, clock });
		await h.credit(M1, 20_000);
		await chargeHourly(h);
		clock.set(DAY2);
		return h;
	};

	/** @param {Harness} h @param {{ run: { balance: number }, state: string }} checked */
	const expectRealBalance = async (h, checked) => {
		expect([checked.run.balance, checked.state]).toEqual([5000, 'low_balance']);
		expect((await dayCharges(h)).map((d) => [d.day, d.amount])).toEqual([['2026-10-01', -14_000]]);
		expect(await billingDoc(h)).toMatchObject({
			settledThrough: new Date(Date.parse('2026-10-02T00:00:00Z')),
			state: 'low_balance',
			balance: 5000,
			phase: { graceStart: null, graceEnd: null, stoppedAt: null },
		});
		expect(await graceRows(h)).toBe(0);
		expect(h.mails.filter((m) => m.template === 'grace_started')).toEqual([]);
		expect(await h.service.verifyChain(M1)).toMatchObject({ ok: true, balance: 6000 });
	};

	it('an overlapping check that reads the ledger after another check settled the day', async () => {
		const h = await twentyCredits('cm_bp1_overlap');
		// B reads the billing state; A then runs whole (writes 10-01 and settles) before B reads the ledger
		const b = billingFaults(h.ctx, { between: () => h.service.check(M1) });
		const checked = await b.check(M1);
		// before the fix: -9 credits and a grace period from 10-01 15:00 to 10-04 15:00, with its email
		await expectRealBalance(h, checked);
		expect(h.mails.filter((m) => m.template === 'low_balance')).toHaveLength(2);
	});

	it('a check that crashes after writing the day charges, outside a transaction: the next check repairs it', async () => {
		const h = await twentyCredits('cm_bp1_crash');
		const crashed = billingFaults({ ...h.ctx, withTransaction: (/** @type {any} */ fn) => fn(undefined) }, { crash: true });
		await expect(crashed.check(M1)).rejects.toThrow(/simulated crash/);
		// the day is written, the settled point is not
		expect((await dayCharges(h)).map((d) => d.day)).toEqual(['2026-10-01']);
		expect((await billingDoc(h))?.settledThrough).toEqual(new Date(Date.parse('2026-10-01T00:00:00Z')));
		await expectRealBalance(h, await h.service.check(M1));
	});

	it('a check that crashes before the billing state writes nothing: its day charges roll back with it', async () => {
		const h = await twentyCredits('cm_bp1_atomic');
		await expect(billingFaults(h.ctx, { crash: true }).check(M1)).rejects.toThrow(/simulated crash/);
		expect(await dayCharges(h)).toEqual([]);
		expect(await accountOf(h, M1)).toMatchObject({ seq: 1, balance: 20_000 });
		await expectRealBalance(h, await h.service.check(M1));
	});

	it('a stored grace with credits left (written by a miscounting check) is dropped, never ending in a stop', async () => {
		const h = await twentyCredits('cm_bp1_phase');
		await h.service.check(M1);
		await h.service.recordSwitches({ merchantId: M1, websiteId: W1, productId: PRODUCT, on: [] });
		// what the miscounting check stored: grace from 10-01 15:00 to 10-04 15:00
		await h.db.collection('commerce_billing').updateOne(
			{ _id: /** @type {any} */ (M1) },
			{
				$set: {
					state: 'grace',
					phase: {
						graceStart: new Date(Date.parse('2026-10-01T15:00:00Z')),
						graceEnd: new Date(Date.parse('2026-10-04T15:00:00Z')),
						stoppedAt: null,
					},
				},
			},
		);
		h.world.notices.splice(0);
		h.clock.set(Date.parse('2026-10-04T16:00:00Z'));
		const summary = await h.service.billingSummary(M1);
		expect(summary).toMatchObject({ status: 'active', balance: 5000, graceEnd: null, stoppedAt: null });
		expect(await billingDoc(h)).toMatchObject({ state: 'active', phase: { graceEnd: null, stoppedAt: null } });
		expect(await h.db.collection('commerce_history').countDocuments({ merchantId: M1, kind: 'stopped' })).toBe(0);
		// the products are told their status changed
		expect(h.world.notices).toEqual([{ productId: PRODUCT, body: { type: 'status.changed', websiteId: W1 } }]);
	});
});

describe("a product's state and its money history never disagree (BP-3)", () => {
	const PAIR = { merchantId: M1, websiteId: W1, productId: PRODUCT, actor: ADMIN };
	/** @typedef {Awaited<ReturnType<typeof bootCommerce>>} Harness */
	/** @param {Harness} h */
	const productDoc = (h) => h.db.collection('commerce_products').findOne({ _id: /** @type {any} */ (`${W1}:${PRODUCT}`) });
	/** @param {Harness} h @param {string} kind */
	const rows = (h, kind) => h.db.collection('commerce_history').countDocuments({ merchantId: M1, kind });
	/** @param {Harness} h @param {number} version @param {string[]} on */
	const report = (h, version, on, service = h.service) =>
		service.acceptFeatures({
			productId: PRODUCT,
			websiteId: W1,
			body: { version, on, adminId: OWNER_ADMIN, adminName: 'Olivia' },
		});

	/** @param {string} dbName */
	const boot = async (dbName) => {
		const clock = createClock(T0);
		const h = await bootCommerce({ mongo, dbName, clock });
		await h.credit(M1, 100_000);
		await h.prices(PRODUCT, 1, { codes: 1000 });
		return { h, clock, ...historyFaults(h.ctx) };
	};

	it('add and remove write both or neither, so the same action retried just works', async () => {
		const { h, service, failures } = await boot('cm_bp3_add_remove');
		// add: the history fails, or the tokens do → nothing is added; the same add then works (not 409)
		failures.left = 1;
		await expect(service.addProduct(PAIR)).rejects.toThrow(/simulated history failure/);
		expect(await productDoc(h)).toBeNull();
		h.world.failTokens = true;
		await expect(service.addProduct(PAIR)).rejects.toThrow(/tokens are down/);
		h.world.failTokens = false;
		expect(await productDoc(h)).toBeNull();
		expect(await service.addProduct(PAIR)).toMatchObject({ productId: PRODUCT, status: 'active' });
		// the tokens come first (the failed attempt ensured them too; ensuring is idempotent)
		expect(h.world.tokens.at(-1)).toEqual({ merchantId: M1, websiteId: W1, productId: PRODUCT });
		// remove: the history fails → the product stays on the website in both; the same remove then works (not 404)
		failures.left = 1;
		await expect(service.removeProduct(PAIR)).rejects.toThrow(/simulated history failure/);
		expect((await productDoc(h))?.status).toBe('added');
		expect((await h.service.billingSummary(M1)).products).toHaveLength(1);
		expect(await service.removeProduct(PAIR)).toEqual({ websiteId: W1, productId: PRODUCT, status: 'removed' });
		expect((await h.service.billingSummary(M1)).products).toEqual([]);
		await expect(service.removeProduct(PAIR)).rejects.toMatchObject({ code: 'not_found' });
		expect([await rows(h, 'added'), await rows(h, 'removed')]).toEqual([1, 1]);
	});

	it('repeating an add or a remove repairs a history entry lost before both were one write', async () => {
		const { h, clock } = await boot('cm_bp3_repair');
		const products = h.db.collection('commerce_products');
		const _id = /** @type {any} */ (`${W1}:${PRODUCT}`);
		await h.service.addProduct(PAIR);
		await report(h, 1, ['codes']);
		// what a Remove whose history insert failed left: removed, while the history still charges it
		clock.set(T0 + HOUR + 5 * MIN);
		await products.updateOne({ _id }, { $set: { status: 'removed', removedAt: new Date(clock.now()) } });
		expect((await h.service.billingSummary(M1)).products).toHaveLength(1);
		expect(await h.service.removeProduct(PAIR)).toMatchObject({ status: 'removed' });
		const removed = await h.service.billingSummary(M1);
		expect(removed).toMatchObject({ products: [], dailySpend: 0 });
		await expect(h.service.removeProduct(PAIR)).rejects.toMatchObject({ code: 'not_found' });
		// what an Add whose history insert failed left: added (switches reported since), but not in the history
		clock.set(T0 + 2 * HOUR + 5 * MIN);
		await products.updateOne({ _id }, { $set: { status: 'added', on: ['codes'] } });
		expect((await h.service.billingSummary(M1)).products).toEqual([]);
		expect(await h.service.addProduct(PAIR)).toMatchObject({ status: 'active', featuresOn: ['codes'], hourlyCost: 1000 });
		await expect(h.service.addProduct(PAIR)).rejects.toMatchObject({ code: 'conflict' });
		// 10:00 and 11:00 charged before the repaired remove, 12:00 after the repaired add
		expect((await h.service.billingSummary(M1)).balance).toBe(100_000 - 3000);
	});

	it('a feature report writes the switches and their history together', async () => {
		const { h, service, failures } = await boot('cm_bp3_features');
		await h.service.addProduct(PAIR);
		failures.left = 1;
		await expect(report(h, 1, ['codes'], service)).rejects.toThrow(/simulated history failure/);
		expect(await productDoc(h)).toMatchObject({ featuresVersion: 0, on: [] });
		expect(await report(h, 1, ['codes'], service)).toEqual({ version: 1 });
		expect((await h.service.billingSummary(M1)).products).toMatchObject([{ featuresOn: ['codes'], hourlyCost: 1000 }]);
	});

	it('suspension follows the money history alone; a repeated suspend or resume repairs a lost entry', async () => {
		const { h, clock, service, failures } = await boot('cm_bp3_suspension');
		await h.service.addProduct(PAIR);
		await report(h, 1, ['codes']);
		clock.set(T0 + 10 * MIN);
		h.world.notices.splice(0);
		/** @param {'active' | 'suspended'} status */
		const identity = (status) => h.world.merchants.set(M1, { merchantId: M1, name: 'One', status });
		// the hook failed after identity suspended the merchant: the products keep working and are charged (one truth)
		identity('suspended');
		failures.left = 1;
		await expect(service.onMerchantStatus({ merchantId: M1, status: 'suspended' })).rejects.toThrow(/simulated/);
		expect(await h.service.billingSummary(M1)).toMatchObject({ status: 'active', balance: 99_000 });
		// identity calls it again on a repeated suspend: written once, the products told each time
		await h.service.onMerchantStatus({ merchantId: M1, status: 'suspended' });
		await h.service.onMerchantStatus({ merchantId: M1, status: 'suspended' });
		expect(await rows(h, 'suspended')).toBe(1);
		expect(h.world.notices).toHaveLength(2);
		// a resume whose entry is lost: still suspended and never charged until the repeat
		clock.set(T0 + 3 * HOUR);
		identity('active');
		failures.left = 1;
		await expect(service.onMerchantStatus({ merchantId: M1, status: 'active' })).rejects.toThrow(/simulated/);
		expect(await h.service.billingSummary(M1)).toMatchObject({ status: 'suspended', balance: 99_000 });
		await h.service.onMerchantStatus({ merchantId: M1, status: 'active' });
		expect(await h.service.billingSummary(M1)).toMatchObject({ status: 'active', balance: 98_000 });
		expect(await rows(h, 'resumed')).toBe(1);
	});
});
