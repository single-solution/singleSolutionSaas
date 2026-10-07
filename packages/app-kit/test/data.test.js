import { createOutboundPolicy } from '@ss/net';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createData, guardFilter, guardPipeline, guardUpdate, planIndexes } from '../src/data.js';
import { createTestLogger, freshDb, mongoUri } from './helpers.js';

const WEBSITE = 'web_0123456789abcdefghjkmnpq';
const WEBSITE_2 = 'web_1123456789abcdefghjkmnpq';

/** @type {MongoClient} */
let client;
beforeAll(async () => {
	client = await new MongoClient(/** @type {string} */ (process.env.TEST_MONGODB_URI)).connect();
});
afterAll(async () => {
	await client.close();
});

/**
 * The data layer with both websites on one merchant database.
 * @param {Record<string, any>} [options]
 */
const makeData = (options = {}) => {
	const dbName = freshDb('guard');
	let t = Date.parse('2026-10-01T10:00:00Z');
	const data = createData({
		productId: 'coupon-box',
		uriOf: async (websiteId) => (websiteId === 'web_none' ? null : mongoUri(dbName)),
		now: () => t,
		logger: createTestLogger().logger,
		policy: createOutboundPolicy({ allowHosts: ['127.0.0.1'] }),
		idleMs: 0,
		...options,
	});
	return { data, db: client.db(dbName), advance: (/** @type {number} */ ms) => (t += ms) };
};

describe('tenant guard (pure)', () => {
	it('requires websiteId equality in filters and forbids $where', () => {
		expect(guardFilter({ websiteId: WEBSITE, a: 1 }, WEBSITE, 'find')).toEqual({ websiteId: WEBSITE, a: 1 });
		expect(guardFilter({ websiteId: { $eq: WEBSITE } }, WEBSITE, 'find')).toBeTruthy();
		for (const filter of [
			{},
			{ websiteId: WEBSITE_2 },
			{ websiteId: { $in: [WEBSITE] } },
			{ websiteId: { $ne: 'x' } },
			null,
			{ websiteId: WEBSITE, $where: 'true' },
		]) {
			expect(() => guardFilter(filter, WEBSITE, 'find')).toThrow(/tenant|websiteId|\$where|filter/);
		}
	});

	it('requires a pinned first $match and refuses cross-collection stages', () => {
		expect(guardPipeline([{ $match: { websiteId: WEBSITE } }, { $group: { _id: null } }], WEBSITE)).toHaveLength(2);
		expect(() => guardPipeline([], WEBSITE)).toThrow();
		expect(() => guardPipeline([{ $group: { _id: null } }], WEBSITE)).toThrow(/first stage/);
		expect(() => guardPipeline([{ $match: {} }], WEBSITE)).toThrow();
		expect(() => guardPipeline([{ $match: { websiteId: WEBSITE } }, { $lookup: { from: 'x' } }], WEBSITE)).toThrow(/\$lookup/);
		expect(() =>
			guardPipeline([{ $match: { websiteId: WEBSITE } }, { $facet: { a: [{ $unionWith: 'x' }] } }], WEBSITE),
		).toThrow(/\$unionWith/);
		expect(() => guardPipeline([{ $match: { websiteId: WEBSITE } }, 'x'], WEBSITE)).toThrow();
		expect(() => guardPipeline(/** @type {any} */ ('x'), WEBSITE)).toThrow();
	});

	it('forbids changing websiteId and stamps updatedAt', () => {
		const at = new Date(0);
		expect(guardUpdate({ $set: { a: 1 } }, WEBSITE, at, 'u')).toEqual({ $set: { a: 1, updatedAt: at } });
		expect(guardUpdate({ $set: { websiteId: WEBSITE } }, WEBSITE, at, 'u')).toMatchObject({ $set: { websiteId: WEBSITE } });
		expect(guardUpdate({ $inc: { n: 1 }, $currentDate: { updatedAt: true } }, WEBSITE, at, 'u')).toEqual({
			$inc: { n: 1 },
			$currentDate: { updatedAt: true },
		});
		for (const update of [
			{ $set: { websiteId: WEBSITE_2 } },
			{ $unset: { websiteId: '' } },
			{ $rename: { a: 'websiteId' } },
			{ $set: { 'websiteId.x': 1 } },
			{ a: 1 },
			{},
			[{ $replaceWith: {} }],
			[{ $unset: 'websiteId' }],
			[{ $set: { websiteId: 'x' } }],
			['x'],
		]) {
			expect(() => guardUpdate(update, WEBSITE, at, 'u')).toThrow();
		}
		expect(guardUpdate([{ $set: { a: 1 } }], WEBSITE, at, 'u')).toEqual([{ $set: { a: 1 } }, { $set: { updatedAt: at } }]);
	});

	it('validates index plans', () => {
		expect(planIndexes([{ collection: 'coupons', keys: { websiteId: 1, code: 1 }, unique: true }]).get('coupons')).toEqual([
			{ key: { websiteId: 1, code: 1 }, name: 'websiteId_1_code_1', unique: true },
		]);
		expect(
			planIndexes([{ collection: 'events', keys: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'ttl' }]).get('events')?.[0],
		).toMatchObject({ expireAfterSeconds: 0 });
		expect(() => planIndexes([{ collection: 'c', keys: { code: 1 } }])).toThrow(/websiteId/);
		expect(planIndexes({ notes: [{ key: { websiteId: 1, id: 1 }, name: 'website_id', unique: true }] }).get('notes')).toEqual([
			{ key: { websiteId: 1, id: 1 }, name: 'website_id', unique: true },
		]);
		expect(() => planIndexes(/** @type {any} */ ({ notes: 'x' }))).toThrow();
		expect(() => planIndexes(/** @type {any} */ ([1]))).toThrow();
		expect(() => planIndexes([{ collection: 'c', keys: { websiteId: 1, at: 1 }, expireAfterSeconds: 1 }])).toThrow(
			/single-field/,
		);
		expect(() => planIndexes([{ collection: 'Bad', keys: { websiteId: 1 } }])).toThrow();
		expect(() => planIndexes([{ collection: 'c', keys: {} }])).toThrow();
		expect(() => planIndexes(/** @type {any} */ ('x'))).toThrow();
	});
});

describe('merchant database (MongoDB)', () => {
	it('prefixes collections, stamps inserts and isolates websites', async () => {
		const { data, db } = makeData();
		const a = await data.forWebsite(WEBSITE, { merchantId: 'mer_1' });
		const b = await data.forWebsite(WEBSITE_2);
		expect(a.prefix).toBe('ss_coupon_box_');
		const coupons = a.collection('coupons');
		expect(coupons.name).toBe('ss_coupon_box_coupons');
		await coupons.insertOne({ code: 'A' });
		await coupons.insertMany([{ code: 'B' }, { code: 'C', websiteId: WEBSITE }]);
		await b.collection('coupons').insertOne({ code: 'Z' });
		const raw = await db.collection('ss_coupon_box_coupons').findOne({ code: 'A' });
		expect(raw).toMatchObject({ websiteId: WEBSITE, merchantId: 'mer_1' });
		expect(raw?.createdAt).toBeInstanceOf(Date);
		expect(raw?.env).toBeUndefined();
		expect(await coupons.countDocuments({ websiteId: WEBSITE })).toBe(3);
		expect(await coupons.distinct('code', { websiteId: WEBSITE })).toEqual(['A', 'B', 'C']);
		expect(await b.collection('coupons').countDocuments({ websiteId: WEBSITE_2 })).toBe(1);
		await expect(Promise.resolve().then(() => coupons.insertOne({ code: 'X', websiteId: WEBSITE_2 }))).rejects.toMatchObject({
			code: 'tenant_guard',
		});
		expect(() => coupons.insertOne(/** @type {any} */ ('x'))).toThrow();
		expect(() => coupons.insertMany(/** @type {any} */ ('x'))).toThrow();
		expect(() => coupons.find({})).toThrow(/websiteId/);
		expect(() => coupons.deleteMany({})).toThrow();
		expect(() => coupons.aggregate([{ $match: {} }])).toThrow();
		expect(() => a.collection('Bad-Name')).toThrow();
		await expect(data.forWebsite('web_none')).rejects.toMatchObject({ code: 'database_not_connected' });
	});

	it('guards updates, replaces, deletes and aggregations', async () => {
		const { data } = makeData();
		const c = (await data.forWebsite(WEBSITE)).collection('coupons');
		await c.insertMany([
			{ code: 'A', n: 1 },
			{ code: 'B', n: 2 },
		]);
		await c.updateOne({ websiteId: WEBSITE, code: 'A' }, { $inc: { n: 10 } });
		await c.updateMany({ websiteId: WEBSITE }, { $set: { active: true } });
		await c.replaceOne({ websiteId: WEBSITE, code: 'B' }, { code: 'B', n: 3 });
		const replaced = await c.findOne({ websiteId: WEBSITE, code: 'B' });
		expect(replaced).toMatchObject({ websiteId: WEBSITE, n: 3 });
		expect(replaced?.active).toBeUndefined();
		expect(
			await c.findOneAndUpdate({ websiteId: WEBSITE, code: 'A' }, { $set: { n: 0 } }, { returnDocument: 'after' }),
		).toMatchObject({ n: 0, active: true });
		const sums = await c
			.aggregate([{ $match: { websiteId: WEBSITE } }, { $group: { _id: null, total: { $sum: '$n' } } }])
			.toArray();
		expect(sums[0]?.total).toBe(3);
		expect(() => c.updateOne({ websiteId: WEBSITE }, { $set: { websiteId: WEBSITE_2 } })).toThrow();
		expect(() => c.replaceOne({ websiteId: WEBSITE }, { websiteId: WEBSITE_2 })).toThrow();
		expect(await c.findOneAndDelete({ websiteId: WEBSITE, code: 'A' })).toMatchObject({ code: 'A' });
		expect((await c.deleteOne({ websiteId: WEBSITE, code: 'B' })).deletedCount).toBe(1);
		await c.insertOne({ code: 'C' });
		expect((await c.deleteMany({ websiteId: WEBSITE })).deletedCount).toBe(1);
	});

	it('creates indexes idempotently with websiteId first, also from the product options', async () => {
		/** @type {import('../src/index.js').IndexDefinition[]} */
		const defs = [
			{ collection: 'coupons', keys: { websiteId: 1, code: 1 }, unique: true },
			{ collection: 'sessions', keys: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'ttl' },
		];
		const { data, db } = makeData({ indexes: defs });
		const a = await data.forWebsite(WEBSITE);
		expect((await a.ensureIndexes(defs)).created).toEqual([]);
		const names = (await db.collection('ss_coupon_box_coupons').indexes()).map((i) => i.name);
		expect(names).toContain('websiteId_1_code_1');
		await a.collection('coupons').insertOne({ code: 'A' });
		await expect(a.collection('coupons').insertOne({ code: 'A' })).rejects.toMatchObject({ code: 11000 });
		await (await data.forWebsite(WEBSITE_2)).collection('coupons').insertOne({ code: 'A' });
		const { data: fresh } = makeData();
		expect((await (await fresh.forWebsite(WEBSITE)).ensureIndexes(defs)).created).toHaveLength(2);
	});

	it('supports transactions', async () => {
		const { data } = makeData();
		const a = await data.forWebsite(WEBSITE);
		const c = a.collection('ledger');
		await c.insertOne({ n: 0 });
		expect(
			await a.transaction(async (session) => {
				await c.updateOne({ websiteId: WEBSITE }, { $inc: { n: 1 } }, { session });
				return 'done';
			}),
		).toBe('done');
		await expect(
			a.transaction(async (session) => {
				await c.updateOne({ websiteId: WEBSITE }, { $inc: { n: 1 } }, { session });
				throw new Error('rollback');
			}),
		).rejects.toThrow('rollback');
		expect(await c.findOne({ websiteId: WEBSITE })).toMatchObject({ n: 1 });
	});

	it('pools clients per URI and closes idle pools', async () => {
		/** @type {number[]} */
		const created = [];
		const { data, advance } = makeData({
			idleMs: 60_000,
			createClient: (/** @type {string} */ uri, /** @type {any} */ options) => {
				created.push(options.maxPoolSize);
				return new MongoClient(uri, options);
			},
		});
		await data.forWebsite(WEBSITE);
		await data.forWebsite(WEBSITE_2);
		expect(created).toEqual([3]);
		advance(61_000);
		await data.forWebsite(WEBSITE);
		await new Promise((resolve) => setImmediate(resolve));
		await data.forWebsite(WEBSITE);
		expect(created.length).toBeGreaterThanOrEqual(1);
		await data.closeAll();
	});

	it('reports unreachable databases without leaking the URI and tests connection strings', async () => {
		const { logger, entries } = createTestLogger();
		const policy = createOutboundPolicy({ allowHosts: ['127.0.0.1'] });
		const unreachable = createData({
			productId: 's',
			uriOf: async () => 'mongodb://user:secret@127.0.0.1:1/x',
			logger,
			policy,
			createClient: (uri, options) =>
				new MongoClient(uri, { ...options, serverSelectionTimeoutMS: 200, connectTimeoutMS: 200 }),
		});
		await expect(unreachable.forWebsite(WEBSITE)).rejects.toMatchObject({ code: 'database_unreachable' });
		expect(JSON.stringify(entries)).not.toContain('secret');
		expect(await unreachable.testUri(mongoUri(freshDb('test')))).toEqual({ ok: true });
		expect(await unreachable.testUri('mongodb://127.0.0.1:1/x')).toMatchObject({ ok: false });
		expect(await unreachable.testUri('mongodb://u:p@10.0.0.5:27017/x?tls=true')).toMatchObject({
			ok: false,
			message: expect.stringMatching(/private_address/),
		});
		await unreachable.closeAll();
	});
});
