/**
 * Import routes (PLAN 0.8.10 K10, Migration): a kit helper for each product's `import` feature. Checked, idempotent
 * bulk upserts with given ids and no side effects; the product's own record checks run in import mode.
 *
 * - `POST /v1/import/:collection?dryRun=1` takes NDJSON (`application/x-ndjson`, at most 1,000 records or 4 MB per
 *   call) of the product's own record shapes with given ids, upserts by id (re-runnable), checks each record, stamps
 *   the tenant and answers `{ inserted, updated, failed: [{ line, id, errors }], dryRun }`. It sends no message,
 *   event, alert or activity copy and holds no stock; each call (not a dry run) writes one activity entry
 *   (`import.<collection>` with the counts), kept in the merchant database only.
 * - `POST /v1/import/finish` runs the product's `finish` (derived values) and answers its summary.
 * - `GET /v1/import/status` → `{ collections: { <name>: <records> } }`.
 *
 * The product writes the routes as literal `defineRoute` calls with its `import` feature and the server token, with
 * the handlers `product.imports` gives:
 *
 *   defineRoute({ method: 'POST', path: '/v1/import/:collection', auth: 'server', feature: 'import', rawBody: true,
 *     maxBodyBytes: IMPORT_LIMITS.bytes, handler: product.imports.upsert })
 * @module
 */
import { IMPORT_LIMITS, isId } from '@ss/contracts';
import { problem } from './http/results.js';
import { isObject, omit } from './util.js';

/** @typedef {{ path: string, message: string }} ImportError */
/**
 * @typedef {object} ImportCheckContext
 * @property {string} websiteId
 * @property {string | null} merchantId
 * @property {() => number} now
 */
/**
 * One collection a product imports into.
 * @typedef {object} ImportCollection
 * @property {(record: Record<string, unknown>, ctx: ImportCheckContext) => ({ ok: true, value: Record<string, unknown> }
 *   | { ok: false, errors: ImportError[] }) | Promise<{ ok: true, value: Record<string, unknown> } | { ok: false, errors: ImportError[] }>} check
 *   the product's own check in import mode (past times, history, legacy hash formats and given numbers allowed); the
 *   value keeps the record's `id`
 * @property {string} [collection] the merchant database collection (unprefixed; default: the import name)
 */
/**
 * @typedef {object} ImportOptions
 * @property {Record<string, ImportCollection>} collections
 * @property {(ctx: any) => Promise<Record<string, unknown>>} [finish] recomputes derived values after an import
 */

/** Import collection names. */
const NAME = /^[a-z][a-z0-9_]{0,40}$/;
const NDJSON = /^application\/(x-)?ndjson(\s*;|$)/;

/** @param {string} message @param {string} [path] @returns {ImportError[]} */
const errorOf = (message, path = '') => [{ path, message }];

/**
 * @param {{ options: ImportOptions | undefined, now: () => number,
 *   record: (ctx: any, entry: import('./activity.js').ActivityEntry, options?: { copy?: boolean }) => Promise<void> }} kit
 */
export const createImports = ({ options, now, record }) => {
	const collections = options?.collections ?? {};
	for (const [name, definition] of Object.entries(collections)) {
		if (!NAME.test(name)) throw new TypeError(`import collection names match ${NAME}: ${name}`);
		if (!isObject(definition) || typeof definition.check !== 'function')
			throw new TypeError(`import collection ${name} needs a check`);
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

	/**
	 * `POST /v1/import/:collection?dryRun=1`.
	 * @param {any} ctx
	 */
	const upsert = async (ctx) => {
		const name = collectionNameOf(ctx);
		const definition = /** @type {ImportCollection} */ (collections[name]);
		const dryRun = ctx.query.dryRun === '1' || ctx.query.dryRun === 'true';
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
		const data = await ctx.data();
		const target = data.collection(definition.collection ?? name);
		const checkContext = { websiteId: ctx.websiteId, merchantId: ctx.merchantId, now };
		/** @type {Array<{ line: number, id: string | null, errors: ImportError[] }>} */
		const failed = [];
		/** @type {Array<{ line: number, id: string, value: Record<string, unknown> }>} */
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
			const id = isObject(parsed) && isId(parsed.id) ? parsed.id : null;
			if (!isObject(parsed) || id === null) {
				failed.push({ line, id: null, errors: errorOf('Each record is an object with an id (<prefix>_<id>).', '/id') });
				continue;
			}
			if (seen.has(id)) {
				failed.push({ line, id, errors: errorOf('The same id appears twice in this call.', '/id') });
				continue;
			}
			seen.add(id);
			const checked = await definition.check(parsed, checkContext);
			if (!checked.ok)
				failed.push({ line, id, errors: checked.errors.length > 0 ? checked.errors : errorOf('The record is not valid.') });
			else accepted.push({ line, id, value: checked.value });
		}
		const ids = accepted.map((item) => item.id);
		const existing = new Set(
			ids.length === 0
				? []
				: (
						await target.find({ websiteId: ctx.websiteId, id: { $in: ids } }, { projection: { _id: 0, id: 1 } }).toArray()
					).map((/** @type {Record<string, unknown>} */ doc) => String(doc.id)),
		);
		let inserted = 0;
		let updated = 0;
		for (const { line, id, value } of accepted) {
			if (dryRun) {
				if (existing.has(id)) updated += 1;
				else inserted += 1;
				continue;
			}
			const fields = omit(value, ['websiteId', 'merchantId', '_id']);
			try {
				const result = await target.updateOne(
					{ websiteId: ctx.websiteId, id },
					{
						$set: { ...fields, id, ...(ctx.merchantId ? { merchantId: ctx.merchantId } : {}) },
						...('createdAt' in fields ? {} : { $setOnInsert: { createdAt: new Date(now()) } }),
					},
					{ upsert: true },
				);
				if (result.upsertedCount > 0) inserted += 1;
				else updated += 1;
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
		failed.sort((a, b) => a.line - b.line);
		if (!dryRun)
			await record(
				ctx,
				{
					actor: actorOf(ctx),
					action: `import.${name}`,
					target: name,
					label: name,
					detail: `${inserted} inserted, ${updated} updated, ${failed.length} failed`,
				},
				{ copy: false },
			);
		return { inserted, updated, failed, dryRun };
	};

	/**
	 * `POST /v1/import/finish`.
	 * @param {any} ctx
	 */
	const finish = async (ctx) => {
		const summary = options?.finish ? await options.finish(ctx) : {};
		await record(
			ctx,
			{ actor: actorOf(ctx), action: 'import.finish', target: 'import', label: 'import', detail: JSON.stringify(summary) },
			{ copy: false },
		);
		return { finished: true, ...summary };
	};

	/**
	 * `GET /v1/import/status`.
	 * @param {any} ctx
	 */
	const status = async (ctx) => {
		const data = await ctx.data();
		/** @type {Record<string, number>} */
		const counts = {};
		for (const [name, definition] of Object.entries(collections))
			counts[name] = await data.collection(definition.collection ?? name).countDocuments({ websiteId: ctx.websiteId });
		return { collections: counts };
	};

	return Object.freeze({ names: Object.keys(collections), upsert, finish, status });
};

/** @typedef {ReturnType<typeof createImports>} Imports */
