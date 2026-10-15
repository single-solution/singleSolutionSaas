import { noticeFor } from '../core/notices.js';
import { DEFAULT_ACTIONS, DEFAULT_CATEGORIES, SHOP_FUNNEL, checkList, readList, zonedTimeOf } from '../core/lists.js';
import { zonedParts } from '@ss/contracts/format';
import { describe, expect, it } from 'vitest';
import { PRESETS, buildReport, dayStart, daysOf, presetRange, rangeOf, topOf } from '../core/analytics.js';
import {
	adminSettings,
	linkOf,
	noticeAnswer,
	noticesOf,
	searchParamsOf,
	tagsOf,
	tagsReady,
	widgetSettings,
} from '../core/config.js';
import {
	ANALYTICS_SIGNALS,
	TAG_SIGNALS,
	allows,
	anyChosen,
	consentMode,
	consentMonthsOf,
	grantedOf,
	makeChoice,
	readChoice,
} from '../core/consent.js';
import consentSchema from '../schemas/consent_banner.settings.json' with { type: 'json' };
import {
	checkBatch,
	countedOf,
	checkEvent,
	cityOf,
	countryOf,
	dayOf,
	expiryOf,
	familiesOf,
	mergeTotals,
	pathOf,
	ratingOf,
	textOf,
} from '../core/events.js';
import { toMajor } from '../core/money.js';
import {
	contactCalls,
	contactOf,
	customCalls,
	detailOf,
	funnelEvent,
	pixelCalls,
	searchCalls,
	searchOf,
	vitalCalls,
} from '../core/pixels.js';
import {
	checksActivity,
	indexNowActivity,
	indexNowSubmission,
	keyLocationOf,
	keyPathOf,
	robotsPresetsOf,
	ONLINE_STORE_PRESET,
	AI_TRAINING_CRAWLERS,
	robotsTxtOf,
	siteUrlOf,
	tokenOf,
	verificationOf,
} from '../core/seo.js';
import { robotsAllows, robotsGroupsOf } from '../core/seo-scan.js';
import { createSnippets } from '../core/snippets.js';
import robotsSchema from '../schemas/robots_verification.settings.json' with { type: 'json' };
import searchesSchema from '../schemas/searches_404s.settings.json' with { type: 'json' };

const NOW = Date.parse('2026-10-08T12:00:00Z');
const DOMAIN = 'shop.example.com';
const context = { domain: DOMAIN, country: 'GB' };

describe('events', () => {
	it('keeps only the path, never the query string or fragment', () => {
		expect(pathOf('/a/b?x=1#y')).toBe('/a/b');
		expect(pathOf('//evil')).toBeNull();
		expect(pathOf('x')).toBeNull();
		expect(pathOf('/a b')).toBeNull();
		expect(pathOf(`/${'a'.repeat(400)}`)).toBeNull();
		expect(pathOf(5)).toBeNull();
		expect(textOf('  a\u0001  b ', 10)).toBe('a b');
		expect(textOf(1, 5)).toBe('');
	});

	it('reads the country from the host’s header and rates Web Vitals', () => {
		/** @param {Record<string, string>} headers */
		const get = (headers) => (/** @type {string} */ name) => headers[name] ?? null;
		expect(countryOf(get({ 'cf-ipcountry': 'de' }))).toBe('DE');
		expect(countryOf(get({ 'x-vercel-ip-country': 'nope' }))).toBeNull();
		expect(ratingOf('LCP', 2500)).toBe('good');
		expect(ratingOf('LCP', 3000)).toBe('needs_improvement');
		expect(ratingOf('LCP', 4001)).toBe('poor');
	});

	it('tells a page view’s source: campaign, other site or direct', () => {
		/** @param {Record<string, unknown>} extra */
		const view = (extra) => checkEvent({ type: 'page_view', path: '/', visit: true, ...extra }, context);
		expect(view({ campaign: { source: 'News', medium: 'Email' } })?.data).toMatchObject({ source: 'news', medium: 'email' });
		expect(view({ referrer: 'www.shop.example.com' })?.data.source).toBe('(direct)');
		expect(view({ referrer: DOMAIN })?.data.source).toBe('(direct)');
		expect(view({ referrer: 'bad host!' })?.data.source).toBe('(direct)');
		expect(view({ referrer: 'm.facebook.com', device: 'tv' })?.data).toMatchObject({
			source: 'm.facebook.com',
			device: 'desktop',
		});
		expect(checkEvent({ type: 'page_view', path: '/', visit: true }, { domain: DOMAIN, country: null })?.data.country).toBe(
			'(unknown)',
		);
		expect(checkEvent({ type: 'page_view', path: '/' }, context)?.totals).toHaveLength(2);
	});

	it('checks funnel events, searches and vitals', () => {
		const purchase = checkEvent(
			{
				type: 'purchase',
				path: '/',
				value: 100,
				currency: 'EUR',
				orderId: 'o1',
				items: [{ id: 'a', quantity: 0 }, { id: '' }, 'x'],
			},
			context,
		);
		expect(purchase?.data).toEqual({
			items: [{ id: 'a', variantId: null, quantity: 1 }],
			value: 100,
			currency: 'EUR',
			orderId: 'o1',
		});
		expect(purchase?.totals).toContainEqual({ metric: 'revenue', key: 'EUR', count: 1, sum: 100 });
		const cart = checkEvent({ type: 'add_to_cart', path: '/', value: -1, currency: 'eur', items: 'no' }, context);
		expect(cart?.data).toEqual({ items: [], value: 0, currency: null });
		expect(checkEvent({ type: 'purchase', path: '/' }, context)?.totals).toHaveLength(1);
		expect(checkEvent({ type: 'search', path: '/', term: ' ' }, context)).toBeNull();
		expect(checkEvent({ type: 'search', path: '/', term: 'x', results: 3 }, context)?.totals).toHaveLength(1);
		expect(checkEvent({ type: 'vital', path: '/', name: 'XYZ', value: 1 }, context)).toBeNull();
		expect(checkEvent({ type: 'vital', path: '/', name: 'INP', value: -1 }, context)).toBeNull();
		expect(checkEvent({ type: 'vital', path: '/', name: 'INP', value: 'x' }, context)).toBeNull();
		expect(checkEvent({ type: 'vital', path: '/', name: 'INP', value: 120.6 }, context)?.data).toEqual({
			name: 'INP',
			value: 121,
			rating: 'good',
		});
		expect(checkEvent(null, context)).toBeNull();
		expect(checkEvent({ type: 'not_found', path: 'x' }, context)).toBeNull();
	});

	it('takes a batch of switched-on features, merges the totals and dates the expiry', () => {
		expect(checkBatch(null, { on: [], ...context })).toEqual([]);
		const events = Array.from({ length: 30 }, () => ({ type: 'page_view', path: '/' }));
		expect(checkBatch({ events }, { on: ['visitor_analytics'], ...context })).toHaveLength(25);
		expect(checkBatch({ events: [{ type: 'not_found', path: '/' }] }, { on: ['visitor_analytics'], ...context })).toEqual([]);
		const kept = checkBatch({ events: events.slice(0, 2) }, { on: ['visitor_analytics'], ...context });
		expect(mergeTotals(kept)).toEqual([
			{ metric: 'page_views', key: '', count: 2, sum: 0 },
			{ metric: 'page', key: '/', count: 2, sum: 0 },
		]);
		expect(expiryOf(Date.parse('2026-01-31T00:00:00Z'), 13).toISOString()).toBe('2027-03-03T00:00:00.000Z');
	});

	it('keeps the session facts with the sessions detail only (G3)', () => {
		const sessions = { ...context, sessions: true, city: 'London' };
		const visit = {
			type: 'page_view',
			path: '/',
			visit: true,
			session: 'abcdef0123456789',
			browser: 'chrome',
			os: 'android',
			page: 1,
		};
		expect(checkEvent(visit, context)?.visitor).toBeUndefined();
		const first = checkEvent(visit, sessions);
		expect(first?.visitor).toEqual({ session: 'abcdef0123456789', browser: 'chrome', os: 'android', city: 'London' });
		expect(first?.data).toMatchObject({ visit: true, page: 1 });
		expect(first?.totals.map((t) => `${t.metric}:${t.key}`)).toEqual([
			'page_views:',
			'page:/',
			'visits:',
			'source:(direct)',
			'device:desktop',
			'country:GB',
			'session_pages:',
			'sessions:',
			'browser:chrome',
			'os:android',
			'city:London, GB',
		]);
		const second = checkEvent(
			{ ...visit, visit: false, page: 2, gap: 42_000, browser: 'netscape' },
			{ ...sessions, city: null },
		);
		expect(second?.visitor).toEqual({ session: 'abcdef0123456789', browser: null, os: 'android', city: null });
		expect(second?.totals.slice(2)).toEqual([
			{ metric: 'session_pages', key: '', count: 1, sum: 0 },
			{ metric: 'duration', key: '', count: 1, sum: 42_000 },
			{ metric: 'engaged', key: '', count: 1, sum: 0 },
		]);
		// a gap longer than a visit, or a broken page number, is not counted
		const odd = checkEvent({ ...visit, visit: false, page: 0, gap: 99_999_999 }, sessions);
		expect(odd?.totals.map((t) => t.metric)).toEqual(['page_views', 'page', 'session_pages']);
		// unknown browser and city on a session's first page
		const bare = checkEvent({ ...visit, browser: undefined, os: undefined }, { ...sessions, country: null, city: 'Paris' });
		expect(bare?.totals.slice(-3).map((t) => t.key)).toEqual(['other', 'other', 'Paris']);
		// no session id: anonymous, but vitals per page and 404 referrers still count
		expect(checkEvent({ ...visit, session: 'short' }, sessions)?.visitor).toBeUndefined();
		const vital = checkEvent({ type: 'vital', path: '/a', name: 'LCP', value: 1200 }, sessions);
		expect(vital?.totals.at(-1)).toEqual({ metric: 'vital_page', key: '/a\nLCP', count: 1, sum: 1200 });
		const lost = checkEvent({ type: 'not_found', path: '/old', referrer: '/shop?x=1' }, sessions);
		expect(lost?.data).toEqual({ from: '/shop' });
		expect(lost?.totals.at(-1)).toEqual({ metric: 'not_found_from', key: '/old\n/shop', count: 1, sum: 0 });
		expect(checkEvent({ type: 'not_found', path: '/old', referrer: 'www.google.com' }, sessions)?.data).toEqual({
			from: 'www.google.com',
		});
		expect(checkEvent({ type: 'not_found', path: '/old' }, sessions)?.totals.at(-1)?.key).toBe('/old\n(direct)');
		expect(checkEvent({ type: 'not_found', path: '/old', referrer: '/shop' }, context)?.data).toEqual({});
	});

	it('tells browser and system families and reads the city header (G3)', () => {
		const ua = {
			chromeAndroid:
				'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36',
			safariIphone:
				'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
			edgeWindows:
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0',
			firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
			samsung:
				'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36',
			opera: 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 OPR/114.0',
			mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
			chromebook: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
		};
		expect(familiesOf(ua.chromeAndroid)).toEqual({ browser: 'chrome', os: 'android' });
		expect(familiesOf(ua.safariIphone)).toEqual({ browser: 'safari', os: 'ios' });
		expect(familiesOf(ua.edgeWindows)).toEqual({ browser: 'edge', os: 'windows' });
		expect(familiesOf(ua.firefoxLinux)).toEqual({ browser: 'firefox', os: 'linux' });
		expect(familiesOf(ua.samsung)).toEqual({ browser: 'samsung', os: 'android' });
		expect(familiesOf(ua.opera)).toEqual({ browser: 'opera', os: 'windows' });
		expect(familiesOf(ua.mac)).toEqual({ browser: 'safari', os: 'macos' });
		expect(familiesOf(ua.mac, { touch: true })).toEqual({ browser: 'safari', os: 'ios' });
		expect(familiesOf(ua.chromebook)).toEqual({ browser: 'chrome', os: 'chromeos' });
		expect(familiesOf('curl/8.0')).toEqual({ browser: 'other', os: 'other' });
		/** @param {Record<string, string>} headers */
		const city = (headers) => cityOf((name) => headers[name] ?? null);
		expect(city({ 'x-vercel-ip-city': 'S%C3%A3o%20Paulo' })).toBe('São Paulo');
		expect(city({ 'x-vercel-ip-city': '%E0%A4%A', 'cf-ipcity': 'Paris' })).toBe('%E0%A4%A');
		expect(city({ 'cf-ipcity': '12345', 'cloudfront-viewer-city': 'Tokyo' })).toBe('Tokyo');
		expect(city({})).toBeNull();
	});
});

describe('analytics report', () => {
	it('checks the range of days', () => {
		expect(rangeOf({}, NOW, 'UTC')).toEqual({ ok: true, from: '2026-09-09', to: '2026-10-08' });
		expect(rangeOf({ to: '2026-03-01' }, NOW, 'UTC')).toEqual({ ok: true, from: '2026-01-31', to: '2026-03-01' });
		expect(rangeOf({ from: 'x' }, NOW, 'UTC').ok).toBe(false);
		expect(rangeOf({ to: 'x' }, NOW, 'UTC').ok).toBe(false);
		expect(rangeOf({ from: '2026-02-30', to: '2026-03-02' }, NOW, 'UTC').ok).toBe(false);
		expect(rangeOf({ from: '2026-10-09', to: '2026-10-08' }, NOW, 'UTC').ok).toBe(false);
		expect(rangeOf({ from: '2024-01-01', to: '2026-10-08' }, NOW, 'UTC').ok).toBe(false);
		expect(daysOf('2026-10-01', '2026-10-03')).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
		expect(daysOf('2026-03-28', '2026-03-30')).toEqual(['2026-03-28', '2026-03-29', '2026-03-30']);
	});

	it('counts days in the business time zone (UTC when missing)', () => {
		const lateEvening = Date.parse('2026-10-08T20:00:00Z');
		// Tokyo is UTC+9: 20:00 UTC is already the next day there; Los Angeles is still on the same day
		expect(dayOf(lateEvening, 'Asia/Tokyo')).toBe('2026-10-09');
		expect(dayOf(lateEvening, 'America/Los_Angeles')).toBe('2026-10-08');
		expect(dayOf(lateEvening, null)).toBe('2026-10-08');
		expect(dayOf(lateEvening, 'Not/AZone')).toBe('2026-10-08');
		expect(rangeOf({}, lateEvening, 'Asia/Tokyo')).toEqual({ ok: true, from: '2026-09-10', to: '2026-10-09' });
		expect(rangeOf({}, Date.parse('2026-10-08T03:00:00Z'), 'America/Los_Angeles')).toMatchObject({ to: '2026-10-07' });
		expect(new Date(dayStart('2026-10-09', 'Asia/Tokyo')).toISOString()).toBe('2026-10-08T15:00:00.000Z');
		expect(dayStart('2026-13-01', 'UTC')).toBeNaN();
	});

	it('counts the merchant’s goals and funnels: events, their own events and pages (G1, G2)', () => {
		const goals = [
			{ key: 'demo', name: 'Booked a demo', kind: 'event', match: 'book_demo' },
			{ key: 'thanks', name: 'Thank-you page', kind: 'page', match: '/thank-you' },
			{ key: 'contact', name: 'Contact', kind: 'event', match: 'contact' },
		];
		const funnels = [
			{
				key: 'lead',
				name: 'Lead',
				steps: [
					{ name: 'Pricing', kind: 'page', match: '/pricing/**' },
					{ name: 'Demo', kind: 'event', match: 'book_demo' },
				],
			},
		];
		const counted = countedOf(goals, funnels);
		expect([...counted.events]).toEqual(['book_demo', 'contact']);
		expect(counted.pages).toEqual(['/thank-you', '/pricing/**']);
		const kept = checkBatch(
			{
				events: [
					{
						type: 'custom',
						path: '/pricing',
						name: 'book_demo',
						props: { plan: 'pro', seats: 5, ok: true, bad: {}, 'Bad Name': 1 },
					},
					{ type: 'custom', path: '/pricing', name: 'not_counted' },
					{ type: 'custom', path: '/x', name: 'purchase' },
					{ type: 'contact', path: '/about', method: 'whatsapp' },
					{ type: 'page_view', path: '/pricing/teams', visit: true },
					{ type: 'page_view', path: '/thank-you' },
				],
			},
			{ on: ['visitor_analytics', 'conversion_funnel'], domain: DOMAIN, country: null, counted },
		);
		// a custom event no goal or step names is dropped, so raw events stay within what is counted; a standard name is
		// not a custom event
		expect(kept.map((event) => event.type)).toEqual(['custom', 'contact', 'page_view', 'page_view']);
		expect(kept[0]?.data).toEqual({ name: 'book_demo', props: { plan: 'pro', seats: 5, ok: true } });
		const merged = mergeTotals(kept);
		expect(merged).toContainEqual({ metric: 'event', key: 'book_demo', count: 1, sum: 0 });
		expect(merged).toContainEqual({ metric: 'event', key: 'contact', count: 1, sum: 0 });
		expect(merged).toContainEqual({ metric: 'page_match', key: '/pricing/**', count: 1, sum: 0 });
		expect(merged).toContainEqual({ metric: 'page_match', key: '/thank-you', count: 1, sum: 0 });
		// without Goals and funnels, contacts and own events are not kept
		expect(
			checkBatch({ events: [{ type: 'contact', path: '/' }] }, { on: ['visitor_analytics'], domain: DOMAIN, country: null }),
		).toEqual([]);
		const report = buildReport({
			from: '2026-10-01',
			to: '2026-10-01',
			timeZone: 'UTC',
			on: ['visitor_analytics', 'conversion_funnel'],
			totals: merged,
			days: [],
			goals,
			funnels,
		});
		expect(report.goals?.map((goal) => [goal.key, goal.count])).toEqual([
			['demo', 1],
			['thanks', 1],
			['contact', 1],
		]);
		expect(report.funnels?.[0]?.steps.map((step) => step.count)).toEqual([1, 1]);
	});

	it('leaves out the parts of features that are off', () => {
		const report = buildReport({
			from: '2026-10-01',
			to: '2026-10-02',
			timeZone: 'Asia/Tokyo',
			on: ['visitor_analytics', 'web_vitals'],
			totals: [
				{ metric: 'page', key: '/b', count: 2, sum: 0 },
				{ metric: 'page', key: '/a', count: 2, sum: 0 },
				{ metric: 'vital_value', key: 'CLS', count: 2, sum: 150 },
			],
			days: [{ day: '2026-10-02', metric: 'visits', count: 4 }],
		});
		expect(report.pages).toEqual([
			{ key: '/a', count: 2 },
			{ key: '/b', count: 2 },
		]);
		expect(report.timeZone).toBe('Asia/Tokyo');
		expect(report.days).toEqual([
			{ day: '2026-10-01', visits: 0, pageViews: 0 },
			{ day: '2026-10-02', visits: 4, pageViews: 0 },
		]);
		expect(report.funnels).toBeNull();
		expect(report.goals).toBeNull();
		expect(report.revenue).toBeNull();
		expect(report.searches).toBeNull();
		expect(report.vitals?.find((v) => v.name === 'CLS')).toMatchObject({ average: 75, count: 2 });
		expect(report.vitals?.find((v) => v.name === 'LCP')).toMatchObject({ average: null });
		expect(report).toMatchObject({ detail: 'anonymous', sessions: null, browsers: null, live: null, journeys: null });
		expect(report.vitalPages).toBeNull();
	});

	it('adds sessions, bounce, duration, browsers, systems, cities, vitals per page and 404 referrers (G3)', () => {
		const report = buildReport({
			from: '2026-10-01',
			to: '2026-10-01',
			timeZone: 'UTC',
			on: ['visitor_analytics', 'web_vitals', 'searches_404s'],
			top: 2,
			detail: 'sessions',
			totals: [
				{ metric: 'sessions', key: '', count: 4, sum: 0 },
				{ metric: 'engaged', key: '', count: 1, sum: 0 },
				{ metric: 'session_pages', key: '', count: 7, sum: 0 },
				{ metric: 'duration', key: '', count: 3, sum: 250_000 },
				{ metric: 'browser', key: 'chrome', count: 3, sum: 0 },
				{ metric: 'browser', key: 'safari', count: 1, sum: 0 },
				{ metric: 'browser', key: 'other', count: 1, sum: 0 },
				{ metric: 'os', key: 'android', count: 4, sum: 0 },
				{ metric: 'city', key: 'London, GB', count: 2, sum: 0 },
				{ metric: 'vital_page', key: '/a\nLCP', count: 2, sum: 5000 },
				{ metric: 'vital_page', key: '/a\nCLS', count: 2, sum: 100 },
				{ metric: 'vital_page', key: '/b\nLCP', count: 1, sum: 9000 },
				{ metric: 'vital_page', key: '/c\nINP', count: 5, sum: 1000 },
				{ metric: 'not_found_from', key: '/old\n/shop', count: 3, sum: 0 },
				{ metric: 'not_found_from', key: '/gone\n(direct)', count: 1, sum: 0 },
			],
			days: [],
			live: { visitors: 2, pages: [{ key: '/', count: 2 }] },
		});
		expect(report.sessions).toEqual({
			count: 4,
			bounces: 3,
			bounceRate: 75,
			averageDuration: 63,
			pagesPerSession: 1.8,
		});
		expect(report.browsers).toEqual([
			{ key: 'chrome', count: 3 },
			{ key: 'other', count: 1 },
		]);
		expect(report.systems).toEqual([{ key: 'android', count: 4 }]);
		expect(report.cities).toEqual([{ key: 'London, GB', count: 2 }]);
		expect(report.vitalPages).toEqual([
			{ path: '/b', samples: 1, averages: { LCP: 9000, INP: null, CLS: null, FCP: null, TTFB: null } },
			{ path: '/a', samples: 4, averages: { LCP: 2500, INP: null, CLS: 50, FCP: null, TTFB: null } },
		]);
		expect(report.notFoundFrom).toEqual([
			{ path: '/old', from: '/shop', count: 3 },
			{ path: '/gone', from: '(direct)', count: 1 },
		]);
		expect(report.live).toEqual({ visitors: 2, pages: [{ key: '/', count: 2 }] });
		expect(report.journeys).toEqual([]);
		const empty = buildReport({
			from: '2026-10-01',
			to: '2026-10-01',
			timeZone: 'UTC',
			on: [],
			totals: [],
			days: [],
			detail: 'sessions',
		});
		expect(empty.sessions).toEqual({ count: 0, bounces: 0, bounceRate: null, averageDuration: null, pagesPerSession: null });
		expect(empty).toMatchObject({ live: { visitors: 0, pages: [] }, vitalPages: null, notFoundFrom: null });
		expect([topOf('25'), topOf('0'), topOf('101'), topOf(undefined), topOf('x')]).toEqual([25, 10, 10, 10, 10]);
		// the dashboard widget's range chips, in the business time zone
		const late = Date.parse('2026-03-01T20:00:00Z');
		expect(PRESETS.map((preset) => presetRange(preset, late, 'Asia/Tokyo'))).toEqual([
			{ from: '2026-03-02', to: '2026-03-02' },
			{ from: '2026-02-24', to: '2026-03-02' },
			{ from: '2026-02-01', to: '2026-03-02' },
			{ from: '2025-12-03', to: '2026-03-02' },
			{ from: '2026-03-01', to: '2026-03-02' },
			{ from: '2026-02-01', to: '2026-02-28' },
			{ from: '2025-03-03', to: '2026-03-02' },
		]);
		expect(presetRange('nonsense', late, 'UTC')).toEqual({ from: '2026-01-31', to: '2026-03-01' });
	});
});

describe('page script settings', () => {
	it('gives well-formed tag ids of switched-on features only', () => {
		const values = {
			meta_pixel: { pixelId: '123456789' },
			google_tags: { ga4Id: 'G-ABCD12', adsId: 'AW-123456', gtmId: 'GTM-ABC123' },
			tiktok_pixel: { pixelId: 'CABCDEFGHIJ12' },
		};
		const categories = [
			{ key: 'analytics', scripts: ' <script>a()</script> ' },
			{ key: 'marketing', scripts: '' },
		];
		const all = ['meta_pixel', 'google_tags', 'tiktok_pixel', 'custom_scripts'];
		expect(tagsOf(all, values, categories)).toEqual({
			consentRequired: true,
			ga4ViaGtm: false,
			contentIds: 'product',
			searchFromUrl: true,
			meta: '123456789',
			ga4: 'G-ABCD12',
			ads: 'AW-123456',
			gtm: 'GTM-ABC123',
			tiktok: 'CABCDEFGHIJ12',
			// each consent category's own scripts (G3)
			scripts: { analytics: '<script>a()</script>' },
			// the conversion actions (G5): none given here
			actions: [],
		});
		expect(tagsOf(all, values, categories, DEFAULT_ACTIONS).actions).toEqual(DEFAULT_ACTIONS);
		expect(tagsOf(['custom_scripts'], values, categories, DEFAULT_ACTIONS).actions).toEqual([]);
		expect(tagsOf(['meta_pixel'], values, categories).scripts).toEqual({});
		expect(tagsOf([], values)).toMatchObject({ meta: null, ga4: null, ads: null, gtm: null, tiktok: null });
		expect(tagsOf(['google_tags'], { google_tags: { adsId: 'bad' } }).ads).toBeNull();
		expect(tagsReady(all, values, categories)).toEqual({ ready: 4, total: 4 });
		expect(tagsReady(all, {}, [])).toEqual({ ready: 0, total: 4 });
		expect(tagsReady([], {})).toEqual({ ready: 0, total: 0 });
		// G1: tags without a consent step; GA4 inside Tag Manager is not loaded by Growth
		const viaGtm = { tags: { consentRequired: false }, google_tags: { ga4Id: 'G-ABCD12', ga4ViaGtm: true } };
		expect(tagsOf(['google_tags'], viaGtm)).toMatchObject({ consentRequired: false, ga4ViaGtm: true, ga4: 'G-ABCD12' });
		expect(tagsReady(['google_tags'], viaGtm)).toEqual({ ready: 0, total: 1 });
		expect(tagsOf([], viaGtm).ga4ViaGtm).toBe(false);
		expect(tagsOf([], { pixels: { contentIds: 'variant' } }).contentIds).toBe('variant');
		// SG-38: searches found in the page address may stay away from the pixels
		expect(tagsOf([], { pixels: { searchFromUrl: false } }).searchFromUrl).toBe(false);
	});

	it('shows the announcements whose times on the business clock say so, in the merchant’s order (G4)', () => {
		/** @param {Record<string, unknown>} entry */
		const announcement = (entry) => readList('announcements', [{ key: 'a', text: 'Hi', ...entry }])[0];
		const list = [
			announcement({ key: 'later', text: 'Black Friday', startsAt: '2026-11-27T00:00' }),
			announcement({ key: 'now', text: 'Free shipping', linkText: 'x', pages: ['/shop/**'] }),
			announcement({ key: 'over', text: 'Summer', endsAt: '2026-10-08T12:00' }),
			announcement({
				key: 'all',
				text: 'Hello',
				dismissible: false,
				dismiss: 'days',
				dismissDays: 3,
				hideOnPages: ['/checkout/**'],
			}),
		];
		// NOW is 2026-10-08 12:00 UTC: in New York it is 08:00, so "over" (until noon there) still shows
		expect(noticesOf({}, list, NOW, 'UTC').map((notice) => notice.key)).toEqual(['now', 'all']);
		expect(noticesOf({}, list, NOW, 'America/New_York').map((notice) => notice.key)).toEqual(['now', 'over', 'all']);
		expect(noticesOf({}, list, NOW, 'UTC')[0]).toEqual({
			key: 'now',
			text: 'Free shipping',
			linkUrl: null,
			linkText: '',
			dismissible: true,
			dismiss: 'visit',
			dismissDays: 7,
			pages: ['/shop/**'],
			hideOnPages: [],
		});
		// a link that is not safe is refused by the list (and left out when read)
		expect(checkList('announcements', [{ key: 'x', text: 'Hi', linkUrl: 'javascript:alert(1)' }])).toMatchObject({
			ok: false,
			errors: [{ path: '/value/0/linkUrl' }],
		});
		expect(
			checkList('announcements', [{ key: 'x', text: 'Hi', startsAt: '2026-11-02T00:00', endsAt: '2026-11-01T00:00' }]),
		).toMatchObject({
			ok: false,
			errors: [{ path: '/value/0/endsAt' }],
		});
		// AO-2: turned off by the merchant, the list kept
		expect(noticesOf({ notice_bar: { enabled: false } }, list, NOW, 'UTC')).toEqual([]);
		// the page's announcement: its pages and hidden pages (* inside a segment, ** across segments)
		const showing = noticesOf({}, list, NOW, 'UTC');
		expect(noticeFor(showing, '/shop/lamps')?.key).toBe('now');
		expect(noticeFor(showing, '/about')?.key).toBe('all');
		expect(noticeFor(showing, '/checkout/pay')).toBeNull();
		expect(noticeAnswer(showing, '/shop/lamps')).toEqual({
			key: 'now',
			text: 'Free shipping',
			linkText: '',
			linkUrl: null,
			dismissible: true,
		});
		expect(noticeAnswer(showing, undefined)?.key).toBe('now');
		expect(noticeAnswer([], '/')).toBeNull();
		expect(noticesOf({}, [announcement({ linkUrl: 'https://x.example/a', linkText: 'More' })], NOW, 'UTC')[0]).toMatchObject({
			linkUrl: 'https://x.example/a',
			linkText: 'More',
		});
		expect(linkOf('/a b')).toBeNull();
		expect(linkOf('http://x.example')).toBeNull();
		expect(searchParamsOf('q, term,  bad param!')).toEqual(['q', 'term', 'bad']);
		// an empty setting means no search parameters at all (the setting's own default names q, s, search and query)
		expect(searchParamsOf('')).toEqual([]);
	});

	it('assembles what the page script needs', () => {
		const settings = widgetSettings({
			on: ['consent_banner', 'visitor_analytics', 'notice_bar'],
			values: {
				consent_banner: { position: 'top', privacyUrl: '/privacy' },
				visitor_analytics: { requireConsent: false },
			},
			now: NOW,
			lists: {
				announcements: [
					{
						key: 'sale',
						text: 'Sale',
						startsAt: '',
						endsAt: '',
						pages: [],
						hideOnPages: [],
						dismissible: true,
						dismiss: 'visit',
						dismissDays: 7,
					},
				],
			},
		});
		expect(settings).toMatchObject({
			consent: {
				banner: true,
				position: 'top',
				privacyUrl: '/privacy',
				askAgainMonths: 12,
				categories: DEFAULT_CATEGORIES.map(({ key, name, description, mode, signals }) => ({
					key,
					name,
					description,
					mode,
					signals,
				})),
			},
			record: { visits: true, funnel: false, requireConsent: false },
			notices: [{ key: 'sale', text: 'Sale' }],
		});
		// the admin widgets' part: the checklist's pages, the IndexNow key file, the analytics detail and retention
		const admin = widgetSettings({
			on: ['seo_checklist', 'indexnow', 'visitor_analytics'],
			values: {
				seo_checklist: { paths: ['/shop', 'bad', '//x', '/shop', '/'] },
				indexnow: { key: 'abcdefgh' },
				visitor_analytics: { detail: 'sessions', retentionMonths: 6 },
			},
			now: NOW,
			admin: { domain: DOMAIN },
		}).admin;
		expect(admin).toEqual({
			seoPages: ['/', '/shop'],
			indexNow: { keySet: true, keyLocation: `https://${DOMAIN}/abcdefgh.txt` },
			retentionMonths: 6,
		});
		// no retention without Visitor analytics (the analytics dashboard needs it)
		expect(adminSettings(['indexnow'], { indexnow: { keyPath: 'x' } }, DOMAIN)).toMatchObject({
			indexNow: { keySet: false, keyLocation: null },
			retentionMonths: null,
		});
		expect(adminSettings(['indexnow'], { indexnow: { keyPath: '/k.txt' } }, DOMAIN).indexNow?.keyLocation).toBe(
			`https://${DOMAIN}/k.txt`,
		);
		expect(adminSettings([], {}, DOMAIN).indexNow).toBeNull();
		expect(widgetSettings({ on: [], values: {}, now: NOW }).admin).toBeNull();
		expect(widgetSettings({ on: [], values: {}, now: NOW })).toMatchObject({
			consent: { banner: false, position: 'bottom', privacyUrl: null, askAgainMonths: 12 },
			record: { requireConsent: true },
			notices: [],
		});
		// G7: the banner in the middle or a corner; a position it does not know is the bottom
		for (const position of ['center', 'bottom_left', 'bottom_right'])
			expect(
				widgetSettings({ on: ['consent_banner'], values: { consent_banner: { position } }, now: NOW }).consent.position,
			).toBe(position);
		expect(
			widgetSettings({ on: ['consent_banner'], values: { consent_banner: { position: 'side' } }, now: NOW }).consent.position,
		).toBe('bottom');
		// G3: the merchant's categories go to the page, their scripts with the tags
		const own = widgetSettings({
			on: ['consent_banner', 'custom_scripts'],
			values: {},
			now: NOW,
			lists: {
				consent_categories: [
					{ key: 'stats', name: 'Stats', description: '', mode: 'opt_in', signals: ['analytics_storage'], scripts: 'x()' },
				],
			},
		});
		expect(own.consent.categories).toEqual([
			{ key: 'stats', name: 'Stats', description: '', mode: 'opt_in', signals: ['analytics_storage'] },
		]);
		expect(own.tags.scripts).toEqual({ stats: 'x()' });
		// G6: the merchant's months, from the banner's settings
		expect(
			widgetSettings({ on: ['consent_banner'], values: { consent_banner: { askAgainMonths: 6 } }, now: NOW }).consent,
		).toMatchObject({ askAgainMonths: 6 });
	});
});

describe('consent', () => {
	const CATEGORIES = DEFAULT_CATEGORIES.map(({ key, name, description, mode, signals }) => ({
		key,
		name,
		description,
		mode,
		signals,
	}));

	it('reads a kept choice until it is too old or a category is new (G3, G6)', () => {
		const choice = makeChoice({ analytics: true, marketing: false }, NOW, CATEGORIES);
		// required on, opt-in only when picked, opt-out unless picked off
		expect(choice.categories).toEqual({
			necessary: true,
			preferences: false,
			analytics: true,
			marketing: false,
			sale_sharing: true,
		});
		/** @param {number} at @param {number} [months] */
		const read = (at, months = 12) => readChoice(JSON.stringify(choice), at, months, CATEGORIES);
		expect(read(NOW + 1000)).toEqual(choice);
		expect(read(NOW + 366 * 86_400_000)).toBeNull();
		expect(read(NOW - 2 * 86_400_000)).toBeNull();
		expect(readChoice('{', NOW, 12, CATEGORIES)).toBeNull();
		expect(readChoice('{"analytics":true,"marketing":true,"at":"2026-10-08T12:00:00Z"}', NOW, 12, CATEGORIES)).toBeNull();
		expect(readChoice(null, NOW, 12, CATEGORIES)).toBeNull();
		// a category added since the choice: asked again
		expect(
			readChoice(JSON.stringify(choice), NOW, 12, [
				...CATEGORIES,
				{ .../** @type {(typeof CATEGORIES)[number]} */ (CATEGORIES[1]), key: 'new_one' },
			]),
		).toBeNull();
		// G6: asked again after the merchant's months (12 by default), counted in calendar months
		/** @param {number} count */
		const days = (count) => NOW + count * 86_400_000;
		expect(read(days(364))).toEqual(choice);
		expect(read(days(365))).toBeNull();
		expect(read(days(150), 6)).toEqual(choice);
		expect(read(Date.parse('2027-04-08T12:00:00Z'), 6)).toBeNull();
		expect(read(days(700), 24)).toEqual(choice);
		const lastDay = makeChoice({}, Date.parse('2026-01-31T12:00:00Z'), CATEGORIES);
		expect(readChoice(JSON.stringify(lastDay), Date.parse('2026-02-28T11:00:00Z'), 1, CATEGORIES)).toEqual(lastDay);
		expect(readChoice(JSON.stringify(lastDay), Date.parse('2026-02-28T12:00:00Z'), 1, CATEGORIES)).toBeNull();
		expect(consentSchema.properties.askAgainMonths.default).toBe(12);
		expect([consentMonthsOf(6), consentMonthsOf(24), consentMonthsOf(0), consentMonthsOf(25)]).toEqual([6, 24, 12, 12]);
		expect([consentMonthsOf(2.5), consentMonthsOf('6'), consentMonthsOf(undefined)]).toEqual([12, 12, 12]);
	});

	it('turns categories into Consent Mode signals: a signal needs every category that lists it (G3)', () => {
		// nothing chosen, tags wait for consent: the required and opt-out categories only
		const before = grantedOf(null, CATEGORIES);
		expect(before).toEqual({ necessary: true, preferences: false, analytics: false, marketing: false, sale_sharing: true });
		expect(consentMode(before, CATEGORIES)).toEqual({
			ad_storage: 'denied',
			ad_user_data: 'denied',
			ad_personalization: 'denied',
			analytics_storage: 'denied',
			functionality_storage: 'denied',
			personalization_storage: 'denied',
			security_storage: 'granted',
		});
		// Global Privacy Control turns opt-out categories off
		expect(grantedOf(null, CATEGORIES, { gpc: true }).sale_sharing).toBe(false);
		// tags need no consent: everything on until a choice (opt-out still off with GPC)
		expect(grantedOf(null, CATEGORIES, { consentRequired: false })).toMatchObject({ analytics: true, marketing: true });
		const all = grantedOf(makeChoice({ analytics: true, marketing: true }, NOW, CATEGORIES), CATEGORIES);
		expect(allows(all, CATEGORIES, TAG_SIGNALS.meta)).toBe(true);
		expect(allows(all, CATEGORIES, ANALYTICS_SIGNALS)).toBe(true);
		// the US opt-out of the sale or sharing of personal data blocks the ad pixels, not analytics
		const optedOut = grantedOf(
			makeChoice({ analytics: true, marketing: true, sale_sharing: false }, NOW, CATEGORIES),
			CATEGORIES,
		);
		expect(consentMode(optedOut, CATEGORIES)).toMatchObject({
			ad_storage: 'granted',
			ad_user_data: 'denied',
			ad_personalization: 'denied',
		});
		expect(allows(optedOut, CATEGORIES, TAG_SIGNALS.meta)).toBe(false);
		expect(allows(optedOut, CATEGORIES, TAG_SIGNALS.ga4)).toBe(true);
		// Tag Manager: not on an opt-out category alone before a choice
		expect(anyChosen(before, CATEGORIES, false)).toBe(false);
		expect(anyChosen(all, CATEGORIES, true)).toBe(true);
		expect(anyChosen(grantedOf(makeChoice({}, NOW, CATEGORIES), CATEGORIES), CATEGORIES, true)).toBe(true);
		expect(anyChosen(grantedOf(makeChoice({ sale_sharing: false }, NOW, CATEGORIES), CATEGORIES), CATEGORIES, true)).toBe(
			false,
		);
		// a signal no category lists is denied
		expect(consentMode({ a: true }, [{ key: 'a', name: 'A', description: '', mode: 'opt_in', signals: [] }]).ad_storage).toBe(
			'denied',
		);
	});
});

describe('pixels and money', () => {
	it('converts minor units', () => {
		expect(toMajor(1250, 'USD')).toBe(12.5);
		expect(toMajor(1250, 'JPY')).toBe(1250);
		expect(toMajor(1250, 'KWD')).toBe(1.25);
	});

	it('names each event per pixel as the merchant’s conversion actions say (G5)', () => {
		/** @param {string} event */
		const action = (event) => DEFAULT_ACTIONS.find((entry) => entry.event === event) ?? null;
		const purchaseAction = { ...action('purchase'), adsLabel: 'L' };
		const detail = detailOf({
			currency: 'USD',
			value: 2500,
			orderId: 'o1',
			items: [{ id: 'a', variantId: 'v', name: 'Case', price: 1250, quantity: 2 }, { id: 'b' }, null],
		});
		expect(detail.items).toHaveLength(2);
		const calls = pixelCalls(
			'purchase',
			detail,
			{ meta: true, google: true, gtm: false, ads: { id: 'AW-1' }, tiktok: true },
			'product',
			/** @type {any} */ (purchaseAction),
		);
		expect(calls.map((call) => [call.vendor, call.args[0], call.args[1]])).toEqual([
			['meta', 'track', 'Purchase'],
			['google', 'event', 'purchase'],
			['google', 'event', 'conversion'],
			['tiktok', 'CompletePayment', expect.any(Object)],
		]);
		expect(calls[1]?.args[2]).toMatchObject({
			value: 25,
			currency: 'USD',
			transaction_id: 'o1',
			items: [
				{ item_id: 'a', item_name: 'Case', item_variant: 'v', quantity: 2, price: 12.5 },
				{ item_id: 'b', quantity: 1 },
			],
		});
		expect(calls[0]?.args[3]).toEqual({ eventID: 'purchase-o1' });
		expect(calls[2]?.args[2]).toEqual({ send_to: 'AW-1/L', value: 25, currency: 'USD', transaction_id: 'o1' });
		// no action: no pixel gets the event; a name left empty: not that pixel; another Meta name: trackCustom
		expect(pixelCalls('purchase', detail, { meta: true, google: true, gtm: false, ads: null, tiktok: true })).toEqual([]);
		const renamed = pixelCalls(
			'add_to_cart',
			detail,
			{ meta: true, google: true, gtm: false, ads: null, tiktok: true },
			'product',
			{
				event: 'add_to_cart',
				meta: 'AddedToBag',
				google: '',
				tiktok: 'AddToCart',
				adsLabel: '',
			},
		);
		expect(renamed.map((call) => [call.vendor, call.args[0], call.args[1]])).toEqual([
			['meta', 'trackCustom', 'AddedToBag'],
			['tiktok', 'AddToCart', expect.any(Object)],
		]);
		const bare = detailOf('nothing');
		expect(
			pixelCalls(
				'view_item',
				bare,
				{ meta: true, google: true, gtm: false, ads: null, tiktok: false },
				'product',
				action('view_item'),
			)[0]?.args[2],
		).toEqual({
			content_ids: [],
			content_type: 'product',
			num_items: 0,
		});
		expect(
			pixelCalls(
				'add_to_cart',
				bare,
				{ meta: false, google: false, gtm: false, ads: null, tiktok: false },
				'product',
				action('add_to_cart'),
			),
		).toEqual([]);
		// the Tag Manager container takes GA4 ecommerce events from its dataLayer (G1); the Ads conversion needs gtag.js
		const tagManager = pixelCalls(
			'purchase',
			detail,
			{ meta: false, google: false, gtm: true, ads: null, tiktok: false },
			'product',
			action('purchase'),
		);
		expect(tagManager).toEqual([
			{ vendor: 'datalayer', args: [{ ecommerce: null }] },
			{
				vendor: 'datalayer',
				args: [{ event: 'purchase', ecommerce: expect.objectContaining({ transaction_id: 'o1', value: 25 }) }],
			},
		]);
		expect(funnelEvent('purchase', detail, '/c')).toMatchObject({ type: 'purchase', orderId: 'o1', value: 2500 });
		// G2: variant ids, searches and contacts
		const all = { meta: true, google: true, gtm: true, ads: null, tiktok: true };
		const byVariant = pixelCalls('add_to_cart', detail, all, 'variant', action('add_to_cart'));
		expect(byVariant[0]?.args[2]).toMatchObject({ content_ids: ['v', 'b'] });
		expect(byVariant.at(-1)?.args[1]).toMatchObject({ contents: [{ content_id: 'v' }, { content_id: 'b' }] });
		expect(searchOf({ term: ' a  b ', results: 2 })).toEqual({ term: 'a b', results: 2 });
		expect(searchOf({ term: 'x', results: -1 })).toEqual({ term: 'x', results: null });
		expect(searchOf(null)).toBeNull();
		expect(contactOf({ method: 'Phone' })).toEqual({ method: 'phone' });
		expect(contactOf({ method: 'no spaces allowed' })).toEqual({ method: null });
		expect(contactOf(undefined)).toEqual({ method: null });
		expect(searchCalls('shoes', all, action('search')).map((call) => [call.vendor, ...call.args])).toEqual([
			['meta', 'track', 'Search', { search_string: 'shoes' }],
			['google', 'event', 'search', { search_term: 'shoes' }],
			['datalayer', { event: 'search', search_term: 'shoes' }],
			['tiktok', 'Search', { query: 'shoes' }],
		]);
		expect(contactCalls(null, { ...all, gtm: false }, action('contact'))).toEqual([
			{ vendor: 'meta', args: ['track', 'Contact', {}] },
			{ vendor: 'google', args: ['event', 'generate_lead', {}] },
			{ vendor: 'tiktok', args: ['Contact', {}] },
		]);
		expect(searchCalls('x', { meta: false, google: false, gtm: false, ads: null, tiktok: false }, action('search'))).toEqual(
			[],
		);
		expect(searchCalls('x', all)).toEqual([]);
		// G2: the merchant's own event, with its properties, to the pixels its action names
		expect(
			customCalls(
				{ plan: 'pro' },
				{ ...all, gtm: false, ads: { id: 'AW-1' } },
				{
					event: 'book_demo',
					meta: 'Schedule',
					google: 'book_demo',
					tiktok: '',
					adsLabel: 'Demo1',
				},
			),
		).toEqual([
			{ vendor: 'meta', args: ['track', 'Schedule', { plan: 'pro' }] },
			{ vendor: 'google', args: ['event', 'book_demo', { plan: 'pro' }] },
			{ vendor: 'google', args: ['event', 'conversion', { send_to: 'AW-1/Demo1' }] },
		]);
		expect(customCalls({}, all)).toEqual([]);
		// G7: a Web Vital as a GA4 event, labeled as web.dev's guide does (SG-26)
		expect(vitalCalls('CLS', 125.4, 'needs_improvement', { ...all, gtm: false }, 'v1-1-CLS')).toEqual([
			{
				vendor: 'google',
				args: [
					'event',
					'CLS',
					{
						value: 125,
						metric_id: 'v1-1-CLS',
						metric_value: 0.125,
						metric_rating: 'needs-improvement',
						event_category: 'web-vitals',
						event_label: 'v1-1-CLS',
						non_interaction: true,
					},
				],
			},
		]);
		expect(vitalCalls('LCP', 900, 'good', { ...all, google: false }, 'v1-1-LCP')[0]).toEqual({
			vendor: 'datalayer',
			args: [
				{
					event: 'LCP',
					value: 900,
					metric_id: 'v1-1-LCP',
					metric_value: 900,
					metric_rating: 'good',
					event_category: 'web-vitals',
					event_label: 'v1-1-LCP',
					non_interaction: true,
				},
			],
		});
		expect(funnelEvent('view_item', bare, '/c')).toEqual({ type: 'view_item', path: '/c', items: [] });
	});
});

describe('SEO', () => {
	it('builds robots.txt and the verification tags from the settings', () => {
		// no sitemap set: the website's /sitemap.xml (Ecommerce's sitemap route serves it), so search engines find it
		expect(robotsTxtOf({}, DOMAIN)).toBe(`Sitemap: https://${DOMAIN}/sitemap.xml\n`);
		expect(robotsTxtOf({ robotsRules: 'User-agent: *\r\nAllow: /\n\n', sitemaps: [] }, DOMAIN)).toBe(
			`User-agent: *\nAllow: /\n\nSitemap: https://${DOMAIN}/sitemap.xml\n`,
		);
		// sitemaps set, none of them on the website: no Sitemap line
		expect(
			robotsTxtOf({ robotsRules: 'User-agent: *\r\nAllow: /\n\n', sitemaps: ['https://other.example/s.xml'] }, DOMAIN),
		).toBe('User-agent: *\nAllow: /\n');
		expect(tokenOf('<meta name="x" content=" t-1 ">')).toBe('t-1');
		expect(tokenOf('bad token')).toBeNull();
		expect(tokenOf(3)).toBeNull();
		expect(verificationOf({ bingVerification: 'B1', metaVerification: 'M1' }).html).toBe(
			'<meta name="msvalidate.01" content="B1">\n<meta name="facebook-domain-verification" content="M1">',
		);
		expect(siteUrlOf('https://shop.example.com:8443/', DOMAIN)).toBeNull();
		expect(siteUrlOf('not a url', DOMAIN)).toBeNull();
		expect(siteUrlOf(1, DOMAIN)).toBeNull();
	});

	it('keeps only search results out by default, and the online store preset adds the shop pages (G12)', () => {
		const defaults = Object.fromEntries(Object.entries(robotsSchema.properties).map(([name, field]) => [name, field.default]));
		const searchParams = searchParamsOf(String(searchesSchema.properties.searchParams.default));
		// a site of any kind: no shop names by default
		expect(defaults.blockParameters).toBe('');
		expect(defaults.blockPaths).toEqual([]);
		expect(robotsPresetsOf(defaults, DOMAIN, searchParams)).toEqual(
			['q', 's', 'search', 'query'].flatMap((name) => [`Disallow: /*?${name}=`, `Disallow: /*&${name}=`]),
		);
		expect(ONLINE_STORE_PRESET).toEqual({
			blockSearchPages: true,
			blockParameters: 'sort, minPrice, maxPrice, inStock',
			blockPaths: ['/cart', '/checkout', '/account'],
		});
	});

	it('blocks the AI training crawlers the merchant picks, and their own user agents (G13)', () => {
		const base = { robotsRules: 'User-agent: *\nAllow: /', sitemaps: ['https://other.example/s.xml'] };
		expect(robotsTxtOf(base, DOMAIN)).toBe('User-agent: *\nAllow: /\n');
		expect(
			robotsTxtOf(
				{
					...base,
					aiCrawlers: ['GPTBot', 'CCBot', 'NotABot'],
					moreAiCrawlers: ['ExampleAI-Crawler', 'bad agent!', 'GPTBot'],
				},
				DOMAIN,
			),
		).toBe(
			[
				'User-agent: *',
				'Allow: /',
				'',
				'User-agent: GPTBot',
				'User-agent: CCBot',
				'User-agent: ExampleAI-Crawler',
				'Disallow: /',
				'',
			].join('\n'),
		);
		expect(AI_TRAINING_CRAWLERS).toContain('ClaudeBot');
	});

	it('adds the merchant’s own verification tags, escaped, and never a tag that changes the page (G8)', () => {
		expect(
			verificationOf({ googleVerification: 'G1' }, [
				{ name: 'p:domain_verify', content: 'abc123' },
				{ name: 'robots', content: 'noindex' },
				{ name: 'baidu-site-verification', content: '<meta name="baidu-site-verification" content="code-x1" />' },
				{ name: 'bad name"', content: 'x' },
				{ name: 'norton', content: 'bad"content' },
			]),
		).toEqual({
			tags: [
				{ name: 'google-site-verification', content: 'G1' },
				{ name: 'p:domain_verify', content: 'abc123' },
				{ name: 'baidu-site-verification', content: 'code-x1' },
			],
			html: [
				'<meta name="google-site-verification" content="G1">',
				'<meta name="p:domain_verify" content="abc123">',
				'<meta name="baidu-site-verification" content="code-x1">',
			].join('\n'),
		});
		expect(checkList('verification_tags', [{ name: 'robots', content: 'x' }])).toMatchObject({
			ok: false,
			errors: [{ path: '/value/0/name' }],
		});
		expect(checkList('verification_tags', [{ name: 'yandex-verification', content: 'a b' }])).toMatchObject({
			ok: false,
			errors: [{ path: '/value/0/content' }],
		});
	});

	it('keeps search results, sorted and filtered lists and private pages out with the online store preset (G12), never what search needs', () => {
		const defaults = {
			...Object.fromEntries(Object.entries(robotsSchema.properties).map(([name, field]) => [name, field.default])),
			...ONLINE_STORE_PRESET,
		};
		const searchParams = searchParamsOf(String(searchesSchema.properties.searchParams.default));
		const presets = [
			...['q', 's', 'search', 'query', 'sort', 'minPrice', 'maxPrice', 'inStock'].flatMap((name) => [
				`Disallow: /*?${name}=`,
				`Disallow: /*&${name}=`,
			]),
			...['/cart', '/checkout', '/account'].flatMap((path) => [
				`Disallow: ${path}$`,
				`Disallow: ${path}/`,
				`Disallow: ${path}?`,
			]),
		];
		expect(robotsPresetsOf(defaults, DOMAIN, searchParams)).toEqual(presets);
		const served = robotsTxtOf(defaults, DOMAIN, searchParams);
		// inside the merchant's own group, before its rules (crawlers that take the first matching rule see them first)
		expect(served).toBe(['User-agent: *', ...presets, 'Allow: /', '', `Sitemap: https://${DOMAIN}/sitemap.xml`, ''].join('\n'));
		// as the SEO checklist reads robots.txt (Google's rules): what search engines need stays open
		const groups = robotsGroupsOf(served);
		/** @param {string} path @param {string[]} [tokens] */
		const allowed = (path, tokens = ['googlebot']) => robotsAllows(groups, tokens, path).allowed;
		for (const path of [
			'/',
			'/sitemap.xml',
			'/products/blue-lamp',
			'/categories/lamps',
			'/categories/lamps?page=2',
			'/categories/lamps?brand=acme&grade=new',
			'/cartoons',
			'/cart-covers/blue',
			'/accounting-books',
			'/checkouts-guide',
			'/search',
			'/products/blue-lamp?size=s',
		])
			expect({ path, allowed: allowed(path) }).toEqual({ path, allowed: true });
		expect(allowed('/media/blue.jpg', ['googlebot-image', 'googlebot'])).toBe(true);
		for (const path of [
			'/search?q=lamp',
			'/?s=lamp',
			'/categories/lamps?brand=acme&sort=price_asc',
			'/categories/lamps?minPrice=1000&maxPrice=5000',
			'/categories/lamps?inStock=1',
			'/cart',
			'/cart/',
			'/cart?step=2',
			'/checkout/pay',
			'/account',
			'/account/orders/12',
		])
			expect({ path, allowed: allowed(path) }).toEqual({ path, allowed: false });

		// the merchant's own names and paths; off, nothing is added
		expect(
			robotsPresetsOf(
				{ blockSearchPages: false, blockParameters: 'order, attr.*, bad!, *, sort', blockPaths: ['/Kasse/', '/çart'] },
				DOMAIN,
				searchParams,
			),
		).toEqual([
			'Disallow: /*?order=',
			'Disallow: /*&order=',
			'Disallow: /*?attr.',
			'Disallow: /*&attr.',
			'Disallow: /*?sort=',
			'Disallow: /*&sort=',
			'Disallow: /Kasse$',
			'Disallow: /Kasse/',
			'Disallow: /Kasse?',
			'Disallow: /%C3%A7art$',
			'Disallow: /%C3%A7art/',
			'Disallow: /%C3%A7art?',
		]);
		// never the home page, a pattern, a query, a host or the sitemap
		for (const path of ['/', '//cart', 'cart', '/a b', '/x*', '/x$', '/x?y', '/x#y', '/sitemap.xml', 3])
			expect(robotsPresetsOf({ blockPaths: [path] }, DOMAIN, [])).toEqual([]);
		expect(robotsPresetsOf({ blockPaths: ['/maps'], sitemaps: [`https://${DOMAIN}/maps/sitemap.xml`] }, DOMAIN, [])).toEqual(
			[],
		);
		expect(robotsPresetsOf({ blockSearchPages: true, blockParameters: 7, blockPaths: 'cart' }, DOMAIN, ['q'])).toEqual([
			'Disallow: /*?q=',
			'Disallow: /*&q=',
		]);
		expect(
			robotsTxtOf({ ...defaults, blockSearchPages: false, blockParameters: '', blockPaths: [] }, DOMAIN, searchParams),
		).toBe(`User-agent: *\nAllow: /\n\nSitemap: https://${DOMAIN}/sitemap.xml\n`);

		// every group of the merchant's rules gets them; without a group for every crawler, one is added first
		const own = { blockSearchPages: true, blockPaths: ['/cart'] };
		expect(
			robotsTxtOf(
				{
					...own,
					robotsRules:
						'User-agent: Googlebot\nUser-agent: Bingbot # big ones\nCrawl-delay: 1\nAllow: /\n\nUser-agent: *\nDisallow: /admin',
				},
				DOMAIN,
				['q'],
			),
		).toBe(
			[
				'User-agent: Googlebot',
				'User-agent: Bingbot # big ones',
				'Crawl-delay: 1',
				'Disallow: /*?q=',
				'Disallow: /*&q=',
				'Disallow: /cart$',
				'Disallow: /cart/',
				'Disallow: /cart?',
				'Allow: /',
				'',
				'User-agent: *',
				'Disallow: /*?q=',
				'Disallow: /*&q=',
				'Disallow: /cart$',
				'Disallow: /cart/',
				'Disallow: /cart?',
				'Disallow: /admin',
				'',
				`Sitemap: https://${DOMAIN}/sitemap.xml`,
				'',
			].join('\n'),
		);
		expect(
			robotsTxtOf({ ...own, robotsRules: 'User-agent: Googlebot\nDisallow: /tmp\nUser-agent: AdsBot-Google' }, DOMAIN, ['q']),
		).toBe(
			[
				'User-agent: *',
				'Disallow: /*?q=',
				'Disallow: /*&q=',
				'Disallow: /cart$',
				'Disallow: /cart/',
				'Disallow: /cart?',
				'',
				'User-agent: Googlebot',
				'Disallow: /*?q=',
				'Disallow: /*&q=',
				'Disallow: /cart$',
				'Disallow: /cart/',
				'Disallow: /cart?',
				'Disallow: /tmp',
				'User-agent: AdsBot-Google',
				'Disallow: /*?q=',
				'Disallow: /*&q=',
				'Disallow: /cart$',
				'Disallow: /cart/',
				'Disallow: /cart?',
				'',
				`Sitemap: https://${DOMAIN}/sitemap.xml`,
				'',
			].join('\n'),
		);
		expect(robotsTxtOf({ ...own, robotsRules: '' }, DOMAIN, [])).toBe(
			`User-agent: *\nDisallow: /cart$\nDisallow: /cart/\nDisallow: /cart?\n\nSitemap: https://${DOMAIN}/sitemap.xml\n`,
		);
	});

	it('checks IndexNow submissions', () => {
		expect(indexNowSubmission({ urls: [], key: 'short', domain: DOMAIN })).toMatchObject({ ok: false, field: 'key' });
		// G5: the key file's own path
		expect(keyPathOf(' /k.txt ')).toBe('/k.txt');
		expect(keyPathOf(undefined)).toBe('');
		for (const bad of ['k.txt', '//x/k.txt', '/a b.txt', '/k.txt?x', `/${'a'.repeat(300)}`]) expect(keyPathOf(bad)).toBeNull();
		expect(keyLocationOf({ key: 'abcdefgh', keyPath: '' }, DOMAIN)).toBe(`https://${DOMAIN}/abcdefgh.txt`);
		expect(keyLocationOf({ key: 'abcdefgh', keyPath: '/i/key.txt' }, DOMAIN)).toBe(`https://${DOMAIN}/i/key.txt`);
		expect(indexNowSubmission({ urls: [], key: 'abcdefgh', keyPath: 'x', domain: DOMAIN })).toMatchObject({
			ok: false,
			field: 'keyPath',
		});
		expect(indexNowSubmission({ urls: 'x', key: 'abcdefgh', domain: DOMAIN })).toMatchObject({ ok: false, field: 'urls' });
	});

	it('writes the activity-log label and detail of a submission and a checklist run', () => {
		const url = `https://${DOMAIN}`;
		expect(indexNowActivity([`${url}/a`], 200)).toEqual({
			label: '1 page submitted to IndexNow',
			detail: 'IndexNow answered 200. Pages: /a',
		});
		const many = Array.from({ length: 52 }, (_, i) => `${url}/p${i}?v=1`);
		const submitted = indexNowActivity(many, null);
		expect(submitted.label).toBe('52 pages submitted to IndexNow');
		expect(submitted.detail).toMatch(/^IndexNow answered nothing\. Pages: \/p0\?v=1, .*\/p49\?v=1 and 2 more$/);
		expect(checksActivity([`${url}/`], { pass: 3, warn: 1, fail: 0 })).toEqual({
			label: '/',
			detail: '3 passed, 1 to improve, 0 to fix. Pages: /',
		});
		expect(checksActivity([`${url}/`, `${url}/shop`, 'not a url'], { pass: 1, warn: 2, fail: 3 })).toEqual({
			label: '/ and 2 more',
			detail: '1 passed, 2 to improve, 3 to fix. Pages: /, /shop, not a url',
		});
	});
});

describe('snippets', () => {
	it('fill in the product’s address and the permissions', () => {
		const snippets = createSnippets({
			base: 'https://growth.example.dev',
			widgets: [
				{ key: 'consent_banner', kind: 'visitor' },
				{ key: 'analytics_dashboard', kind: 'admin' },
			],
			permissions: ['analytics.read'],
		});
		expect(snippets.pageScript).toContain('https://growth.example.dev/widget.js');
		expect(snippets.admin).toContain('data-ss-growth="analytics_dashboard"');
		expect(snippets.admin).not.toContain('consent_banner');
		expect(snippets.ticketNode).toContain('["analytics.read"]');
		expect(snippets.notice).toContain('https://growth.example.dev/v1/notice?path=');
		expect(snippets.analytics).toContain('/v1/events/counts?by=type');
	});
});

describe('merchant lists', () => {
	it('checks a list field by field, fills defaults and names every wrong field', () => {
		expect(checkList('goals', [{ key: 'Signup', name: ' Signed up ', match: 'sign_up' }])).toEqual({
			ok: true,
			value: [{ key: 'signup', name: 'Signed up', kind: 'event', match: 'sign_up' }],
		});
		expect(
			checkList('goals', [
				{ key: 'a', name: 'A', kind: 'page', match: 'thank-you' },
				{ key: 'a', name: 'B', match: 'b' },
				{ key: 'c', name: '', match: 'c', extra: 1 },
			]),
		).toMatchObject({
			ok: false,
			errors: [{ path: '/value/0/match' }, { path: '/value/2/extra' }, { path: '/value/2/name' }, { path: '/value/1/key' }],
		});
		expect(checkList('funnels', [{ key: 'f', name: 'F', steps: [{ name: 'Only', match: 'x' }] }])).toMatchObject({
			ok: false,
			errors: [{ path: '/value/0/steps' }],
		});
		expect(checkList('goals', {})).toMatchObject({ ok: false, errors: [{ path: '/value' }] });
		expect(
			checkList(
				'verification_tags',
				Array.from({ length: 21 }, (_, n) => ({ name: `t${n}`, content: 'x' })),
			),
		).toMatchObject({
			ok: false,
		});
	});

	it('reads a list never saved as its defaults, and leaves out an entry that no longer passes', () => {
		expect(readList('funnels', undefined)).toEqual([SHOP_FUNNEL]);
		expect(readList('goals', undefined).map((goal) => goal.key)).toEqual(['purchase', 'contact']);
		expect(
			readList('goals', [
				{ key: 'ok', name: 'OK', match: 'ok' },
				{ key: 'bad key', name: 'X', match: 'x' },
			]),
		).toEqual([{ key: 'ok', name: 'OK', kind: 'event', match: 'ok' }]);
		expect(readList('goals', 'nonsense')).toEqual([]);
		expect(readList('announcements', undefined)).toEqual([]);
	});

	it('finds the instant of a wall-clock time in a time zone, also around a daylight-saving change', () => {
		/** @param {string} zone */
		const partsIn = (zone) => (/** @type {number} */ at) => zonedParts(at, zone);
		expect(new Date(zonedTimeOf('2026-11-20T09:30', partsIn('America/New_York'))).toISOString()).toBe(
			'2026-11-20T14:30:00.000Z',
		);
		expect(new Date(zonedTimeOf('2026-07-01T00:00', partsIn('Asia/Karachi'))).toISOString()).toBe('2026-06-30T19:00:00.000Z');
		expect(new Date(zonedTimeOf('2026-03-29T03:30', partsIn('Europe/Berlin'))).toISOString()).toBe('2026-03-29T01:30:00.000Z');
		expect(zonedTimeOf('2026-13-01T00:00', partsIn('UTC'))).toBeNaN();
	});
});
