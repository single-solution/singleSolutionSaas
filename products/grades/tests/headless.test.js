/** Mode B: the headless cores of every element (state, actions, subscribe, validate, strings, destroy). */
import { describe, expect, it } from 'vitest';
import { createTierFilter } from '../headless/filters.js';
import { createInspectionReport } from '../headless/inspection.js';
import { createConditions } from '../headless/mapping.js';
import { createShowcase } from '../headless/showcase.js';
import { badgeOf, cssColor, errorMessage } from '../headless/store.js';
import { createTranslator } from '../headless/strings.js';
import { createTierBadges } from '../headless/tiers.js';
import { createWarranty } from '../headless/warranty.js';
import strings from '../strings/en.json' with { type: 'json' };
import { createClient, tierView } from './helpers.js';

const t = createTranslator(strings);
const excellent = tierView({
	key: 'excellent',
	label: 'Excellent',
	rank: 1,
	color: { hex: '#123456', token: null, css: '#123456' },
});
const good = tierView();
const TOKEN = `grr_${'a'.repeat(43)}`;

describe('store helpers', () => {
	it('validates colours, builds badges and resolves error messages', () => {
		expect(cssColor(good)).toBe('var(--ss-color-warning)');
		expect(cssColor({ color: { css: 'red; background: url(x)' } })).toBeNull();
		expect(cssColor(null)).toBeNull();
		expect(badgeOf({ ...good, badge: 'outline', shortLabel: undefined, description: undefined, icon: 3 }, t)).toMatchObject({
			style: 'outline',
			shortLabel: 'Good',
			description: '',
			icon: null,
			ariaLabel: 'Grade: Good',
		});
		expect(badgeOf({ ...good, badge: 'weird' }, t).style).toBe('soft');
		expect(errorMessage(t, strings, 'inspection', { code: 'not_found' })).toBe(
			'This report link is unknown, revoked or expired.',
		);
		expect(errorMessage(t, strings, 'inspection', {})).toBe('Something went wrong. Please try again.');
	});
});

describe('tiers', () => {
	const routes = {
		'GET /v1/tiers': () => ({ items: [excellent, good] }),
		'GET /v1/items/itm_1': () => ({
			itemId: 'itm_1',
			tier: good,
			variants: [{ variantId: 'v1', tier: excellent }],
			tiers: [excellent, good],
		}),
	};

	it('loads the legend and an item, selects variants and notifies subscribers', async () => {
		/** @type {Array<[string, any]>} */
		const events = [];
		const client = createClient(routes);
		const element = createTierBadges({ strings, client, emit: (name, data) => events.push([name, data]) });
		/** @type {string[]} */
		const seen = [];
		const off = element.subscribe((state) => seen.push(state.status));
		expect(element.state().status).toBe('idle');
		const loaded = await element.actions.load({ itemId: 'itm_1', variantId: 'v1' });
		expect(loaded.ok).toBe(true);
		const state = element.state();
		expect(state.legend.map((b) => b.key)).toEqual(['excellent', 'good']);
		expect(state.offered.map((b) => b.key)).toEqual(['excellent', 'good']);
		expect(state.current?.key).toBe('excellent');
		expect(state.variants).toEqual([{ variantId: 'v1', tier: 'excellent' }]);
		expect(seen).toEqual(['loading', 'ready']);
		await element.actions.selectVariant('v9');
		expect(element.state().current?.key).toBe('good');
		await element.actions.selectVariant(null);
		expect(element.state().current?.key).toBe('good');
		expect((await element.actions.selectVariant('a b')).ok).toBe(false);
		expect(events.map(([name]) => name)).toEqual(['tiers.loaded', 'tiers.variant_selected', 'tiers.variant_selected']);
		expect(Object.isFrozen(element.state())).toBe(true);
		off();
		element.destroy();
		await element.actions.load();
		expect(element.state().status).toBe('ready');
		expect(element.strings).toBe(strings);
	});

	it('works without an item, validates ids and reports problems', async () => {
		const legend = createTierBadges({ strings, client: createClient(routes) });
		await legend.actions.load();
		expect(legend.state()).toMatchObject({ itemId: null, offered: [], current: null });
		const invalid = createTierBadges({ strings, client: createClient(routes) });
		expect((await invalid.actions.load({ itemId: 'a b' })).ok).toBe(false);
		expect(invalid.state()).toMatchObject({ status: 'error', error: 'This id is not valid.' });
		expect(invalid.validate('ok_id')).toEqual([]);
		const failing = createTierBadges({
			strings,
			client: createClient({ ...routes, 'GET /v1/tiers': () => ({ error: { code: 'element_disabled', status: 403 } }) }),
		});
		await failing.actions.load({ itemId: 'itm_1' });
		expect(failing.state().error).toBe('Grades are not available here.');
		const missingItem = createTierBadges({ strings, client: createClient({ 'GET /v1/tiers': routes['GET /v1/tiers'] }) });
		await missingItem.actions.load({ itemId: 'itm_404' });
		expect(missingItem.state().error).toBe('This item has no grade.');
		const empty = createTierBadges({
			strings,
			client: createClient({
				...routes,
				'GET /v1/items/itm_1': () => ({ itemId: 'itm_1', tier: null, variants: [], tiers: [] }),
			}),
		});
		await empty.actions.load({ itemId: 'itm_1' });
		expect(empty.state().current).toBeNull();
	});
});

describe('showcase', () => {
	const entry = (/** @type {any} */ tier, extra = {}) => ({
		tier,
		headline: tier.label,
		body: 'Body',
		bullets: ['b'],
		video: null,
		images: [],
		warranty: { days: 30, periodText: '1 month' },
		...extra,
	});
	it('loads entries for an item or a tier and selects tiers', async () => {
		const client = createClient({
			'GET /v1/showcase': (query) => ({
				layout: query.tier ? 'single' : 'compare',
				entries: [entry(excellent), entry(good, { warranty: null, bullets: undefined, images: undefined })],
			}),
		});
		/** @type {string[]} */
		const events = [];
		const element = createShowcase({ config: { layout: 'single' }, strings, client, emit: (name) => events.push(name) });
		expect(element.state().layout).toBe('single');
		await element.actions.load({ itemId: 'itm_1' });
		expect(client.calls[0]?.query).toEqual({ itemId: 'itm_1' });
		expect(element.state()).toMatchObject({ layout: 'compare', selected: null });
		expect(element.state().current?.tier.key).toBe('excellent');
		expect(element.state().entries[0]?.warrantyText).toBe('Warranty: 1 month');
		expect(element.state().entries[1]).toMatchObject({ warrantyText: null, bullets: [], images: [] });
		await element.actions.load({ tier: 'good' });
		expect(element.state().current?.tier.key).toBe('good');
		expect((await element.actions.select('excellent')).ok).toBe(true);
		expect(element.state().selected).toBe('excellent');
		expect((await element.actions.select('nope')).ok).toBe(false);
		expect(events).toEqual(['showcase.tier_selected']);
	});

	it('validates input and reports problems', async () => {
		const element = createShowcase({ strings, client: createClient({}) });
		expect(element.state().layout).toBe('cards');
		expect(element.validate({ itemId: 'a b', tier: 'Bad' }).map((p) => p.code)).toEqual(['id_invalid', 'tier_invalid']);
		expect((await element.actions.load({ tier: 'Bad' })).ok).toBe(false);
		await element.actions.load();
		expect(element.state()).toMatchObject({ status: 'error', error: 'Something went wrong. Please try again.' });
		const empty = createShowcase({ strings, client: createClient({ 'GET /v1/showcase': () => ({ entries: [] }) }) });
		await empty.actions.load();
		expect(empty.state()).toMatchObject({ status: 'ready', current: null, layout: 'cards' });
	});
});

describe('filters', () => {
	const options = [
		{ ...excellent, count: 1200 },
		{ ...good, count: null },
	];
	const routes = {
		'GET /v1/tier-filters': () => ({ param: 'grade', multiSelect: true, options }),
		'GET /v1/tier-filters/items': (/** @type {any} */ query) =>
			query.cursor
				? { items: [{ itemId: 'itm_3', tiers: ['good'] }], nextCursor: null, hasMore: false }
				: { items: [{ itemId: 'itm_1', tiers: ['excellent'] }], nextCursor: 'c1', hasMore: true },
	};

	it('loads options, toggles a multi selection, applies and pages', async () => {
		/** @type {Array<[string, any]>} */
		const events = [];
		const client = createClient(routes);
		const element = createTierFilter({ config: { param_name: 'tier' }, strings, client, emit: (n, d) => events.push([n, d]) });
		await element.actions.load({ collection: 'phones', selected: ['good', 'unknown'] });
		expect(client.calls[0]?.query).toEqual({ collection: 'phones' });
		const state = element.state();
		expect(state).toMatchObject({ param: 'grade', multiSelect: true, selected: ['good'], queryValue: 'good' });
		expect(state.options.map((o) => [o.key, o.countText, o.selected])).toEqual([
			['excellent', '1,200', false],
			['good', null, true],
		]);
		await element.actions.toggle('excellent');
		expect(element.state().queryValue).toBe('excellent,good');
		await element.actions.toggle('good');
		expect(element.state().selected).toEqual(['excellent']);
		expect((await element.actions.toggle('ghost')).ok).toBe(false);
		await element.actions.apply();
		expect(client.calls.at(-1)?.query).toEqual({ tier: 'excellent', collection: 'phones' });
		expect(element.state()).toMatchObject({ itemIds: ['itm_1'], hasMore: true, cursor: 'c1', applying: false });
		await element.actions.loadMore();
		expect(client.calls.at(-1)?.query.cursor).toBe('c1');
		expect(element.state().itemIds).toEqual(['itm_1', 'itm_3']);
		await element.actions.clear();
		expect(element.state()).toMatchObject({ selected: [], queryValue: '', itemIds: [] });
		const applied = await element.actions.apply();
		expect(applied.ok).toBe(true);
		expect(events.map(([name]) => name)).toEqual([
			'filters.changed',
			'filters.changed',
			'filters.changed',
			'filters.applied',
			'filters.applied',
			'filters.changed',
		]);
	});

	it('replaces the selection in single-select mode and reports problems', async () => {
		const single = createTierFilter({
			strings,
			client: createClient({ ...routes, 'GET /v1/tier-filters': () => ({ param: 'tier', multiSelect: false, options }) }),
		});
		await single.actions.load({ selected: ['excellent', 'good'] });
		expect(single.state().selected).toEqual(['excellent']);
		await single.actions.toggle('good');
		expect(single.state().selected).toEqual(['good']);
		await single.actions.load();
		expect(single.state().selected).toEqual([]);
		const element = createTierFilter({ strings, client: createClient({}) });
		expect(element.state().multiSelect).toBe(true);
		expect(element.validate({ collection: 'a b', selected: ['Bad'] }).map((p) => p.code)).toEqual([
			'id_invalid',
			'tier_invalid',
		]);
		expect((await element.actions.load({ collection: 'a b' })).ok).toBe(false);
		await element.actions.load();
		expect(element.state().status).toBe('error');
		const failingItems = createTierFilter({
			strings,
			client: createClient({ 'GET /v1/tier-filters': routes['GET /v1/tier-filters'] }),
		});
		await failingItems.actions.load({ selected: ['good'] });
		await failingItems.actions.apply();
		expect(failingItems.state()).toMatchObject({ applying: false, error: 'Something went wrong. Please try again.' });
	});
});

describe('warranty', () => {
	const terms = [
		{ tier: 'excellent', label: 'Excellent', days: 90, periodText: '3 months', text: 'T', exclusions: [] },
		{ tier: 'good', label: 'Good', days: 30, periodText: '1 month', text: 'G', exclusions: ['x'] },
	];
	it('loads terms, picks the selected tier and validates', async () => {
		/** @type {string[]} */
		const events = [];
		const element = createWarranty({
			strings,
			client: createClient({ 'GET /v1/warranty': () => ({ items: terms }) }),
			emit: (n) => events.push(n),
		});
		await element.actions.load({ tier: 'good' });
		expect(element.state().current?.tier).toBe('good');
		await element.actions.load();
		expect(element.state().current?.tier).toBe('excellent');
		expect((await element.actions.select('good')).ok).toBe(true);
		expect((await element.actions.select('nope')).ok).toBe(false);
		expect(events).toEqual(['warranty.tier_selected']);
		await element.actions.load({ tier: 'missing' });
		expect(element.state().current).toBeNull();
		expect((await element.actions.load({ tier: 'Bad' })).ok).toBe(false);
		expect(element.validate(null)).toEqual([]);
		const failing = createWarranty({ strings, client: createClient({}) });
		await failing.actions.load();
		expect(failing.state().status).toBe('error');
	});
});

describe('mapping', () => {
	const view = {
		itemId: 'itm_1',
		vocabularies: [
			{ key: 'schema_org', name: 'schema.org itemCondition', display: false },
			{ key: 'feed', name: 'Feed', display: true },
			{ key: 'empty', name: 'Empty', display: true },
		],
		item: {
			tier: good,
			values: { schema_org: 'https://schema.org/UsedCondition', feed: 'used', empty: null },
			offer: { itemCondition: 'u' },
		},
		variants: [{ variantId: 'v1', tier: excellent, values: { feed: 'https://example.com/LikeNew' } }],
		tiers: [],
	};
	it('derives the displayed rows and Offer properties per variant', async () => {
		/** @type {string[]} */
		const events = [];
		const element = createConditions({
			strings,
			client: createClient({ 'GET /v1/condition-mappings/items/itm_1': () => view }),
			emit: (n) => events.push(n),
		});
		await element.actions.load({ itemId: 'itm_1' });
		expect(element.state()).toMatchObject({ tier: { key: 'good' }, offer: { itemCondition: 'u' } });
		expect(element.state().rows).toEqual([{ key: 'feed', name: 'Feed', value: 'used', text: 'used' }]);
		await element.actions.selectVariant('v1');
		expect(element.state()).toMatchObject({ tier: { key: 'excellent' }, offer: {} });
		expect(element.state().rows[0]?.text).toBe('Like New');
		expect((await element.actions.selectVariant('a b')).ok).toBe(false);
		expect(events).toEqual(['mapping.variant_selected']);
	});

	it('handles items without a tier, invalid ids and problems', async () => {
		const none = createConditions({
			strings,
			client: createClient({
				'GET /v1/condition-mappings/items/itm_2': () => ({ ...view, item: null, variants: [], tiers: [] }),
			}),
		});
		await none.actions.load({ itemId: 'itm_2' });
		expect(none.state()).toMatchObject({ status: 'ready', tier: null, rows: [] });
		const fresh = createConditions({ strings, client: createClient({}) });
		await fresh.actions.selectVariant(null);
		expect(fresh.state().tier).toBeNull();
		expect((await fresh.actions.load({ itemId: 'a b' })).ok).toBe(false);
		expect((await fresh.actions.load(/** @type {any} */ ({}))).ok).toBe(false);
		await fresh.actions.load({ itemId: 'itm_3' });
		expect(fresh.state().error).toBe('This item has no grade.');
	});
});

describe('inspection', () => {
	const report = {
		itemId: 'itm_1',
		serial: 'SN-1',
		tier: excellent,
		score: 93,
		checklist: { key: 'standard', name: 'Standard inspection' },
		inspector: 'Kim',
		inspectedAt: '2026-10-01T10:00:00.000Z',
		results: [
			{ item: 'function', label: 'Works', kind: 'pass_fail', value: true, note: null, photos: [] },
			{
				item: 'appearance',
				label: 'Appearance',
				kind: 'score',
				max: 5,
				value: 4,
				note: 'Scratch',
				photos: [{ url: 'https://p/1', contentType: 'image/png' }],
			},
			{ item: 'notes', label: 'Notes', kind: 'text', value: 'Fine' },
		],
	};
	it('loads a report, opens and closes photos', async () => {
		/** @type {string[]} */
		const events = [];
		const element = createInspectionReport({
			strings,
			client: createClient({ [`GET /v1/inspection-reports/${TOKEN}`]: () => report }),
			emit: (n) => events.push(n),
		});
		await element.actions.load({ token: TOKEN });
		const state = element.state();
		expect(state).toMatchObject({
			status: 'ready',
			tier: { key: 'excellent' },
			scoreText: 'Score 93 / 100',
			dateText: 'Oct 1, 2026',
			serial: 'SN-1',
			inspector: 'Kim',
			checklist: 'Standard inspection',
		});
		expect(state.rows.map((r) => [r.answer, r.passed])).toEqual([
			['Pass', true],
			['4 / 5', null],
			['Fine', null],
		]);
		expect(state.rows[2]?.photos).toEqual([]);
		expect((await element.actions.openPhoto('appearance', 0)).ok).toBe(true);
		expect(element.state().photo).toEqual({ url: 'https://p/1', alt: 'Appearance, photo 1' });
		expect((await element.actions.openPhoto('appearance', 3)).ok).toBe(false);
		expect((await element.actions.openPhoto('ghost', 0)).ok).toBe(false);
		await element.actions.closePhoto();
		expect(element.state().photo).toBeNull();
		expect(events).toEqual(['inspection.viewed']);
	});

	it('validates tokens and shows not-found and bare reports', async () => {
		const element = createInspectionReport({ strings, client: createClient({}) });
		expect((await element.actions.load({ token: 'nope' })).ok).toBe(false);
		expect(element.state().error).toBe('This report link is unknown, revoked or expired.');
		await element.actions.load({ token: TOKEN });
		expect(element.state().error).toBe('This report link is unknown, revoked or expired.');
		const bare = createInspectionReport({
			strings,
			client: createClient({
				[`GET /v1/inspection-reports/${TOKEN}`]: () => ({
					...report,
					tier: null,
					score: null,
					inspectedAt: null,
					serial: undefined,
					inspector: undefined,
					checklist: null,
				}),
			}),
		});
		await bare.actions.load({ token: TOKEN });
		expect(bare.state()).toMatchObject({
			tier: null,
			scoreText: null,
			dateText: null,
			serial: null,
			inspector: null,
			checklist: null,
		});
	});
});
