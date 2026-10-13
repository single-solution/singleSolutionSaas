import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeMongoClients } from '../../../src/infra/db.js';
import { createCommerceService } from '../../../src/modules/commerce/service.js';
import { T0, createClock, startMongo } from '../../helpers.js';
import { M1, OWNER_ADMIN, PRODUCT, PRODUCT2, W1, W2, bootCommerce } from './fixtures.js';

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

const ADMIN = /** @type {const} */ ({ type: 'admin', id: 'adm_owner', role: 'owner', name: 'Olivia' });
/** @param {number} day of October 2026 @param {number} [hour] @param {number} [minute] */
const at = (day, hour = 0, minute = 0) => Date.UTC(2026, 9, day, hour, minute);

/** @typedef {Awaited<ReturnType<typeof bootCommerce>>} Harness */

/**
 * A commerce service that records the filters of its reads (`find` and `aggregate`) per collection.
 * @param {any} ctx module context
 * @param {Array<{ name: string, op: string, query: any }>} reads
 */
const recording = (ctx, reads) =>
	createCommerceService({
		...ctx,
		collection: (/** @type {string} */ name) => {
			const repo = ctx.collection(name);
			/** @param {any} ops */
			const wrap = (ops) => ({
				...ops,
				find: (/** @type {any} */ query, /** @type {any[]} */ ...rest) => {
					reads.push({ name, op: 'find', query });
					return ops.find(query, ...rest);
				},
				aggregate: (/** @type {any} */ query, /** @type {any[]} */ ...rest) => {
					reads.push({ name, op: 'aggregate', query });
					return ops.aggregate(query, ...rest);
				},
			});
			return typeof repo.forMerchant === 'function'
				? { ...repo, forMerchant: (/** @type {string} */ m) => wrap(repo.forMerchant(m)) }
				: wrap(repo);
		},
	});

/** @param {Harness} h @param {string} websiteId @param {string} productId @param {number} version @param {string[]} on */
const report = (h, websiteId, productId, version, on) =>
	h.service.acceptFeatures({ productId, websiteId, body: { version, on, adminId: OWNER_ADMIN, adminName: 'Olivia' } });

/** @param {Harness} h */
const billingDoc = (h) => h.db.collection('commerce_billing').findOne({ _id: /** @type {any} */ (M1) });

/** @param {Awaited<ReturnType<Harness['service']['billingSummary']>>} s */
const numbers = (s) => ({
	status: s.status,
	balance: s.balance,
	dailySpend: s.dailySpend,
	graceEnd: s.graceEnd,
	stoppedAt: s.stoppedAt,
	products: s.products,
});

/**
 * Six days of a merchant on two websites: price changes, switches, suspend and resume, remove and re-add, a receipt,
 * and a check at every step.
 * @param {Harness} h
 */
const sixDays = async (h) => {
	const { clock, service } = h;
	/** @param {number} t @param {() => Promise<unknown>} [step] */
	const when = async (t, step) => {
		clock.set(t);
		if (step) await step();
		await service.check(M1);
	};
	await when(at(1, 10), async () => {
		await h.credit(M1, 200_000);
		await h.prices(PRODUCT, 1, { codes: 1000, box: 500 });
		await h.prices(PRODUCT2, 1, { bar: 250 });
		await service.addProduct({ merchantId: M1, websiteId: W1, productId: PRODUCT, actor: ADMIN });
		await report(h, W1, PRODUCT, 1, ['codes']);
	});
	await when(at(1, 13, 20), async () => {
		await service.addProduct({ merchantId: M1, websiteId: W2, productId: PRODUCT2, actor: ADMIN });
		await report(h, W2, PRODUCT2, 1, ['bar']);
	});
	await when(at(2, 1));
	await when(at(2, 5, 30), () => service.onMerchantStatus({ merchantId: M1, status: 'suspended' }));
	await when(at(2, 8), () => service.onMerchantStatus({ merchantId: M1, status: 'active' }));
	await when(at(3, 0, 10));
	await when(at(3, 2), () => h.prices(PRODUCT, 2, { codes: 2000, box: 500 }));
	await when(at(3, 12, 15), () => service.removeProduct({ merchantId: M1, websiteId: W1, productId: PRODUCT, actor: ADMIN }));
	await when(at(4, 9), async () => {
		await service.addProduct({ merchantId: M1, websiteId: W1, productId: PRODUCT, actor: ADMIN });
		await report(h, W1, PRODUCT, 2, ['box', 'codes']);
	});
	await when(at(4, 17), () => h.credit(M1, 50_000));
	await when(at(5, 0, 30));
};

describe('the check reads from the last settled point only (K-19)', () => {
	it('reads the history from a day before the settled point, the price lists then in force, and no whole-ledger sum', async () => {
		const h = await bootCommerce({ mongo, dbName: 'cm_k19_reads', clock: createClock(T0) });
		await sixDays(h);
		const settled = /** @type {Date} */ ((await billingDoc(h))?.settledThrough);
		expect(settled).toEqual(new Date(at(5)));
		/** @type {Array<{ name: string, op: string, query: any }>} */
		const reads = [];
		h.clock.set(at(40, 9));
		await recording(h.ctx, reads).check(M1);
		const of = (/** @type {string} */ name) => reads.filter((r) => r.name === name);
		expect(of('commerce_history').map((r) => r.query.at)).toEqual([{ $gte: new Date(at(4)), $lte: new Date(at(40, 9)) }]);
		const lists = of('commerce_price_lists');
		expect(lists.find((r) => r.op === 'find')?.query.at).toEqual({ $gte: new Date(at(4)), $lte: new Date(at(40, 9)) });
		expect(lists.find((r) => r.op === 'aggregate')?.query[0].$match.at).toEqual({ $lt: new Date(at(4)) });
		// the ledger: only the entries of the days and receipts from the settled point on (and any beyond the account);
		// then the append of the days it settles (entries beyond the account, and its own keys)
		const ledger = of('commerce_ledger');
		expect(ledger.filter((r) => r.op === 'aggregate')).toEqual([]);
		expect(ledger[0]?.query.$or).toEqual([
			{ seq: { $gt: expect.any(Number) } },
			{ type: 'receipt', at: { $gte: settled } },
			{ type: 'day_charge', day: { $gte: '2026-10-05' } },
		]);
		expect(ledger.slice(1).map((r) => Object.keys(r.query).sort())).toEqual([
			['merchantId', 'seq'],
			['entryKey', 'merchantId'],
		]);
	});

	it('gives the numbers of a replay from the first day, and applies an entry written after its day was settled', async () => {
		const h = await bootCommerce({ mongo, dbName: 'cm_k19_same', clock: createClock(T0) });
		await sixDays(h);
		h.clock.set(at(6, 10));
		const bounded = numbers(await h.service.billingSummary(M1));
		expect(bounded.dailySpend).toBe(24 * (2000 + 500 + 250));
		// the same instant from the first day on (no stored state: the whole history and the whole ledger)
		await h.db.collection('commerce_billing').deleteOne({ _id: /** @type {any} */ (M1) });
		expect(numbers(await h.service.billingSummary(M1))).toEqual(bounded);
		expect(await h.service.verifyChain(M1)).toMatchObject({ ok: true });

		// a feature report stamped 23:50 on 10-06 that is written only after a check settled 10-06
		h.clock.set(at(7, 0, 5));
		await h.service.check(M1);
		await h.db.collection('commerce_history').insertOne({
			merchantId: M1,
			kind: 'switches',
			at: new Date(at(6, 23, 50)),
			websiteId: W2,
			productId: PRODUCT2,
			on: [],
		});
		h.clock.set(at(7, 9));
		const late = numbers(await h.service.billingSummary(M1));
		expect(late.dailySpend).toBe(24 * (2000 + 500));
		// what the pre-K-19 check (whole history from the settled point) found
		await h.db.collection('commerce_billing').updateOne({ _id: /** @type {any} */ (M1) }, { $unset: { held: '' } });
		expect(numbers(await h.service.billingSummary(M1))).toEqual(late);
	});

	it('a check never waits long for a ledger held by another write: it answers live and writes nothing', async () => {
		const h = await bootCommerce({ mongo, dbName: 'cm_k19_busy', clock: createClock(T0) });
		await h.credit(M1, 20_000);
		await h.prices(PRODUCT, 1, { codes: 1000 });
		await h.service.addProduct({ merchantId: M1, websiteId: W1, productId: PRODUCT, actor: ADMIN });
		await report(h, W1, PRODUCT, 1, ['codes']);
		h.clock.set(at(2, 0, 5));
		const lock = /** @type {NonNullable<Awaited<ReturnType<typeof h.ctx.locks.acquire>>>} */ (
			await h.ctx.locks.acquire(`commerce.ledger:${M1}`, { ttlMs: 60_000, owner: 'test' })
		);
		const started = Date.now();
		const status = await h.service.statusFor({ productId: PRODUCT, websiteId: W1 });
		expect(Date.now() - started).toBeLessThan(5000);
		expect(status).toMatchObject({ status: 'active', todayMillicredits: 1000 });
		const live = await h.service.check(M1);
		expect([live.run.balance, live.state]).toEqual([5000, 'low_balance']);
		expect(await h.db.collection('commerce_ledger').countDocuments({ type: 'day_charge' })).toBe(0);
		expect((await billingDoc(h))?.settledThrough).toEqual(new Date(at(1)));
		// once the ledger is free, the next check writes the day
		await lock.release();
		await h.service.check(M1);
		expect(await h.db.collection('commerce_ledger').countDocuments({ type: 'day_charge' })).toBe(1);
		expect(await billingDoc(h)).toMatchObject({ settledThrough: new Date(at(2)), balance: 5000, state: 'low_balance' });
	});
});
