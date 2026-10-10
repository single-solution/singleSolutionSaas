import { describe, expect, it } from 'vitest';
import { buildReport, dayStart, daysOf, lastDays, rangeOf } from '../core/analytics.js';
import { linkOf, noticeOf, searchParamsOf, tagsOf, tagsReady, widgetSettings } from '../core/config.js';
import { consentMode, granted, makeChoice, readChoice } from '../core/consent.js';
import { checkBatch, checkEvent, countryOf, dayOf, expiryOf, mergeTotals, pathOf, ratingOf, textOf } from '../core/events.js';
import { decimalsOf, isAmount, toMajor } from '../core/money.js';
import { detailOf, funnelEvent, pixelCalls } from '../core/pixels.js';
import {
	attributesOf,
	blocksAll,
	checksActivity,
	indexNowActivity,
	indexNowSubmission,
	pageChecks,
	pagesOf,
	robotsTxtOf,
	scanHtml,
	siteChecks,
	siteUrlOf,
	tokenOf,
	verificationOf,
} from '../core/seo.js';
import { createSnippets } from '../core/snippets.js';

const NOW = Date.parse('2026-10-08T12:00:00Z');
const DOMAIN = 'shop.example.com';
const context = { domain: DOMAIN, country: 'PK' };

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
		// Karachi is UTC+5: 20:00 UTC is already the next day there; Los Angeles is still on the same day
		expect(dayOf(lateEvening, 'Asia/Karachi')).toBe('2026-10-09');
		expect(dayOf(lateEvening, 'America/Los_Angeles')).toBe('2026-10-08');
		expect(dayOf(lateEvening, null)).toBe('2026-10-08');
		expect(dayOf(lateEvening, 'Not/AZone')).toBe('2026-10-08');
		expect(rangeOf({}, lateEvening, 'Asia/Karachi')).toEqual({ ok: true, from: '2026-09-10', to: '2026-10-09' });
		expect(rangeOf({}, Date.parse('2026-10-08T03:00:00Z'), 'America/Los_Angeles')).toMatchObject({ to: '2026-10-07' });
		expect(lastDays(lateEvening, 'Asia/Karachi')).toEqual({ from: '2026-09-10', to: '2026-10-09' });
		expect(new Date(dayStart('2026-10-09', 'Asia/Karachi')).toISOString()).toBe('2026-10-08T19:00:00.000Z');
		expect(dayStart('2026-13-01', 'UTC')).toBeNaN();
	});

	it('leaves out the parts of features that are off', () => {
		const report = buildReport({
			from: '2026-10-01',
			to: '2026-10-02',
			timeZone: 'Asia/Karachi',
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
		expect(report.timeZone).toBe('Asia/Karachi');
		expect(report.days).toEqual([
			{ day: '2026-10-01', visits: 0, pageViews: 0 },
			{ day: '2026-10-02', visits: 4, pageViews: 0 },
		]);
		expect(report.funnel).toBeNull();
		expect(report.searches).toBeNull();
		expect(report.vitals?.find((v) => v.name === 'CLS')).toMatchObject({ average: 75, count: 2 });
		expect(report.vitals?.find((v) => v.name === 'LCP')).toMatchObject({ average: null });
	});
});

describe('page script settings', () => {
	it('gives well-formed tag ids of switched-on features only', () => {
		const values = {
			meta_pixel: { pixelId: '123456789' },
			google_tags: { ga4Id: 'G-ABCD12', adsId: 'AW-123456', adsPurchaseLabel: 'abcDEF12', gtmId: 'GTM-ABC123' },
			tiktok_pixel: { pixelId: 'CABCDEFGHIJ12' },
			custom_scripts: { analyticsScripts: '<script>a()</script>', marketingScripts: '' },
		};
		const all = ['meta_pixel', 'google_tags', 'tiktok_pixel', 'custom_scripts'];
		expect(tagsOf(all, values)).toEqual({
			meta: '123456789',
			ga4: 'G-ABCD12',
			ads: 'AW-123456',
			adsPurchaseLabel: 'abcDEF12',
			gtm: 'GTM-ABC123',
			tiktok: 'CABCDEFGHIJ12',
			scripts: { analytics: '<script>a()</script>', marketing: '' },
		});
		expect(tagsOf([], values)).toMatchObject({ meta: null, ga4: null, ads: null, gtm: null, tiktok: null });
		expect(
			tagsOf(['google_tags'], { google_tags: { adsId: 'bad', adsPurchaseLabel: 'abcDEF12' } }).adsPurchaseLabel,
		).toBeNull();
		expect(tagsReady(all, values)).toEqual({ ready: 4, total: 4 });
		expect(tagsReady(all, {})).toEqual({ ready: 0, total: 4 });
		expect(tagsReady([], {})).toEqual({ ready: 0, total: 0 });
	});

	it('shows the notice bar only between its dates, with a safe link', () => {
		/** @param {Record<string, unknown>} notice */
		const at = (notice, now = NOW) => noticeOf({ notice_bar: notice }, now);
		expect(at({ text: '' })).toBeNull();
		expect(at({ text: 'Hi', startsAt: 'soon' })).toBeNull();
		expect(at({ text: 'Hi', startsAt: '2026-10-09T00:00:00Z' })).toBeNull();
		expect(at({ text: 'Hi', endsAt: '2026-10-08T12:00:00Z' })).toBeNull();
		expect(at({ text: 'Hi', linkUrl: 'javascript:alert(1)', linkText: 'x', dismissible: false })).toEqual({
			text: 'Hi',
			linkUrl: null,
			linkText: '',
			dismissible: false,
		});
		expect(
			at({ text: 'Hi', linkUrl: 'https://x.example/a', startsAt: '2026-10-01T00:00:00Z', endsAt: '2026-11-01T00:00:00Z' }),
		).toMatchObject({ linkUrl: 'https://x.example/a' });
		expect(linkOf('/a b')).toBeNull();
		expect(linkOf('http://x.example')).toBeNull();
		expect(searchParamsOf('q, term,  bad param!')).toEqual(['q', 'term', 'bad']);
		expect(searchParamsOf('')).toEqual(['q', 's', 'search', 'query']);
	});

	it('assembles what the page script needs', () => {
		const settings = widgetSettings({
			on: ['consent_banner', 'visitor_analytics', 'notice_bar'],
			values: {
				consent_banner: { position: 'top', privacyUrl: '/privacy' },
				visitor_analytics: { requireConsent: false },
				notice_bar: { text: 'Sale' },
			},
			now: NOW,
		});
		expect(settings).toMatchObject({
			consent: { banner: true, position: 'top', privacyUrl: '/privacy' },
			record: { visits: true, funnel: false, requireConsent: false },
			notice: { text: 'Sale' },
		});
		expect(widgetSettings({ on: [], values: {}, now: NOW })).toMatchObject({
			consent: { banner: false, position: 'bottom', privacyUrl: null },
			record: { requireConsent: true },
			notice: null,
		});
	});
});

describe('consent', () => {
	it('reads a kept choice until it is a year old', () => {
		const choice = makeChoice({ analytics: true, marketing: false }, NOW);
		expect(readChoice(JSON.stringify(choice), NOW + 1000)).toEqual(choice);
		expect(readChoice(JSON.stringify(choice), NOW + 366 * 86_400_000)).toBeNull();
		expect(readChoice(JSON.stringify(choice), NOW - 2 * 86_400_000)).toBeNull();
		expect(readChoice('{', NOW)).toBeNull();
		expect(readChoice('{"analytics":1}', NOW)).toBeNull();
		expect(readChoice(null, NOW)).toBeNull();
		expect(consentMode(null)).toEqual({
			ad_storage: 'denied',
			ad_user_data: 'denied',
			ad_personalization: 'denied',
			analytics_storage: 'denied',
		});
		expect(consentMode(choice).analytics_storage).toBe('granted');
		expect(granted(null, 'necessary')).toBe(true);
		expect(granted(choice, 'marketing')).toBe(false);
	});
});

describe('pixels and money', () => {
	it('converts minor units', () => {
		expect(decimalsOf('JPY')).toBe(0);
		expect(decimalsOf('KWD')).toBe(3);
		expect(toMajor(1250, 'USD')).toBe(12.5);
		expect(isAmount(1.5)).toBe(false);
	});

	it('names each shop event per pixel', () => {
		const detail = detailOf({
			currency: 'USD',
			value: 2500,
			orderId: 'o1',
			items: [{ id: 'a', variantId: 'v', name: 'Case', price: 1250, quantity: 2 }, { id: 'b' }, null],
		});
		expect(detail.items).toHaveLength(2);
		const calls = pixelCalls('purchase', detail, { meta: true, google: true, ads: { id: 'AW-1', label: 'L' }, tiktok: true });
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
		const bare = detailOf('nothing');
		expect(pixelCalls('view_item', bare, { meta: true, google: true, ads: null, tiktok: false })[0]?.args[2]).toEqual({
			content_ids: [],
			content_type: 'product',
			num_items: 0,
		});
		expect(pixelCalls('add_to_cart', bare, { meta: false, google: false, ads: null, tiktok: false })).toEqual([]);
		expect(funnelEvent('purchase', detail, '/c')).toMatchObject({ type: 'purchase', orderId: 'o1', value: 2500 });
		expect(funnelEvent('view_item', bare, '/c')).toEqual({ type: 'view_item', path: '/c', items: [] });
	});
});

describe('SEO', () => {
	it('builds robots.txt and the verification tags from the settings', () => {
		expect(robotsTxtOf({}, DOMAIN)).toBe('\n');
		expect(robotsTxtOf({ robotsRules: 'User-agent: *\r\nAllow: /\n\n', sitemaps: 'x' }, DOMAIN)).toBe(
			'User-agent: *\nAllow: /\n',
		);
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

	it('checks IndexNow submissions', () => {
		expect(indexNowSubmission({ urls: [], key: 'short', domain: DOMAIN })).toMatchObject({ ok: false, field: 'key' });
		expect(indexNowSubmission({ urls: 'x', key: 'abcdefgh', domain: DOMAIN })).toMatchObject({ ok: false, field: 'urls' });
	});

	it('scans HTML', () => {
		expect(attributesOf('<img src=a.png alt="" data-x=\'y\' hidden>')).toEqual({
			src: 'a.png',
			alt: '',
			'data-x': 'y',
			hidden: '',
		});
		const scan = scanHtml(
			'<!-- <title>no</title> --><html lang=en><title> A &amp; B&nbsp;&lt;&gt;&quot;&#39; </title><script>var x="<h1>"</script><h1 class="x">',
		);
		expect(scan).toMatchObject({ title: 'A & B <>"\'', lang: 'en', h1: 1, description: null, canonical: null });
		expect(blocksAll('User-agent: bot\nDisallow: /\n\nUser-agent: *\nUser-agent: other\nDisallow: /private # x')).toBe(false);
		expect(blocksAll('User-agent: a\nUser-agent: *\nDisallow: /')).toBe(true);
		expect(pagesOf(['/', '/a', '//b', 'c', 3], DOMAIN)).toEqual([`https://${DOMAIN}/`, `https://${DOMAIN}/a`]);
		expect(pagesOf(undefined, DOMAIN)).toEqual([`https://${DOMAIN}/`]);
	});

	it('checks pages', () => {
		const url = `https://${DOMAIN}/`;
		/** @param {string} body @param {Record<string, string>} [headers] */
		const checks = (body, headers) =>
			Object.fromEntries(pageChecks({ url, status: 200, body, headers }, DOMAIN).map((c) => [c.id, c.status]));
		const thin = checks('<title>Short</title><link rel="canonical" href="https://other.example/">', {
			'x-robots-tag': 'noindex',
		});
		expect(thin).toMatchObject({ noindex: 'fail', title: 'warn', canonical: 'warn', viewport: 'fail', h1: 'warn' });
		expect(checks('<link rel="canonical" href="http://[bad">').canonical).toBe('warn');
		expect(checks('<link rel="canonical" href="/x">').canonical).toBe('pass');
		expect(pageChecks({ url, status: null, body: '' }, DOMAIN)).toEqual([
			{ id: 'reachable', status: 'fail', page: url, detail: { status: 0 } },
		]);
		const site = siteChecks({
			home: { url, status: 500, body: '' },
			robots: { url: `${url}robots.txt`, status: 404, body: '' },
			sitemap: null,
		});
		expect(site.map((c) => c.status)).toEqual(['warn', 'pass', 'warn', 'warn']);
		expect(site[2]?.page).toBeNull();
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
		expect(snippets.analytics).toContain('/v1/events/counts?by=type');
	});
});
