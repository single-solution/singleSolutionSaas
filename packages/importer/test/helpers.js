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
 * A product's import routes as `ss-import` sees them (PLAN 0.8.10 K10), in memory: NDJSON upserts by id with a check
 * (non-empty `text`), dry runs, finish, status and a count route.
 * @param {{ token?: string, failOn?: string }} [options] `failOn`: answer 500 to this collection
 */
export const fakeProduct = ({ token = 'server-token', failOn } = {}) => {
	/** @type {Map<string, Map<string, Record<string, unknown>>>} */
	const stored = new Map();
	/** @type {Array<{ method: string, path: string, dryRun: boolean, records: number }>} */
	const calls = [];
	let finished = 0;
	/** @param {number} status @param {unknown} body */
	const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
	/** @type {typeof globalThis.fetch} */
	const fetch = async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (request.headers.get('authorization') !== `Bearer ${token}`) return json(401, { detail: 'The token is not valid.' });
		if (request.method === 'GET' && url.pathname === '/v1/import/status')
			return json(200, { collections: Object.fromEntries([...stored].map(([name, rows]) => [name, rows.size])) });
		if (request.method === 'GET' && url.pathname === '/v1/notes/count')
			return json(200, { count: stored.get('notes')?.size ?? 0, capped: false });
		if (request.method === 'POST' && url.pathname === '/v1/import/finish') {
			finished += 1;
			return json(200, { finished: true, notes: stored.get('notes')?.size ?? 0 });
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
			if (typeof record.text !== 'string' || record.text.length === 0 || record.text.length > 40) {
				failed.push({
					line: index + 1,
					id: record.id ?? null,
					errors: [{ path: '/text', message: 'text is 1–40 characters' }],
				});
				continue;
			}
			if (rows.has(record.id)) updated += 1;
			else inserted += 1;
			if (!dryRun) rows.set(record.id, record);
		}
		if (!dryRun) stored.set(collection, rows);
		return json(200, { inserted, updated, failed, dryRun });
	};
	return { fetch, stored, calls, finished: () => finished, token };
};
