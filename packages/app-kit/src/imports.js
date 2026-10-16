/**
 * Import routes (PLAN 0.8.10 K10, Migration): a kit helper for each product's `import` feature. Checked, idempotent
 * bulk upserts with given ids and no side effects; the product's own record checks run in import mode.
 *
 * - `POST /v1/import/:collection?dryRun=1` takes NDJSON (`application/x-ndjson`, at most 1,000 records or 4 MB per
 *   call) of the product's own record shapes, checks each record, and writes it by the collection's key (default `id`;
 *   others such as `key`, `customerId`, `userId` or `day` + `part`, IMP-21): the checked record replaces the stored one
 *   (fields the source no longer has go, IMP-22; `createdAt` is kept when the record has none), so a re-run gives
 *   exactly the source again. The tenant is stamped. It answers `{ inserted, updated, failed: [{ line, id, errors }],
 *   dryRun }` (`id`: the record's key). It sends no message, event, alert or activity copy and holds no stock; each
 *   call (not a dry run) writes one activity entry (`import.<collection>`, values `{ inserted, updated, failed }`:
 *   codes and numbers for texts to put into words, A8), kept in the merchant database only.
 * - `POST /v1/import/:collection/prune?dryRun=1` takes `{ keep: [<key>, …], after?: <key>, through?: <key> }` (JSON, at
 *   most 1,000 keys): the records an import wrote whose key lies after `after` and up to `through` (open ends when left
 *   out) and is not kept are removed, at most 1,000 per call (`more: true`: call again). The importer sends the
 *   source's keys sorted ({@link compareKeyTexts}) and cut into calls, each range ending at its last key and the last
 *   one open, so records deleted in the source go too (the final pass, IMP-22). Only records written by an import are
 *   ever removed (the kit notes each key it writes in `ss_<product>_imports`): records the merchant made in the product
 *   itself, ready-made ones and live totals stay, and a wrong keep list can only take away what a re-import restores.
 *   A dry run answers what would go. Each real call writes one activity entry (`import.<collection>.prune`, values
 *   `{ removed, more }`).
 * - `POST /v1/import/finish` runs the product's `finish` (derived values) and answers `{ finished: true, …summary }`.
 *   A finish that works in bounded batches reads `ctx.query.after` and answers `more: true` with `next` while work is
 *   left; the importer calls again with `?after=<next>` until `more` is false.
 * - `GET /v1/import/status` → `{ collections: { <name>: <records> }, imported: { <name>: <records an import wrote> },
 *   totals: { <name>: <number> } }` (`totals`: the product's verification sums, for `ss-import verify`).
 *
 * The kit serves the four routes (server token, feature `import`, which the manifest must have) when the product passes
 * `imports`; the product describes them in its `schemas/api.json` (its collections, its finish and its totals), and
 * `ss app assets` documents them for every manifest with the `import` feature (`KIT_IMPORT_ROUTES`, `@ss/app-kit/api`).
 * @module
 */
import { IMPORT_LIMITS, isId } from '@ss/contracts';
import { isObject } from '@ss/contracts/util';
import { defineRoute } from './http/routes.js';
import { problem } from './http/results.js';
import { omit } from './util.js';

/** @typedef {{ path: string, message: string }} ImportError */
/**
 * @typedef {object} ImportCheckContext
 * @property {string} websiteId
 * @property {string | null} merchantId
 * @property {() => number} now
 * @property {boolean} dryRun
 * @property {import('./data.js').WebsiteData} data the website's merchant database (lookups; the kit writes)
 * @property {() => Promise<import('@ss/contracts').BusinessInfo>} business the website's business.json copy with its
 *   defaults (read once per call, on first use): its `country` gives national phone numbers their calling code
 * @property {unknown} prepared what the collection's `prepare` gave for this call (undefined without one)
 */
/**
 * One collection a product imports into.
 * @typedef {object} ImportCollection
 * @property {(record: Record<string, unknown>, ctx: ImportCheckContext) => ({ ok: true, value: Record<string, unknown> }
 *   | { ok: false, errors: ImportError[] }) | Promise<{ ok: true, value: Record<string, unknown> } | { ok: false, errors: ImportError[] }>} check
 *   the product's own check in import mode (past times, history, legacy hash formats and given numbers allowed); the
 *   value keeps the record's key
 * @property {string} [collection] the merchant database collection (unprefixed; default: the import name)
 * @property {ReadonlyArray<string>} [key] the top-level fields a record is found by (default `['id']`); each holds a
 *   string or a whole number
 * @property {(ctx: Omit<ImportCheckContext, 'prepared'>) => Promise<unknown>} [prepare] runs once per call before the
 *   checks (settings or lists every check needs)
 */
/**
 * @typedef {object} ImportOptions
 * @property {Record<string, ImportCollection>} collections
 * @property {(ctx: any) => Promise<Record<string, unknown>>} [finish] recomputes derived values after an import
 * @property {(ctx: any) => Promise<Record<string, number>>} [totals] verification sums (`GET /v1/import/status`)
 */

/** The feature of the import routes. */
export const IMPORT_FEATURE = 'import';
/** Room for the request around the largest NDJSON body (a body a little too large gets the clear 413 of the handler). */
const ENVELOPE = 64 * 1024;

/** Import collection names. */
const NAME = /^[a-z][a-z0-9_]{0,40}$/;
/** Key fields: top-level field names. */
const FIELD = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;
const NDJSON = /^application\/(x-)?ndjson(\s*;|$)/;
const JSON_TYPE = /^application\/json(\s*;|$)/;
/** Ledger of the keys imports wrote (`ss_<product>_imports`). */
const LEDGER = 'imports';
const LEDGER_INDEXES = Object.freeze([
	{ collection: LEDGER, keys: { websiteId: 1, name: 1, key: 1 }, name: 'kit_imports_key', unique: true },
]);
/** Joins the values of a key of several fields (no key value holds it). */
const SEPARATOR = '\u001f';
/** A key value: text without control characters, at most 200 characters. */
// eslint-disable-next-line no-control-regex
const KEY_TEXT = /^[^\u0000-\u001f]{1,200}$/;

/** @param {string} message @param {string} [path] @returns {ImportError[]} */
const errorOf = (message, path = '') => [{ path, message }];

/** Most values one activity entry keeps (the kit's activity log). */
const MAX_ENTRY_VALUES = 20;

/**
 * What a product's `finish` answered, as an activity entry's values (A8: codes, numbers and yes/no, never a sentence):
 * its numbers, yes/no and short texts, at most {@link MAX_ENTRY_VALUES}.
 * @param {Record<string, unknown>} summary
 * @returns {Record<string, string | number | boolean>}
 */
export const summaryValues = (summary) =>
	/** @type {Record<string, string | number | boolean>} */ (
		Object.fromEntries(
			Object.entries(summary)
				.filter(
					([, value]) =>
						(typeof value === 'number' && Number.isFinite(value)) ||
						typeof value === 'boolean' ||
						(typeof value === 'string' && value.length <= 200),
				)
				.slice(0, MAX_ENTRY_VALUES),
		)
	);

/**
 * The text of a key's values (the ledger's `key`): the value of a one-field key, else the values joined by U+001F.
 * The importer sorts the keys it keeps by this text, byte by byte ({@link compareKeyTexts}).
 * @param {ReadonlyArray<string | number>} values
 */
export const keyTextOf = (values) => values.map(String).join(SEPARATOR);

/**
 * Order of key texts as MongoDB compares strings (UTF-8 bytes), the order prune ranges follow.
 * @param {string} a
 * @param {string} b
 */
export const compareKeyTexts = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/**
 * The values of a record's key, or null when a field is missing or not a key value.
 * @param {unknown} record
 * @param {ReadonlyArray<string>} fields
 * @returns {Array<string | number> | null}
 */
const keyValuesOf = (record, fields) => {
	if (!isObject(record)) return null;
	/** @type {Array<string | number>} */
	const values = [];
	for (const field of fields) {
		const value = record[field];
		if (field === 'id' && fields.length === 1) {
			if (!isId(value)) return null;
		} else if (!(typeof value === 'string' && KEY_TEXT.test(value)) && !(Number.isSafeInteger(value) && Number(value) >= 0))
			return null;
		values.push(/** @type {string | number} */ (value));
	}
	return values;
};

/**
 * @param {{ options: ImportOptions | undefined, now: () => number,
 *   record: (ctx: any, entry: import('./activity.js').ActivityEntry, options?: { copy?: boolean }) => Promise<void>,
 *   business: (websiteId: string) => Promise<import('@ss/contracts').BusinessInfo> }} kit `business`: the kept
 *   business.json copy of a website, with defaults
 */
export const createImports = ({ options, now, record, business }) => {
	const collections = options?.collections ?? {};
	for (const [name, definition] of Object.entries(collections)) {
		if (!NAME.test(name)) throw new TypeError(`import collection names match ${NAME}: ${name}`);
		if (!isObject(definition) || typeof definition.check !== 'function')
			throw new TypeError(`import collection ${name} needs a check`);
		const key = definition.key ?? ['id'];
		if (!Array.isArray(key) || key.length === 0 || key.length > 4 || !key.every((field) => FIELD.test(field)))
			throw new TypeError(`import collection ${name}: key is 1–4 top-level field names`);
		if (definition.prepare !== undefined && typeof definition.prepare !== 'function')
			throw new TypeError(`import collection ${name}: prepare is a function`);
	}

	/** @param {any} ctx */
	const collectionNameOf = (ctx) => {
		const name = String(ctx.params.collection ?? '');
		if (!Object.hasOwn(collections, name))
			throw problem(
				'not_found',
				`Nothing is imported as ${name}. This product imports: ${Object.keys(collections).join(', ') || 'nothing'}.`,
			);
		return name;
	};

	/** @param {any} ctx */
	const actorOf = (ctx) => ctx.actor ?? { kind: 'server', id: 'server', name: 'Server' };
	/** @param {any} ctx */
	const dryRunOf = (ctx) => ctx.query.dryRun === '1' || ctx.query.dryRun === 'true';
	/** @param {ImportCollection} definition */
	const keyFieldsOf = (definition) => definition.key ?? ['id'];

	/**
	 * The filter of the records with these keys.
	 * @param {string} websiteId
	 * @param {ReadonlyArray<string>} fields
	 * @param {Array<Array<string | number>>} keys
	 */
	const keysFilter = (websiteId, fields, keys) =>
		fields.length === 1
			? { websiteId, [/** @type {string} */ (fields[0])]: { $in: keys.map((values) => values[0]) } }
			: { websiteId, $or: keys.map((values) => Object.fromEntries(fields.map((field, i) => [field, values[i]]))) };

	/**
	 * The merchant database with the ledger's index.
	 * @param {any} ctx
	 * @returns {Promise<import('./data.js').WebsiteData>}
	 */
	const dataOf = async (ctx) => {
		const data = await ctx.data();
		await data.ensureIndexes([...LEDGER_INDEXES]);
		return data;
	};

	/**
	 * `POST /v1/import/:collection?dryRun=1`.
	 * @param {any} ctx
	 */
	const upsert = async (ctx) => {
		const name = collectionNameOf(ctx);
		const definition = /** @type {ImportCollection} */ (collections[name]);
		const fields = keyFieldsOf(definition);
		const byId = fields.length === 1 && fields[0] === 'id';
		const dryRun = dryRunOf(ctx);
		const type = String(ctx.headers.get('content-type') ?? '').toLowerCase();
		if (!NDJSON.test(type)) return problem('unsupported_media_type', 'Send application/x-ndjson: one JSON record per line.');
		if (Buffer.byteLength(ctx.rawBody) > IMPORT_LIMITS.bytes)
			return problem('payload_too_large', `One call takes at most ${IMPORT_LIMITS.bytes} bytes.`);
		const lines = String(ctx.rawBody)
			.split('\n')
			.map((text, index) => ({ line: index + 1, text: text.trim() }))
			.filter(({ text }) => text !== '');
		if (lines.length > IMPORT_LIMITS.records)
			return problem('payload_too_large', `One call takes at most ${IMPORT_LIMITS.records} records.`);
		const data = await dataOf(ctx);
		const target = data.collection(definition.collection ?? name);
		/** @type {Promise<import('@ss/contracts').BusinessInfo> | null} */
		let info = null;
		const base = {
			websiteId: ctx.websiteId,
			merchantId: ctx.merchantId,
			now,
			dryRun,
			data,
			business: () => (info ??= business(ctx.websiteId)),
		};
		const checkContext = { ...base, prepared: definition.prepare ? await definition.prepare(base) : undefined };
		/** @type {Array<{ line: number, id: string | null, errors: ImportError[] }>} */
		const failed = [];
		/** @type {Array<{ line: number, id: string, text: string, values: Array<string | number>, value: Record<string, unknown> }>} */
		const accepted = [];
		const seen = new Set();
		for (const { line, text } of lines) {
			/** @type {unknown} */
			let parsed;
			try {
				parsed = JSON.parse(text);
			} catch {
				failed.push({ line, id: null, errors: errorOf('The line is not JSON.') });
				continue;
			}
			const values = keyValuesOf(parsed, fields);
			if (!isObject(parsed) || values === null) {
				failed.push({
					line,
					id: null,
					errors: byId
						? errorOf('Each record is an object with an id (<prefix>_<id>).', '/id')
						: errorOf(`Each record is an object with its key: ${fields.join(', ')}.`, `/${fields[0]}`),
				});
				continue;
			}
			const keyText = keyTextOf(values);
			const id = values.map(String).join('/');
			if (seen.has(keyText)) {
				failed.push({
					line,
					id,
					errors: errorOf(`The same ${byId ? 'id' : 'key'} appears twice in this call.`, `/${fields[0]}`),
				});
				continue;
			}
			seen.add(keyText);
			const checked = await definition.check(parsed, checkContext);
			if (!checked.ok)
				failed.push({ line, id, errors: checked.errors.length > 0 ? checked.errors : errorOf('The record is not valid.') });
			else if (keyTextOf(keyValuesOf(checked.value, fields) ?? []) !== keyText)
				failed.push({ line, id, errors: errorOf('The check changed the record’s key.', `/${fields[0]}`) });
			else accepted.push({ line, id, text: keyText, values, value: checked.value });
		}
		/** @type {Map<string, unknown>} key text → the stored record's createdAt */
		const existing = new Map(
			accepted.length === 0
				? []
				: (
						await target
							.find(
								keysFilter(
									ctx.websiteId,
									fields,
									accepted.map((item) => item.values),
								),
								{ projection: { _id: 0, createdAt: 1, ...Object.fromEntries(fields.map((field) => [field, 1])) } },
							)
							.toArray()
					).map((/** @type {Record<string, unknown>} */ doc) => [
						keyTextOf(fields.map((field) => /** @type {string | number} */ (doc[field]))),
						doc.createdAt,
					]),
		);
		let inserted = 0;
		let updated = 0;
		/** @type {Array<{ text: string, values: Array<string | number> }>} */
		const written = [];
		for (const { line, id, text, values, value } of accepted) {
			if (dryRun) {
				if (existing.has(text)) updated += 1;
				else inserted += 1;
				continue;
			}
			const match = Object.fromEntries(fields.map((field, i) => [field, values[i]]));
			const fieldsOfValue = omit(value, ['websiteId', 'merchantId', '_id', 'updatedAt']);
			const createdAt = fieldsOfValue.createdAt ?? existing.get(text);
			try {
				const result = await target.replaceOne(
					{ websiteId: ctx.websiteId, ...match },
					{ ...fieldsOfValue, ...match, ...(createdAt === undefined ? {} : { createdAt }) },
					{ upsert: true },
				);
				if (result.upsertedCount > 0) inserted += 1;
				else updated += 1;
				written.push({ text, values });
			} catch (error) {
				failed.push({
					line,
					id,
					errors: errorOf(
						error instanceof Error && /duplicate key/i.test(error.message)
							? 'A unique value is already taken.'
							: 'The record was not saved.',
					),
				});
			}
		}
		if (written.length > 0) {
			try {
				await data.collection(LEDGER).insertMany(
					written.map(({ text, values }) => ({
						name,
						key: text,
						match: Object.fromEntries(fields.map((field, i) => [field, values[i]])),
					})),
					{ ordered: false },
				);
			} catch (error) {
				// keys an earlier import already noted
				const errors = /** @type {{ writeErrors?: unknown }} */ (error).writeErrors;
				const list = /** @type {Array<{ code?: number }>} */ (Array.isArray(errors) ? errors : [errors]);
				if (!list.every((item) => item?.code === 11000)) throw error;
			}
		}
		failed.sort((a, b) => a.line - b.line);
		if (!dryRun)
			await record(
				ctx,
				{
					actor: actorOf(ctx),
					action: `import.${name}`,
					target: name,
					label: name,
					values: { inserted, updated, failed: failed.length },
				},
				{ copy: false },
			);
		return { inserted, updated, failed, dryRun };
	};

	/**
	 * `POST /v1/import/:collection/prune?dryRun=1`.
	 * @param {any} ctx
	 */
	const prune = async (ctx) => {
		const name = collectionNameOf(ctx);
		const definition = /** @type {ImportCollection} */ (collections[name]);
		const fields = keyFieldsOf(definition);
		const dryRun = dryRunOf(ctx);
		const type = String(ctx.headers.get('content-type') ?? '').toLowerCase();
		if (!JSON_TYPE.test(type)) return problem('unsupported_media_type', 'Send application/json: { keep, after, through }.');
		if (Buffer.byteLength(ctx.rawBody) > IMPORT_LIMITS.bytes)
			return problem('payload_too_large', `One call takes at most ${IMPORT_LIMITS.bytes} bytes.`);
		/** @type {unknown} */
		let body;
		try {
			body = JSON.parse(String(ctx.rawBody));
		} catch {
			body = null;
		}
		/** @param {unknown} key @returns {string | null} a one-field key is its value; a key of several fields an object */
		const textOf = (key) => {
			const values = keyValuesOf(
				fields.length === 1 && !isObject(key) ? { [/** @type {string} */ (fields[0])]: key } : key,
				fields,
			);
			return values === null ? null : keyTextOf(values);
		};
		const keep = isObject(body) && Array.isArray(body.keep) ? body.keep.map(textOf) : null;
		const after = isObject(body) && body.after !== undefined && body.after !== null ? textOf(body.after) : undefined;
		const through = isObject(body) && body.through !== undefined && body.through !== null ? textOf(body.through) : undefined;
		if (keep === null || keep.includes(null) || after === null || through === null) {
			const shape = fields.length === 1 ? `the ${fields[0]} of each record` : `{ ${fields.join(', ')} } of each record`;
			return problem('validation_failed', `Send { keep: [${shape}], after?, through? }.`, {
				errors: [{ path: '/keep', message: `holds ${shape}` }],
			});
		}
		if (keep.length > IMPORT_LIMITS.records)
			return problem('payload_too_large', `One call keeps at most ${IMPORT_LIMITS.records} keys.`);
		const data = await dataOf(ctx);
		const ledger = data.collection(LEDGER);
		/** @type {Record<string, unknown>} */
		const range = {
			...(after === undefined ? {} : { $gt: after }),
			...(through === undefined ? {} : { $lte: through }),
			$nin: keep,
		};
		const filter = { websiteId: ctx.websiteId, name, key: range };
		const stale = /** @type {Array<{ key: string, match: Record<string, string | number> }>} */ (
			await ledger
				.find(filter, { projection: { _id: 0, key: 1, match: 1 } })
				.sort({ key: 1 })
				.limit(IMPORT_LIMITS.records)
				.toArray()
		);
		const keys = stale.map((entry) => entry.key.split(SEPARATOR).join('/'));
		if (dryRun) return { removed: await ledger.countDocuments(filter), keys, more: false, dryRun };
		let removed = 0;
		if (stale.length > 0) {
			const result = await data.collection(definition.collection ?? name).deleteMany(
				keysFilter(
					ctx.websiteId,
					fields,
					stale.map((entry) => fields.map((field) => /** @type {string | number} */ (entry.match[field]))),
				),
			);
			removed = result.deletedCount ?? 0;
			await ledger.deleteMany({ websiteId: ctx.websiteId, name, key: { $in: stale.map((entry) => entry.key) } });
		}
		const more = stale.length === IMPORT_LIMITS.records && (await ledger.countDocuments(filter, { limit: 1 })) > 0;
		await record(
			ctx,
			{
				actor: actorOf(ctx),
				action: `import.${name}.prune`,
				target: name,
				label: name,
				values: { removed, more },
			},
			{ copy: false },
		);
		return { removed, keys, more, dryRun };
	};

	/**
	 * `POST /v1/import/finish`.
	 * @param {any} ctx
	 */
	const finish = async (ctx) => {
		const summary = options?.finish ? await options.finish(ctx) : {};
		await record(
			ctx,
			{ actor: actorOf(ctx), action: 'import.finish', target: 'import', label: 'import', values: summaryValues(summary) },
			{ copy: false },
		);
		return { finished: true, ...summary };
	};

	/**
	 * `GET /v1/import/status`.
	 * @param {any} ctx
	 */
	const status = async (ctx) => {
		const data = await dataOf(ctx);
		/** @type {Record<string, number>} */
		const counts = {};
		/** @type {Record<string, number>} */
		const imported = {};
		for (const [name, definition] of Object.entries(collections)) {
			counts[name] = await data.collection(definition.collection ?? name).countDocuments({ websiteId: ctx.websiteId });
			imported[name] = await data.collection(LEDGER).countDocuments({ websiteId: ctx.websiteId, name });
		}
		const totals = options?.totals ? await options.totals(ctx) : {};
		return { collections: counts, imported, totals };
	};

	/** The import routes (server token, feature `import`). */
	const routes = Object.freeze([
		defineRoute({
			method: 'POST',
			path: '/v1/import/:collection',
			auth: 'server',
			feature: IMPORT_FEATURE,
			rawBody: true,
			maxBodyBytes: IMPORT_LIMITS.bytes + ENVELOPE,
			handler: upsert,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/import/:collection/prune',
			auth: 'server',
			feature: IMPORT_FEATURE,
			rawBody: true,
			maxBodyBytes: IMPORT_LIMITS.bytes + ENVELOPE,
			handler: prune,
		}),
		defineRoute({ method: 'POST', path: '/v1/import/finish', auth: 'server', feature: IMPORT_FEATURE, handler: finish }),
		defineRoute({ method: 'GET', path: '/v1/import/status', auth: 'server', feature: IMPORT_FEATURE, handler: status }),
	]);

	return Object.freeze({
		names: Object.keys(collections),
		upsert,
		prune,
		finish,
		status,
		routes,
	});
};

/** @typedef {ReturnType<typeof createImports>} Imports */
