/**
 * The ceilings on what the page script's events add to a website's day (SR-7-9): the browser token is public, so a
 * flood of made-up values must not fill the merchant's database. A metric holds at most MAX_DAY_KEYS distinct keys a
 * day (later new ones are counted under "(other)"), a website stores at most MAX_DAY_EVENTS raw events a day (later
 * events still count in the totals), and a page path must be one of the site's own relative paths.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fieldOf } from '../adapters/store.js';
import { MAX_DAY_EVENTS, MAX_DAY_KEYS } from '../core/events.js';
import { ALL, dailyRows, setup } from './helpers.js';

/** @type {Awaited<ReturnType<typeof setup>>} */
let env;
/** @type {import('mongodb').Db} */
let db;

const DAY_MS = 86_400_000;
/** @param {string} path */
const view = (path) => ({ type: 'page_view', path, visit: false });
const today = () => new Date(env.now()).toISOString().slice(0, 10);

beforeAll(async () => {
	env = await setup();
	await env.switchOn(ALL);
	await env.connectDatabase();
	db = await env.merchantDb();
	// the website's first use builds the indexes (once per instance)
	await env.collect([]);
});
afterAll(async () => {
	await env.close();
});

/**
 * A day's totals document as an earlier day's traffic left it.
 * @param {Record<string, Record<string, { c: number }>>} totals
 * @param {number} [rawEvents]
 */
const seed = async (totals, rawEvents) =>
	db.collection('ss_growth_totals').insertOne({
		websiteId: env.websiteId,
		merchantId: 'm',
		day: today(),
		part: 0,
		totals,
		...(rawEvents === undefined ? {} : { rawEvents }),
		createdAt: new Date(),
		updatedAt: new Date(),
	});

/** @param {string} prefix @param {number} count @param {string} [tail] */
const keys = (prefix, count, tail = '') =>
	Object.fromEntries(Array.from({ length: count }, (_, at) => [`_${prefix}${at}${tail}`, { c: 1 }]));

/** @param {string} metric */
const rowsOf = async (metric) => (await dailyRows(db)).filter((row) => row.day === today() && row.metric === metric);
const rawCount = () => db.collection('ss_growth_analytics_events').countDocuments({});
const caplogs = () => env.logs.filter((entry) => entry.message.startsWith('collect cap'));

describe('distinct keys of a metric per day (SR-7-9)', () => {
	it('counts new values under (other) once a metric holds its most, and keeps counting the values it has', async () => {
		env.advance(DAY_MS);
		await seed({ page_views: { _: { c: 1 } }, page: keys('/seed-', MAX_DAY_KEYS - 2) });
		const first = await env.collect([view('/seed-0'), ...[1, 2, 3, 4, 5].map((at) => view(`/new-${at}`))]);
		expect([first.status, (await first.json()).accepted]).toEqual([202, 6]);
		let page = await rowsOf('page');
		const count = (/** @type {string} */ key) => page.find((row) => row.key === key)?.count;
		expect([count('/seed-0'), count('/new-1'), count('/new-2'), count('/new-3'), count('(other)')]).toEqual([
			2,
			1,
			1,
			undefined,
			3,
		]);
		// the next batch: a value it has still counts, a new one goes under (other)
		await env.collect([view('/new-6'), view('/seed-1'), view('/new-1')]);
		page = await rowsOf('page');
		expect([count('/seed-1'), count('/new-1'), count('/new-6'), count('(other)')]).toEqual([2, 2, undefined, 4]);
		expect(page).toHaveLength(MAX_DAY_KEYS + 1);
		// the figures that have a single key are not touched
		expect((await rowsOf('page_views')).find((row) => row.key === '')?.count).toBe(10);
		// it is told once
		expect(caplogs()).toHaveLength(1);
		expect(caplogs()[0]).toMatchObject({
			level: 'warn',
			fields: { websiteId: env.websiteId, metric: 'page', max: MAX_DAY_KEYS },
		});
	});

	it('counts the product of a full shop metric under (other), the currency of a revenue row kept', async () => {
		env.advance(DAY_MS);
		await seed({
			item_purchase: keys('prd_', MAX_DAY_KEYS),
			item_revenue: keys('prd_', MAX_DAY_KEYS, '\nUSD'),
			item_name: keys('prd_', MAX_DAY_KEYS, '\nLamp'),
		});
		await env.collect([
			{
				type: 'purchase',
				path: '/thanks',
				currency: 'USD',
				value: 1000,
				items: [{ id: 'prd_fresh', quantity: 2, name: 'Fresh lamp', price: 500 }],
			},
		]);
		const only = (/** @type {Array<{ key: string }>} */ rows) =>
			rows.filter((row) => row.key.startsWith('(other)') || row.key.includes('fresh'));
		expect(only(await rowsOf('item_purchase'))).toMatchObject([{ key: '(other)', count: 1, sum: 2 }]);
		expect(only(await rowsOf('item_revenue'))).toMatchObject([{ key: '(other)\nUSD', count: 2, sum: 1000 }]);
		expect(only(await rowsOf('item_name'))).toMatchObject([{ key: '(other)\n(other)', count: 1 }]);
		// the shop figures that are not per product are counted as always
		expect(await rowsOf('revenue')).toMatchObject([{ key: 'USD', count: 1, sum: 1000 }]);
	});

	it('finds a key that holds dots, a dollar sign or a percent sign, and keeps counting it when the metric is full', async () => {
		env.advance(DAY_MS);
		const odd = '$1.00 shade 50%2e off';
		await seed({ search: { ...keys('term-', MAX_DAY_KEYS - 2), [fieldOf(odd)]: { c: 4 } } });
		await env.collect([
			{ type: 'search', path: '/s', term: odd, results: 3 },
			{ type: 'search', path: '/s', term: 'something else', results: 3 },
			{ type: 'search', path: '/s', term: 'and more', results: 3 },
		]);
		const search = await rowsOf('search');
		expect(search.find((row) => row.key === odd)?.count).toBe(5);
		expect(search.find((row) => row.key === 'something else')?.count).toBe(1);
		expect(search.find((row) => row.key === '(other)')?.count).toBe(1);
		expect(search).toHaveLength(MAX_DAY_KEYS + 1);
	});

	it('is exact near the ceiling: the last free keys are taken, the rest go under (other)', async () => {
		env.advance(DAY_MS);
		await seed({ page: keys('/seed-', MAX_DAY_KEYS - 30) });
		const fresh = (/** @type {string} */ prefix) => Array.from({ length: 20 }, (_, at) => view(`/${prefix}-${at}`));
		await env.collect(fresh('a'));
		const second = await env.operationsDuring(() => env.collect(fresh('b')));
		// the day's counts are read again, then the 20 values are looked up, then written
		expect(second.names).toEqual([
			'aggregate ss_growth_totals',
			'find ss_growth_totals',
			'insert ss_growth_analytics_events',
			'update ss_growth_totals',
		]);
		const page = await rowsOf('page');
		expect(page.filter((row) => row.key !== '(other)')).toHaveLength(MAX_DAY_KEYS);
		expect(page.find((row) => row.key === '(other)')?.count).toBe(10);
	});
});

describe('raw events per website per day (SR-7-9)', () => {
	it('stores no new raw rows once the day is full, and the totals keep counting', async () => {
		env.advance(DAY_MS);
		await seed({ page_views: { _: { c: 1 } }, page: { '_/p': { c: 1 } } }, MAX_DAY_EVENTS - 2);
		const before = await rawCount();
		const first = await env.collect([1, 2, 3, 4, 5].map(() => view('/p')));
		expect((await first.json()).accepted).toBe(5);
		expect(await rawCount()).toBe(before + 2);
		expect((await rowsOf('page')).find((row) => row.key === '/p')?.count).toBe(6);
		const second = await env.operationsDuring(() => env.collect([view('/p'), view('/p'), view('/p')]));
		expect(second.names).toEqual(['update ss_growth_totals']);
		expect(await rawCount()).toBe(before + 2);
		expect((await rowsOf('page')).find((row) => row.key === '/p')?.count).toBe(9);
		expect((await db.collection('ss_growth_totals').findOne({ day: today() }))?.rawEvents).toBe(MAX_DAY_EVENTS);
		expect(caplogs().filter((entry) => entry.message.includes('raw events'))).toHaveLength(1);
	});

	it('counts the raw events a day stores', async () => {
		env.advance(DAY_MS);
		await env.collect([view('/a'), view('/b'), view('/c')]);
		await env.collect([view('/a')]);
		expect((await db.collection('ss_growth_totals').findOne({ day: today() }))?.rawEvents).toBe(4);
	});
});

describe('page paths (SR-7-9)', () => {
	it('keeps the site’s own relative paths and refuses what is not one', async () => {
		env.advance(DAY_MS);
		const refused = ['/\\evil.example', '/a<script>', '/a"b', '/a`b', '/a{b}', '//evil.example', 'https://evil.example/x', 'x'];
		const answer = await env.collect([...refused.map(view), view('/lamps/x?id=1#top')]);
		expect([answer.status, (await answer.json()).accepted]).toEqual([202, 1]);
		expect((await rowsOf('page')).map((row) => row.key)).toEqual(['/lamps/x']);
	});
});

describe('database operations of the ceilings (RT-2)', () => {
	it('reads the day’s counts once per instance and day, and again after 15 seconds', async () => {
		env.advance(DAY_MS);
		const cold = await env.operationsDuring(() => env.collect([view('/a')]));
		expect(cold.names).toEqual(['aggregate ss_growth_totals', 'insert ss_growth_analytics_events', 'update ss_growth_totals']);
		const warm = await env.operationsDuring(() => env.collect([view('/b')]));
		expect(warm.names).toEqual(['insert ss_growth_analytics_events', 'update ss_growth_totals']);
		env.advance(16_000);
		const later = await env.operationsDuring(() => env.collect([view('/c')]));
		expect(later.names).toEqual(['aggregate ss_growth_totals', 'insert ss_growth_analytics_events', 'update ss_growth_totals']);
		env.advance(DAY_MS);
		const nextDay = await env.operationsDuring(() => env.collect([view('/a')]));
		expect(nextDay.total).toBe(3);
	});
});
