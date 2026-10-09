import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	closeMongoClients,
	createLocks,
	createRegistry,
	createRepositories,
	createTransactionRunner,
	defineCollection,
	ensureIndexes,
	getMongoClient,
	guardPipeline,
	guardUpdate,
	indexSpecs,
} from '../src/infra/db.js';
import { isPlatformError } from '../src/infra/errors.js';
import { COLLECTIONS, INFRA_COLLECTIONS } from '../src/infra/schema.js';
import { MERCHANT, MERCHANT_2, createClock, createTestLogger, startMongo } from './helpers.js';

/** @type {Awaited<ReturnType<typeof startMongo>>} */
let mongo;
beforeAll(async () => {
	mongo = await startMongo();
}, 120_000);
afterAll(async () => {
	await mongo?.stop();
});

const DEFS = [
	defineCollection({ module: 'demo', name: 'demo_things', indexes: [{ keys: { slug: 1 }, unique: true }] }),
	defineCollection({ module: 'demo', name: 'demo_ledger', appendOnly: true, indexes: [{ keys: { at: -1 } }] }),
	defineCollection({
		module: 'demo',
		name: 'demo_websites',
		tenant: 'merchant',
		indexes: [{ keys: { domain: 1 }, unique: true }],
	}),
	defineCollection({ module: 'demo', name: 'demo_events', tenant: 'merchant', appendOnly: true, timestamps: false }),
	defineCollection({ module: 'demo', name: 'demo_cache', timestamps: false, ttl: { field: 'expireAt', afterSeconds: 0 } }),
];

/** @param {() => unknown} fn */
const guardCode = async (fn) => {
	try {
		await fn();
	} catch (error) {
		return isPlatformError(error) ? error.code : `other:${/** @type {Error} */ (error).message}`;
	}
	return null;
};

describe('collection definitions and registry', () => {
	it('validates names, tenants, indexes and ttl', () => {
		expect(() => defineCollection({ module: 'Demo', name: 'demo_x' })).toThrow(/module/);
		expect(() => defineCollection({ module: 'demo', name: 'other_x' })).toThrow(/name/);
		expect(() => defineCollection({ module: 'demo', name: 'demo' })).toThrow(/name/);
		expect(() => defineCollection({ module: 'demo', name: 'demo_x', tenant: /** @type {any} */ ('website') })).toThrow(
			/tenant/,
		);
		expect(() => defineCollection({ module: 'demo', name: 'demo_x', indexes: [{ keys: {} }] })).toThrow(/keys/);
		expect(() => defineCollection({ module: 'demo', name: 'demo_x', ttl: { field: 'x', afterSeconds: -1 } })).toThrow(/ttl/);
		const tenant = defineCollection({ module: 'demo', name: 'demo_x', tenant: 'merchant' });
		expect(tenant.indexes?.[0]).toEqual({ keys: { merchantId: 1, _id: 1 }, name: 'tenant' });
		const explicit = defineCollection({
			module: 'demo',
			name: 'demo_y',
			tenant: 'merchant',
			indexes: [{ keys: { merchantId: 1, slug: 1 } }],
		});
		expect(explicit.indexes).toHaveLength(1);
		expect(indexSpecs(DEFS[4] ?? tenant).map((s) => s.name)).toEqual(['ttl']);
		expect(indexSpecs(/** @type {any} */ (DEFS[0]))).toEqual([{ key: { slug: 1 }, name: 'slug_1', unique: true }]);
	});

	it('rejects duplicates and unknown names', () => {
		expect(() => createRegistry([...DEFS, /** @type {any} */ (DEFS[0])])).toThrow(/twice/);
		const registry = createRegistry(DEFS);
		expect(registry.has('demo_things')).toBe(true);
		expect(registry.ofModule('demo')).toHaveLength(5);
		expect(() => registry.get('nope_x')).toThrow(/not declared/);
		expect(
			createRegistry(INFRA_COLLECTIONS)
				.all()
				.every((def) => def.module === 'platform'),
		).toBe(true);
	});
});

describe('ensureIndexes', () => {
	it('creates declared indexes idempotently and reports undeclared ones', async () => {
		const db = mongo.db('db_indexes', { fresh: true });
		const registry = createRegistry([...INFRA_COLLECTIONS, ...DEFS]);
		const dry = await ensureIndexes(db, registry, { dryRun: true });
		expect(dry.created).toContain('demo_things.slug_1');
		expect(await db.listCollections({ name: 'demo_things' }).toArray()).toHaveLength(0);
		const { logger, entries } = createTestLogger();
		const first = await ensureIndexes(db, registry, { logger });
		expect(first.created).toEqual(
			expect.arrayContaining([
				'demo_things.slug_1',
				'demo_websites.tenant',
				'demo_cache.ttl',
				`${COLLECTIONS.audit}.at_-1__id_-1`,
			]),
		);
		expect(entries.some((e) => e.msg === 'indexes ensured')).toBe(true);
		const ttl = (await db.collection('demo_cache').listIndexes().toArray()).find((index) => index.name === 'ttl');
		expect(ttl?.expireAfterSeconds).toBe(0);
		await db.collection('demo_things').createIndex({ extra: 1 }, { name: 'extra_1' });
		const second = await ensureIndexes(db, registry);
		expect(second.created).toEqual([]);
		expect(second.existing).toContain('demo_things.slug_1');
		expect(second.undeclared).toEqual(['demo_things.extra_1']);
	});
});

describe('repositories', () => {
	const clock = createClock();
	/** @returns {ReturnType<typeof createRepositories>} */
	const repos = () => createRepositories(mongo.db('db_repos'), createRegistry(DEFS), { now: clock.now });

	it('mutable collections stamp timestamps and refuse $where / write stages', async () => {
		const things = repos().mutable('demo_things');
		await things.insertOne({ _id: 't1', slug: 'a' });
		const doc = await things.findOne({ _id: 't1' });
		expect(doc?.createdAt).toEqual(new Date(clock.now()));
		expect(doc?.updatedAt).toEqual(new Date(clock.now()));
		clock.advance(1000);
		await things.updateOne({ _id: 't1' }, { $set: { slug: 'b' } });
		expect((await things.findOne({ _id: 't1' }))?.updatedAt).toEqual(new Date(clock.now()));
		await things.updateOne({ _id: 't2' }, { $set: { slug: 'c' } }, { upsert: true });
		expect((await things.findOne({ _id: 't2' }))?.createdAt).toEqual(new Date(clock.now()));
		await things.updateMany({ slug: { $in: ['b', 'c'] } }, [{ $set: { n: 1 } }]);
		expect(await things.countDocuments({ n: 1 })).toBe(2);
		const after = await things.findOneAndUpdate({ _id: 't1' }, { $inc: { n: 1 } });
		expect(after?.n).toBe(2);
		await things.replaceOne({ _id: 't1' }, { slug: 'r', createdAt: new Date(0) });
		expect(await things.findOne({ _id: 't1' })).toMatchObject({ slug: 'r', createdAt: new Date(0) });
		expect(await things.find({}).sort({ _id: 1 }).toArray()).toHaveLength(2);
		expect(await things.aggregate([{ $match: {} }, { $count: 'n' }]).toArray()).toEqual([{ n: 2 }]);
		await things.insertMany([{ slug: 'm1' }, { slug: 'm2' }]);
		expect((await things.deleteMany({ slug: { $in: ['m1', 'm2'] } })).deletedCount).toBe(2);
		expect((await things.deleteOne({ _id: 't2' })).deletedCount).toBe(1);

		expect(await guardCode(() => things.findOne({ $where: 'true' }))).toBe('tenant_guard');
		expect(await guardCode(() => things.aggregate([{ $match: {} }, { $out: 'demo_ledger' }]))).toBe('tenant_guard');
		expect(await guardCode(() => things.aggregate([{ $match: {} }, { $facet: { a: [{ $merge: 'x' }] } }]))).toBe(
			'tenant_guard',
		);
		expect(await guardCode(() => things.aggregate([]))).toBe('tenant_guard');
		expect(await guardCode(() => things.updateOne({ _id: 't1' }, {}))).toBe('tenant_guard');
		expect(await guardCode(() => things.updateOne({ _id: 't1' }, { slug: 'x' }))).toBe('tenant_guard');
		expect(await guardCode(() => things.replaceOne({ _id: 't1' }, { $set: { a: 1 } }))).toBe('tenant_guard');
		expect(await guardCode(() => things.insertOne(/** @type {any} */ ('x')))).toBe('tenant_guard');
		expect(await guardCode(() => things.insertMany([]))).toBe('tenant_guard');
		expect(await guardCode(() => things.findOne(/** @type {any} */ (null)))).toBe('tenant_guard');
		// cross-collection reads are allowed outside merchant scopes
		expect(
			await things
				.aggregate([{ $match: {} }, { $lookup: { from: 'demo_ledger', localField: '_id', foreignField: 'thing', as: 'l' } }])
				.toArray(),
		).toBeDefined();
	});

	it('append-only collections expose no update or delete', async () => {
		const r = repos();
		const ledger = r.appendOnly('demo_ledger');
		await ledger.insertOne({ _id: 'e1', amount: 5 });
		await ledger.insertMany([{ _id: 'e2', amount: 6 }]);
		expect(await ledger.countDocuments({})).toBe(2);
		expect((await ledger.findOne({ _id: 'e1' }))?.updatedAt).toBeUndefined();
		expect((await ledger.findOne({ _id: 'e1' }))?.createdAt).toBeInstanceOf(Date);
		for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany'])
			expect(op in ledger).toBe(false);
		expect(Object.isFrozen(ledger)).toBe(true);
		expect(await ledger.aggregate([{ $match: {} }, { $group: { _id: null, total: { $sum: '$amount' } } }]).toArray()).toEqual([
			{ _id: null, total: 11 },
		]);
		expect(await guardCode(() => ledger.aggregate([{ $match: {} }, { $merge: { into: 'demo_ledger' } }]))).toBe('tenant_guard');
		expect(await guardCode(() => r.mutable('demo_ledger'))).toBe('wrong_repository');
		expect(await guardCode(() => r.mutable('demo_websites'))).toBe('wrong_repository');
		expect(await guardCode(() => r.appendOnly('demo_things'))).toBe('wrong_repository');
		expect(await guardCode(() => r.tenant('demo_things'))).toBe('wrong_repository');
		expect(r.repo('demo_ledger')).toBe(r.repo('demo_ledger')); // cached
	});

	it('merchant-scoped collections require merchantId in every operation', async () => {
		const r = repos();
		const websites = r.tenant('demo_websites');
		const mine = /** @type {import('../src/infra/db.js').MutableOps} */ (websites.forMerchant(MERCHANT));
		const theirs = /** @type {import('../src/infra/db.js').MutableOps} */ (websites.forMerchant(MERCHANT_2));
		await mine.insertOne({ _id: 'w1', domain: 'a.example.com' });
		await theirs.insertOne({ _id: 'w2', domain: 'b.example.com', merchantId: MERCHANT_2 });
		expect(await mine.findOne({ _id: 'w1', merchantId: MERCHANT })).toMatchObject({ merchantId: MERCHANT });
		expect(await mine.findOne({ _id: 'w2', merchantId: { $eq: MERCHANT } })).toBeNull();
		expect(await mine.countDocuments({ merchantId: MERCHANT })).toBe(1);
		await mine.updateOne({ merchantId: MERCHANT, _id: 'w1' }, { $set: { name: 'A' } });
		await mine.updateOne({ merchantId: MERCHANT, _id: 'w9' }, { $set: { domain: 'c.example.com' } }, { upsert: true });
		expect(await mine.findOne({ merchantId: MERCHANT, _id: 'w9' })).toMatchObject({ merchantId: MERCHANT });
		expect(await mine.aggregate([{ $match: { merchantId: MERCHANT } }, { $count: 'n' }]).toArray()).toEqual([{ n: 2 }]);
		await mine.replaceOne({ merchantId: MERCHANT, _id: 'w9' }, { domain: 'd.example.com' });
		expect(await mine.findOne({ merchantId: MERCHANT, _id: 'w9' })).toMatchObject({
			merchantId: MERCHANT,
			domain: 'd.example.com',
		});

		const refused = [
			() => mine.findOne({ _id: 'w2' }),
			() => mine.findOne({ merchantId: { $in: [MERCHANT, MERCHANT_2] } }),
			() => mine.findOne({ merchantId: MERCHANT_2 }),
			() => mine.find({ $or: [{ merchantId: MERCHANT }, { merchantId: MERCHANT_2 }] }),
			() => mine.insertOne({ domain: 'x', merchantId: MERCHANT_2 }),
			() => mine.updateOne({ merchantId: MERCHANT }, { $set: { merchantId: MERCHANT_2 } }),
			() => mine.updateOne({ merchantId: MERCHANT }, { $unset: { 'merchantId.x': '' } }),
			() => mine.updateOne({ merchantId: MERCHANT }, [{ $set: { merchantId: MERCHANT_2 } }]),
			() => mine.updateOne({ merchantId: MERCHANT }, [{ $unset: 'merchantId' }]),
			() => mine.updateOne({ merchantId: MERCHANT }, [{ $replaceWith: { a: 1 } }]),
			() => mine.updateOne({ merchantId: MERCHANT }, [1]),
			() => mine.replaceOne({ merchantId: MERCHANT }, { merchantId: MERCHANT_2 }),
			() => mine.deleteMany({}),
			() => mine.aggregate([{ $match: {} }]),
			() => mine.aggregate([{ $group: { _id: null } }]),
			() =>
				mine.aggregate([{ $match: { merchantId: MERCHANT } }, { $lookup: { from: 'demo_things', as: 'x', pipeline: [] } }]),
			() => mine.aggregate([{ $match: { merchantId: MERCHANT } }, { $facet: { a: [{ $unionWith: 'demo_things' }] } }]),
			() => mine.aggregate(/** @type {any} */ ([{ $match: { merchantId: MERCHANT } }, 'x'])),
			() => websites.forMerchant(''),
		];
		for (const attempt of refused) expect(await guardCode(attempt)).toBe('tenant_guard');
		expect((await mine.deleteOne({ merchantId: MERCHANT, _id: 'w9' })).deletedCount).toBe(1);
		expect((await mine.deleteMany({ merchantId: MERCHANT })).deletedCount).toBe(1);

		// explicit cross-merchant view for staff/system code
		const all = /** @type {import('../src/infra/db.js').MutableOps} */ (websites.acrossMerchants());
		expect(await all.countDocuments({})).toBe(1);
		await all.insertOne({ _id: 'w3', domain: 'e.example.com', merchantId: MERCHANT });
		expect(await all.countDocuments({})).toBe(2);
		expect(await guardCode(() => all.findOne({ $where: '1' }))).toBe('tenant_guard');

		// merchant-scoped append-only
		const events = r.tenant('demo_events').forMerchant(MERCHANT);
		await events.insertOne({ _id: 'ev1' });
		expect(await events.findOne({ merchantId: MERCHANT, _id: 'ev1' })).toEqual({ _id: 'ev1', merchantId: MERCHANT });
		expect('deleteOne' in events).toBe(false);
	});

	it('guard helpers', () => {
		expect(guardUpdate({ $set: { a: 1 } }, { merchantId: null, at: null, upsert: false, name: 'x' })).toEqual({
			$set: { a: 1 },
		});
		expect(guardUpdate([{ $set: { a: 1 } }], { merchantId: null, at: null, upsert: false, name: 'x' })).toEqual([
			{ $set: { a: 1 } },
		]);
		const at = new Date(0);
		expect(guardUpdate({ $set: { createdAt: at } }, { merchantId: null, at, upsert: true, name: 'x' })).toEqual({
			$set: { createdAt: at, updatedAt: at },
		});
		expect(guardPipeline([{ $match: { merchantId: 'm' } }], 'm', 'x')).toHaveLength(1);
	});
});

describe('locks', () => {
	it('acquires, refuses while held, takes over expired locks, extends and releases', async () => {
		const clock = createClock();
		const r = createRepositories(mongo.db('db_locks'), createRegistry(INFRA_COLLECTIONS), { now: clock.now });
		const locks = createLocks(r.mutable(COLLECTIONS.locks), { now: clock.now });
		const first = await locks.acquire('job', { ttlMs: 1000 });
		expect(first).not.toBeNull();
		expect(await locks.acquire('job', { ttlMs: 1000 })).toBeNull();
		expect(await first?.extend(5000)).toBe(true);
		clock.advance(2000);
		expect(await locks.acquire('job', { ttlMs: 1000 })).toBeNull(); // extended
		clock.advance(4000);
		const second = await locks.acquire('job', { ttlMs: 1000, owner: 'b' });
		expect(second).not.toBeNull();
		expect(await first?.extend(1000)).toBe(false); // lost to the takeover
		await first?.release(); // no effect on the new holder
		expect(await locks.acquire('job', { ttlMs: 1000 })).toBeNull();
		await second?.release();
		expect(await locks.withLock('job', { ttlMs: 1000 }, async () => 42)).toEqual({ locked: false, value: 42 });
		const held = await locks.acquire('job', { ttlMs: 1000 });
		expect(await locks.withLock('job', { ttlMs: 1000 }, async () => 1)).toEqual({ locked: true });
		await held?.release();
		await expect(locks.withLock('job', { ttlMs: 1000 }, async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
		expect(await locks.acquire('job', { ttlMs: 1000 })).not.toBeNull(); // released after the failure
	});
});

describe('getMongoClient', () => {
	it('caches one client per URI and pool size on globalThis', async () => {
		/** @type {string[]} */
		const created = [];
		const createClient = (/** @type {string} */ uri, /** @type {any} */ options) => {
			created.push(`${uri}|${options.maxPoolSize}`);
			return /** @type {any} */ ({ close: async () => {} });
		};
		const a = getMongoClient({ uri: 'mongodb://a/x', createClient });
		expect(getMongoClient({ uri: 'mongodb://a/x', createClient })).toBe(a);
		getMongoClient({ uri: 'mongodb://a/x', maxPoolSize: 3, createClient });
		expect(created).toEqual(['mongodb://a/x|5', 'mongodb://a/x|3']);
		await closeMongoClients();
		getMongoClient({ uri: 'mongodb://a/x', createClient });
		expect(created).toHaveLength(3);
		await closeMongoClients();
		await closeMongoClients();
		const real = getMongoClient({ uri: mongo.uri });
		expect((await real.db('admin').command({ ping: 1 })).ok).toBe(1);
		await closeMongoClients();
	});
});

describe('transactions', () => {
	it('commits all writes through the guarded repositories, or none', async () => {
		const db = mongo.db('db_tx');
		const registry = createRegistry(DEFS);
		await ensureIndexes(db, registry);
		const r = createRepositories(db, registry);
		const withTransaction = createTransactionRunner(mongo.client);
		const things = r.mutable('demo_things');
		const value = await withTransaction(async (session) => {
			await things.insertOne({ _id: 'tx1', slug: 'tx-1' }, { session });
			await things.updateOne({ _id: 'tx1' }, { $set: { n: 1 } }, { session });
			// not visible outside the transaction before the commit
			expect(await things.findOne({ _id: 'tx1' })).toBeNull();
			return 'ok';
		});
		expect(value).toBe('ok');
		expect(await things.findOne({ _id: 'tx1' })).toMatchObject({ n: 1 });

		await expect(
			withTransaction(async (session) => {
				await things.insertOne({ _id: 'tx2', slug: 'tx-2' }, { session });
				await things.insertOne({ _id: 'tx3', slug: 'tx-1' }, { session }); // unique slug violation
			}),
		).rejects.toMatchObject({ code: 11000 });
		expect(await things.countDocuments({ _id: { $in: ['tx2', 'tx3'] } })).toBe(0);
		// guards still apply inside transactions
		await expect(withTransaction(async (session) => things.find({ $where: '1' }, { session }).toArray())).rejects.toThrow(
			/\$where/,
		);
	});

	it('retries transient transaction errors and unknown commit results, within bounds', async () => {
		/** @param {string} label */
		const labelled = (label) => Object.assign(new Error(label), { hasErrorLabel: (/** @type {string} */ l) => l === label });
		/** @param {{ fnErrors?: Error[], commitErrors?: Error[] }} plan */
		const fakeClient = (plan) => {
			const log = /** @type {string[]} */ ([]);
			let active = false;
			const session = /** @type {any} */ ({
				startTransaction: () => {
					active = true;
					log.push('start');
				},
				inTransaction: () => active,
				commitTransaction: async () => {
					const error = plan.commitErrors?.shift();
					log.push(error ? `commit:${error.message}` : 'commit');
					if (error) throw error;
					active = false;
				},
				abortTransaction: async () => {
					active = false;
					log.push('abort');
				},
				endSession: async () => void log.push('end'),
			});
			return { log, client: /** @type {any} */ ({ startSession: () => session }) };
		};
		const run = (/** @type {any} */ plan, /** @type {any} */ options = {}) => {
			const { log, client } = fakeClient(plan);
			const withTransaction = createTransactionRunner(client, options);
			let calls = 0;
			const result = withTransaction(async () => {
				calls += 1;
				const error = plan.fnErrors?.shift();
				if (error) throw error;
				return calls;
			});
			return { log, result };
		};

		const transient = run({ fnErrors: [labelled('TransientTransactionError')] });
		expect(await transient.result).toBe(2);
		expect(transient.log).toEqual(['start', 'abort', 'start', 'commit', 'end']);

		const unknown = run({ commitErrors: [labelled('UnknownTransactionCommitResult')] });
		expect(await unknown.result).toBe(1);
		expect(unknown.log).toEqual(['start', 'commit:UnknownTransactionCommitResult', 'commit', 'end']);

		const transientCommit = run({ commitErrors: [labelled('TransientTransactionError')] });
		expect(await transientCommit.result).toBe(2);
		expect(transientCommit.log).toEqual(['start', 'commit:TransientTransactionError', 'start', 'commit', 'end']);

		const exhausted = run(
			{ fnErrors: [labelled('TransientTransactionError'), labelled('TransientTransactionError')] },
			{ maxAttempts: 2 },
		);
		await expect(exhausted.result).rejects.toThrow('TransientTransactionError');
		expect(exhausted.log.at(-1)).toBe('end');

		const fatalCommit = run({ commitErrors: [new Error('boom')] });
		await expect(fatalCommit.result).rejects.toThrow('boom');

		let t = 0;
		const late = run({ fnErrors: [labelled('TransientTransactionError')] }, { timeoutMs: 10, clock: () => (t += 20) });
		await expect(late.result).rejects.toThrow('TransientTransactionError');
	});
});
