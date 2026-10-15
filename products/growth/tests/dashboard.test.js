// @vitest-environment jsdom
/**
 * The dashboard in the browser (jsdom), on a faked dashboard API: Overview's own part (PLAN 0.6 "Overviews talk": the
 * tags ready, the tag features with no id asked for, the setup at a glance) and the Settings notes
 * of the store-conversion options (PLAN 0.8.10 G1, G4–G7): the law warning while tags need no consent, tag ids that are
 * not loaded, Tag Manager missing for GA4, what robots.txt, the verification tags and the IndexNow key file serve, the
 * notice bar now, and Web Vitals to Google Analytics without Google tags. Setup only: no business data. Times are
 * computed in UTC and shown in the viewer's local time (owner 2026-10-14): UTC on the server and in the first render.
 */
import { act } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { byText, cleanup, click, render } from '@ss/ui/testing';
import { manifest, SHARED_SETTINGS } from '../adapters/product.js';
import { TABS } from '../app/dashboard/tabs.js';
import { TEXTS } from '../app/dashboard/texts.js';

const WEBSITE = 'web_1';
const DOMAIN = 'shop.example.com';
const NOW = Date.parse('2026-10-08T12:00:00Z');

/** @type {Record<string, Record<string, unknown>>} */
const VALUES = {
	tags: { consentRequired: false },
	pixels: { contentIds: 'variant' },
	meta_pixel: { pixelId: 'not-a-pixel' },
	google_tags: { ga4Id: 'G-ABCD12', ga4ViaGtm: true, gtmId: '' },
	visitor_analytics: { detail: 'sessions', retentionMonths: 6 },
	web_vitals: { toGa4: true },
	robots_verification: { blockAiCrawlers: true, sitemaps: [`https://${DOMAIN}/sitemap.xml`], yandexVerification: 'ya-1' },
	searches_404s: { searchParams: 'term' },
	indexnow: { key: 'abcdefgh', keyPath: '/indexnow-key.txt' },
	seo_checklist: { paths: ['/', '/shop'] },
	notice_bar: { text: 'Sale', startsAt: '2026-11-01T00:00:00Z', hideOnPages: ['/'], dismissFor: 'page' },
};
const ON = Object.keys(VALUES).filter((key) => !['tags', 'pixels', 'google_tags', 'web_vitals'].includes(key));
ON.push('google_tags', 'web_vitals');

/** The settings answer of the dashboard API: every feature and shared group with its schema and values. */
const settingsAnswer = (/** @type {string[]} */ on) => ({
	features: [
		...manifest.features.map((feature) => ({ key: feature.key, name: feature.name, schema: feature.settings })),
		...Object.entries(SHARED_SETTINGS).map(([key, group]) => ({ key, name: group.name, schema: group.settings })),
	].map((feature) => ({
		...feature,
		on: on.includes(feature.key) || feature.key === 'tags' || feature.key === 'pixels',
		values: Object.fromEntries(
			Object.entries(/** @type {any} */ (feature.schema).properties).map(([name, node]) => [
				name,
				{ value: VALUES[feature.key]?.[name] ?? /** @type {any} */ (node).default, source: 'website' },
			]),
		),
	})),
});

/** A grace period, the widget's last visit and a change, at known instants (UTC). */
const TIMES = {
	status: { status: 'grace', graceEndsAt: '2026-10-04T14:30:00.000Z' },
	checklist: { connections: [], widget: { installed: true, lastSeenAt: '2026-10-05T23:15:00.000Z' }, business: { found: true } },
	recentChanges: [
		{
			who: { kind: 'user', id: 'u_1', name: 'Alex Morgan' },
			what: 'settings',
			detail: 'Notice bar',
			at: '2026-10-06T08:00:00.000Z',
		},
	],
};

/**
 * The viewer's browser in a time zone (what `Intl.DateTimeFormat().resolvedOptions()` answers there).
 * @param {string} timeZone
 */
const viewerIn = (timeZone) => {
	const real = Intl.DateTimeFormat.prototype.resolvedOptions;
	vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(
		/** @this {Intl.DateTimeFormat} */
		function () {
			return { ...real.call(this), timeZone };
		},
	);
};

/** @param {string[]} on @param {object} [overview] parts of the overview answer */
const serve = (on, overview = {}) =>
	vi.stubGlobal(
		'fetch',
		vi.fn(async (/** @type {string} */ path) => {
			const base = `/v1/dashboard/websites/${WEBSITE}`;
			const body =
				path === `${base}/overview`
					? {
							website: { websiteId: WEBSITE, domain: DOMAIN, merchantId: 'm_1', merchantName: 'Merchant' },
							status: { status: 'active', graceEndsAt: null },
							featuresOn: on,
							todayMillicredits: 0,
							checklist: { connections: [], widget: null, business: { found: true } },
							recentChanges: [],
							...overview,
						}
					: path === `${base}/settings`
						? settingsAnswer(on)
						: path === `${base}/texts`
							? { texts: [] }
							: path === `${base}/theme`
								? { theme: { colors: {}, fontFamily: 'inherit', radius: 8, mode: 'auto', customCss: '' } }
								: path === `${base}/format`
									? {
											format: {
												locale: '',
												currencyDisplay: 'code',
												currencySymbol: '',
												wholeUnits: false,
												times: 'viewer',
											},
										}
									: null;
			return new Response(JSON.stringify(body), { status: body ? 200 : 404 });
		}),
	);

/** Let the loads answer. */
const settle = async () => {
	for (let i = 0; i < 6; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};

const props = {
	websiteId: WEBSITE,
	domain: DOMAIN,
	who: /** @type {const} */ ({ kind: 'merchant', id: 'm_1', name: 'Merchant' }),
	support: { email: 'help@example.com', phone: '' },
	portal: 'https://portal.example.com',
	open: vi.fn(),
};

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('the dashboard (setup only)', () => {
	it('Overview shows the setup of the switched-on features at a glance', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		serve(ON);
		const Overview = TABS.overview;
		const { container } = render(<Overview {...props} />);
		await settle();
		const text = container.textContent ?? '';
		for (const words of [
			TEXTS.setup.title,
			TEXTS.setup.noWait,
			TEXTS.setup.ownTool,
			'Meta' + TEXTS.setup.notSet,
			'Google Analytics 4' + TEXTS.setup.notSet,
			TEXTS.setup.ids.variant,
			TEXTS.setup.sessions,
			'6 months',
			'Web Vitals',
			TEXTS.setup.blocked,
			'yandex-verification',
			`https://${DOMAIN}/indexnow-key.txt`,
			'2 pages',
			'Starts',
			TEXTS.setup.closeFor.page,
			'1 pages',
		])
			expect(text).toContain(words);
	});

	it('Overview counts the Sitemap lines robots.txt serves, /sitemap.xml when none is set', async () => {
		const saved = VALUES.robots_verification ?? {};
		const glance = async () => {
			serve(['robots_verification']);
			const Overview = TABS.overview;
			const { container } = render(<Overview {...props} />);
			await settle();
			const text = container.textContent ?? '';
			cleanup();
			return text;
		};
		try {
			VALUES.robots_verification = { sitemaps: [] };
			expect(await glance()).toContain(`${TEXTS.setup.sitemaps}1`);
			// a sitemap on another site is never named
			VALUES.robots_verification = { sitemaps: ['https://other.example/sitemap.xml'] };
			expect(await glance()).toContain(`${TEXTS.setup.sitemaps}0`);
		} finally {
			VALUES.robots_verification = saved;
		}
	});

	it('Overview asks for the ids of tag features that have none, counts the tags ready and opens Settings', async () => {
		const saved = { meta_pixel: VALUES.meta_pixel ?? {}, google_tags: VALUES.google_tags ?? {} };
		try {
			VALUES.meta_pixel = { pixelId: '' };
			VALUES.google_tags = { ga4Id: '' };
			serve(['meta_pixel', 'google_tags']);
			const Overview = TABS.overview;
			props.open.mockClear();
			const { container } = render(<Overview {...props} />);
			await settle();
			const needs = [...container.querySelectorAll('section[aria-label="Needs you"] li p:first-child')].map(
				(p) => p.textContent,
			);
			expect(needs).toContain('2 tag features have no id or script yet');
			expect(byText(container, TEXTS.overview.tags, 'span').parentElement?.parentElement?.textContent).toContain('0 of 2');
			click(byText(container, 'Open Settings', 'button'));
			click(byText(container, TEXTS.overview.tagsStep, 'button'));
			expect(props.open.mock.calls).toEqual([['settings'], ['settings']]);
			cleanup();
			VALUES.meta_pixel = { pixelId: '1234567890' };
			serve(['meta_pixel', 'google_tags']);
			const one = render(<Overview {...props} />);
			await settle();
			expect(one.container.textContent).toContain('A tag feature has no id or script yet');
		} finally {
			Object.assign(VALUES, saved);
		}
	});

	it('Overview leaves out what is off', async () => {
		serve([]);
		const Overview = TABS.overview;
		const { container } = render(<Overview {...props} />);
		await settle();
		expect(container.textContent).not.toContain(TEXTS.setup.title);
	});

	it('Settings warn about the law, name ids that are not loaded and show what the site serves', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		serve(ON.filter((key) => key !== 'google_tags'));
		const Settings = TABS.settings;
		const { container } = render(<Settings {...props} />);
		await settle();
		const text = container.textContent ?? '';
		expect(text).toContain(TEXTS.settings.consentWarning);
		expect(text).toContain('Not loaded, as they are not well formed: pixelId.');
		expect(text).toContain(TEXTS.settings.gtmMissing);
		expect(text).toContain(TEXTS.setup.vitalsNoGoogle);
		expect(text).toContain('User-agent: GPTBot');
		// the presets (G12), with the search parameters of Searches and 404s
		expect(text).toContain('Disallow: /*?term=');
		expect(text).toContain('Disallow: /cart$');
		expect(text).toContain(`Sitemap: https://${DOMAIN}/sitemap.xml`);
		expect(text).toContain('<meta name="yandex-verification" content="ya-1">');
		expect(text).toContain(`Your site serves the key abcdefgh as plain text at https://${DOMAIN}/indexnow-key.txt`);
		expect(text).toContain('Starts');
	});

	it('Settings say when the key file address is not a path and when the notice shows or has no text', async () => {
		VALUES.indexnow = { key: 'abcdefgh', keyPath: 'nope' };
		VALUES.notice_bar = { text: 'Sale' };
		VALUES.robots_verification = {};
		VALUES.tags = {};
		serve(['indexnow', 'notice_bar', 'robots_verification']);
		const Settings = TABS.settings;
		const { container } = render(<Settings {...props} />);
		await settle();
		const text = container.textContent ?? '';
		expect(text).toContain(TEXTS.setup.keyPathBad);
		expect(text).toContain(TEXTS.setup.noticeShowing);
		expect(text).toContain(TEXTS.setup.noTags);
		expect(text).not.toContain(TEXTS.settings.consentWarning);
	});

	it('Settings say when the merchant turned the notice bar off (AO-2)', async () => {
		VALUES.notice_bar = { text: 'Sale', enabled: false };
		serve(['notice_bar']);
		const Settings = TABS.settings;
		const { container } = render(<Settings {...props} />);
		await settle();
		expect(container.textContent).toContain(TEXTS.setup.noticeOff);
	});

	it('Settings say where Web Vitals go while Visitor analytics is off (SG-27)', async () => {
		VALUES.web_vitals = { toGa4: true };
		serve(['web_vitals', 'google_tags']);
		const Settings = TABS.settings;
		const ga4 = render(<Settings {...props} />);
		await settle();
		expect(ga4.container.textContent).toContain(TEXTS.setup.vitalsGa4Only);
		cleanup();
		VALUES.web_vitals = { toGa4: false };
		const nowhere = render(<Settings {...props} />);
		await settle();
		expect(nowhere.container.textContent).toContain(TEXTS.setup.vitalsNowhere);
	});
});

describe("times: computed in UTC, shown in the viewer's local time (owner 2026-10-14)", () => {
	it("Overview: the grace end, the widget's last visit, the changes and the notice start in the viewer's zone; UTC first", async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		VALUES.notice_bar = { text: 'Sale', startsAt: '2026-11-01T00:00:00Z' };
		viewerIn('America/New_York');
		serve(['notice_bar'], TIMES);
		const Overview = TABS.overview;
		const { container } = render(<Overview {...props} />);
		await settle();
		const text = container.textContent ?? '';
		expect(text).toContain('Growth is in grace until Oct 4, 2026, 10:30 AM EDT');
		expect(text).toContain('Last seen Oct 5, 2026, 7:15 PM EDT');
		// midnight UTC on Nov 1 is still Oct 31 in New York
		expect(text).toContain('Starts Oct 31, 2026, 8:00 PM EDT');
		const change = container.querySelector('ol time');
		expect([change?.textContent, change?.getAttribute('title'), change?.getAttribute('datetime')]).toEqual([
			'Oct 6, 2026, 4:00 AM EDT',
			'Oct 6, 2026, 8:00 AM UTC',
			'2026-10-06T08:00:00.000Z',
		]);
		// the server (and the first render in the browser) print UTC, with the answers this page already loaded
		const html = renderToString(<Overview {...props} />);
		for (const words of [
			' is in grace until ',
			'Oct 4, 2026, 2:30 PM UTC',
			'Oct 5, 2026, 11:15 PM UTC',
			'Starts Nov 1, 2026, 12:00 AM UTC',
			'>Oct 6, 2026, 8:00 AM UTC</time>',
		])
			expect(html).toContain(words);
	});

	it("Settings: the notice bar's end in the viewer's zone; UTC first", async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		VALUES.notice_bar = { text: 'Sale', endsAt: '2026-10-01T03:00:00Z' };
		viewerIn('Asia/Tokyo');
		serve(['notice_bar']);
		const Settings = TABS.settings;
		const { container } = render(<Settings {...props} />);
		await settle();
		expect(container.textContent).toContain('Ended Oct 1, 2026, 12:00 PM GMT+9');
		expect(renderToString(<Settings {...props} />)).toContain('Ended Oct 1, 2026, 3:00 AM UTC');
	});
});
