import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MongoClient } from 'mongodb';

/** A fresh, empty folder for one test. */
export const tempDir = async () => mkdtemp(path.join(tmpdir(), 'ss-import-'));

/** @param {string} dir */
export const removeDir = (dir) => rm(dir, { recursive: true, force: true });

let databases = 0;

/** A fresh database on the shared test MongoDB (`TEST_MONGODB_URI`). */
export const freshDb = async () => {
	databases += 1;
	const name = `importer_${process.pid}_${databases}`;
	const client = await new MongoClient(/** @type {string} */ (process.env.TEST_MONGODB_URI)).connect();
	const url = new URL(/** @type {string} */ (process.env.TEST_MONGODB_URI));
	url.pathname = `/${name}`;
	return { client, db: client.db(name), uri: url.toString(), name };
};

/**
 * A product as `ss-import` sees it (PLAN 0.8.10 K1, K10), in memory: NDJSON upserts by key with a check (non-empty
 * `text` of at most 40 characters, for `notes`), dry runs, prune by key ranges (at most `pruneBatch` a call), finish,
 * status with verification totals, a count route, and the settings API (settings, Format and lists; the first write
 * answers 429 when `busyOnce`).
 * @param {{ token?: string, failOn?: string, keys?: Record<string, string[]>, totals?: Record<string, number>,
 *   pruneBatch?: number, busyOnce?: boolean }} [options] `failOn`: answer 500 to this collection; `keys`: the key fields
 *   of collections not found by `id`
 */
export const fakeProduct = ({
	token = 'server-token',
	failOn,
	keys = {},
	totals = {},
	pruneBatch = 1000,
	busyOnce = false,
} = {}) => {
	/** @type {Map<string, Map<string, Record<string, unknown>>>} */
	const stored = new Map();
	/** @type {Array<{ method: string, path: string, dryRun: boolean, records: number, body?: unknown }>} */
	const calls = [];
	let finished = 0;
	let busy = busyOnce;
	/** @type {Record<string, { on: boolean, schema: { properties: Record<string, unknown> }, values: Record<string, { value: unknown, source: string }> }>} */
	const features = {
		checkout: {
			on: true,
			schema: { properties: { channels: {}, guests: {} } },
			values: { channels: { value: ['email'], source: 'default' }, guests: { value: true, source: 'website' } },
		},
		alerts: { on: false, schema: { properties: { channels: {} } }, values: { channels: { value: [], source: 'default' } } },
	};
	/** @type {Record<string, unknown>} */
	const format = { currency: 'USD', locale: 'en' };
	/** @type {Record<string, string>} */
	const formatSources = { currency: 'default', locale: 'website' };
	/** @type {Record<string, unknown>} */
	const lists = { couriers: [] };
	/** @param {number} status @param {unknown} body @param {Record<string, string>} [headers] */
	const json = (status, body, headers = {}) =>
		new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
	/** @param {string} collection */
	const fieldsOf = (collection) => keys[collection] ?? ['id'];
	/** @param {string} collection @param {Record<string, unknown>} record */
	const textOf = (collection, record) =>
		fieldsOf(collection)
			.map((field) => String(record[field]))
			.join('\u001f');
	/** @param {string} collection @param {unknown} key */
	const keyText = (collection, key) =>
		typeof key === 'object' && key !== null ? textOf(collection, /** @type {Record<string, unknown>} */ (key)) : String(key);
	/** @type {typeof globalThis.fetch} */
	const fetch = async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (request.headers.get('authorization') !== `Bearer ${token}`) return json(401, { detail: 'The token is not valid.' });
		const write = request.method === 'PUT';
		if (write && busy) {
			busy = false;
			return json(429, { detail: 'Too many requests.' }, { 'retry-after': '2' });
		}
		if (request.method === 'GET' && url.pathname === '/v1/settings')
			return json(200, {
				features: Object.entries(features).map(([key, feature]) => ({
					key,
					on: feature.on,
					schema: feature.schema,
					values: feature.on ? feature.values : null,
				})),
			});
		const setting = /^\/v1\/settings\/([a-z_]+)\.([a-zA-Z]+)$/.exec(url.pathname);
		if (write && setting) {
			const [, feature = '', key = ''] = setting;
			const { value } = await request.json();
			if (value === 'bad') return json(422, { detail: 'The value is not valid.', errors: [{ message: 'is not a list' }] });
			const values = /** @type {any} */ (features[feature]).values;
			values[key] = { value, source: 'website' };
			calls.push({ method: 'PUT', path: url.pathname, dryRun: false, records: 0, body: value });
			return json(200, { key: `${feature}.${key}`, value, source: 'website' });
		}
		if (url.pathname === '/v1/format') {
			if (!write) return json(200, { format, sources: formatSources });
			const body = await request.json();
			Object.assign(format, body);
			for (const field of Object.keys(body)) formatSources[field] = 'website';
			calls.push({ method: 'PUT', path: url.pathname, dryRun: false, records: 0, body });
			return json(200, { format, sources: formatSources });
		}
		const list = /^\/v1\/lists\/([a-z_]+)$/.exec(url.pathname);
		if (list) {
			const name = String(list[1]);
			if (!Object.hasOwn(lists, name)) return json(404, { detail: 'No such list.' });
			if (!write) return json(200, { value: lists[name] });
			lists[name] = (await request.json()).value;
			calls.push({ method: 'PUT', path: url.pathname, dryRun: false, records: 0, body: lists[name] });
			return json(200, { value: lists[name] });
		}
		if (request.method === 'GET' && url.pathname === '/v1/import/status') {
			const counts = Object.fromEntries([...stored].map(([name, rows]) => [name, rows.size]));
			return json(200, { collections: counts, imported: counts, totals });
		}
		const count = /^\/v1\/([a-z_]+)\/count$/.exec(url.pathname);
		if (request.method === 'GET' && count) return json(200, { count: stored.get(String(count[1]))?.size ?? 0, capped: false });
		if (request.method === 'POST' && url.pathname === '/v1/import/finish') {
			finished += 1;
			return json(200, { finished: true, notes: stored.get('notes')?.size ?? 0 });
		}
		const prune = /^\/v1\/import\/([a-z_]+)\/prune$/.exec(url.pathname);
		if (request.method === 'POST' && prune) {
			const collection = String(prune[1]);
			const body = await request.json();
			const dryRun = url.searchParams.get('dryRun') === '1';
			calls.push({ method: 'POST', path: url.pathname, dryRun, records: body.keep.length, body });
			const keep = new Set(body.keep.map((/** @type {unknown} */ key) => keyText(collection, key)));
			const after = body.after === undefined ? null : keyText(collection, body.after);
			const through = body.through === undefined ? null : keyText(collection, body.through);
			const rows = stored.get(collection) ?? new Map();
			const stale = [...rows.keys()]
				.filter((key) => (after === null || key > after) && (through === null || key <= through) && !keep.has(key))
				.sort();
			const removing = dryRun ? stale : stale.slice(0, pruneBatch);
			if (!dryRun) for (const key of removing) rows.delete(key);
			return json(200, {
				removed: removing.length,
				keys: removing,
				more: !dryRun && stale.length > pruneBatch,
				dryRun,
			});
		}
		const match = /^\/v1\/import\/([a-z_]+)$/.exec(url.pathname);
		if (request.method !== 'POST' || !match) return json(404, { detail: 'No such resource.' });
		const collection = /** @type {string} */ (match[1]);
		if (collection === failOn) return json(500, {});
		if (request.headers.get('content-type') !== 'application/x-ndjson') return json(415, { detail: 'Send NDJSON.' });
		const dryRun = url.searchParams.get('dryRun') === '1';
		const lines = (await request.text()).split('\n').filter((line) => line !== '');
		calls.push({ method: 'POST', path: url.pathname, dryRun, records: lines.length });
		const rows = stored.get(collection) ?? new Map();
		let inserted = 0;
		let updated = 0;
		/** @type {Array<{ line: number, id: string | null, errors: Array<{ path: string, message: string }> }>} */
		const failed = [];
		for (const [index, text] of lines.entries()) {
			const record = JSON.parse(text);
			if (collection === 'notes' && (typeof record.text !== 'string' || record.text.length === 0 || record.text.length > 40)) {
				failed.push({
					line: index + 1,
					id: record.id ?? null,
					errors: [{ path: '/text', message: 'text is 1–40 characters' }],
				});
				continue;
			}
			const key = textOf(collection, record);
			if (rows.has(key)) updated += 1;
			else inserted += 1;
			if (!dryRun) rows.set(key, record);
		}
		if (!dryRun) stored.set(collection, rows);
		return json(200, { inserted, updated, failed, dryRun });
	};
	return { fetch, stored, calls, finished: () => finished, token, features, format, lists };
};
