// @vitest-environment jsdom
/**
 * The dashboard in the browser (jsdom), on a faked dashboard API: Overview's own part (PLAN 0.6 "Overviews talk": the
 * tags ready, the tag features with no id asked for, the setup at a glance) and the Settings notes
 * of the store-conversion options (PLAN 0.8.10 G1, G4–G7): the law warning while tags need no consent, tag ids that are
 * not loaded, Tag Manager missing for GA4, what robots.txt, the verification tags and the IndexNow key file serve, the
 * notice bar now, and Web Vitals to Google Analytics without Google tags (on Defaults, only what the values say).
 * Setup only: no business data. Times are computed in UTC and shown in the viewer's local time (owner 2026-10-14): UTC on
 * the server and in the first render. The tabs render inside the shared dashboard's provider (`@ss/ui/dashboard`).
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DashboardProvider } from '@ss/ui/dashboard';
import { byText, cleanup, click, render } from '@ss/ui/testing';
import { manifest, SHARED_SETTINGS } from '../adapters/product.js';
import { TABS } from '../app/dashboard/tabs.js';
import { TEXTS } from '../app/dashboard/texts.js';
import { LISTS } from '../core/lists.js';
import { closeEditor, editorOf, openRow, rowMenu, rowNames } from './dashboard-provider.js';
import { type } from '@ss/ui/testing';

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
	robots_verification: {
		aiCrawlers: ['GPTBot'],
		blockPaths: ['/cart'],
		sitemaps: [`https://${DOMAIN}/sitemap.xml`],
		yandexVerification: 'ya-1',
	},
	searches_404s: { searchParams: 'term' },
	indexnow: { key: 'abcdefgh', keyPath: '/indexnow-key.txt' },
	seo_checklist: { paths: ['/', '/shop'] },
	notice_bar: { enabled: true },
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

const FORMAT = { locale: '', currencyDisplay: 'code', currencySymbols: {}, wholeUnits: false, times: 'viewer' };

/** The writes the dashboard made. @type {Array<{ path: string, body: any }>} */
const sent = [];

/** @param {string[]} on */
const serve = (on) =>
	vi.stubGlobal(
		'fetch',
		vi.fn(async (/** @type {string} */ path, /** @type {RequestInit | undefined} */ init) => {
			if (init?.method === 'PUT') {
				sent.push({ path, body: JSON.parse(String(init.body)) });
				return new Response(JSON.stringify(JSON.parse(String(init.body))), { status: 200 });
			}
			const base = `/v1/dashboard/websites/${WEBSITE}`;
			const body =
				path === '/v1/dashboard/defaults'
					? { ...settingsAnswer(on), texts: [], recentChanges: [] }
					: path === `${base}/overview`
						? {
								website: { websiteId: WEBSITE, domain: DOMAIN, merchantId: 'm_1', merchantName: 'Merchant' },
								status: { status: 'active', graceEndsAt: null },
								featuresOn: on,
								todayMillicredits: 0,
								checklist: {
									connections: [],
									widget: null,
									website: { version: 1, requires: ['pages.privacy'], missing: [] },
								},
								recentChanges: [],
							}
						: path.startsWith(`${base}/lists/`)
							? { value: LISTS[/** @type {keyof typeof LISTS} */ (path.slice(`${base}/lists/`.length))].defaults() }
							: path === `${base}/settings`
								? settingsAnswer(on)
								: path === `${base}/features`
									? // Settings lists every feature with its switch: the features answer too (the shared groups are no features)
										{
											features: settingsAnswer(on)
												.features.filter((feature) => manifest.features.some((own) => own.key === feature.key))
												.map((feature) => ({
													key: feature.key,
													name: feature.name,
													description: '',
													dependsOn: [],
													millicreditsPerHour: 0,
													on: feature.on,
												})),
										}
									: path === `${base}/texts`
										? { texts: [] }
										: path === `${base}/format`
											? { format: FORMAT }
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
	merchantId: 'm_1',
	domain: DOMAIN,
	who: /** @type {const} */ ({ kind: 'merchant', id: 'm_1', name: 'Merchant' }),
	support: { channels: [{ type: /** @type {const} */ ('email'), label: 'Email', url: 'mailto:help@example.com' }] },
	portal: 'https://portal.example.com',
	open: vi.fn(),
};

/** Growth's tabs with the dashboard's words and feature names around them. @param {typeof props} tab */
const Overview = (tab) => (
	<DashboardProvider manifest={manifest} texts={TEXTS}>
		<TABS.overview {...tab} />
	</DashboardProvider>
);
/** @param {typeof props} tab */
const Settings = (tab) => (
	<DashboardProvider manifest={manifest} texts={TEXTS}>
		<TABS.settings {...tab} />
	</DashboardProvider>
);
/** @param {typeof props} tab */
const Defaults = (tab) => (
	<DashboardProvider manifest={manifest} texts={TEXTS}>
		<TABS.defaults {...tab} />
	</DashboardProvider>
);

/**
 * Opens a row of the list beside the page. A feature is one row with all its groups stacked on its page, so the id of
 * a group (`feature.group`) opens the row of its feature.
 * @param {ParentNode} root @param {string} id
 */
const openSection = (root, id) =>
	click(
		/** @type {HTMLElement} */ (
			root.querySelector(`[role="option"][data-ss-id="${id}"]`) ??
				root.querySelector(`[role="option"][data-ss-id="${id.split('.')[0]}"]`)
		),
	);

/**
 * Opens every row of the list, so the text of all of them is on the page (a view stays mounted once opened).
 * @param {ParentNode} root
 */
const visitAll = async (root) => {
	/** @type {Set<string>} */
	const seen = new Set();
	for (let pass = 0; pass < 3; pass += 1)
		for (const row of [...root.querySelectorAll('[role="option"][data-ss-id]')]) {
			const id = String(row.getAttribute('data-ss-id'));
			if (seen.has(id)) continue;
			seen.add(id);
			openSection(root, id);
			await settle();
		}
};

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('the dashboard (setup only)', () => {
	it('Overview asks for the ids of tag features that have none, counts the tags ready and opens Settings', async () => {
		const saved = { meta_pixel: VALUES.meta_pixel ?? {}, google_tags: VALUES.google_tags ?? {} };
		try {
			VALUES.meta_pixel = { pixelId: '' };
			VALUES.google_tags = { ga4Id: '' };
			serve(['meta_pixel', 'google_tags']);
			props.open.mockClear();
			const { container } = render(<Overview {...props} />);
			await settle();
			const needs = [...container.querySelectorAll('section[aria-label="Needs you"] li p:first-child')].map(
				(p) => p.textContent,
			);
			expect(needs).toContain('2 tag features have no id or script yet');
			expect(byText(container, TEXTS.overview.tags, 'span').parentElement?.parentElement?.textContent).toContain('0 of 2');
			click(byText(container, 'Open Settings', 'button'));
			// each tag feature is a setup step with its why and a button to its own section
			expect(container.textContent).toContain('The Meta pixel loads nothing on your pages until its id is set.');
			expect(container.textContent).toContain('Add a Google tag ID');
			const row = /** @type {HTMLElement} */ (byText(container, 'Add your Meta pixel ID', 'span').closest('li'));
			click(byText(row, 'Add id', 'button'));
			expect(props.open.mock.calls).toEqual([['settings'], ['settings', 'meta_pixel']]);
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

	it('edits a merchant list: add, rename, reorder and remove, then saves the whole list (G1)', async () => {
		sent.length = 0;
		serve(ON.filter((key) => key !== 'google_tags').concat('conversion_funnel'));
		const { container } = render(<Settings {...props} />);
		await settle();
		openSection(container, 'conversion_funnel.goals');
		await settle();
		const card = /** @type {HTMLElement} */ (container.querySelector('[id="section-conversion_funnel.goals"]'));
		// the goals, stacked on the feature's page under their own small heading; the list itself has no second title
		expect(rowNames(card)).toEqual(['Purchase', 'Contact']);
		expect(card.querySelectorAll('h2')).toHaveLength(1);
		// a new goal opens in place, under the last row: its name and event (the kind is a select)
		await act(async () => click(byText(card, TEXTS.lists.add, 'button')));
		const fresh = [...editorOf(card).querySelectorAll('input')];
		await type(/** @type {HTMLInputElement} */ (fresh[1]), 'Booked a demo');
		await type(/** @type {HTMLInputElement} */ (fresh[2]), 'book_demo');
		await closeEditor(card);
		// nothing is saved until the Save bar; move the new goal up, rename Purchase, remove Contact
		expect(sent).toEqual([]);
		await rowMenu(card, 'Booked a demo', TEXTS.lists.up);
		expect(rowNames(card)).toEqual(['Purchase', 'Booked a demo', 'Contact']);
		const purchase = await openRow(card, 'Purchase');
		await type(
			/** @type {HTMLInputElement} */ ([...purchase.querySelectorAll('input')].find((input) => input.value === 'Purchase')),
			'Order',
		);
		await closeEditor(card);
		await rowMenu(card, 'Contact', TEXTS.lists.remove);
		expect(rowNames(card)).toEqual(['Order', 'Booked a demo']);
		await act(async () => click(byText(document.body, TEXTS.lists.save, 'button')));
		await settle();
		expect(sent.at(-1)).toEqual({
			path: `/v1/dashboard/websites/${WEBSITE}/lists/goals`,
			body: {
				value: [
					{ key: 'purchase', name: 'Order', kind: 'event', match: 'purchase' },
					{ key: 'new_3', name: 'Booked a demo', kind: 'event', match: 'book_demo' },
				],
			},
		});
	});

	it('applies the online store preset to robots and verification in one click (G12)', async () => {
		sent.length = 0;
		serve(ON);
		const reload = vi.fn();
		vi.stubGlobal('location', { ...window.location, reload });
		const { container } = render(<Settings {...props} />);
		await settle();
		openSection(container, 'robots_verification.robots-txt');
		openSection(container, 'robots_verification.preset');
		await click(byText(container, TEXTS.lists.preset.apply, 'button'));
		await settle();
		expect(sent.map((write) => [write.path.split('/').pop(), write.body.value])).toEqual([
			['robots_verification.blockSearchPages', true],
			['robots_verification.blockParameters', 'sort, minPrice, maxPrice, inStock'],
			['robots_verification.blockPaths', ['/cart', '/checkout', '/account']],
		]);
	});

	it('Settings warn about the law, name ids that are not loaded and show what the site serves', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		serve([...ON, 'google_tags']);
		const { container } = render(<Settings {...props} />);
		await settle();
		await visitAll(container);
		const text = container.textContent ?? '';
		expect(text).toContain(TEXTS.settings.consentWarning);
		expect(text).toContain('Not loaded, as they are not well formed: pixelId.');
		expect(text).toContain(TEXTS.settings.gtmMissing);
		expect(text).toContain('User-agent: GPTBot');
		// the presets (G12), with the search parameters of Searches and 404s
		expect(text).toContain('Disallow: /*?term=');
		expect(text).toContain('Disallow: /cart$');
		expect(text).toContain(`Sitemap: https://${DOMAIN}/sitemap.xml`);
		expect(text).toContain('<meta name="yandex-verification" content="ya-1">');
		expect(text).toContain(`Your site serves the key abcdefgh as plain text at https://${DOMAIN}/indexnow-key.txt`);
	});

	it('Settings say when the key file address is not a path', async () => {
		VALUES.indexnow = { key: 'abcdefgh', keyPath: 'nope' };
		VALUES.notice_bar = { enabled: true };
		VALUES.robots_verification = {};
		VALUES.tags = {};
		serve(['indexnow', 'notice_bar', 'robots_verification']);
		const { container } = render(<Settings {...props} />);
		await settle();
		await visitAll(container);
		const text = container.textContent ?? '';
		expect(text).toContain(TEXTS.setup.keyPathBad);
		expect(text).toContain(TEXTS.setup.noTags);
		expect(text).not.toContain(TEXTS.settings.consentWarning);
	});

	it('Settings say when the merchant turned the notice bar off (AO-2)', async () => {
		VALUES.notice_bar = { enabled: false };
		serve(['notice_bar']);
		const { container } = render(<Settings {...props} />);
		await settle();
		await visitAll(container);
		expect(container.textContent).toContain(TEXTS.setup.noticeOff);
	});

	it('Settings say where Web Vitals go while Visitor analytics is off (SG-27)', async () => {
		VALUES.web_vitals = { toGa4: true };
		serve(['web_vitals', 'google_tags']);
		const ga4 = render(<Settings {...props} />);
		await settle();
		await visitAll(ga4.container);
		expect(ga4.container.textContent).toContain(TEXTS.setup.vitalsGa4Only);
		cleanup();
		VALUES.web_vitals = { toGa4: false };
		const nowhere = render(<Settings {...props} />);
		await settle();
		await visitAll(nowhere.container);
		expect(nowhere.container.textContent).toContain(TEXTS.setup.vitalsNowhere);
		// a feature that is off is not listed, so Web Vitals without Google tags says so on its own
		cleanup();
		VALUES.web_vitals = { toGa4: true };
		serve(['web_vitals']);
		const alone = render(<Settings {...props} />);
		await settle();
		await visitAll(alone.container);
		expect(alone.container.textContent).toContain(TEXTS.setup.vitalsNoGoogle);
	});

	it('Defaults say what the values alone tell (no website: no robots.txt or key file address)', async () => {
		VALUES.tags = { consentRequired: false };
		VALUES.indexnow = { key: 'abcdefgh', keyPath: 'nope' };
		serve(['indexnow', 'robots_verification']);
		const { container } = render(<Defaults {...props} />);
		await settle();
		await visitAll(container);
		const text = container.textContent ?? '';
		expect(text).toContain(TEXTS.settings.consentWarning);
		expect(text).not.toContain(TEXTS.setup.keyPathBad);
		expect(text).not.toContain('(GET /v1/robots.txt)');
	});
});
