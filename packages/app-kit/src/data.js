/**
 * Client-owned data (PLAN §1a, Part E §7). The merchant's database is resolved per website through the Portal
 * (`resolveResource({ websiteId, kind: 'database' })` → short-lived `{ uri, dbName? }` descriptor, never cached past
 * `expiresAt`) and opened with a pooled `MongoClient`:
 *
 * - pools are keyed by a hash of the URI and kept on `globalThis` so warm serverless invocations reuse them; they
 *   are small (`maxPoolSize` 3 by default, {@link CLIENT_DB_POOL_SIZE}) and closed after `idleMs` without use;
 * - collections are namespaced `ss_<slug with - → _>_<name>`;
 * - a tenant guard rejects any read/update/delete/aggregate whose filter (or first `$match`) does not pin
 *   `websiteId` to this website, refuses cross-collection aggregation stages, forbids changing `websiteId`, and stamps
 *   `websiteId`, `createdAt`, `updatedAt` and `schemaVersion` on writes;
 * - `ensureIndexes` is idempotent (memoised per pool) and requires `websiteId` first in every index (TTL indexes
 *   excepted, which must be single-field);
 * - `migrate` runs lazy, versioned steps per website under a lock document with a lease.
 * @module
 */
import { createOutboundPolicy, guardedLookup, isSafeMongoUri } from '@ss/net';
import { MongoClient } from 'mongodb';
import { collectionPrefix, createSingleFlight, isObject, kitError, randomToken, sha256Hex } from './util.js';

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
 * @typedef {object} MigrationStep
 * @property {number} version positive integer, strictly increasing
 * @property {string} [name]
 * @property {(scope: WebsiteData) => Promise<void>} up must be idempotent per website (it may be retried after a crash)
 */

/**
 * @typedef {object} WebsiteData
 * @property {string} websiteId
 * @property {string} prefix
 * @property {(name: string) => GuardedCollection} collection
 * @property {(defs: Parameters<typeof planIndexes>[0]) => Promise<{ created: string[] }>} ensureIndexes array of definitions or `{ [collection]: [...] }`
 * @property {(steps: MigrationStep[]) => Promise<{ version: number, applied: number[] }>} migrate
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
 * @param {{ websiteId: string, at: Date, schemaVersion: number, stamp: Record<string, unknown> }} context
 * @param {string} op
 * @returns {Document}
 */
export const stampInsert = (doc, { websiteId, at, schemaVersion, stamp }, op) => {
	if (!isObject(doc)) throw tenantError(op, 'a document object is required');
	if (doc.websiteId !== undefined && doc.websiteId !== websiteId)
		throw tenantError(op, 'the document belongs to another website');
	/** @type {Document} */
	const out = { ...stamp, ...doc, websiteId };
	out.createdAt ??= at;
	out.updatedAt ??= at;
	out.schemaVersion ??= schemaVersion;
	return out;
};

/**
 * Wrap a driver collection with the tenant guard.
 * @param {import('mongodb').Collection<any>} collection
 * @param {{ websiteId: string, now: () => number, schemaVersion: () => number, stamp: Record<string, unknown> }} context
 */
export const guardCollection = (collection, { websiteId, now, schemaVersion, stamp }) => {
	const at = () => new Date(now());
	/** @param {unknown} doc @param {string} op */
	const insertDoc = (doc, op) => stampInsert(doc, { websiteId, at: at(), schemaVersion: schemaVersion(), stamp }, op);
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
 * Validate migration steps (positive, strictly increasing integer versions).
 * @param {MigrationStep[]} steps
 * @returns {number} target version (0 when there are no steps)
 */
export const targetVersion = (steps) => {
	if (!Array.isArray(steps)) throw kitError('invalid_migration', 'migration steps must be an array');
	let last = 0;
	for (const step of steps) {
		if (!isObject(step) || !Number.isSafeInteger(step.version) || step.version <= last || typeof step.up !== 'function') {
			throw kitError('invalid_migration', 'migration versions must be increasing positive integers with an up() function');
		}
		last = step.version;
	}
	return last;
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
 *   portal: { resolveResource: (input: { websiteId: string, kind: 'database' }) => Promise<{ descriptor: Record<string, unknown>, expiresAt: string }> },
 *   slug: string,
 *   now?: () => number,
 *   randomBytes: (length: number) => Uint8Array,
 *   logger: Logger,
 *   createClient?: (uri: string, options: import('mongodb').MongoClientOptions) => MongoClient,
 *   clientOptions?: import('mongodb').MongoClientOptions,
 *   outbound?: import('@ss/net').OutboundPolicyOptions,
 *   idleMs?: number,
 *   indexes?: IndexDefinition[],
 *   migrations?: MigrationStep[],
 *   lockLeaseMs?: number,
 *   lockWaitMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   autoSweep?: boolean,
 * }} options `indexes` / `migrations` are applied lazily on the first `forWebsite` of each website per instance.
 */
export const createData = ({
	portal,
	slug,
	now = Date.now,
	randomBytes,
	logger,
	createClient = (uri, options) => new MongoClient(uri, options),
	clientOptions = {},
	idleMs = 5 * 60_000,
	indexes = [],
	migrations = [],
	lockLeaseMs = 60_000,
	lockWaitMs = 30_000,
	sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	autoSweep = true,
	outbound = {},
}) => {
	// SSRF guard for the merchant database: the URI is vetted before connecting and every host the driver dials
	// (seed list, SRV answers, discovered replica-set members) is resolved through the guarded lookup.
	const policy = createOutboundPolicy(outbound);
	const lookup = guardedLookup(policy);
	const prefix = collectionPrefix(slug);
	const owner = randomToken(randomBytes, 9);
	const defaultTarget = targetVersion(migrations);
	planIndexes(indexes);
	/** @type {Map<string, { uri: string, dbName: string | undefined, expiresAt: number }>} */
	const descriptors = new Map();
	/** @type {Set<string>} */
	const indexed = new Set();
	/** @type {Map<string, number>} */
	const migrated = new Map();
	/** @type {Map<string, Promise<void>>} */
	const prepared = new Map();
	const resolveOnce =
		/** @type {(key: string, run: () => Promise<{ uri: string, dbName: string | undefined, expiresAt: number }>) => Promise<{ uri: string, dbName: string | undefined, expiresAt: number }>} */ (
			createSingleFlight()
		);
	const pools = poolRegistry();
	/** @type {ReturnType<typeof setInterval> | undefined} */
	let sweeper;

	/**
	 * Close pools unused for longer than `idleMs`.
	 * @param {{ idleMs?: number }} [options]
	 */
	const closeIdle = async ({ idleMs: limit = idleMs } = {}) => {
		const cutoff = now() - limit;
		const closing = [];
		for (const [key, entry] of pools) {
			if (entry.lastUsed > cutoff) continue;
			pools.delete(key);
			closing.push(entry.client.then((client) => client.close()).catch(() => {}));
		}
		await Promise.all(closing);
		return closing.length;
	};

	/** @param {string} websiteId */
	const descriptorFor = async (websiteId) => {
		const cached = descriptors.get(websiteId);
		if (cached && cached.expiresAt - 5_000 > now()) return cached;
		return resolveOnce(websiteId, async () => {
			const { descriptor, expiresAt } = await portal.resolveResource({ websiteId, kind: 'database' });
			const uri = descriptor.uri;
			if (typeof uri !== 'string' || !/^mongodb(\+srv)?:\/\//.test(uri)) {
				throw kitError('resource_invalid', 'database descriptor has no mongodb uri');
			}
			const safe = isSafeMongoUri(uri, policy);
			if (!safe.ok) {
				logger.warn('client database refused by the outbound policy', { code: safe.code, reason: safe.reason });
				throw kitError('resource_invalid', `client database refused (${safe.reason})`, { reason: safe.code });
			}
			const expires = Date.parse(expiresAt);
			const entry = {
				uri,
				dbName: typeof descriptor.dbName === 'string' ? descriptor.dbName : undefined,
				expiresAt: Number.isNaN(expires) ? now() : expires,
			};
			descriptors.set(websiteId, entry);
			return entry;
		});
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
				appName: `ss-${slug}`,
				...clientOptions,
				lookup: /** @type {any} */ (lookup),
			};
			const connecting = Promise.resolve()
				.then(() => createClient(uri, options).connect())
				.catch((error) => {
					pools.delete(key);
					logger.error('client database connection failed', { code: error?.code ?? error?.name ?? 'error' });
					throw kitError('resource_unavailable', 'client database is unreachable');
				});
			entry = { client: connecting, lastUsed: now() };
			pools.set(key, entry);
			if (autoSweep && !sweeper && idleMs > 0) {
				sweeper = setInterval(() => void closeIdle(), Math.max(1000, Math.floor(idleMs / 2)));
				sweeper.unref?.();
			}
		}
		entry.lastUsed = now();
		return { key, client: entry.client };
	};

	/**
	 * Guarded access to one website's data in the merchant database.
	 * @param {string} websiteId
	 * @param {{ merchantId?: string, env?: 'live' | 'test' }} [stampFields] also stamped on inserts when given
	 * @returns {Promise<WebsiteData>}
	 */
	const forWebsite = async (websiteId, stampFields = {}) => {
		if (typeof websiteId !== 'string' || websiteId.length === 0) throw kitError('invalid_argument', 'websiteId is required');
		const { uri, dbName } = await descriptorFor(websiteId);
		const { key, client: clientPromise } = clientFor(uri);
		const client = await clientPromise;
		const db = client.db(dbName);
		const scopeKey = `${key}|${db.databaseName}`;
		const schemaVersion = Math.max(1, defaultTarget);
		/** @type {Record<string, unknown>} */
		const stamp = {};
		if (stampFields.merchantId) stamp.merchantId = stampFields.merchantId;
		if (stampFields.env) stamp.env = stampFields.env;

		/** @param {string} name */
		const collection = (name) => {
			if (typeof name !== 'string' || !NAME.test(name))
				throw kitError('invalid_argument', `invalid collection name: ${String(name)}`);
			return guardCollection(db.collection(`${prefix}${name}`), { websiteId, now, schemaVersion: () => schemaVersion, stamp });
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

		/** @type {WebsiteData['migrate']} */
		const migrate = async (steps) => {
			const target = targetVersion(steps);
			const memo = `${scopeKey}|${websiteId}`;
			if ((migrated.get(memo) ?? -1) >= target) return { version: target, applied: [] };
			const state = db.collection(`${prefix}migrations`);
			const deadline = now() + lockWaitMs;
			/** @type {Document | null} */
			let doc = await state.findOne(/** @type {any} */ ({ _id: websiteId }));
			if (doc && doc.version >= target) {
				migrated.set(memo, doc.version);
				return { version: doc.version, applied: [] };
			}
			for (;;) {
				try {
					doc = await state.findOneAndUpdate(
						/** @type {any} */ ({ _id: websiteId, $or: [{ lock: null }, { 'lock.until': { $lte: new Date(now()) } }] }),
						{ $set: { lock: { owner, until: new Date(now() + lockLeaseMs) } }, $setOnInsert: { websiteId, version: 0 } },
						{ upsert: true, returnDocument: 'after' },
					);
					if (doc) break;
				} catch (error) {
					if (/** @type {any} */ (error)?.code !== 11000) throw error;
				}
				const current = await state.findOne(/** @type {any} */ ({ _id: websiteId }));
				if (current && current.version >= target) {
					migrated.set(memo, current.version);
					return { version: current.version, applied: [] };
				}
				if (now() >= deadline) throw kitError('migration_locked', 'another instance is migrating this website');
				await sleep(200);
			}
			/** @type {number[]} */
			const applied = [];
			let version = Number(doc.version ?? 0);
			try {
				for (const step of steps) {
					if (step.version <= version) continue;
					await step.up(scope);
					const result = await state.updateOne(/** @type {any} */ ({ _id: websiteId, 'lock.owner': owner }), {
						$set: { version: step.version, updatedAt: new Date(now()), 'lock.until': new Date(now() + lockLeaseMs) },
						$push: /** @type {any} */ ({
							history: { version: step.version, name: step.name ?? null, at: new Date(now()) },
						}),
					});
					if (result.matchedCount === 0) throw kitError('migration_lock_lost', 'migration lock was lost');
					version = step.version;
					applied.push(step.version);
					logger.info('migration applied', { websiteId, version: step.version, name: step.name });
				}
			} finally {
				await state
					.updateOne(/** @type {any} */ ({ _id: websiteId, 'lock.owner': owner }), { $set: { lock: null } })
					.catch(() => {});
			}
			migrated.set(memo, version);
			return { version, applied };
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

		/** @type {WebsiteData} */
		const scope = Object.freeze({ websiteId, prefix, collection, ensureIndexes, migrate, transaction });

		if (indexes.length > 0 || migrations.length > 0) {
			const memo = `${scopeKey}|${websiteId}`;
			let ready = prepared.get(memo);
			if (!ready) {
				ready = (async () => {
					if (indexes.length > 0) await ensureIndexes(indexes);
					if (migrations.length > 0) await migrate(migrations);
				})();
				prepared.set(memo, ready);
				ready.catch(() => prepared.delete(memo));
			}
			await ready;
		}
		return scope;
	};

	/** Close every pool this process opened (tests, graceful shutdown). */
	const closeAll = async () => {
		if (sweeper) clearInterval(sweeper);
		sweeper = undefined;
		const entries = [...pools.values()];
		pools.clear();
		await Promise.all(entries.map((entry) => entry.client.then((client) => client.close()).catch(() => {})));
	};

	return Object.freeze({
		forWebsite,
		prefix,
		closeIdle,
		closeAll,
		/** Forget the cached descriptor of a website (e.g. after `resource.revoked`). */
		forget: (/** @type {string} */ websiteId) => {
			descriptors.delete(websiteId);
		},
	});
};
