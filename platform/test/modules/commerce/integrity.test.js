import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeMongoClients } from '../../../src/infra/db.js';
import { createCommerceService } from '../../../src/modules/commerce/service.js';
import { T0, createClock, startMongo } from '../../helpers.js';
import { HOUR, M1, M2, PRODUCT, STAFF, W1, bootCommerce } from './fixtures.js';

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

/** @param {any} faulty @param {string} merchantId @param {number} amount */
const receiptVia = (faulty, merchantId, amount) =>
	faulty.addReceipt({ merchantId, amount, amountPaid: 'PKR 1', method: 'cash', reference: null, actor: STAFF });

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

	it('concurrent checks write each day charge once and send one e-mail per state', async () => {
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
