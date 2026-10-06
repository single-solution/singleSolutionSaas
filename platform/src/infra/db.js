/**
 * Control-plane database access (PLAN §1a: this database holds control-plane records only — never client data).
 *
 * - `getMongoClient` — one pooled `MongoClient` per URI, cached on `globalThis` so warm serverless invocations
 *   reuse it. The driver connects lazily on the first operation, so importing or building never needs a database.
 * - `defineCollection` / `createRegistry` — every module declares its collections (indexes, TTL, `appendOnly`,
 *   `tenant: 'merchant'`). Names are global and owned: a module's collections are named `<module>_<name>`.
 * - `ensureIndexes` — creates every declared index idempotently (and reports undeclared ones; never drops).
 * - `createRepositories` — the only way module code reaches a collection:
 *   - append-only collections expose `insertOne`, `insertMany`, `findOne`, `find`, `countDocuments`, `aggregate`
 *     and nothing that updates or deletes;
 *   - merchant-scoped collections are reached through `forMerchant(merchantId)` (every filter and the first
 *     `$match` must pin `merchantId` by equality, inserts are stamped, `merchantId` can never be changed,
 *     cross-collection stages are refused) or the explicit `acrossMerchants()` view for staff/system code;
 *   - every repository refuses `$where` and the `$out` / `$merge` write stages (which could bypass append-only).
 * - `createLocks` — lease locks (unique `_id`, expiry takeover) used by migrations, operation runs and ledger appends.
 * - `createTransactionRunner` — `withTransaction(async (session) => …)` over a driver session: snapshot reads,
 *   majority commit, whole-transaction retry on `TransientTransactionError` and commit retry on
 *   `UnknownTransactionCommitResult`. Repository operations take the driver options, so `{ session }` is passed to
 *   them like any other option (the guards are unchanged).
 * - `runMigrations` — versioned, ordered, recorded migrations under a lock, with a read-only dry run.
 * @module
 */
import { MongoClient } from 'mongodb';
import { platformError } from './errors.js';
import { isDuplicateKey, isObject, randomToken, sha256Hex, defaultRandomBytes } from './util.js';

/** @typedef {import('mongodb').Db} Db */
/** @typedef {import('mongodb').Document} Document */
/** @typedef {import('./logger.js').Logger} Logger */

/**
 * @typedef {object} IndexSpec
 * @property {Record<string, 1 | -1 | 'text' | 'hashed' | '2dsphere'>} keys
 * @property {string} [name]
 * @property {boolean} [unique]
 * @property {boolean} [sparse]
 * @property {Document} [partialFilterExpression]
 */

/**
 * @typedef {object} CollectionDefinition
 * @property {string} module owning module (`platform` for infra)
 * @property {string} name physical collection name, `<module>_<name>`
 * @property {string} [description]
 * @property {ReadonlyArray<IndexSpec>} [indexes]
 * @property {{ field: string, afterSeconds: number }} [ttl] TTL index (retention)
 * @property {boolean} [appendOnly] repositories expose no update/delete
 * @property {'merchant'} [tenant] merchant-scoped: queries must pin `merchantId`
 * @property {boolean} [timestamps] stamp `createdAt` / `updatedAt` (default true)
 */

const NAME = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;
const MODULE = /^[a-z][a-z0-9]*$/;
const CLIENTS = Symbol.for('ss.platform.mongo-clients');
const WRITE_STAGES = new Set(['$out', '$merge']);
const CROSS_STAGES = new Set([
	'$lookup',
	'$graphLookup',
	'$unionWith',
	'$collStats',
	'$indexStats',
	'$planCacheStats',
	'$currentOp',
	'$listSessions',
	'$listLocalSessions',
	'$documents',
	'$changeStream',
]);

// ---------------------------------------------------------------------------------------------------------------
// Client

/**
 * Pooled client per URI, cached on `globalThis` (serverless-safe). No connection is made until first use.
 * @param {{ uri: string, maxPoolSize?: number, appName?: string, createClient?: (uri: string, options: import('mongodb').MongoClientOptions) => MongoClient }} options
 * @returns {MongoClient}
 */
export const getMongoClient = ({ uri, maxPoolSize = 5, appName = 'ss-portal', createClient }) => {
	const store = /** @type {any} */ (globalThis);
	/** @type {Map<string, MongoClient>} */
	const cache = (store[CLIENTS] ??= new Map());
	const key = `${sha256Hex(uri)}:${maxPoolSize}`;
	let client = cache.get(key);
	if (!client) {
		/** @type {import('mongodb').MongoClientOptions} */
		const options = { maxPoolSize, minPoolSize: 0, maxIdleTimeMS: 60_000, serverSelectionTimeoutMS: 5_000, appName };
		client = createClient ? createClient(uri, options) : new MongoClient(uri, options);
		cache.set(key, client);
	}
	return client;
};

/** Close and forget every cached client (tests, scripts). */
export const closeMongoClients = async () => {
	const store = /** @type {any} */ (globalThis);
	/** @type {Map<string, MongoClient> | undefined} */
	const cache = store[CLIENTS];
	if (!cache) return;
	const clients = [...cache.values()];
	cache.clear();
	await Promise.all(clients.map((client) => client.close()));
};

// ---------------------------------------------------------------------------------------------------------------
// Registry

/**
 * Validate and freeze a collection definition.
 * @param {CollectionDefinition} definition
 * @returns {Readonly<CollectionDefinition>}
 */
export const defineCollection = (definition) => {
	const { module, name, indexes = [], ttl, appendOnly = false, tenant, timestamps = true } = definition;
	if (typeof module !== 'string' || !MODULE.test(module)) throw new TypeError(`collection module is invalid: ${module}`);
	if (typeof name !== 'string' || !NAME.test(name) || name.length > 64 || !name.startsWith(`${module}_`)) {
		throw new TypeError(`collection name must be ${module}_<snake_case>: ${name}`);
	}
	if (tenant !== undefined && tenant !== 'merchant') throw new TypeError(`${name}: tenant must be 'merchant'`);
	for (const index of indexes) {
		if (!isObject(index.keys) || Object.keys(index.keys).length === 0) throw new TypeError(`${name}: index keys are required`);
	}
	if (ttl !== undefined && (typeof ttl.field !== 'string' || !Number.isInteger(ttl.afterSeconds) || ttl.afterSeconds < 0)) {
		throw new TypeError(`${name}: ttl needs a field and integer afterSeconds >= 0`);
	}
	const all = [...indexes];
	if (tenant === 'merchant' && !all.some((index) => Object.keys(index.keys)[0] === 'merchantId')) {
		all.unshift({ keys: { merchantId: 1, _id: 1 }, name: 'tenant' });
	}
	return Object.freeze({
		...definition,
		indexes: Object.freeze(all.map((index) => Object.freeze({ ...index }))),
		appendOnly,
		timestamps,
		...(ttl ? { ttl: Object.freeze({ ...ttl }) } : {}),
	});
};

/**
 * @param {ReadonlyArray<Readonly<CollectionDefinition>>} definitions
 */
export const createRegistry = (definitions) => {
	/** @type {Map<string, Readonly<CollectionDefinition>>} */
	const byName = new Map();
	for (const def of definitions) {
		const checked = defineCollection(def);
		if (byName.has(checked.name)) throw new TypeError(`collection ${checked.name} is declared twice`);
		byName.set(checked.name, checked);
	}
	return Object.freeze({
		/** @param {string} name */
		get: (name) => {
			const def = byName.get(name);
			if (!def) throw platformError('unknown_collection', `collection ${name} is not declared`);
			return def;
		},
		/** @param {string} name */
		has: (name) => byName.has(name),
		all: () => [...byName.values()],
		/** @param {string} module */
		ofModule: (module) => [...byName.values()].filter((def) => def.module === module),
	});
};
/** @typedef {ReturnType<typeof createRegistry>} Registry */

/**
 * @typedef {{ key: Record<string, any>, name: string, unique?: boolean, sparse?: boolean, partialFilterExpression?: Document, expireAfterSeconds?: number }} PlannedIndex
 */

/**
 * Index specs (including TTL) of a definition, with stable names.
 * @param {Readonly<CollectionDefinition>} def
 * @returns {PlannedIndex[]}
 */
export const indexSpecs = (def) => {
	/** @type {PlannedIndex[]} */
	const specs = (def.indexes ?? []).map((index) => ({
		key: index.keys,
		name:
			index.name ??
			Object.entries(index.keys)
				.map(([field, dir]) => `${field}_${dir}`)
				.join('_'),
		...(index.unique ? { unique: true } : {}),
		...(index.sparse ? { sparse: true } : {}),
		...(index.partialFilterExpression ? { partialFilterExpression: index.partialFilterExpression } : {}),
	}));
	if (def.ttl) specs.push({ key: { [def.ttl.field]: 1 }, name: 'ttl', expireAfterSeconds: def.ttl.afterSeconds });
	return specs;
};

/**
 * Create every declared index (idempotent). With `dryRun`, only reports what would be created. Collections are
 * processed `concurrency` at a time (default 8).
 * @param {Db} db
 * @param {Registry} registry
 * @param {{ dryRun?: boolean, logger?: Logger, concurrency?: number }} [options]
 * @returns {Promise<{ created: string[], existing: string[], undeclared: string[] }>}
 */
export const ensureIndexes = async (db, registry, { dryRun = false, logger, concurrency = 8 } = {}) => {
	/** @type {string[]} */
	const created = [];
	/** @type {string[]} */
	const existing = [];
	/** @type {string[]} */
	const undeclared = [];
	/** @param {Readonly<CollectionDefinition>} def */
	const ensureOne = async (def) => {
		const specs = indexSpecs(def);
		/** @type {Set<string>} */
		let present = new Set();
		try {
			present = new Set((await db.collection(def.name).listIndexes().toArray()).map((index) => String(index.name)));
		} catch (error) {
			if (/** @type {any} */ (error)?.codeName !== 'NamespaceNotFound') throw error;
		}
		const missing = specs.filter((spec) => !present.has(spec.name));
		if (!dryRun && missing.length > 0) await db.collection(def.name).createIndexes(/** @type {any} */ (missing));
		return { def, specs, present };
	};
	// collections are independent: create their indexes concurrently (bounded), report in registry order
	const defs = registry.all();
	/** @type {Array<{ def: Readonly<CollectionDefinition>, specs: PlannedIndex[], present: Set<string> }>} */
	const results = new Array(defs.length);
	let next = 0;
	const worker = async () => {
		while (next < defs.length) {
			const index = next;
			next += 1;
			results[index] = await ensureOne(/** @type {Readonly<CollectionDefinition>} */ (defs[index]));
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, defs.length)) }, worker));
	for (const { def, specs, present } of results) {
		for (const spec of specs) (present.has(spec.name) ? existing : created).push(`${def.name}.${spec.name}`);
		for (const name of present)
			if (name !== '_id_' && !specs.some((s) => s.name === name)) undeclared.push(`${def.name}.${name}`);
	}
	logger?.info('indexes ensured', { created: created.length, existing: existing.length, undeclared, dryRun });
	return { created, existing, undeclared };
};

// ---------------------------------------------------------------------------------------------------------------
// Guards

/**
 * @param {string} name
 * @param {string} message
 */
const guardError = (name, message) => platformError('tenant_guard', `${name}: ${message}`);

/**
 * @param {unknown} value
 * @param {string} merchantId
 */
const pins = (value, merchantId) =>
	value === merchantId || (isObject(value) && Object.keys(value).length === 1 && value.$eq === merchantId);

/**
 * Refuse `$where` at the top level of a filter (server-side JavaScript).
 * @param {unknown} filter
 * @param {string} name
 * @returns {Document}
 */
export const guardAnyFilter = (filter, name) => {
	if (!isObject(filter)) throw guardError(name, 'a filter object is required');
	if ('$where' in filter) throw guardError(name, '$where is not allowed');
	return filter;
};

/**
 * Throw unless the filter pins `merchantId` (top-level equality) and avoids `$where`.
 * @param {unknown} filter
 * @param {string} merchantId
 * @param {string} name
 * @returns {Document}
 */
export const guardMerchantFilter = (filter, merchantId, name) => {
	const f = guardAnyFilter(filter, name);
	if (!pins(f.merchantId, merchantId)) throw guardError(name, 'the filter must pin merchantId to the scoped merchant');
	return f;
};

/**
 * @param {unknown[]} pipeline
 * @param {string} name
 * @param {boolean} crossAllowed
 */
const checkStages = (pipeline, name, crossAllowed) => {
	for (const stage of pipeline) {
		if (!isObject(stage)) throw guardError(name, 'invalid pipeline stage');
		for (const [op, body] of Object.entries(stage)) {
			if (WRITE_STAGES.has(op)) throw guardError(name, `${op} is not allowed`);
			if (!crossAllowed && CROSS_STAGES.has(op)) throw guardError(name, `${op} is not allowed on merchant-scoped data`);
			if (op === '$facet' && isObject(body))
				for (const sub of Object.values(body)) if (Array.isArray(sub)) checkStages(sub, name, crossAllowed);
		}
	}
};

/**
 * Validate an aggregation pipeline. Merchant scopes need a first `$match` that pins `merchantId`.
 * @param {unknown} pipeline
 * @param {string | null} merchantId null = not merchant-scoped
 * @param {string} name
 * @returns {Document[]}
 */
export const guardPipeline = (pipeline, merchantId, name) => {
	if (!Array.isArray(pipeline) || pipeline.length === 0) throw guardError(name, 'a pipeline is required');
	if (merchantId !== null) {
		const first = pipeline[0];
		if (!isObject(first) || !isObject(first.$match)) throw guardError(name, 'the first stage must be $match with merchantId');
		guardMerchantFilter(first.$match, merchantId, name);
	}
	checkStages(pipeline, name, merchantId === null);
	return /** @type {Document[]} */ (pipeline);
};

/** @param {string} key */
const touchesMerchant = (key) => key === 'merchantId' || key.startsWith('merchantId.');

/**
 * Refuse updates that change `merchantId`; add `updatedAt` (and `createdAt` on upsert).
 * @param {unknown} update
 * @param {{ merchantId: string | null, at: Date | null, upsert: boolean, name: string }} options
 * @returns {Document | Document[]}
 */
export const guardUpdate = (update, { merchantId, at, upsert, name }) => {
	if (Array.isArray(update)) {
		for (const stage of update) {
			if (!isObject(stage)) throw guardError(name, 'invalid update stage');
			for (const [op, body] of Object.entries(stage)) {
				if (merchantId !== null && (op === '$replaceRoot' || op === '$replaceWith'))
					throw guardError(name, `${op} is not allowed`);
				const keys = op === '$unset' ? [body].flat() : isObject(body) ? Object.keys(body) : [];
				if (merchantId !== null && keys.some((key) => typeof key === 'string' && touchesMerchant(key))) {
					throw guardError(name, 'merchantId cannot be changed');
				}
			}
		}
		return at ? [...update, { $set: { updatedAt: at } }] : update;
	}
	if (!isObject(update) || Object.keys(update).length === 0) throw guardError(name, 'an update document is required');
	/** @type {Record<string, any>} */
	const out = {};
	for (const [op, body] of Object.entries(update)) {
		if (!op.startsWith('$')) throw guardError(name, 'use update operators (replacements go through replaceOne)');
		if (merchantId !== null && isObject(body) && Object.keys(body).some(touchesMerchant)) {
			throw guardError(name, 'merchantId cannot be changed');
		}
		out[op] = isObject(body) ? { ...body } : body;
	}
	if (at) {
		out.$set = { ...(out.$set ?? {}), updatedAt: at };
		if (upsert && !('createdAt' in (out.$set ?? {})) && !('createdAt' in (out.$setOnInsert ?? {}))) {
			out.$setOnInsert = { ...(out.$setOnInsert ?? {}), createdAt: at };
		}
	}
	return out;
};

// ---------------------------------------------------------------------------------------------------------------
// Repositories

/**
 * @typedef {object} ReadOps
 * @property {string} name
 * @property {(filter: Document, options?: import('mongodb').FindOptions) => Promise<Document | null>} findOne
 * @property {(filter: Document, options?: import('mongodb').FindOptions) => import('mongodb').FindCursor<Document>} find
 * @property {(filter: Document, options?: import('mongodb').CountDocumentsOptions) => Promise<number>} countDocuments
 * @property {(pipeline: Document[], options?: import('mongodb').AggregateOptions) => import('mongodb').AggregationCursor<Document>} aggregate
 * @property {(doc: Document, options?: import('mongodb').InsertOneOptions) => Promise<{ insertedId: unknown }>} insertOne
 * @property {(docs: Document[], options?: import('mongodb').BulkWriteOptions) => Promise<{ insertedCount: number }>} insertMany
 */

/**
 * @typedef {ReadOps & {
 *   updateOne: (filter: Document, update: Document | Document[], options?: import('mongodb').UpdateOptions) => Promise<import('mongodb').UpdateResult>,
 *   updateMany: (filter: Document, update: Document | Document[], options?: import('mongodb').UpdateOptions) => Promise<import('mongodb').UpdateResult>,
 *   findOneAndUpdate: (filter: Document, update: Document | Document[], options?: import('mongodb').FindOneAndUpdateOptions) => Promise<Document | null>,
 *   replaceOne: (filter: Document, doc: Document, options?: import('mongodb').ReplaceOptions) => Promise<import('mongodb').UpdateResult | Document>,
 *   deleteOne: (filter: Document, options?: import('mongodb').DeleteOptions) => Promise<import('mongodb').DeleteResult>,
 *   deleteMany: (filter: Document, options?: import('mongodb').DeleteOptions) => Promise<import('mongodb').DeleteResult>,
 * }} MutableOps
 */

/** @typedef {{ forMerchant: (merchantId: string) => ReadOps | MutableOps, acrossMerchants: () => ReadOps | MutableOps }} TenantRepository */

/**
 * Build guarded operations for one collection and one scope.
 * @param {import('mongodb').Collection} collection
 * @param {Readonly<CollectionDefinition>} def
 * @param {{ merchantId: string | null, now: () => number }} scope
 * @returns {ReadOps | MutableOps}
 */
const buildOps = (collection, def, { merchantId, now }) => {
	const { name } = def;
	const at = () => (def.timestamps ? new Date(now()) : null);
	/** @param {unknown} filter */
	const filterOf = (filter) =>
		merchantId === null ? guardAnyFilter(filter, name) : guardMerchantFilter(filter, merchantId, name);
	/** @param {unknown} doc */
	const stamp = (doc) => {
		if (!isObject(doc)) throw guardError(name, 'a document object is required');
		if (merchantId !== null && doc.merchantId !== undefined && doc.merchantId !== merchantId) {
			throw guardError(name, 'the document belongs to another merchant');
		}
		const time = at();
		return {
			...doc,
			...(merchantId === null ? {} : { merchantId }),
			...(time ? { createdAt: doc.createdAt ?? time, ...(def.appendOnly ? {} : { updatedAt: doc.updatedAt ?? time }) } : {}),
		};
	};

	/** @type {ReadOps} */
	const read = {
		name,
		findOne: (filter, options) => collection.findOne(filterOf(filter), options),
		find: (filter, options) => collection.find(filterOf(filter), options),
		countDocuments: (filter, options) => collection.countDocuments(filterOf(filter), options),
		aggregate: (pipeline, options) => collection.aggregate(guardPipeline(pipeline, merchantId, name), options),
		insertOne: async (doc, options) => {
			const result = await collection.insertOne(/** @type {any} */ (stamp(doc)), options);
			return { insertedId: result.insertedId };
		},
		insertMany: async (docs, options) => {
			if (!Array.isArray(docs) || docs.length === 0) throw guardError(name, 'documents are required');
			const result = await collection.insertMany(/** @type {any[]} */ (docs.map(stamp)), options);
			return { insertedCount: result.insertedCount };
		},
	};
	if (def.appendOnly) return Object.freeze(read);

	/**
	 * @param {Document | Document[]} update
	 * @param {{ upsert?: boolean } | undefined} options
	 */
	const updateOf = (update, options) => guardUpdate(update, { merchantId, at: at(), upsert: options?.upsert === true, name });
	/** @type {MutableOps} */
	const mutable = {
		...read,
		updateOne: (filter, update, options) => collection.updateOne(filterOf(filter), updateOf(update, options), options),
		updateMany: (filter, update, options) => collection.updateMany(filterOf(filter), updateOf(update, options), options),
		findOneAndUpdate: (filter, update, options = {}) =>
			collection.findOneAndUpdate(filterOf(filter), updateOf(update, options), { returnDocument: 'after', ...options }),
		replaceOne: (filter, doc, options) => {
			if (isObject(doc) && Object.keys(doc).some((key) => key.startsWith('$')))
				throw guardError(name, 'a replacement cannot use operators');
			const { createdAt, ...rest } = /** @type {Document} */ (doc);
			const time = at();
			const replacement = {
				...rest,
				...(merchantId === null ? {} : { merchantId }),
				...(createdAt === undefined ? {} : { createdAt }),
				...(time ? { updatedAt: time } : {}),
			};
			if (merchantId !== null && isObject(doc) && doc.merchantId !== undefined && doc.merchantId !== merchantId) {
				throw guardError(name, 'the document belongs to another merchant');
			}
			return collection.replaceOne(filterOf(filter), replacement, options);
		},
		deleteOne: (filter, options) => collection.deleteOne(filterOf(filter), options),
		deleteMany: (filter, options) => collection.deleteMany(filterOf(filter), options),
	};
	return Object.freeze(mutable);
};

/**
 * Repository factory over the registry. `repo(name)` returns the guarded operations of a declared collection
 * (`TenantRepository` for merchant-scoped ones). Undeclared collections cannot be reached.
 * @param {Db} db
 * @param {Registry} registry
 * @param {{ now?: () => number }} [options]
 */
export const createRepositories = (db, registry, { now = Date.now } = {}) => {
	/** @type {Map<string, unknown>} */
	const cache = new Map();
	/**
	 * @param {string} name
	 * @returns {ReadOps | MutableOps | TenantRepository}
	 */
	const repo = (name) => {
		const cached = cache.get(name);
		if (cached) return /** @type {any} */ (cached);
		const def = registry.get(name);
		const collection = db.collection(name);
		/** @type {ReadOps | MutableOps | TenantRepository} */
		const built =
			def.tenant === 'merchant'
				? Object.freeze({
						forMerchant: (/** @type {string} */ merchantId) => {
							if (typeof merchantId !== 'string' || merchantId.length === 0)
								throw guardError(name, 'merchantId is required');
							return buildOps(collection, def, { merchantId, now });
						},
						acrossMerchants: () => buildOps(collection, def, { merchantId: null, now }),
					})
				: buildOps(collection, def, { merchantId: null, now });
		cache.set(name, built);
		return built;
	};
	return Object.freeze({
		repo,
		/**
		 * Mutable operations of a non-tenant collection (throws for append-only or merchant-scoped ones).
		 * @param {string} name
		 * @returns {MutableOps}
		 */
		mutable: (name) => {
			const def = registry.get(name);
			if (def.appendOnly || def.tenant)
				throw platformError('wrong_repository', `${name} is ${def.appendOnly ? 'append-only' : 'merchant-scoped'}`);
			return /** @type {MutableOps} */ (repo(name));
		},
		/**
		 * Read + insert operations of an append-only collection.
		 * @param {string} name
		 * @returns {ReadOps}
		 */
		appendOnly: (name) => {
			const def = registry.get(name);
			if (!def.appendOnly || def.tenant)
				throw platformError('wrong_repository', `${name} is not a plain append-only collection`);
			return /** @type {ReadOps} */ (repo(name));
		},
		/**
		 * Tenant repository of a merchant-scoped collection.
		 * @param {string} name
		 * @returns {TenantRepository}
		 */
		tenant: (name) => {
			if (registry.get(name).tenant !== 'merchant') throw platformError('wrong_repository', `${name} is not merchant-scoped`);
			return /** @type {TenantRepository} */ (repo(name));
		},
	});
};
/** @typedef {ReturnType<typeof createRepositories>} Repositories */

// ---------------------------------------------------------------------------------------------------------------
// Locks

/**
 * Lease locks on a mutable collection (`_id` = lock name). An expired lock is taken over atomically.
 * @param {MutableOps} locks
 * @param {{ now?: () => number, randomBytes?: (n: number) => Uint8Array }} [options]
 */
export const createLocks = (locks, { now = Date.now, randomBytes = defaultRandomBytes } = {}) => {
	/**
	 * @param {string} name
	 * @param {{ ttlMs: number, owner?: string }} options
	 * @returns {Promise<{ token: string, release: () => Promise<void>, extend: (ms: number) => Promise<boolean> } | null>}
	 */
	const acquire = async (name, { ttlMs, owner = 'portal' }) => {
		const token = randomToken(randomBytes, 16);
		const expireAt = new Date(now() + ttlMs);
		try {
			await locks.insertOne({ _id: name, token, owner, expireAt });
		} catch (error) {
			if (!isDuplicateKey(error)) throw error;
			const taken = await locks.updateOne(
				{ _id: name, expireAt: { $lte: new Date(now()) } },
				{ $set: { token, owner, expireAt } },
			);
			if (taken.modifiedCount === 0) return null;
		}
		return Object.freeze({
			token,
			release: async () => {
				await locks.deleteOne({ _id: name, token });
			},
			extend: async (/** @type {number} */ ms) =>
				(await locks.updateOne({ _id: name, token }, { $set: { expireAt: new Date(now() + ms) } })).modifiedCount === 1,
		});
	};
	return Object.freeze({
		acquire,
		/**
		 * Run `fn` under the lock; returns `{ locked: true }` without running when the lock is held elsewhere.
		 * @template T
		 * @param {string} name
		 * @param {{ ttlMs: number, owner?: string }} options
		 * @param {() => Promise<T>} fn
		 * @returns {Promise<{ locked: true } | { locked: false, value: T }>}
		 */
		withLock: async (name, options, fn) => {
			const lock = await acquire(name, options);
			if (!lock) return { locked: true };
			try {
				return { locked: false, value: await fn() };
			} finally {
				await lock.release();
			}
		},
	});
};
/** @typedef {ReturnType<typeof createLocks>} Locks */

// ---------------------------------------------------------------------------------------------------------------
// Transactions

/**
 * @param {unknown} error
 * @param {string} label
 */
const hasLabel = (error, label) =>
	isObject(error) && typeof error.hasErrorLabel === 'function' && /** @type {any} */ (error).hasErrorLabel(label) === true;

/**
 * @typedef {<T>(fn: (session: import('mongodb').ClientSession) => Promise<T>) => Promise<T>} WithTransaction
 */

/**
 * Transaction runner over a client (needs a replica set). `fn` may run more than once (transient errors restart
 * the whole transaction), so it must only touch the database through the given session and keep side effects
 * (mail, events, HTTP) outside. A non-transient error aborts and propagates unchanged.
 * @param {Pick<MongoClient, 'startSession'>} client
 * @param {{ maxAttempts?: number, maxCommitAttempts?: number, timeoutMs?: number, clock?: () => number }} [options]
 * @returns {WithTransaction}
 */
export const createTransactionRunner = (
	client,
	{ maxAttempts = 5, maxCommitAttempts = 5, timeoutMs = 30_000, clock = Date.now } = {},
) => {
	return async (fn) => {
		const session = client.startSession();
		const until = clock() + timeoutMs;
		try {
			for (let attempt = 1; ; attempt += 1) {
				session.startTransaction({
					readConcern: { level: 'snapshot' },
					writeConcern: { w: 'majority' },
					readPreference: 'primary',
				});
				/** @type {any} */
				let value;
				try {
					value = await fn(session);
				} catch (error) {
					if (session.inTransaction()) await session.abortTransaction().catch(() => undefined);
					if (hasLabel(error, 'TransientTransactionError') && attempt < maxAttempts && clock() < until) continue;
					throw error;
				}
				for (let commit = 1; ; commit += 1) {
					try {
						await session.commitTransaction();
						return value;
					} catch (error) {
						if (hasLabel(error, 'UnknownTransactionCommitResult') && commit < maxCommitAttempts && clock() < until)
							continue;
						if (hasLabel(error, 'TransientTransactionError') && attempt < maxAttempts && clock() < until) break;
						throw error;
					}
				}
				// a transient commit failure: run the whole transaction again
			}
		} finally {
			await session.endSession();
		}
	};
};

// ---------------------------------------------------------------------------------------------------------------
// Migrations

/**
 * @typedef {object} MigrationContext
 * @property {Db} db raw database — migrations are reviewed code and the only raw access; they never update
 *   append-only collections
 * @property {Logger} logger
 */

/**
 * @typedef {object} Migration
 * @property {string} id `YYYYMMDDHHMM-<module>-<slug>`; migrations run in id order across modules
 * @property {string} [description]
 * @property {(ctx: MigrationContext) => Promise<void>} up must be safe to re-run if a crash interrupted it
 * @property {(ctx: MigrationContext) => Promise<string[]>} [plan] read-only description of the changes (dry run)
 */

const MIGRATION_ID = /^\d{12}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Validate and order migrations.
 * @param {ReadonlyArray<Migration>} migrations
 * @returns {Migration[]}
 */
export const orderMigrations = (migrations) => {
	const seen = new Set();
	for (const m of migrations) {
		if (typeof m.id !== 'string' || !MIGRATION_ID.test(m.id))
			throw new TypeError(`migration id must be YYYYMMDDHHMM-<module>-<slug>: ${m.id}`);
		if (seen.has(m.id)) throw new TypeError(`migration ${m.id} is declared twice`);
		if (typeof m.up !== 'function') throw new TypeError(`migration ${m.id} needs up()`);
		seen.add(m.id);
	}
	return [...migrations].sort((a, b) => (a.id < b.id ? -1 : 1));
};

/**
 * Apply pending migrations in order under the `migrations` lock, recording each in the append-only `applied`
 * collection. A failure stops the run (later migrations are not attempted; the failed one is not recorded).
 * `dryRun` takes no lock and writes nothing: it lists pending migrations with their `plan()`.
 * @param {{ db: Db, applied: ReadOps, locks: Locks, migrations: ReadonlyArray<Migration>, logger: Logger,
 *   now?: () => number, dryRun?: boolean, lockTtlMs?: number }} options
 * @returns {Promise<{ dryRun: boolean, applied: string[], pending: Array<{ id: string, description?: string, plan?: string[] }> }>}
 */
export const runMigrations = async ({
	db,
	applied,
	locks,
	migrations,
	logger,
	now = Date.now,
	dryRun = false,
	lockTtlMs = 15 * 60_000,
}) => {
	const ordered = orderMigrations(migrations);
	const ctx = { db, logger };
	/** @returns {Promise<Migration[]>} */
	const pendingNow = async () => {
		const done = new Set((await applied.find({}, { projection: { _id: 1 } }).toArray()).map((doc) => String(doc._id)));
		return ordered.filter((m) => !done.has(m.id));
	};
	if (dryRun) {
		const pending = [];
		for (const m of await pendingNow()) {
			pending.push({
				id: m.id,
				...(m.description ? { description: m.description } : {}),
				...(m.plan ? { plan: await m.plan(ctx) } : {}),
			});
		}
		return { dryRun: true, applied: [], pending };
	}
	const result = await locks.withLock('migrations', { ttlMs: lockTtlMs, owner: 'migrations' }, async () => {
		/** @type {string[]} */
		const ran = [];
		for (const m of await pendingNow()) {
			const started = now();
			logger.info('migration starting', { id: m.id });
			await m.up(ctx);
			await applied.insertOne({
				_id: m.id,
				description: m.description ?? null,
				appliedAt: new Date(now()),
				durationMs: now() - started,
			});
			logger.info('migration applied', { id: m.id, ms: now() - started });
			ran.push(m.id);
		}
		return ran;
	});
	if (result.locked) throw platformError('locked', 'another migration run holds the lock');
	return { dryRun: false, applied: result.value, pending: [] };
};
