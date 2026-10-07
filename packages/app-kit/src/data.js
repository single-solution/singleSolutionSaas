/**
 * The merchant database (PLAN 0.4.8, 0.10): the `database` connection of each website (a MongoDB connection string,
 * stored encrypted in Connections), opened with a small pooled `MongoClient` whose every DNS answer goes through the
 * `@ss/net` guarded lookup.
 *
 * - Pools are keyed by a hash of the URI and kept on `globalThis` so warm serverless invocations reuse them; they are
 *   small ({@link CLIENT_DB_POOL_SIZE}) and closed when unused for `idleMs` (checked when the next website is served).
 * - Collections are `ss_<product id>_<name>`.
 * - The tenant guard refuses any read, update, delete or aggregate whose filter (or first `$match`) does not pin
 *   `websiteId` to this website by equality (no `$in`), refuses cross-collection aggregation stages, forbids changing
 *   `websiteId`, and stamps `websiteId`, `merchantId`, `createdAt` and `updatedAt` on inserts.
 * - `ensureIndexes` is idempotent per pool and requires `websiteId` first in every index (TTL indexes excepted).
 * @module
 */
import { guardedLookup, isSafeMongoUri } from '@ss/net';
import { MongoClient } from 'mongodb';
import { collectionPrefix, isObject, kitError, sha256Hex } from './util.js';

/** Connections per merchant database per instance (serverless instances multiply it; clusters may be free tiers). */
export const CLIENT_DB_POOL_SIZE = 3;

/** @typedef {import('./logger.js').Logger} Logger */
/** @typedef {import('mongodb').Document} Document */

const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const POOLS = Symbol.for('ss.app-kit.mongo-pools');
const DENIED_STAGES = new Set([
	'$out',
	'$merge',
	'$unionWith',
	'$lookup',
	'$graphLookup',
	'$collStats',
	'$indexStats',
	'$planCacheStats',
	'$currentOp',
	'$listSessions',
	'$listLocalSessions',
	'$documents',
	'$changeStream',
]);

/**
 * @typedef {object} IndexDefinition
 * @property {string} collection unprefixed collection name
 * @property {Record<string, 1 | -1 | 'text' | '2dsphere' | 'hashed'>} keys `websiteId` must come first (except TTL)
 * @property {string} [name]
 * @property {boolean} [unique]
 * @property {boolean} [sparse]
 * @property {number} [expireAfterSeconds] TTL (single-field index on a date field)
 * @property {Document} [partialFilterExpression]
 */

/**
 * @typedef {object} WebsiteData
 * @property {string} websiteId
 * @property {string} prefix
 * @property {(name: string) => GuardedCollection} collection
 * @property {(defs: Parameters<typeof planIndexes>[0]) => Promise<{ created: string[] }>} ensureIndexes array of definitions or `{ [collection]: [...] }`
 * @property {<T>(fn: (session: import('mongodb').ClientSession) => Promise<T>) => Promise<T>} transaction
 */

/** @typedef {ReturnType<typeof guardCollection>} GuardedCollection */

/**
 * @param {string} op
 * @param {string} message
 */
const tenantError = (op, message) => kitError('tenant_guard', `${op}: ${message}`);

/**
 * @param {unknown} value
 * @param {string} websiteId
 * @returns {boolean}
 */
const pinsWebsite = (value, websiteId) =>
	value === websiteId || (isObject(value) && Object.keys(value).length === 1 && value.$eq === websiteId);

/**
 * Throw unless `filter` pins `websiteId` (top level, equality) and avoids `$where`.
 * @param {unknown} filter
 * @param {string} websiteId
 * @param {string} op
 * @returns {Document}
 */
export const guardFilter = (filter, websiteId, op) => {
	if (!isObject(filter)) throw tenantError(op, 'a filter object with websiteId is required');
	if (!pinsWebsite(filter.websiteId, websiteId)) throw tenantError(op, 'the filter must pin websiteId to this website');
	if ('$where' in filter) throw tenantError(op, '$where is not allowed');
	return filter;
};

/**
 * @param {unknown[]} pipeline
 * @param {string} op
 */
const denyStages = (pipeline, op) => {
	for (const stage of pipeline) {
		if (!isObject(stage)) throw tenantError(op, 'invalid pipeline stage');
		for (const [name, body] of Object.entries(stage)) {
			if (DENIED_STAGES.has(name)) throw tenantError(op, `${name} is not allowed (cross-collection or server stage)`);
			if (name === '$facet' && isObject(body))
				for (const sub of Object.values(body)) if (Array.isArray(sub)) denyStages(sub, op);
		}
	}
};

/**
 * Throw unless the pipeline starts with a `$match` that pins websiteId.
 * @param {unknown} pipeline
 * @param {string} websiteId
 * @returns {Document[]}
 */
export const guardPipeline = (pipeline, websiteId) => {
	if (!Array.isArray(pipeline) || pipeline.length === 0) throw tenantError('aggregate', 'a pipeline is required');
	const first = pipeline[0];
	if (!isObject(first) || !isObject(first.$match))
		throw tenantError('aggregate', 'the first stage must be $match with websiteId');
	guardFilter(first.$match, websiteId, 'aggregate');
	denyStages(pipeline, 'aggregate');
	return /** @type {Document[]} */ (pipeline);
};

/**
 * @param {string} key
 * @returns {boolean}
 */
const touchesWebsite = (key) => key === 'websiteId' || key.startsWith('websiteId.');

/**
 * Guard an update document (operators or pipeline) and add `updatedAt`.
 * @param {unknown} update
 * @param {string} websiteId
 * @param {Date} at
 * @param {string} op
 * @returns {Document | Document[]}
 */
export const guardUpdate = (update, websiteId, at, op) => {
	if (Array.isArray(update)) {
		for (const stage of update) {
			if (!isObject(stage)) throw tenantError(op, 'invalid update stage');
			for (const [name, body] of Object.entries(stage)) {
				if (name === '$replaceRoot' || name === '$replaceWith') throw tenantError(op, `${name} is not allowed`);
				if (name === '$unset' && [body].flat().some((key) => typeof key === 'string' && touchesWebsite(key))) {
					throw tenantError(op, 'websiteId cannot be removed');
				}
				if (isObject(body) && Object.keys(body).some(touchesWebsite)) throw tenantError(op, 'websiteId cannot be changed');
			}
		}
		return [...update, { $set: { updatedAt: at } }];
	}
	if (!isObject(update) || Object.keys(update).length === 0) throw tenantError(op, 'an update document is required');
	/** @type {Document} */
	const out = {};
	for (const [operator, body] of Object.entries(update)) {
		if (!operator.startsWith('$')) throw tenantError(op, 'use update operators (use replaceOne to replace)');
		if (isObject(body)) {
			for (const [key, value] of Object.entries(body)) {
				if (!touchesWebsite(key)) continue;
				const sameValue = (operator === '$set' || operator === '$setOnInsert') && key === 'websiteId' && value === websiteId;
				if (!sameValue) throw tenantError(op, 'websiteId cannot be changed');
			}
			if (operator === '$rename' && Object.values(body).some((to) => typeof to === 'string' && touchesWebsite(to))) {
				throw tenantError(op, 'websiteId cannot be changed');
			}
		}
		out[operator] = isObject(body) ? { ...body } : body;
	}
	const set = isObject(out.$set) ? out.$set : {};
	const current = isObject(out.$currentDate) ? out.$currentDate : {};
	if (!('updatedAt' in set) && !('updatedAt' in current)) out.$set = { ...set, updatedAt: at };
	return out;
};

/**
 * Stamp tenant and audit fields on a new document.
 * @param {unknown} doc
 * @param {{ websiteId: string, at: Date, stamp: Record<string, unknown> }} context
 * @param {string} op
 * @returns {Document}
 */
export const stampInsert = (doc, { websiteId, at, stamp }, op) => {
	if (!isObject(doc)) throw tenantError(op, 'a document object is required');
	if (doc.websiteId !== undefined && doc.websiteId !== websiteId)
		throw tenantError(op, 'the document belongs to another website');
	/** @type {Document} */
	const out = { ...stamp, ...doc, websiteId };
	out.createdAt ??= at;
	out.updatedAt ??= at;
	return out;
};

/**
 * Wrap a driver collection with the tenant guard.
 * @param {import('mongodb').Collection<any>} collection
 * @param {{ websiteId: string, now: () => number, stamp: Record<string, unknown> }} context
 */
export const guardCollection = (collection, { websiteId, now, stamp }) => {
	const at = () => new Date(now());
	/** @param {unknown} doc @param {string} op */
	const insertDoc = (doc, op) => stampInsert(doc, { websiteId, at: at(), stamp }, op);
	/** @param {unknown} filter @param {string} op */
	const f = (filter, op) => guardFilter(filter, websiteId, op);
	/** @param {unknown} update @param {string} op */
	const u = (update, op) => guardUpdate(update, websiteId, at(), op);
	/** @param {unknown} replacement @param {string} op */
	const r = (replacement, op) => {
		const doc = insertDoc(replacement, op);
		doc.updatedAt = at();
		return doc;
	};
	return Object.freeze({
		name: collection.collectionName,
		/** @param {Document} filter @param {import('mongodb').FindOptions} [options] */
		find: (filter, options) => collection.find(f(filter, 'find'), options),
		/** @param {Document} filter @param {import('mongodb').FindOptions} [options] */
		findOne: (filter, options) => collection.findOne(f(filter, 'findOne'), options),
		/** @param {Document} filter @param {import('mongodb').CountDocumentsOptions} [options] */
		countDocuments: (filter, options) => collection.countDocuments(f(filter, 'countDocuments'), options),
		/** @param {string} key @param {Document} filter */
		distinct: (key, filter) => collection.distinct(key, f(filter, 'distinct')),
		/** @param {Document[]} pipeline @param {import('mongodb').AggregateOptions} [options] */
		aggregate: (pipeline, options) => collection.aggregate(guardPipeline(pipeline, websiteId), options),
		/** @param {Document} doc @param {import('mongodb').InsertOneOptions} [options] */
		insertOne: (doc, options) => collection.insertOne(insertDoc(doc, 'insertOne'), options),
		/** @param {Document[]} docs @param {import('mongodb').BulkWriteOptions} [options] */
		insertMany: (docs, options) => {
			if (!Array.isArray(docs)) throw tenantError('insertMany', 'an array of documents is required');
			return collection.insertMany(
				docs.map((doc) => insertDoc(doc, 'insertMany')),
				options,
			);
		},
		/** @param {Document} filter @param {Document | Document[]} update @param {import('mongodb').UpdateOptions} [options] */
		updateOne: (filter, update, options) => collection.updateOne(f(filter, 'updateOne'), u(update, 'updateOne'), options),
		/** @param {Document} filter @param {Document | Document[]} update @param {import('mongodb').UpdateOptions} [options] */
		updateMany: (filter, update, options) => collection.updateMany(f(filter, 'updateMany'), u(update, 'updateMany'), options),
		/** @param {Document} filter @param {Document} replacement @param {import('mongodb').ReplaceOptions} [options] */
		replaceOne: (filter, replacement, options) =>
			collection.replaceOne(f(filter, 'replaceOne'), r(replacement, 'replaceOne'), options),
		/** @param {Document} filter @param {Document | Document[]} update @param {import('mongodb').FindOneAndUpdateOptions} [options] */
		findOneAndUpdate: (filter, update, options = {}) =>
			collection.findOneAndUpdate(f(filter, 'findOneAndUpdate'), u(update, 'findOneAndUpdate'), options),
		/** @param {Document} filter @param {import('mongodb').FindOneAndDeleteOptions} [options] */
		findOneAndDelete: (filter, options = {}) => collection.findOneAndDelete(f(filter, 'findOneAndDelete'), options),
		/** @param {Document} filter @param {import('mongodb').DeleteOptions} [options] */
		deleteOne: (filter, options) => collection.deleteOne(f(filter, 'deleteOne'), options),
		/** @param {Document} filter @param {import('mongodb').DeleteOptions} [options] */
		deleteMany: (filter, options) => collection.deleteMany(f(filter, 'deleteMany'), options),
	});
};

/**
 * Normalise index definitions: an array of `{ collection, keys | key, ... }`, or a map
 * `{ [collection]: [{ keys | key, name?, unique?, ... }] }` (driver-style `key` accepted).
 * @param {IndexDefinition[] | Record<string, ReadonlyArray<Omit<IndexDefinition, 'collection'> | (Omit<IndexDefinition, 'collection' | 'keys'> & { key: IndexDefinition['keys'] })>>} defs
 * @returns {IndexDefinition[]}
 */
const normaliseIndexes = (defs) => {
	/** @param {any} def @param {string | undefined} collection */
	const one = (def, collection) => {
		if (!isObject(def)) throw kitError('invalid_index', 'every index must be an object');
		const { key, ...rest } = def;
		return /** @type {IndexDefinition} */ ({ ...rest, ...(collection ? { collection } : {}), keys: def.keys ?? key });
	};
	if (Array.isArray(defs)) return defs.map((def) => one(def, undefined));
	if (isObject(defs)) {
		return Object.entries(defs).flatMap(([collection, list]) => {
			if (!Array.isArray(list)) throw kitError('invalid_index', `indexes of ${collection} must be an array`);
			return list.map((def) => one(def, collection));
		});
	}
	throw kitError('invalid_index', 'index definitions must be an array or a map of collection → indexes');
};

/**
 * Validate index definitions and return driver specs grouped by collection.
 * @param {Parameters<typeof normaliseIndexes>[0]} input
 * @returns {Map<string, import('mongodb').IndexDescription[]>}
 */
export const planIndexes = (input) => {
	const defs = normaliseIndexes(input);
	/** @type {Map<string, import('mongodb').IndexDescription[]>} */
	const byCollection = new Map();
	for (const def of defs) {
		if (typeof def.collection !== 'string' || !NAME.test(def.collection)) {
			throw kitError('invalid_index', 'every index needs a valid collection name');
		}
		const keys = Object.keys(isObject(def.keys) ? def.keys : {});
		if (keys.length === 0) throw kitError('invalid_index', `index on ${def.collection} has no keys`);
		const ttl = def.expireAfterSeconds !== undefined;
		if (ttl && keys.length !== 1) throw kitError('invalid_index', `TTL index on ${def.collection} must be single-field`);
		if (!ttl && keys[0] !== 'websiteId')
			throw kitError('invalid_index', `index on ${def.collection} must start with websiteId`);
		const name = def.name ?? keys.map((key) => `${key}_${def.keys[key]}`).join('_');
		/** @type {import('mongodb').IndexDescription} */
		const spec = { key: /** @type {any} */ ({ ...def.keys }), name };
		if (def.unique !== undefined) spec.unique = def.unique;
		if (def.sparse !== undefined) spec.sparse = def.sparse;
		if (ttl) spec.expireAfterSeconds = def.expireAfterSeconds;
		if (def.partialFilterExpression !== undefined) spec.partialFilterExpression = def.partialFilterExpression;
		const list = byCollection.get(def.collection) ?? [];
		list.push(spec);
		byCollection.set(def.collection, list);
	}
	return byCollection;
};

/**
 * @typedef {object} PoolEntry
 * @property {Promise<MongoClient>} client
 * @property {number} lastUsed
 */

/** @returns {Map<string, PoolEntry>} */
const poolRegistry = () => {
	const g = /** @type {Record<symbol, Map<string, PoolEntry>>} */ (/** @type {unknown} */ (globalThis));
	g[POOLS] ??= new Map();
	return /** @type {Map<string, PoolEntry>} */ (g[POOLS]);
};

/**
 * @param {{
 *   productId: string,
 *   uriOf: (websiteId: string) => Promise<string | null>,
 *   now?: () => number,
 *   logger: Logger,
 *   policy: import('@ss/net').OutboundPolicy,
 *   createClient?: (uri: string, options: import('mongodb').MongoClientOptions) => MongoClient,
 *   idleMs?: number,
 *   indexes?: IndexDefinition[],
 * }} options `uriOf` reads the website's `database` connection; `indexes` are created on a website's first use per
 *   instance
 */
export const createData = ({
	productId,
	uriOf,
	now = Date.now,
	logger,
	policy,
	createClient = (uri, options) => new MongoClient(uri, options),
	idleMs = 5 * 60_000,
	indexes = [],
}) => {
	const lookup = guardedLookup(policy);
	const prefix = collectionPrefix(productId);
	planIndexes(indexes);
	/** @type {Set<string>} */
	const indexed = new Set();
	const pools = poolRegistry();

	/** Close pools unused for longer than `idleMs`. */
	const closeIdle = async () => {
		const cutoff = now() - idleMs;
		const closing = [];
		for (const [key, entry] of pools) {
			if (entry.lastUsed > cutoff) continue;
			pools.delete(key);
			closing.push(entry.client.then((client) => client.close()).catch(() => {}));
		}
		await Promise.all(closing);
	};

	/** @param {string} uri */
	const clientFor = (uri) => {
		const key = sha256Hex(uri);
		let entry = pools.get(key);
		if (!entry) {
			const options = {
				maxPoolSize: CLIENT_DB_POOL_SIZE,
				minPoolSize: 0,
				maxIdleTimeMS: 60_000,
				serverSelectionTimeoutMS: 5_000,
				connectTimeoutMS: 5_000,
				appName: `ss-${productId}`,
				lookup: /** @type {any} */ (lookup),
			};
			const connecting = Promise.resolve()
				.then(() => createClient(uri, options).connect())
				.catch((error) => {
					pools.delete(key);
					logger.warn('merchant database unreachable', { code: error?.code ?? error?.name ?? 'error' });
					throw kitError('database_unreachable', 'the merchant database cannot be reached');
				});
			entry = { client: connecting, lastUsed: now() };
			pools.set(key, entry);
		}
		entry.lastUsed = now();
		return { key, client: entry.client };
	};

	/**
	 * Guarded access to one website's data in the merchant database. Throws `database_not_connected` when the website
	 * has no `database` connection.
	 * @param {string} websiteId
	 * @param {{ merchantId?: string }} [stampFields] stamped on inserts when given
	 * @returns {Promise<WebsiteData>}
	 */
	const forWebsite = async (websiteId, { merchantId } = {}) => {
		const uri = await uriOf(websiteId);
		if (!uri) throw kitError('database_not_connected', 'the merchant database is not connected');
		if (idleMs > 0) void closeIdle();
		const { key, client: clientPromise } = clientFor(uri);
		const client = await clientPromise;
		const db = client.db();
		const scopeKey = `${key}|${db.databaseName}`;
		const stamp = merchantId ? { merchantId } : {};

		/** @param {string} name */
		const collection = (name) => {
			if (typeof name !== 'string' || !NAME.test(name))
				throw kitError('invalid_argument', `invalid collection name: ${String(name)}`);
			return guardCollection(db.collection(`${prefix}${name}`), { websiteId, now, stamp });
		};

		/** @type {WebsiteData['ensureIndexes']} */
		const ensureIndexes = async (defs) => {
			/** @type {string[]} */
			const created = [];
			for (const [name, specs] of planIndexes(defs)) {
				const todo = specs.filter((spec) => !indexed.has(`${scopeKey}|${name}|${spec.name}`));
				if (todo.length === 0) continue;
				await db.collection(`${prefix}${name}`).createIndexes(todo);
				for (const spec of todo) {
					indexed.add(`${scopeKey}|${name}|${spec.name}`);
					created.push(`${prefix}${name}.${spec.name}`);
				}
			}
			return { created };
		};

		/** @type {WebsiteData['transaction']} */
		const transaction = async (fn) => {
			const session = client.startSession();
			try {
				/** @type {any} */
				let out;
				await session.withTransaction(async () => {
					out = await fn(session);
				});
				return out;
			} finally {
				await session.endSession();
			}
		};

		if (indexes.length > 0) await ensureIndexes(indexes);
		return Object.freeze({ websiteId, prefix, collection, ensureIndexes, transaction });
	};

	/**
	 * Test a MongoDB connection string: refused by the outbound policy, or connect and ping (5 s).
	 * @param {string} uri
	 * @returns {Promise<{ ok: true } | { ok: false, message: string }>}
	 */
	const testUri = async (uri) => {
		const safe = isSafeMongoUri(uri, policy);
		if (!safe.ok) return { ok: false, message: `This address is not allowed (${safe.reason}).` };
		/** @type {MongoClient | null} */
		let client = null;
		try {
			client = await createClient(uri, {
				serverSelectionTimeoutMS: 5_000,
				connectTimeoutMS: 5_000,
				maxPoolSize: 1,
				lookup: /** @type {any} */ (lookup),
			}).connect();
			await client.db().command({ ping: 1 });
			return { ok: true };
		} catch {
			return { ok: false, message: 'The database cannot be reached with this connection string.' };
		} finally {
			await client?.close().catch(() => {});
		}
	};

	/** Close every pool this process opened (tests, graceful shutdown). */
	const closeAll = async () => {
		const entries = [...pools.values()];
		pools.clear();
		await Promise.all(entries.map((entry) => entry.client.then((client) => client.close()).catch(() => {})));
	};

	return Object.freeze({ forWebsite, testUri, prefix, closeAll });
};

/** @typedef {ReturnType<typeof createData>} Data */
