/**
 * Moving another system's analytics into Growth (PLAN 0.8.10 K10, Migration step 8, G8): the `import` feature's
 * routes for the merchant's server take days of daily totals in their readable form, check every metric, key and
 * value, write each day as its document of `ss_growth_totals` (keys escaped), replace a re-imported day (live totals of
 * that day included), prune what the source no longer has, answer the sums `ss-import verify` compares, and the
 * existing report reads the imported days.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { checkDay, isDay } from '../core/imports.js';
import { createRoutes } from '../server/routes.js';
import { ALL, BASE, checkAnswer, dailyRows, setup } from './helpers.js';

/** @type {Array<Awaited<ReturnType<typeof setup>>>} */
const systems = [];
afterAll(async () => {
	for (const sys of systems) await sys.close();
});

/** @param {string[]} [on] */
const start = async (on = ALL) => {
	const sys = await setup();
	systems.push(sys);
	await sys.switchOn(on);
	await sys.connectDatabase();
	const handler = sys.product.handler(createRoutes(sys.product));
	/** @param {string} method @param {string} path @param {string} [body] @param {string} [type] */
	const raw = async (method, path, body, type) => {
		const response = await handler(
			new Request(`${BASE}${path}`, {
				method,
				headers: { authorization: `Bearer ${sys.server}`, ...(type ? { 'content-type': type } : {}) },
				...(body === undefined ? {} : { body }),
			}),
		);
		await checkAnswer(method, path, response);
		const text = await response.text();
		return { status: response.status, json: text ? JSON.parse(text) : null };
	};
	return {
		...sys,
		/** @param {unknown[]} records @param {{ dryRun?: boolean }} [options] */
		send: (records, { dryRun = false } = {}) =>
			raw(
				'POST',
				`/v1/import/totals${dryRun ? '?dryRun=1' : ''}`,
				`${records.map((r) => JSON.stringify(r)).join('\n')}\n`,
				'application/x-ndjson',
			),
		/** @param {unknown} body */
		prune: (body) => raw('POST', '/v1/import/totals/prune', JSON.stringify(body), 'application/json'),
		finish: () => raw('POST', '/v1/import/finish'),
		status: () => raw('GET', '/v1/import/status'),
		/** @param {string} from @param {string} to */
		report: async (from, to) =>
			/** @type {any} */ (await (await sys.call('GET', `/v1/analytics?from=${from}&to=${to}`, { token: sys.server })).json()),
	};
};

/** A day as the importer rebuilds it from another system's analytics. @param {string} day @param {number} visits */
const dayOf = (day, visits) => ({
	day,
	part: 0,
	totals: {
		visits: { '': { c: visits } },
		page_views: { '': { c: visits * 3 } },
		page: { '/phones': { c: visits * 2 }, '/phones/a.b$c': { c: visits } },
		source: { '(direct)': { c: visits - 1 }, 'www.google.com': { c: 1 } },
		device: { mobile: { c: visits } },
		country: { PK: { c: visits } },
		funnel: { purchase: { c: 2 } },
		revenue: { PKR: { c: 2, s: 250_000 } },
		vital: { 'LCP:good': { c: 1 } },
		vital_value: { LCP: { c: 1, s: 1800 } },
		search: { case: { c: 1, s: 0 } },
	},
});

describe('import of daily totals (K10, G8)', () => {
	it('checks every metric, key and value; a dry run writes nothing', async () => {
		const sys = await start();
		const dry = await sys.send(
			[
				dayOf('2024-03-01', 5),
				{ day: '2024-02-30', part: 1, totals: [], websiteId: 'web_x', note: 'x' },
				{
					day: '2024-03-02',
					part: 0,
					totals: {
						visits: { home: { c: 1 } },
						page_views: [],
						clicks: { '': { c: 1 } },
						device: { phone: { c: 1 } },
						page: { '/a': { c: -1 }, '/b': { c: 1, s: 5 }, '/c': 7, '/d': { c: 1, x: 1 } },
						revenue: { PKR: { c: 1, s: 'many' } },
						vital_page: { '/a\nLCP': { c: 1, s: 900 }, '/a\nXYZ': { c: 1 } },
						not_found_from: { '/gone\nwww.example.com': { c: 1 }, '/gone\n': { c: 1 } },
					},
				},
			],
			{ dryRun: true },
		);
		expect(dry.status).toBe(200);
		expect(dry.json).toMatchObject({ inserted: 1, updated: 0, dryRun: true });
		expect(dry.json.failed).toEqual([
			{
				line: 2,
				id: '2024-02-30/1',
				errors: [
					{ path: '/websiteId', message: 'websiteId is never taken from a record: the import stamps the website.' },
					{ path: '/note', message: 'Unknown field note.' },
					{ path: '/day', message: 'A day: YYYY-MM-DD (in the business time zone).' },
					{ path: '/part', message: 'part is 0: an imported day is one document.' },
					{ path: '/totals', message: 'The totals: { <metric>: { <key>: { c, s } } }.' },
				],
			},
			{
				line: 3,
				id: '2024-03-02/0',
				errors: [
					{ path: '/totals/visits/home', message: 'A key of visits is only the empty key "".' },
					{ path: '/totals/page_views', message: 'The keys of the metric: { <key>: { c, s } }.' },
					{ path: '/totals/clicks', message: expect.stringMatching(/^Unknown metric clicks: one of visits, /) },
					{ path: '/totals/device/phone', message: 'A key of device is mobile, tablet, desktop.' },
					{ path: '/totals/page/~1a/c', message: 'The count: a whole number of 0 or more.' },
					{ path: '/totals/page/~1b/s', message: 'page keeps no sum.' },
					{ path: '/totals/page/~1c', message: 'A total: { c, s }.' },
					{ path: '/totals/page/~1d/x', message: 'Unknown field x.' },
					{ path: '/totals/revenue/PKR/s', message: 'The sum: a finite number.' },
					{ path: '/totals/vital_page/~1a\nXYZ', message: 'A key of vital_page is <path>\\n<vital>.' },
					{ path: '/totals/not_found_from/~1gone\n', message: 'A key of not_found_from is <path>\\n<where from>.' },
				],
			},
		]);
		expect((await sys.status()).json).toEqual({
			collections: { totals: 0 },
			imported: { totals: 0 },
			totals: { days: 0, visits: 0, page_views: 0 },
		});
	});

	it('writes each day as its document, the report reads it, a re-run replaces the day and prune removes it', async () => {
		const sys = await start();
		// a day Growth counted live before the import (today, 2026-10-01 in UTC)
		await sys.collect([{ type: 'page_view', path: '/live', visit: true, device: 'desktop' }]);
		const first = await sys.send([dayOf('2024-03-01', 5), dayOf('2024-03-02', 7), dayOf('2026-10-01', 2)]);
		expect(first.json).toEqual({ inserted: 2, updated: 1, failed: [], dryRun: false });
		const db = await sys.merchantDb();
		const stored = await db.collection('ss_growth_totals').findOne({ day: '2024-03-01' }, { projection: { _id: 0 } });
		expect(stored).toMatchObject({ websiteId: sys.websiteId, day: '2024-03-01', part: 0 });
		// keys escaped as the live writes escape them, no sum while it is 0
		expect(stored?.totals.page).toEqual({ '_/phones': { c: 10 }, '_/phones/a%2Eb%24c': { c: 5 } });
		expect(stored?.totals.visits).toEqual({ _: { c: 5 } });
		expect(stored?.totals.search).toEqual({ _case: { c: 1 } });
		// the live totals of the re-imported day are replaced
		expect((await dailyRows(db)).filter((row) => row.day === '2026-10-01' && row.metric === 'page')).toEqual([
			expect.objectContaining({ key: '/phones', count: 4 }),
			expect.objectContaining({ key: '/phones/a.b$c', count: 2 }),
		]);

		const report = await sys.report('2024-03-01', '2024-03-02');
		expect(report.totals).toEqual({ visits: 12, pageViews: 36 });
		expect(report.days).toEqual([
			{ day: '2024-03-01', visits: 5, pageViews: 15 },
			{ day: '2024-03-02', visits: 7, pageViews: 21 },
		]);
		expect(report.pages).toEqual([
			{ key: '/phones', count: 24 },
			{ key: '/phones/a.b$c', count: 12 },
		]);
		expect(report.funnel.revenue).toEqual([{ currency: 'PKR', value: 500_000, orders: 4 }]);
		expect(report.vitals.find((/** @type {any} */ v) => v.name === 'LCP')).toMatchObject({ count: 2, average: 1800, good: 2 });

		// a re-run replaces the day
		const again = await sys.send([dayOf('2024-03-01', 9)]);
		expect(again.json).toEqual({ inserted: 0, updated: 1, failed: [], dryRun: false });
		expect((await sys.report('2024-03-01', '2024-03-01')).totals).toEqual({ visits: 9, pageViews: 27 });
		expect((await sys.finish()).json).toEqual({ finished: true });
		expect((await sys.status()).json).toEqual({
			collections: { totals: 3 },
			imported: { totals: 3 },
			totals: { days: 3, visits: 18, page_views: 54 },
		});

		// the source no longer has 2024-03-02: prune removes it (only days an import wrote are ever removed)
		const pruned = await sys.prune({
			keep: [
				{ day: '2024-03-01', part: 0 },
				{ day: '2026-10-01', part: 0 },
			],
		});
		expect(pruned.json).toEqual({ removed: 1, keys: ['2024-03-02/0'], more: false, dryRun: false });
		expect((await sys.status()).json.totals).toEqual({ days: 2, visits: 11, page_views: 33 });
	});

	it('the routes need the import feature', async () => {
		const sys = await start(ALL.filter((key) => key !== 'import'));
		const sent = await sys.send([dayOf('2024-03-01', 1)]);
		expect(sent.status).toBe(403);
		expect(sent.json.type).toMatch(/feature_off$/);
		expect((await sys.status()).status).toBe(403);
	});
});

describe('the day check (pure)', () => {
	it('takes real days only and keeps sums only where they are not 0', () => {
		expect(isDay('2024-02-29')).toBe(true);
		expect(isDay('2023-02-29')).toBe(false);
		expect(isDay('2024-2-1')).toBe(false);
		expect(isDay(20240201)).toBe(false);
		expect(
			checkDay({
				day: '2024-02-29',
				part: 0,
				totals: { duration: { '': { c: 3, s: 0 } }, not_found_from: { '/gone\n(direct)': { c: 1 } } },
			}),
		).toEqual({
			ok: true,
			value: {
				day: '2024-02-29',
				part: 0,
				totals: { duration: { '': { c: 3 } }, not_found_from: { '/gone\n(direct)': { c: 1 } } },
			},
		});
		expect(checkDay({ day: '2024-02-29', part: 0, totals: { toString: {} } })).toMatchObject({
			ok: false,
			errors: [{ path: '/totals/toString' }],
		});
	});
});
