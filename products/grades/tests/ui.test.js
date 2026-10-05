/** Mode A: every default renderer (structure, a11y, variants, slots, tier colours through the CSSOM, tokens only). */
import { describe, expect, it } from 'vitest';
import { createTierFilter } from '../headless/filters.js';
import { createInspectionReport } from '../headless/inspection.js';
import { createConditions } from '../headless/mapping.js';
import { createShowcase } from '../headless/showcase.js';
import { createTierBadges } from '../headless/tiers.js';
import { createWarranty } from '../headless/warranty.js';
import { styles as badgeless } from '../ui/warranty.js';
import { render as renderFilters, styles as filterStyles } from '../ui/filters.js';
import { render as renderInspection, styles as inspectionStyles } from '../ui/inspection.js';
import { render as renderMapping, styles as mappingStyles } from '../ui/mapping.js';
import { render as renderShowcase, styles as showcaseStyles } from '../ui/showcase.js';
import { render as renderTiers, styles as tierStyles } from '../ui/tiers.js';
import { render as renderWarranty } from '../ui/warranty.js';
import { paint } from '../ui/dom.js';
import strings from '../strings/en.json' with { type: 'json' };
import { createClient, createFakeDom, findAll, tierView } from './helpers.js';

const excellent = tierView({ key: 'excellent', label: 'Excellent', rank: 1, badge: 'solid' });
const good = tierView();
const TOKEN = `grr_${'b'.repeat(43)}`;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const slot = (/** @type {string} */ name) => ({ tag: 'slot', name, children: [], textContent: `[${name}]` });

describe('styles', () => {
	it('use design tokens only', () => {
		for (const css of [tierStyles, showcaseStyles, filterStyles, badgeless, mappingStyles, inspectionStyles]) {
			expect(css).toContain('var(--ss-');
			expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
		}
	});

	it('paints only through the CSSOM and skips nodes without it', () => {
		const node = createFakeDom().createElement('span');
		paint(node, 'var(--ss-color-success)');
		expect(node.style.properties).toEqual({ '--ss-grades-tier': 'var(--ss-color-success)' });
		expect(paint({}, '#fff000')).toEqual({});
		paint(node, null);
		expect(node.attributes.style).toBeUndefined();
	});
});

describe('tiers renderer', () => {
	const load = async () => {
		const element = createTierBadges({
			strings,
			client: createClient({
				'GET /v1/tiers': () => ({ items: [excellent, good] }),
				'GET /v1/items/itm_1': () => ({ itemId: 'itm_1', tier: good, variants: [], tiers: [excellent, good] }),
			}),
		});
		await element.actions.load({ itemId: 'itm_1' });
		return element;
	};

	it('renders the badge, the offered list and the legend with colours and labels', async () => {
		const element = await load();
		const dom = createFakeDom();
		const badge = renderTiers({ state: element.state(), strings, dom, slots: { before: slot('before') } });
		expect(badge.tag).toBe('span');
		expect(badge.attributes.class).toBe('ss-grades-tiers ss-grades-tiers--badge');
		const [pill] = findAll(badge, (n) => n.attributes?.class?.startsWith('ss-grades-badge '));
		expect(pill.attributes).toMatchObject({ role: 'img', 'aria-label': 'Grade: Good', 'data-tier': 'good' });
		expect(pill.attributes.class).toContain('ss-grades-badge--soft');
		expect(pill.style.properties['--ss-grades-tier']).toBe('var(--ss-color-warning)');
		expect(badge.textContent).toBe('[before]Good');
		const list = renderTiers({ state: element.state(), strings, dom, theme: { variant: 'list' } });
		expect(list.attributes).toMatchObject({ role: 'region', 'aria-label': 'Grades' });
		expect(findAll(list, (n) => n.tag === 'li')).toHaveLength(2);
		expect(findAll(list, (n) => n.attributes?.class?.includes('ss-grades-badge--solid'))).toHaveLength(1);
		const legend = renderTiers({ state: element.state(), strings, dom, theme: { variant: 'legend' } });
		expect(legend.textContent).toContain('Light signs of use.');
	});

	it('renders empty slots and errors', () => {
		const dom = createFakeDom();
		const state = /** @type {any} */ ({ status: 'error', legend: [], offered: [], current: null, error: 'Oops' });
		const badge = renderTiers({ state, strings, dom, slots: { empty: slot('empty') } });
		expect(badge.textContent).toBe('[empty]Oops');
		const list = renderTiers({ state: { ...state, error: null }, strings, dom, theme: { variant: 'list' } });
		expect(list.children).toHaveLength(0);
		const legend = renderTiers({
			state: {
				...state,
				error: null,
				legend: [
					{ ...state, key: 'a', label: 'A', shortLabel: 'A', description: '', style: 'soft', color: null, ariaLabel: 'A' },
				],
			},
			strings,
			dom,
			theme: { variant: 'legend' },
		});
		expect(findAll(legend, (n) => n.tag === 'p')).toHaveLength(0);
	});
});

describe('showcase renderer', () => {
	const entries = [
		{
			tier: excellent,
			headline: 'Like new',
			body: 'Inspected.',
			bullets: ['One'],
			video: 'https://video.example.com/v',
			images: [{ url: 'https://cdn.example.com/a.jpg', alt: 'Front' }],
			warranty: { days: 90, periodText: '3 months' },
		},
		{ tier: good, headline: 'Good', body: '', bullets: [], video: null, images: [], warranty: null },
	];
	const load = async (layout = 'cards') => {
		const element = createShowcase({ strings, client: createClient({ 'GET /v1/showcase': () => ({ layout, entries }) }) });
		await element.actions.load();
		return element;
	};

	it('renders cards with copy, media links and the warranty', async () => {
		const element = await load();
		const root = renderShowcase({ state: element.state(), actions: element.actions, strings, dom: createFakeDom() });
		expect(root.attributes).toMatchObject({ role: 'region', 'aria-label': 'What our grades mean', 'aria-busy': 'false' });
		const cards = findAll(root, (n) => n.tag === 'article');
		expect(cards).toHaveLength(2);
		expect(cards[0].style.properties['--ss-grades-tier']).toBe('var(--ss-color-warning)');
		const [img] = findAll(root, (n) => n.tag === 'img');
		expect(img.attributes).toMatchObject({ src: 'https://cdn.example.com/a.jpg', alt: 'Front', loading: 'lazy' });
		const [link] = findAll(root, (n) => n.tag === 'a');
		expect(link.attributes).toMatchObject({ href: 'https://video.example.com/v', rel: 'noopener noreferrer' });
		expect(root.textContent).toContain('Warranty: 3 months');
		expect(root.textContent).toContain('Watch the Excellent inspection video');
	});

	it('renders the comparison table and the tabbed single layout', async () => {
		const element = await load('compare');
		const table = renderShowcase({ state: element.state(), actions: element.actions, strings, dom: createFakeDom() });
		expect(findAll(table, (n) => n.tag === 'th' && n.attributes.scope === 'row')).toHaveLength(2);
		expect(table.textContent).toContain('—');
		const single = renderShowcase({
			state: element.state(),
			actions: element.actions,
			strings,
			theme: { variant: 'single' },
			dom: createFakeDom(),
		});
		const tabs = findAll(single, (n) => n.attributes?.role === 'tab');
		expect(tabs.map((tab) => tab.attributes['aria-selected'])).toEqual(['true', 'false']);
		tabs[1].dispatch('click');
		await tick();
		expect(element.state().selected).toBe('good');
		const empty = renderShowcase({
			state: /** @type {any} */ ({ ...element.state(), entries: [], current: null }),
			actions: element.actions,
			strings,
			dom: createFakeDom(),
		});
		expect(empty.textContent).toContain('No grades to explain yet.');
		const none = renderShowcase({
			state: /** @type {any} */ ({ ...element.state(), current: null }),
			actions: element.actions,
			strings,
			theme: { variant: 'single' },
			dom: createFakeDom(),
		});
		expect(findAll(none, (n) => n.attributes?.role === 'tabpanel')).toHaveLength(0);
	});
});

describe('filters renderer', () => {
	it('renders toggles with counts, toggles and clears', async () => {
		const element = createTierFilter({
			strings,
			client: createClient({
				'GET /v1/tier-filters': () => ({
					param: 'tier',
					multiSelect: true,
					options: [
						{ ...excellent, count: 3 },
						{ ...good, count: null },
					],
				}),
			}),
		});
		await element.actions.load({ selected: ['good'] });
		const dom = createFakeDom();
		const root = renderFilters({ state: element.state(), actions: element.actions, strings, dom });
		expect(root.tag).toBe('fieldset');
		const buttons = findAll(root, (n) => n.attributes?.class === 'ss-grades-filters__option');
		expect(buttons.map((b) => [b.attributes['aria-pressed'], b.textContent])).toEqual([
			['false', 'Excellent(3)'],
			['true', 'Good'],
		]);
		buttons[0].dispatch('click');
		await tick();
		expect(element.state().selected).toEqual(['excellent', 'good']);
		const [clear] = findAll(root, (n) => n.attributes?.class === 'ss-grades-filters__clear');
		clear.dispatch('click');
		await tick();
		expect(element.state().selected).toEqual([]);
		const list = renderFilters({ state: element.state(), actions: element.actions, strings, theme: { variant: 'list' }, dom });
		expect(list.attributes.class).toContain('ss-grades-filters--list');
		expect(findAll(list, (n) => n.attributes?.class === 'ss-grades-filters__clear')).toHaveLength(0);
		const empty = renderFilters({
			state: /** @type {any} */ ({ ...element.state(), options: [] }),
			actions: element.actions,
			strings,
			dom,
		});
		expect(empty.textContent).toContain('No grades to filter by.');
	});
});

describe('warranty renderer', () => {
	it('renders inline, terms and table variants', async () => {
		const element = createWarranty({
			strings,
			client: createClient({
				'GET /v1/warranty': () => ({
					items: [
						{
							tier: 'excellent',
							label: 'Excellent',
							days: 90,
							periodText: '3 months',
							text: 'Ninety days.',
							exclusions: ['Drops'],
						},
						{ tier: 'good', label: 'Good', days: 0, periodText: 'No warranty', text: 'None.', exclusions: [] },
					],
				}),
			}),
		});
		await element.actions.load({ tier: 'excellent' });
		const dom = createFakeDom();
		const inline = renderWarranty({ state: element.state(), strings, dom });
		expect(inline.tag).toBe('p');
		expect(inline.textContent).toBe('Warranty: 3 months');
		const terms = renderWarranty({ state: element.state(), strings, theme: { variant: 'terms' }, dom });
		expect(terms.textContent).toContain('Warranty for Excellent');
		expect(terms.textContent).toContain('Not covered:Drops');
		const table = renderWarranty({ state: element.state(), strings, theme: { variant: 'table' }, dom });
		expect(findAll(table, (n) => n.tag === 'tr')).toHaveLength(2);
		const empty = renderWarranty({
			state: /** @type {any} */ ({ status: 'error', terms: [], current: null, error: 'Down' }),
			strings,
			slots: { empty: slot('empty') },
			dom,
		});
		expect(empty.textContent).toBe('[empty]Down');
	});
});

describe('mapping renderer', () => {
	it('renders the statement and the table', async () => {
		const element = createConditions({
			strings,
			client: createClient({
				'GET /v1/condition-mappings/items/itm_1': () => ({
					vocabularies: [{ key: 'feed', name: 'Feed', display: true }],
					item: { tier: good, values: { feed: 'used' }, offer: {} },
					variants: [],
					tiers: [],
				}),
			}),
		});
		await element.actions.load({ itemId: 'itm_1' });
		const dom = createFakeDom();
		const statement = renderMapping({ state: element.state(), strings, dom });
		expect(statement.textContent).toBe('Condition: Good · Feed: used');
		const table = renderMapping({ state: element.state(), strings, theme: { variant: 'table' }, dom });
		expect(table.attributes.role).toBe('region');
		expect(findAll(table, (n) => n.tag === 'dt')[0].textContent).toBe('Feed');
		const empty = renderMapping({
			state: /** @type {any} */ ({ status: 'error', tier: null, rows: [], error: 'No' }),
			strings,
			dom,
		});
		expect(empty.textContent).toBe('No');
	});
});

describe('inspection renderer', () => {
	const report = {
		serial: 'SN-1',
		tier: excellent,
		score: 90,
		checklist: { name: 'Standard inspection' },
		inspector: 'Kim',
		inspectedAt: '2026-10-01T10:00:00.000Z',
		results: [
			{ item: 'function', label: 'Works', kind: 'pass_fail', value: false, note: 'Battery', photos: [] },
			{
				item: 'appearance',
				label: 'Appearance',
				kind: 'score',
				max: 5,
				value: 4,
				photos: [{ url: 'https://p/1', contentType: 'image/png' }],
			},
			{ item: 'notes', label: 'Notes', kind: 'text', value: 'Fine', photos: [] },
		],
	};
	it('renders the report with answers, notes, thumbnails and a closable viewer', async () => {
		const element = createInspectionReport({
			strings,
			client: createClient({ [`GET /v1/inspection-reports/${TOKEN}`]: () => report }),
		});
		await element.actions.load({ token: TOKEN });
		const dom = createFakeDom();
		const root = renderInspection({ state: element.state(), actions: element.actions, strings, dom });
		expect(root.attributes).toMatchObject({ role: 'region', 'aria-label': 'Inspection report' });
		expect(root.textContent).toContain('Score 90 / 100');
		expect(root.textContent).toContain('Inspected Oct 1, 2026');
		expect(root.textContent).toContain('Unit SN-1');
		expect(root.textContent).toContain('Inspected by Kim');
		expect(findAll(root, (n) => n.attributes?.class?.includes('--fail'))).toHaveLength(1);
		const [thumb] = findAll(root, (n) => n.attributes?.class === 'ss-grades-report__thumb');
		expect(thumb.attributes['aria-label']).toBe('Appearance, photo 1');
		thumb.dispatch('click');
		await tick();
		const open = renderInspection({ state: element.state(), actions: element.actions, strings, dom });
		const [viewer] = findAll(open, (n) => n.attributes?.role === 'dialog');
		expect(viewer.attributes['aria-label']).toBe('Appearance, photo 1');
		viewer.dispatch('keydown', { key: 'Enter' });
		viewer.dispatch('keydown', { key: 'Escape' });
		await tick();
		expect(element.state().photo).toBeNull();
		await element.actions.openPhoto('appearance', 0);
		const reopened = renderInspection({ state: element.state(), actions: element.actions, strings, dom });
		findAll(reopened, (n) => n.tag === 'button' && n.textContent === 'Close photo')[0].dispatch('click');
		await tick();
		expect(element.state().photo).toBeNull();
		const summary = renderInspection({
			state: element.state(),
			actions: element.actions,
			strings,
			theme: { variant: 'summary' },
			dom,
		});
		expect(findAll(summary, (n) => n.tag === 'li')).toHaveLength(0);
	});

	it('renders loading and bare reports', () => {
		const dom = createFakeDom();
		const actions = { openPhoto: () => undefined, closePhoto: () => undefined };
		const loading = renderInspection({
			state: /** @type {any} */ ({ status: 'loading', rows: [], tier: null, photo: null, error: null }),
			actions,
			strings,
			slots: { empty: slot('empty') },
			dom,
		});
		expect(loading.attributes['aria-busy']).toBe('true');
		expect(loading.textContent).toContain('[empty]');
		const bare = renderInspection({
			state: /** @type {any} */ ({
				status: 'ready',
				rows: [{ item: 'a', label: 'A', answer: 'Pass', passed: true, note: null, photos: [] }],
				tier: null,
				scoreText: null,
				dateText: null,
				serial: null,
				inspector: null,
				checklist: null,
				photo: null,
				error: null,
			}),
			actions,
			strings,
			dom,
		});
		expect(findAll(bare, (n) => n.tag === 'ul')[0].attributes['aria-label']).toBe('Inspection report');
	});
});
