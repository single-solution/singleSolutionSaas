// @vitest-environment jsdom
/**
 * The dashboard in the browser (jsdom), on a faked dashboard API: Overview's setup at a glance and the Settings notes
 * of the store-conversion options (PLAN 0.8.10 G1, G4–G7): the law warning while tags need no consent, tag ids that are
 * not loaded, Tag Manager missing for GA4, what robots.txt, the verification tags and the IndexNow key file serve, the
 * notice bar now, and Web Vitals to Google Analytics without Google tags. Setup only: no business data.
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@ss/ui/testing';
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

/** @param {string[]} on */
const serve = (on) =>
	vi.stubGlobal(
		'fetch',
		vi.fn(async (/** @type {string} */ path) => {
			const base = `/v1/dashboard/websites/${WEBSITE}`;
			const body =
				path === `${base}/overview`
					? {
							status: { status: 'active', graceEndsAt: null },
							featuresOn: on,
							todayMillicredits: 0,
							checklist: { connections: [], widget: null, business: { found: true } },
							recentChanges: [],
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
};

afterEach(() => {
	cleanup();
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
