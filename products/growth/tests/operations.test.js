/**
 * Merchant database operations per page view (RT-2): MongoDB Atlas's free tier allows about 100 operations a second
 * for the whole cluster, so each batch the page script sends costs one insert of its raw events and one update of the
 * day's totals, whatever it holds; the analytics report reads a day's parts as one.
 */
import { BSON } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL, dailyRows, setup } from './helpers.js';

/** @type {Awaited<ReturnType<typeof setup>>} */
let env;

const HERE = { 'x-vercel-ip-country': 'GB', 'x-vercel-ip-city': 'London' };
const VISITOR = { session: 'sessionaaaaaaaaaaaaaaaaaaaaaaaaa', browser: 'chrome', os: 'android' };

beforeAll(async () => {
	env = await setup();
	await env.switchOn(ALL);
	await env.connectDatabase();
	await env.setting('visitor_analytics', 'detail', 'sessions');
	// the website's first use builds the indexes (once per instance)
	await env.collect([]);
});
afterAll(async () => {
	await env.close();
});

describe('database operations per page view (RT-2)', () => {
	it('a landing page view with every detail costs one insert and one update', async () => {
		const ops = await env.operationsDuring(() =>
			env.collect(
				[
					{
						type: 'page_view',
						path: '/lamps',
						visit: true,
						device: 'mobile',
						referrer: 'www.google.com',
						page: 1,
						...VISITOR,
					},
				],
				HERE,
			),
		);
		expect(ops.names).toEqual(['insert ss_growth_events', 'update ss_growth_totals']);
		expect(ops.total).toBe(2);
	});

	it('so does the next page with a shop event and a search, and the page’s five Web Vitals', async () => {
		const next = await env.operationsDuring(() =>
			env.collect(
				[
					{ type: 'page_view', path: '/lamps/x', visit: false, page: 2, gap: 20_000, ...VISITOR },
					{ type: 'view_item', path: '/lamps/x', items: [{ id: 'prd_1', quantity: 1 }], ...VISITOR },
					{ type: 'search', path: '/lamps/x', term: 'shade', results: 0, ...VISITOR },
				],
				HERE,
			),
		);
		expect(next.total).toBe(2);
		const vitals = await env.operationsDuring(() =>
			env.collect(
				['LCP', 'INP', 'CLS', 'FCP', 'TTFB'].map((name) => ({
					type: 'vital',
					path: '/lamps',
					name,
					value: 300,
					...VISITOR,
				})),
				HERE,
			),
		);
		expect(vitals.total).toBe(2);
	});
});

describe('the day’s totals (RT-2)', () => {
	it('keeps any key, whatever its characters, and reads it back', async () => {
		env.advance(86_400_000);
		await env.collect([
			{ type: 'page_view', path: '/p/shade.v2.html', visit: false },
			{ type: 'search', path: '/s', term: '$100 shade 50%2E off', results: 2 },
		]);
		const db = await env.merchantDb();
		const rows = await dailyRows(db);
		expect(rows).toContainEqual(expect.objectContaining({ day: '2026-10-02', metric: 'page', key: '/p/shade.v2.html' }));
		expect(rows).toContainEqual(expect.objectContaining({ metric: 'search', key: '$100 shade 50%2e off', count: 1 }));
		const report = await (await env.call('GET', '/v1/analytics?from=2026-10-02&to=2026-10-02', { token: env.server })).json();
		expect(report.pages).toEqual([{ key: '/p/shade.v2.html', count: 1 }]);
		expect(report.searches).toEqual([{ key: '$100 shade 50%2e off', count: 1 }]);
		expect(report.days).toEqual([{ day: '2026-10-02', visits: 0, pageViews: 1 }]);
	});

	it('goes on in a next part when the day’s document is full, and reads the parts as one day', async () => {
		env.advance(86_400_000);
		const db = await env.merchantDb();
		const full = {
			websiteId: env.websiteId,
			merchantId: 'm',
			day: '2026-10-03',
			part: 0,
			totals: { page_views: { _: { c: 5 } }, visits: { _: { c: 2 } }, page: { '_/a': { c: 5 } } },
			createdAt: new Date(),
			updatedAt: new Date(),
		};
		const room = 16 * 1024 * 1024 - BSON.calculateObjectSize(full) - 10 - 40;
		await db.collection('ss_growth_totals').insertOne({ ...full, pad: 'x'.repeat(room) });
		const ops = await env.operationsDuring(() =>
			env.collect([{ type: 'page_view', path: `/${'long-path-'.repeat(20)}`, visit: true }]),
		);
		expect(ops.names).toEqual(['insert ss_growth_events', 'update ss_growth_totals', 'update ss_growth_totals']);
		expect(await db.collection('ss_growth_totals').countDocuments({ day: '2026-10-03' })).toBe(2);
		const report = await (await env.call('GET', '/v1/analytics?from=2026-10-03&to=2026-10-03', { token: env.server })).json();
		expect(report.totals).toEqual({ visits: 3, pageViews: 6 });
		expect(report.days).toEqual([{ day: '2026-10-03', visits: 3, pageViews: 6 }]);
		expect(report.pages[0]).toEqual({ key: '/a', count: 5 });
	});

	it('fails a batch the day’s document cannot take for another reason', async () => {
		env.advance(86_400_000);
		const db = await env.merchantDb();
		await db
			.collection('ss_growth_totals')
			.insertOne({ websiteId: env.websiteId, day: '2026-10-04', part: 0, totals: { page_views: 'broken' } });
		const answer = await env.collect([{ type: 'page_view', path: '/', visit: false }]);
		expect(answer.status).toBe(500);
		expect(await db.collection('ss_growth_totals').countDocuments({ day: '2026-10-04' })).toBe(1);
	});
});
