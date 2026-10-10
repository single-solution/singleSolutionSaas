/**
 * Detailed analytics (PLAN 0.8.10 G3) through the API: with the `detail` setting `sessions`, events keep the tab's
 * session, browser, system and city; the report adds sessions, bounce, duration, browsers, systems, cities, live
 * visitors, journeys, Web Vitals per page and 404 referrers; the event log filters by session, also with a ticket.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_ORIGIN, ALL, setup } from './helpers.js';

/** @type {Awaited<ReturnType<typeof setup>>} */
let env;

const A = 'sessionaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'sessionbbbbbbbbbbbbbbbbbbbbbbbbb';
const HERE = { 'x-vercel-ip-country': 'PK', 'x-vercel-ip-city': 'Lahore' };

beforeAll(async () => {
	env = await setup();
	await env.switchOn(ALL);
	await env.connectDatabase();
});
afterAll(async () => {
	await env.close();
});

describe('detailed analytics (G3)', () => {
	it('keeps nothing about sessions while the detail is anonymous', async () => {
		await env.collect([{ type: 'page_view', path: '/', visit: true, session: A, browser: 'chrome', os: 'android' }], HERE);
		const db = await env.merchantDb();
		const event = await db.collection('ss_growth_events').findOne({});
		expect(event).not.toHaveProperty('session');
		expect(event).not.toHaveProperty('city');
		const report = await (await env.call('GET', '/v1/analytics', { token: env.server })).json();
		expect(report).toMatchObject({ detail: 'anonymous', sessions: null, live: null, journeys: null, browsers: null });
	});

	it('records sessions and reports them, live visitors and journeys included', async () => {
		await env.setting('visitor_analytics', 'detail', 'sessions');
		const visitor = { browser: 'chrome', os: 'android' };
		await env.collect(
			[
				{ type: 'page_view', path: '/', visit: true, session: A, ...visitor, page: 1, device: 'mobile' },
				{ type: 'page_view', path: '/shop', visit: false, session: A, ...visitor, page: 2, gap: 30_000 },
				{ type: 'search', path: '/shop', term: 'cases', session: A, ...visitor },
				{
					type: 'purchase',
					path: '/cart',
					items: [{ id: 'prd_1', quantity: 1 }],
					value: 2500,
					currency: 'USD',
					orderId: 'ord_1',
					session: A,
					...visitor,
				},
				{ type: 'vital', path: '/shop', name: 'LCP', value: 4100, session: A, ...visitor },
				{ type: 'not_found', path: '/old', referrer: '/shop', session: A, ...visitor },
			],
			HERE,
		);
		env.advance(60_000);
		await env.collect(
			[
				{
					type: 'page_view',
					path: '/',
					visit: true,
					session: B,
					browser: 'safari',
					os: 'ios',
					page: 1,
					referrer: 'www.google.com',
				},
			],
			{ 'x-vercel-ip-country': 'AE', 'x-vercel-ip-city': 'Dubai' },
		);
		const db = await env.merchantDb();
		expect(await db.collection('ss_growth_events').findOne({ session: B })).toMatchObject({
			browser: 'safari',
			os: 'ios',
			city: 'Dubai',
			data: { visit: true, page: 1, source: 'www.google.com', country: 'AE' },
		});
		const indexes = await db.collection('ss_growth_events').indexes();
		expect(indexes.find((index) => index.name === 'by_session')).toMatchObject({
			partialFilterExpression: { session: { $exists: true } },
		});

		const report = await (await env.call('GET', '/v1/analytics?top=5', { token: env.server })).json();
		expect(report.detail).toBe('sessions');
		expect(report.sessions).toEqual({ count: 2, bounces: 1, bounceRate: 50, averageDuration: 15, pagesPerSession: 1.5 });
		expect(report.browsers).toEqual([
			{ key: 'chrome', count: 1 },
			{ key: 'safari', count: 1 },
		]);
		expect(report.systems).toEqual([
			{ key: 'android', count: 1 },
			{ key: 'ios', count: 1 },
		]);
		expect(report.cities).toEqual([
			{ key: 'Dubai, AE', count: 1 },
			{ key: 'Lahore, PK', count: 1 },
		]);
		expect(report.vitalPages).toEqual([
			{ path: '/shop', samples: 1, averages: { LCP: 4100, INP: null, CLS: null, FCP: null, TTFB: null } },
		]);
		expect(report.notFoundFrom).toEqual([{ path: '/old', from: '/shop', count: 1 }]);
		expect(report.live).toEqual({
			visitors: 2,
			pages: [
				{ key: '/', count: 1 },
				{ key: '/shop', count: 1 },
			],
		});
		expect(report.journeys.map((/** @type {any} */ journey) => journey.session)).toEqual([B, A]);
		expect(report.journeys[1]).toMatchObject({
			session: A,
			events: 6,
			pages: 2,
			device: 'mobile',
			browser: 'chrome',
			os: 'android',
			country: 'PK',
			city: 'Lahore',
			source: '(direct)',
			duration: 0,
		});
		expect(report.journeys[1].steps.map((/** @type {any} */ step) => step.type)).toEqual([
			'page_view',
			'page_view',
			'search',
			'purchase',
			'not_found',
		]);
		expect(report.journeys[1].steps[2]).toMatchObject({ term: 'cases' });
		expect(report.journeys[1].steps[3]).toMatchObject({ value: 2500, currency: 'USD' });

		// live visitors are judged when the report is read: 5 minutes later nobody is live
		env.advance(6 * 60_000);
		const later = await (await env.call('GET', '/v1/analytics', { token: env.server })).json();
		expect(later.live).toEqual({ visitors: 0, pages: [] });
		expect(later.journeys).toHaveLength(2);
		// a range without sessions
		const before = await (await env.call('GET', '/v1/analytics?from=2026-09-01&to=2026-09-02', { token: env.server })).json();
		expect(before.journeys).toEqual([]);
	});

	it('lists and counts one session’s events, with the server token and in the dashboard widget’s event log', async () => {
		const own = await (await env.call('GET', `/v1/events?session=${A}`, { token: env.server })).json();
		expect(own.items).toHaveLength(6);
		expect(own.items.every((/** @type {any} */ item) => item.session === A && item.city === 'Lahore')).toBe(true);
		expect(await (await env.call('GET', `/v1/events/count?session=${A}`, { token: env.server })).json()).toEqual({
			count: 6,
			capped: false,
		});
		// a malformed session id filters nothing
		const all = await (await env.call('GET', '/v1/events/count?session=x', { token: env.server })).json();
		expect(all.count).toBe(8);
		const ticket = await env.ticket(['analytics.read']);
		/** @param {string} path */
		const admin = async (path) => env.call('GET', path, { token: ticket, origin: ADMIN_ORIGIN });
		const views = await (await admin('/v1/admin/events?type=page_view&limit=2')).json();
		expect(views.items.map((/** @type {any} */ item) => item.type)).toEqual(['page_view', 'page_view']);
		expect(views.hasMore).toBe(true);
		const byType = await (await admin(`/v1/admin/events/counts?by=type&session=${A}`)).json();
		expect(byType).toEqual({
			total: 6,
			groups: { page_view: 2, search: 1, purchase: 1, vital: 1, not_found: 1 },
		});
		expect(await (await admin('/v1/admin/events/count?type=purchase')).json()).toEqual({ count: 1, capped: false });
		const refused = await env.call('GET', '/v1/admin/events', {
			token: await env.ticket(['seo.check']),
			origin: ADMIN_ORIGIN,
		});
		expect(refused.status).toBe(403);
	});
});
