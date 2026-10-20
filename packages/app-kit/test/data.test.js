import { DATABASE_DEADLINES, createOutboundPolicy } from '@ss/net';
import { Collection, MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	PRODUCT_DATABASE_OPTIONS,
	createData,
	guardFilter,
	guardPipeline,
	guardUpdate,
	isDatabaseUnavailable,
	planIndexes,
	sameIndex,
} from '../src/data.js';
import { kitError } from '../src/util.js';
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

	it('accepts Atlas Search first only when its compound filter pins the website (K11)', () => {
		const search = (/** @type {unknown} */ filter) => ({
			$search: {
				index: 'ss_ecommerce_products_search',
				compound: { filter, must: [{ autocomplete: { path: 'name', query: 'iph' } }] },
			},
		});
		const pinned = { equals: { path: 'websiteId', value: WEBSITE } };
		expect(guardPipeline([search([pinned]), { $limit: 10 }], WEBSITE)).toHaveLength(2);
		expect(guardPipeline([search(pinned)], WEBSITE)).toHaveLength(1);
		expect(guardPipeline([search([{ equals: { path: 'status', value: 'active' } }, pinned])], WEBSITE)).toHaveLength(1);
		for (const bad of [
			[search([{ equals: { path: 'websiteId', value: WEBSITE_2 } }])],
			[search([{ equals: { path: 'status', value: 'active' } }])],
			[search([{ text: { path: 'websiteId', query: WEBSITE } }])],
			[search(undefined)],
			[{ $search: { index: 'x', text: { path: 'name', query: 'a' } } }],
			[{ $search: 'x' }],
			[{ $search: { compound: { filter: [pinned] } }, $limit: 1 }],
			[search([pinned]), { $lookup: { from: 'x' } }],
		])
			expect(() => guardPipeline(bad, WEBSITE)).toThrow(/tenant|first stage|\$search|\$lookup/);
		expect(() => guardPipeline([{ $match: { websiteId: WEBSITE } }, search([pinned])], WEBSITE)).toThrow(
			/only as the first stage/,
		);
		expect(() => guardPipeline([{ $match: { websiteId: WEBSITE } }, { $searchMeta: {} }], WEBSITE)).toThrow();
		expect(() => guardPipeline([{ $vectorSearch: {} }], WEBSITE)).toThrow(/first stage/);
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

	it('creates the product indexes once per database and instance, two collections at a time (K-16)', async () => {
		/** @type {import('../src/index.js').IndexDefinition[]} */
		const defs = [
			{ collection: 'coupons', keys: { websiteId: 1, code: 1 } },
			{ collection: 'orders', keys: { websiteId: 1, at: -1 } },
			{ collection: 'carts', keys: { websiteId: 1, user: 1 } },
		];
		let running = 0;
		let most = 0;
		const original = Collection.prototype.createIndexes;
		const spy = vi.spyOn(Collection.prototype, 'createIndexes').mockImplementation(
			/** @this {Collection} @param {any} specs @param {any} options */
			async function (specs, options) {
				running += 1;
				most = Math.max(most, running);
				try {
					return await original.call(this, specs, options);
				} finally {
					running -= 1;
				}
			},
		);
		try {
			const { data, db } = makeData({ indexes: defs });
			await Promise.all([data.forWebsite(WEBSITE), data.forWebsite(WEBSITE_2), data.forWebsite(WEBSITE)]);
			await data.forWebsite(WEBSITE);
			expect(spy).toHaveBeenCalledTimes(3);
			// two at a time: never every pooled connection
			expect(most).toBe(2);
			expect((await db.collection('ss_coupon_box_orders').indexes()).map((i) => i.name)).toContain('websiteId_1_at_-1');
			// a failed creation is tried again by the next request
			spy.mockClear();
			spy.mockRejectedValueOnce(new Error('index build failed'));
			const { data: failing } = makeData({ indexes: defs.slice(0, 1) });
			await expect(failing.forWebsite(WEBSITE)).rejects.toThrow('index build failed');
			await failing.forWebsite(WEBSITE);
			expect(spy).toHaveBeenCalledTimes(2);
		} finally {
			spy.mockRestore();
		}
	});

	it("makes the product's declared indexes the truth: changed and retired ones are replaced, nothing else is touched", async () => {
		const dbName = freshDb('indexes');
		const db = client.db(dbName);
		/** A new instance of the product on this database, with these declared indexes. @param {any[]} indexes */
		const instance = (indexes) => {
			const { logger, entries } = createTestLogger();
			const data = createData({
				productId: 'coupon-box',
				uriOf: async () => mongoUri(dbName),
				logger,
				policy: createOutboundPolicy({ allowHosts: ['127.0.0.1'] }),
				idleMs: 0,
				indexes,
			});
			return { data, entries };
		};
		/** @param {string} name */
		const indexesOf = async (name) =>
			Object.fromEntries(
				(await db.collection(name).indexes())
					.filter((index) => index.name !== '_id_')
					.map((index) => [
						index.name,
						{
							key: index.key,
							...(index.unique ? { unique: true } : {}),
							...(index.partialFilterExpression ? { partial: index.partialFilterExpression } : {}),
							...(index.expireAfterSeconds !== undefined ? { ttl: index.expireAfterSeconds } : {}),
						},
					]),
			);
		/** @type {import('../src/index.js').IndexDefinition[]} */
		const before = [
			{ collection: 'coupons', keys: { websiteId: 1, code: 1 }, name: 'by_code' },
			{ collection: 'coupons', keys: { websiteId: 1, slug: 1 }, name: 'by_slug', unique: true },
			{
				collection: 'coupons',
				keys: { websiteId: 1, at: -1 },
				name: 'by_at',
				partialFilterExpression: { at: { $type: 'date' }, active: true },
			},
			{ collection: 'sessions', keys: { expiresAt: 1 }, name: 'ttl', expireAfterSeconds: 60 },
		];
		const first = instance(before);
		const site = await first.data.forWebsite(WEBSITE);
		await site.collection('coupons').insertMany([{ code: 'A', slug: 'a' }, { code: 'B' }]);
		// another product's collection and a collection this product declares nothing for are never touched
		await db.collection('ss_other_coupons').createIndex({ websiteId: 1, code: 1 }, { name: 'by_code' });
		await db.collection('ss_coupon_box_notes').createIndex({ websiteId: 1, at: 1 }, { name: 'by_at' });
		await first.data.closeAll();

		// the next release: by_code becomes unique, by_slug is retired for a per-category one, the TTL changes
		/** @type {import('../src/index.js').IndexDefinition[]} */
		const after = [
			{ collection: 'coupons', keys: { websiteId: 1, code: 1 }, name: 'by_code', unique: true },
			{ collection: 'coupons', keys: { websiteId: 1, categoryId: 1, slug: 1 }, name: 'by_category_slug', unique: true },
			{
				collection: 'coupons',
				keys: { websiteId: 1, at: -1 },
				name: 'by_at',
				partialFilterExpression: { at: { $type: 'date' }, active: true },
			},
			{ collection: 'sessions', keys: { expiresAt: 1 }, name: 'ttl', expireAfterSeconds: 3600 },
		];
		const second = instance(after);
		const upgraded = await second.data.forWebsite(WEBSITE);
		expect(await indexesOf('ss_coupon_box_coupons')).toEqual({
			by_code: { key: { websiteId: 1, code: 1 }, unique: true },
			by_category_slug: { key: { websiteId: 1, categoryId: 1, slug: 1 }, unique: true },
			by_at: { key: { websiteId: 1, at: -1 }, partial: { at: { $type: 'date' }, active: true } },
		});
		expect(await indexesOf('ss_coupon_box_sessions')).toEqual({ ttl: { key: { expiresAt: 1 }, ttl: 3600 } });
		expect(second.entries.find((entry) => entry.msg === 'merchant database indexes replaced')?.fields).toEqual({
			dropped: ['ss_coupon_box_coupons.by_code', 'ss_coupon_box_coupons.by_slug', 'ss_coupon_box_sessions.ttl'],
		});
		expect(Object.keys(await indexesOf('ss_other_coupons'))).toEqual(['by_code']);
		expect(Object.keys(await indexesOf('ss_coupon_box_notes'))).toEqual(['by_at']);
		// no record changed; a missing field reads as null, so the new index needs no backfill
		expect(await upgraded.collection('coupons').countDocuments({ websiteId: WEBSITE, categoryId: null })).toBe(2);
		await expect(upgraded.collection('coupons').insertOne({ code: 'A' })).rejects.toMatchObject({ code: 11000 });
		await second.data.closeAll();

		// an instance of the same release finds everything as declared: nothing dropped or created
		const third = instance(after);
		const dropIndex = vi.spyOn(Collection.prototype, 'dropIndex');
		const createIndexes = vi.spyOn(Collection.prototype, 'createIndexes');
		try {
			await third.data.forWebsite(WEBSITE);
			expect(dropIndex).not.toHaveBeenCalled();
			expect(createIndexes).not.toHaveBeenCalled();
			expect(third.entries.some((entry) => entry.msg === 'merchant database indexes replaced')).toBe(false);
		} finally {
			dropIndex.mockRestore();
			createIndexes.mockRestore();
			await third.data.closeAll();
		}
	});

	it('compares an index found with the one declared by keys in order and options', () => {
		const declared = { key: { websiteId: 1, slug: 1 }, name: 'by_slug', unique: true };
		expect(sameIndex({ v: 2, key: { websiteId: 1, slug: 1 }, name: 'by_slug', unique: true }, declared)).toBe(true);
		expect(sameIndex({ key: { slug: 1, websiteId: 1 }, name: 'by_slug', unique: true }, declared)).toBe(false);
		expect(sameIndex({ key: { websiteId: 1, slug: -1 }, name: 'by_slug', unique: true }, declared)).toBe(false);
		expect(sameIndex({ key: { websiteId: 1, slug: 1 }, name: 'by_slug' }, declared)).toBe(false);
		expect(sameIndex({ key: { websiteId: 1, slug: 1 }, unique: true, sparse: true }, declared)).toBe(false);
		expect(
			sameIndex(
				{ key: { websiteId: 1, slug: 1 }, unique: true, partialFilterExpression: { slug: { $type: 'string' } } },
				declared,
			),
		).toBe(false);
		expect(sameIndex({ key: { at: 1 }, expireAfterSeconds: 60 }, { key: { at: 1 }, expireAfterSeconds: 60 })).toBe(true);
		expect(sameIndex({ key: { at: 1 }, expireAfterSeconds: 60 }, { key: { at: 1 }, expireAfterSeconds: 0 })).toBe(false);
	});

	it('gives every database call deadlines and recognizes a database that cannot be reached (K-16)', async () => {
		expect(DATABASE_DEADLINES).toEqual({
			serverSelectionTimeoutMS: 5_000,
			connectTimeoutMS: 5_000,
			waitQueueTimeoutMS: 10_000,
			socketTimeoutMS: 10_000,
		});
		expect(PRODUCT_DATABASE_OPTIONS).toMatchObject({ maxPoolSize: 5, ...DATABASE_DEADLINES });
		/** @type {any[]} */
		const seen = [];
		const { data } = makeData({
			createClient: (/** @type {string} */ uri, /** @type {any} */ options) => {
				seen.push(options);
				return new MongoClient(uri, options);
			},
		});
		await data.forWebsite(WEBSITE);
		expect(seen[0]).toMatchObject({ maxPoolSize: 5, ...DATABASE_DEADLINES });
		await data.closeAll();
		for (const name of ['MongoServerSelectionError', 'MongoNetworkTimeoutError', 'MongoWaitQueueTimeoutError'])
			expect(isDatabaseUnavailable(Object.assign(new Error('x'), { name }))).toBe(true);
		expect(isDatabaseUnavailable(Object.assign(new Error('x'), { code: 50 }))).toBe(true);
		expect(isDatabaseUnavailable(kitError('database_unreachable', 'x'))).toBe(true);
		expect(isDatabaseUnavailable(kitError('database_not_connected', 'x'))).toBe(false);
		expect(isDatabaseUnavailable(Object.assign(new Error('dup'), { code: 11000 }))).toBe(false);
		// a mongodb+srv address whose DNS records cannot be read right now
		expect(isDatabaseUnavailable(Object.assign(new Error('querySrv ENOTFOUND'), { code: 'ENOTFOUND' }))).toBe(true);
		expect(isDatabaseUnavailable(Object.assign(new Error('querySrv'), { code: 'EAI_AGAIN' }))).toBe(true);
		expect(isDatabaseUnavailable(null)).toBe(false);
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
		expect(created).toEqual([5]);
		advance(61_000);
		await data.forWebsite(WEBSITE);
		await new Promise((resolve) => setImmediate(resolve));
		await data.forWebsite(WEBSITE);
		expect(created.length).toBeGreaterThanOrEqual(1);
		await data.closeAll();
	});

	it('checks the address again before a new pool opens, so a value that got in some other way never connects (SR-1-12)', async () => {
		const { logger, entries } = createTestLogger();
		/** @type {string[]} */
		const opened = [];
		const refused = [
			'mongodb://user:topsecret@10.0.0.5:27017/x?tls=true',
			'mongodb://user:topsecret@127.0.0.1:27017/x?authMechanism=MONGODB-AWS',
			'mongodb://user:topsecret@db.example.com:27017/x?tls=false',
			'postgres://user:topsecret@db.example.com/x',
		];
		for (const uri of refused) {
			const data = createData({
				productId: 's',
				uriOf: async () => uri,
				logger,
				policy: createOutboundPolicy({ allowHosts: ['127.0.0.1'] }),
				createClient: (address, options) => {
					opened.push(address);
					return new MongoClient(address, options);
				},
			});
			await expect(data.forWebsite(WEBSITE), uri).rejects.toMatchObject({
				code: 'database_unreachable',
				message: expect.stringMatching(/not allowed/),
			});
			// it is tried again next time (nothing stays in the pool), and is still refused
			await expect(data.forWebsite(WEBSITE), uri).rejects.toMatchObject({ code: 'database_unreachable' });
			await data.closeAll();
		}
		expect(opened).toEqual([]);
		expect(JSON.stringify(entries)).not.toContain('topsecret');
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
