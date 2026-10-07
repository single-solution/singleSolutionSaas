/** core/: pure tier, item, warranty, mapping, filter, showcase, inspection, validation and view logic. */
import { describe, expect, it } from 'vitest';
import { defaultsOf, effectiveConfig } from '../core/config.js';
import { filterOptions, parseSelection, sortByTier } from '../core/filters.js';
import {
	answerText,
	checklistView,
	completionProblems,
	criticalFailed,
	mergeResults,
	normaliseChecklists,
	pickChecklist,
	reportView,
	scoreOf,
	suggestTier,
	validateResults,
} from '../core/inspection.js';
import { catalogTiers, effectiveTier, rollupTiers, snapshotPatch, variantKey } from '../core/items.js';
import { mappingProblems, offerProperties, readableValue, resolveVocabularies, valuesFor } from '../core/mapping.js';
import { checkCondition, compileCondition, matches } from '../core/rules.js';
import { showcaseEntries } from '../core/showcase.js';
import { cleanText, fill, isId, isKey, translator } from '../core/text.js';
import { appliesTo, colorOf, itemContext, normaliseTiers, rankKeys, tierIndex, tierNamed, tierView } from '../core/tiers.js';
import {
	idList,
	validateAssignment,
	validateBatch,
	validateInspection,
	validateInspectionPatch,
	validatePhotoUpload,
	validateReportLink,
	validateUnit,
	validateUnitPatch,
} from '../core/validate.js';
import { periodText, printableTerms, warrantyTerms } from '../core/warranty.js';
import en from '../strings/en.json' with { type: 'json' };
import tiersSchema from '../schemas/tiers.features.json' with { type: 'json' };

const t = translator(en);
const options = { now: Date.parse('2026-10-01T00:00:00Z'), timeZone: 'UTC' };
const ladder = normaliseTiers(defaultsOf(tiersSchema).tiers);
const index = tierIndex(ladder);

describe('text', () => {
	it('checks ids and keys, cleans text and fills placeholders', () => {
		expect(isId('itm_1:a.b-c')).toBe(true);
		expect(isId('a b')).toBe(false);
		expect(isId(1)).toBe(false);
		expect(isKey('good_2')).toBe(true);
		expect(isKey('Good')).toBe(false);
		expect(cleanText('  a\u0000b \n', 10)).toBe('ab');
		expect(cleanText('   ', 10)).toBeNull();
		expect(cleanText(5, 10)).toBeNull();
		expect(cleanText('abcdef', 3)).toBe('abc');
		expect(fill('{a} {b}', { a: 1 })).toBe('1 {b}');
		expect(t('missing.key')).toBe('missing.key');
		expect(t('tiers.badge.label', { tier: 'Good' })).toBe('Grade: Good');
	});
});

describe('config', () => {
	it('overlays only declared keys of the declared type', () => {
		const schema = {
			properties: {
				a: { type: 'integer', default: 1 },
				b: { type: 'string', default: 'x' },
				c: { type: 'boolean', default: false },
				d: { type: 'array', default: [] },
				e: { type: 'object', default: {} },
				f: { type: 'number', default: 0.5 },
				g: { default: null },
			},
		};
		expect(effectiveConfig(schema, { a: 2.5, b: 3, c: true, d: 'no', e: [], f: 2, g: 'any', z: 1 })).toEqual({
			a: 1,
			b: 'x',
			c: true,
			d: [],
			e: {},
			f: 2,
			g: 'any',
		});
		expect(effectiveConfig(schema, null)).toEqual(defaultsOf(schema));
		expect(effectiveConfig({}, {})).toEqual({});
	});
});

describe('rules', () => {
	it('compiles once, treats empty as always and errors as no match', () => {
		expect(compileCondition('')).toEqual({ ok: true, program: null });
		expect(compileCondition(null)).toEqual({ ok: true, program: null });
		expect(compileCondition("'a' in item.collections")).toBe(compileCondition("'a' in item.collections"));
		expect(matches('', {}, options)).toBe(true);
		expect(matches('item.title ==', {}, options)).toBe(false);
		expect(matches("'a' in item.collections", { item: { collections: ['a'] } }, options)).toBe(true);
		expect(matches('item.x > 1', { item: {} }, options)).toBe(false);
		expect(checkCondition('', 'tier').ok).toBe(true);
		expect(checkCondition('unit.serial == 1', 'checklist').ok).toBe(true);
		for (let i = 0; i < 520; i += 1) compileCondition(`item.n == ${i}`);
		expect(compileCondition('item.n == 0').ok).toBe(true);
	});
});

describe('tiers', () => {
	it('normalises the ladder: valid entries, first duplicate, order then position', () => {
		const tiers = normaliseTiers([
			{ key: 'b', label: 'B', order: 2, color: '#ABCDEF' },
			{ key: 'a', label: ' A ', short_label: 'AA', order: 1, token: '--ss-x', icon: 'star', description: 'n' },
			{ key: 'c', label: 'C', icon: 'Bad Icon', active: false },
			{ key: 'a', label: 'dup' },
			{ key: 'd', label: '' },
			'x',
			{ key: 'e', label: 'E', order: 2 },
		]);
		expect(tiers.map((tier) => [tier.key, tier.rank])).toEqual([
			['a', 0],
			['b', 1],
			['e', 2],
			['c', 3],
		]);
		expect(tiers[0]).toMatchObject({
			label: 'A',
			shortLabel: 'AA',
			icon: 'star',
			description: 'n',
			color: { css: 'var(--ss-x)' },
		});
		expect(tiers[1]?.color).toEqual({ hex: '#abcdef', token: null, css: '#abcdef' });
		expect(tiers[3]).toMatchObject({ icon: null, active: false, order: 1000 });
		expect(normaliseTiers('nope')).toEqual([]);
		expect(colorOf('red', 'var(--x)')).toEqual({ hex: null, token: null, css: null });
	});

	it('finds tiers by key or label, ranks keys and checks applicability', () => {
		expect(tierNamed(ladder, ' EXCELLENT ')?.key).toBe('excellent');
		expect(tierNamed(ladder, 'good')?.key).toBe('good');
		expect(tierNamed(ladder, '')).toBeNull();
		expect(tierNamed(ladder, 'x'.repeat(200))).toBeNull();
		expect(tierNamed(ladder, 3)).toBeNull();
		expect(rankKeys(index, ['fair', 'new', 'zzz', 'new', 3])).toEqual(['new', 'fair']);
		const hidden = tierIndex(normaliseTiers([{ key: 'h', label: 'H', active: false }]));
		expect(rankKeys(hidden, ['h'])).toEqual([]);
		expect(rankKeys(hidden, ['h'], { includeInactive: true })).toEqual(['h']);
		const [phonesOnly] = normaliseTiers([{ key: 'p', label: 'P', applies_when: "'phones' in item.collections" }]);
		const tier = /** @type {any} */ (phonesOnly);
		expect(appliesTo(tier, null, options)).toBe(true);
		expect(appliesTo(tier, { known: false }, options)).toBe(true);
		expect(appliesTo(tier, { known: true, collections: ['phones'] }, options)).toBe(true);
		expect(appliesTo(tier, { known: true, collections: ['shirts'] }, options)).toBe(false);
		expect(itemContext(null)).toEqual({
			item: { itemId: null, title: null, brand: null, status: null, collections: [], attributes: {} },
		});
		expect(tierView(/** @type {any} */ (ladder[0]), 'solid')).toMatchObject({ key: 'new', badge: 'solid', rank: 0 });
	});
});

describe('items', () => {
	it('builds snapshot patches, names tiers from attributes and rolls up tiers', () => {
		expect(snapshotPatch({ itemId: 'i', title: 'T', changed: ['title'] })).toEqual({ title: 'T' });
		expect(
			snapshotPatch({
				variants: [
					{ variantId: 'v', sku: 'S', title: 'V', attributes: { tier: 'good' }, price: 1 },
					{ price: 2 },
					{ variantId: 'w' },
				],
			}),
		).toEqual({
			variants: [
				{ variantId: 'v', sku: 'S', title: 'V', attributes: { tier: 'good' } },
				{ variantId: 'w', sku: null, title: null, attributes: {} },
			],
		});
		const item = {
			attributes: { tier: 'New' },
			variants: [{ variantId: 'v', attributes: { tier: 'fair' } }, { variantId: 'w' }],
		};
		expect(catalogTiers(item, ladder, 'tier')).toEqual([
			{ variantId: null, tier: 'new' },
			{ variantId: 'v', tier: 'fair' },
		]);
		expect(catalogTiers(item, ladder, '')).toEqual([]);
		expect(catalogTiers({}, ladder, 'tier')).toEqual([]);
		expect(rollupTiers(index, { assignments: [{ tier: 'fair' }], unitTiers: ['new', null] })).toEqual(['new', 'fair']);
		expect(variantKey(null)).toBe('_');
		expect(variantKey('v')).toBe('v');
		const rows = [
			{ variantId: null, tier: 'good' },
			{ variantId: 'v', tier: 'new' },
		];
		expect(effectiveTier(rows, 'v', null)).toBe('new');
		expect(effectiveTier(rows, 'w', null)).toBe('good');
		expect(effectiveTier(rows, null, null)).toBe('good');
		expect(effectiveTier([], null, 'fair')).toBe('fair');
	});
});

describe('warranty', () => {
	it('writes periods in words with a configurable month', () => {
		expect(periodText(0, t, 30)).toBe('No warranty');
		expect(periodText(-3, t, 30)).toBe('No warranty');
		expect(periodText(1, t, 30)).toBe('1 day');
		expect(periodText(29, t, 30)).toBe('29 days');
		expect(periodText(30, t, 30)).toBe('1 month');
		expect(periodText(61, t, 30)).toBe('2 months 1 day');
		expect(periodText(31, t, 31)).toBe('1 month');
	});

	it('builds terms per tier with templates, defaults, exclusions and printable text', () => {
		const terms = warrantyTerms({
			tiers: ladder,
			config: {
				terms: [
					{ tier: 'new', days: 90, text: '{period} / {days} / {tier}', exclusions: ['A', ' ', 5] },
					{ tier: 'new', days: 1 },
					{ tier: 'Bad' },
					'x',
					{ tier: 'good', days: 'x' },
				],
				default_days: 14,
				days_per_month: 30,
			},
			t,
		});
		expect(terms.map((term) => [term.tier, term.days, term.periodText])).toEqual([
			['new', 90, '3 months'],
			['excellent', 14, '14 days'],
			['good', 14, '14 days'],
			['fair', 14, '14 days'],
		]);
		expect(terms[0]).toMatchObject({ text: '3 months / 90 / New', exclusions: ['A'] });
		expect(terms[1]?.text).toBe('14 days warranty on items graded Excellent.');
		const none = warrantyTerms({ tiers: ladder, config: { terms: 'x', hide_without_cover: true }, t });
		expect(none).toEqual([]);
		const printable = printableTerms(terms, t);
		expect(printable.split('\n')[0]).toBe('Warranty terms');
		expect(printable).toContain('New — 3 months');
		expect(printable).toContain('Not covered:\n  - A');
	});
});

describe('mapping', () => {
	it('resolves vocabularies with allowed values, fallbacks and problems', () => {
		const vocabularies = resolveVocabularies(
			[
				{
					key: 'sd',
					name: 'SD',
					target: 'structured_data',
					property: 'itemCondition',
					allowed: ['https://schema.org/NewCondition', 'https://schema.org/UsedCondition', ''],
					fallback: 'https://schema.org/UsedCondition',
					values: [
						{ tier: 'new', value: 'https://schema.org/NewCondition' },
						{ tier: 'new', value: 'ignored' },
						{ tier: 'good', value: 'https://schema.org/Bad' },
						{ tier: 'BAD', value: 'x' },
						'x',
					],
				},
				{
					key: 'free',
					name: '',
					target: 'weird',
					property: '',
					fallback: null,
					values: [{ tier: 'fair', value: 'F' }],
					display: true,
				},
				{ key: 'sd2', name: 'Second', target: 'structured_data', property: 'itemCondition', fallback: 'x', allowed: ['y'] },
				{ key: 'sd', name: 'dup' },
				{ key: 'Bad' },
				'x',
			],
			ladder,
		);
		expect(vocabularies.map((v) => v.key)).toEqual(['sd', 'free', 'sd2']);
		expect(vocabularies[0]?.rows.map((row) => [row.tier, row.source, row.problem])).toEqual([
			['new', 'mapped', null],
			['excellent', 'fallback', null],
			['good', 'fallback', 'not_allowed'],
			['fair', 'fallback', null],
		]);
		expect(vocabularies[1]).toMatchObject({ name: 'free', target: 'other', property: 'free', fallback: null, display: true });
		expect(vocabularies[2]?.fallback).toBeNull();
		expect(valuesFor(vocabularies, 'fair')).toEqual({ sd: 'https://schema.org/UsedCondition', free: 'F', sd2: null });
		expect(valuesFor(vocabularies, null)).toEqual({ sd: 'https://schema.org/UsedCondition', free: null, sd2: null });
		expect(valuesFor(vocabularies, 'unknown').sd).toBe('https://schema.org/UsedCondition');
		expect(offerProperties(vocabularies, 'new')).toEqual({ itemCondition: 'https://schema.org/NewCondition' });
		expect(offerProperties(vocabularies, null)).toEqual({ itemCondition: 'https://schema.org/UsedCondition' });
		expect(mappingProblems(vocabularies)).toEqual([
			{ vocabulary: 'sd', tier: 'good', problem: 'not_allowed' },
			{ vocabulary: 'free', tier: 'new', problem: 'unmapped' },
			{ vocabulary: 'free', tier: 'excellent', problem: 'unmapped' },
			{ vocabulary: 'free', tier: 'good', problem: 'unmapped' },
			{ vocabulary: 'sd2', tier: 'new', problem: 'unmapped' },
			{ vocabulary: 'sd2', tier: 'excellent', problem: 'unmapped' },
			{ vocabulary: 'sd2', tier: 'good', problem: 'unmapped' },
			{ vocabulary: 'sd2', tier: 'fair', problem: 'unmapped' },
		]);
		expect(resolveVocabularies('x', ladder)).toEqual([]);
		expect(readableValue('https://schema.org/RefurbishedCondition')).toBe('Refurbished Condition');
		expect(readableValue('https://example.com/x#UsedLike/')).toBe('Used Like');
		expect(readableValue('used')).toBe('used');
	});
});

describe('filters', () => {
	it('shows options by counts, visibility and caps; parses selections and sorts by tier', () => {
		const counts = new Map([
			['new', 3],
			['good', 0],
			['fair', 1],
		]);
		const base = { tiers: ladder, counts, collection: 'c', badgeStyle: 'soft', ...options };
		expect(filterOptions({ ...base, config: { hide_empty: true } }).map((o) => [o.key, o.count])).toEqual([
			['new', 3],
			['fair', 1],
		]);
		expect(
			filterOptions({
				...base,
				config: { visible_when: "tier.count >= 1 and collection == 'c'", show_counts: false, max_options: 1 },
			}).map((o) => [o.key, o.count]),
		).toEqual([['new', null]]);
		expect(filterOptions({ ...base, tiers: normaliseTiers([{ key: 'h', label: 'H', active: false }]), config: {} })).toEqual(
			[],
		);
		expect(parseSelection(undefined, index, { multi: true })).toEqual([]);
		expect(parseSelection('', index, { multi: true })).toEqual([]);
		expect(parseSelection('fair,new,fair', index, { multi: true })).toEqual(['new', 'fair']);
		expect(parseSelection('fair,new', index, { multi: false })).toEqual(['new']);
		expect(parseSelection('fair,mint', index, { multi: true })).toBeNull();
		expect(parseSelection(5, index, { multi: true })).toBeNull();
		expect(
			parseSelection(
				Array(25)
					.fill('new')
					.map((k, i) => `${k}${i}`)
					.join(','),
				index,
				{ multi: true },
			),
		).toBeNull();
		const tiersByItem = new Map([
			['a', ['fair']],
			['b', ['new', 'good']],
			['c', []],
		]);
		expect(sortByTier(['d', 'a', 'c', 'b'], tiersByItem, index, 'tier_order')).toEqual(['b', 'a', 'd', 'c']);
		expect(sortByTier(['b', 'a', 'd'], tiersByItem, index, 'tier_order_desc')).toEqual(['a', 'b', 'd']);
		expect(sortByTier(['b', 'a'], tiersByItem, index, 'none')).toEqual(['b', 'a']);
		expect(sortByTier(['x'], new Map([['x', ['gone']]]), index, 'tier_order')).toEqual(['x']);
	});
});

describe('showcase', () => {
	it('merges entries with the ladder, media checks and warranty', () => {
		const entries = showcaseEntries({
			tiers: ladder,
			badgeStyle: 'soft',
			config: {
				entries: [
					{
						tier: 'good',
						headline: 'Good one',
						body: 'Copy',
						bullets: ['a', '', 3],
						video_url: 'http://insecure',
						images: [{ url: 'https://i.example.com/a.png', alt: 'A' }, { url: 'nope' }, 'x'],
					},
					{ tier: 'good', headline: 'dup' },
					{ tier: 'BAD' },
				],
			},
			warranty: new Map([['good', { days: 30, periodText: '1 month' }]]),
		});
		expect(entries.map((entry) => entry.tier.key)).toEqual(['new', 'excellent', 'good', 'fair']);
		expect(entries[2]).toMatchObject({
			headline: 'Good one',
			body: 'Copy',
			bullets: ['a'],
			video: null,
			images: [{ url: 'https://i.example.com/a.png', alt: 'A' }],
			warranty: { days: 30, periodText: '1 month' },
		});
		expect(entries[0]).toMatchObject({ headline: 'New', bullets: [], images: [], warranty: null });
		const only = showcaseEntries({
			tiers: ladder,
			badgeStyle: 'soft',
			config: { entries: 'x', include_tiers_without_entry: false, show_warranty: false },
			warranty: null,
		});
		expect(only).toEqual([]);
		const one = showcaseEntries({ tiers: ladder, badgeStyle: 'soft', config: {}, warranty: null, only: new Set(['fair']) });
		expect(one.map((entry) => entry.tier.key)).toEqual(['fair']);
	});
});

describe('inspection', () => {
	const checklists = normaliseChecklists(
		[
			{
				key: 'phones',
				name: 'Phones',
				tiers: ['good', 'unknown'],
				applies_when: "'phones' in item.collections",
				items: [
					{ key: 'screen', label: 'Screen', kind: 'score', max: 4, weight: 2, required: true, photos_required: 2 },
					{ key: 'power', label: 'Power', kind: 'pass_fail', weight: 3, required: true, critical: true },
					{ key: 'note', label: 'Note', kind: 'text', weight: 9, critical: true },
					{ key: 'skip', label: 'Skip', kind: 'pass_fail', weight: 0 },
					{ key: 'power', label: 'dup', kind: 'pass_fail' },
					{ key: 'bad', label: 'Bad', kind: 'photo' },
					{ key: 'odd', label: 'Odd', kind: 'score', max: 99, weight: -1, photos_required: 99 },
					'x',
				],
			},
			{ key: 'empty', name: 'Empty', items: [] },
			{ key: 'any', name: '', items: [{ key: 'ok', label: 'OK', kind: 'pass_fail', weight: 1 }] },
			{ key: 'phones', name: 'dup', items: [{ key: 'a', label: 'A', kind: 'text' }] },
			{ key: 'Bad', items: [] },
			'x',
		],
		index,
	);

	it('normalises checklists and picks the matching one', () => {
		expect(checklists.map((c) => c.key)).toEqual(['phones', 'any']);
		const [phones, any] = /** @type {any[]} */ (checklists);
		expect(phones.tiers).toEqual(['good']);
		expect(phones.items.map((/** @type {any} */ i) => [i.key, i.max, i.weight, i.critical, i.photosRequired])).toEqual([
			['screen', 4, 2, false, 2],
			['power', 1, 3, true, 0],
			['note', 1, 0, false, 0],
			['skip', 1, 0, false, 0],
			['odd', 5, 1, false, 0],
		]);
		expect(any.name).toBe('any');
		expect(normaliseChecklists('x', index)).toEqual([]);
		const unit = { itemId: 'i', tier: 'good' };
		expect(pickChecklist(checklists, { unit, item: { collections: ['phones'] }, ...options })?.key).toBe('phones');
		expect(pickChecklist(checklists, { unit, item: { collections: ['other'] }, ...options })?.key).toBe('any');
		expect(pickChecklist(checklists, { unit: { itemId: 'i', tier: 'fair' }, item: null, ...options })?.key).toBe('any');
		expect(pickChecklist(checklists, { key: 'phones', unit, item: null, ...options })?.key).toBe('phones');
		expect(pickChecklist(checklists, { key: 'nope', unit, item: null, ...options })).toBeNull();
		expect(pickChecklist([], { unit, item: null, ...options })).toBeNull();
		expect(checklistView(phones).items[0]).toEqual({
			key: 'screen',
			label: 'Screen',
			help: '',
			kind: 'score',
			max: 4,
			weight: 2,
			required: true,
			critical: false,
			photosRequired: 2,
		});
	});

	it('validates, merges, scores and suggests tiers; completion needs answers and photos', () => {
		const phones = /** @type {any} */ (checklists[0]);
		expect(validateResults(phones, 'x').problems).toEqual([{ path: '/results', code: 'results_invalid' }]);
		const checked = validateResults(phones, [
			{ item: 'screen', value: 3, note: '  scratched ' },
			{ item: 'power', value: 'yes' },
			{ item: 'note', value: '  ' },
			{ item: 'note', value: 'x'.repeat(3000) },
			{ item: 'skip', value: true, note: null },
			{ item: 'skip', value: false },
			{ item: 'ghost', value: 1 },
			{ item: 'odd', value: 2, note: 'y'.repeat(600) },
			7,
		]);
		expect(checked.problems.map((p) => [p.path, p.code])).toEqual([
			['/results/1/value', 'value_invalid'],
			['/results/2/value', 'value_invalid'],
			['/results/3/item', 'item_duplicate'],
			['/results/5/item', 'item_duplicate'],
			['/results/6/item', 'item_unknown'],
			['/results/7/note', 'note_invalid'],
			['/results/8/item', 'item_unknown'],
		]);
		expect(checked.results).toEqual([
			{ item: 'screen', value: 3, note: 'scratched' },
			{ item: 'skip', value: true, note: null },
		]);
		const merged = mergeResults(
			[{ item: 'power', value: true, note: null }],
			[
				{ item: 'screen', value: 4, note: null },
				{ item: 'power', value: false, note: null },
			],
			phones,
		);
		expect(merged.map((r) => [r.item, r.value])).toEqual([
			['screen', 4],
			['power', false],
		]);
		expect(scoreOf(phones, [])).toBeNull();
		expect(scoreOf(phones, merged)).toBe(40);
		expect(scoreOf(phones, [{ item: 'screen', value: 3, note: null }])).toBe(75);
		expect(criticalFailed(phones, merged)).toBe(true);
		expect(criticalFailed(phones, [{ item: 'power', value: true, note: null }])).toBe(false);
		const thresholds = [
			{ tier: 'excellent', min_score: 80 },
			{ tier: 'new', min_score: 80 },
			{ tier: 'fair', min_score: 0 },
			{ tier: 'ghost', min_score: 50 },
			{ tier: 'good', min_score: 'x' },
			'x',
		];
		expect(suggestTier({ score: 85, critical: false, thresholds, index, criticalFailTier: '' })).toBe('new');
		expect(suggestTier({ score: 10, critical: false, thresholds, index, criticalFailTier: '' })).toBe('fair');
		expect(suggestTier({ score: null, critical: false, thresholds, index, criticalFailTier: '' })).toBeNull();
		expect(suggestTier({ score: 100, critical: true, thresholds, index, criticalFailTier: '' })).toBe('fair');
		expect(suggestTier({ score: 100, critical: true, thresholds, index, criticalFailTier: 'good' })).toBe('good');
		expect(suggestTier({ score: 100, critical: true, thresholds: 'x', index, criticalFailTier: '' })).toBeNull();
		expect(
			suggestTier({ score: 5, critical: false, thresholds: [{ tier: 'new', min_score: 50 }], index, criticalFailTier: '' }),
		).toBeNull();
		expect(completionProblems(phones, [{ item: 'power', value: true, note: null }], new Map([['screen', 1]]))).toEqual([
			{ path: '/results/screen', code: 'required' },
			{ path: '/photos/screen', code: 'photos_missing' },
		]);
		expect(completionProblems(phones, merged, new Map([['screen', 2]]))).toEqual([]);
	});

	it('builds the buyer report without internals', () => {
		const phones = /** @type {any} */ (checklists[0]);
		const report = reportView({
			unit: { itemId: 'i', tier: 'good', serial: 'S' },
			inspection: {
				score: 90,
				completedAt: '2026-10-01T00:00:00.000Z',
				inspector: 'Ann',
				results: [
					{ item: 'screen', value: 3, note: 'ok' },
					{ item: 'removed', value: true },
					{ item: 'gone_text', value: 'free text' },
				],
			},
			checklist: phones,
			index,
			badgeStyle: 'soft',
			photos: [
				{ item: 'screen', url: 'https://x/1', contentType: 'image/png' },
				{ item: 'screen', url: null, contentType: 'image/png' },
			],
			showInspector: false,
		});
		expect(report).toMatchObject({
			itemId: 'i',
			variantId: null,
			serial: 'S',
			tier: { key: 'good' },
			score: 90,
			checklist: { key: 'phones', name: 'Phones' },
			inspector: null,
			inspectedAt: '2026-10-01T00:00:00.000Z',
		});
		expect(report.results).toEqual([
			{
				item: 'screen',
				label: 'Screen',
				kind: 'score',
				max: 4,
				value: 3,
				note: 'ok',
				photos: [{ url: 'https://x/1', contentType: 'image/png' }],
			},
			{ item: 'removed', label: 'removed', kind: 'pass_fail', max: null, value: true, note: null, photos: [] },
			{ item: 'gone_text', label: 'gone_text', kind: 'string', max: null, value: 'free text', note: null, photos: [] },
		]);
		const bare = reportView({
			unit: { itemId: 'i' },
			inspection: { results: 'x' },
			checklist: null,
			index,
			badgeStyle: 'soft',
			photos: [],
			showInspector: true,
		});
		expect(bare).toMatchObject({
			tier: null,
			score: null,
			checklist: null,
			results: [],
			inspector: null,
			inspectedAt: null,
			serial: null,
		});
	});
});

describe('validate', () => {
	it('checks assignments, batches, units and patches', () => {
		expect(validateAssignment({ itemId: 'i', tier: 'good' })).toEqual([]);
		expect(validateAssignment({ itemId: 'i', tier: 'good', variantId: null, note: null })).toEqual([]);
		expect(validateAssignment(null)).toEqual([{ path: '/', code: 'body_invalid' }]);
		expect(validateAssignment('x', '/a/0')).toEqual([{ path: '/a/0', code: 'body_invalid' }]);
		expect(validateAssignment({ itemId: 'i', tier: 'good', note: 'x'.repeat(501) })).toEqual([
			{ path: '/note', code: 'note_invalid' },
		]);
		expect(validateBatch({ assignments: [{ itemId: 'i', tier: 'g' }], x: 1 })).toEqual([{ path: '/x', code: 'field_unknown' }]);
		expect(validateBatch({ assignments: Array(101).fill({ itemId: 'i', tier: 'g' }) })).toEqual([
			{ path: '/assignments', code: 'assignments_invalid' },
		]);
		expect(validateBatch({ assignments: [{ itemId: '', tier: 'g' }] })).toEqual([
			{ path: '/assignments/0/itemId', code: 'id_invalid' },
		]);
		expect(validateBatch(null)).toEqual([{ path: '/', code: 'body_invalid' }]);
		expect(validateUnit({ itemId: 'i', variantId: 'v', serial: 'S-1', tier: null, note: 'n', available: false })).toEqual([]);
		expect(
			validateUnit({ itemId: 'i', serial: 'a b', tier: 'X', available: 'y', variantId: 'a b', note: 4 }).map((p) => p.code),
		).toEqual(['id_invalid', 'serial_invalid', 'tier_invalid', 'note_invalid', 'flag_invalid']);
		expect(validateUnit(5)).toEqual([{ path: '/', code: 'body_invalid' }]);
		expect(validateUnitPatch({ tier: null })).toEqual([]);
		expect(validateUnitPatch({ x: 1, serial: 'a b' }).map((p) => p.code)).toEqual(['field_unknown', 'serial_invalid']);
		expect(validateUnitPatch({})).toEqual([{ path: '/', code: 'body_invalid' }]);
	});

	it('checks inspections, photo uploads, report links and id lists', () => {
		expect(
			validateInspection({ unitId: 'u', checklist: 'standard', results: [], inspector: 'Kim', complete: true, tier: null }),
		).toEqual([]);
		expect(validateInspection({ unitId: 'u', checklist: 'Bad', inspector: ' ', tier: 'X' }).map((p) => p.code)).toEqual([
			'checklist_invalid',
			'inspector_invalid',
			'tier_invalid',
		]);
		expect(validateInspection(null)).toEqual([{ path: '/', code: 'body_invalid' }]);
		expect(validateInspection({})).toEqual([{ path: '/unitId', code: 'id_invalid' }]);
		expect(validateInspectionPatch({ results: Array(51).fill({}) })).toEqual([{ path: '/results', code: 'results_invalid' }]);
		expect(validateInspectionPatch({ inspector: null })).toEqual([]);
		expect(validateInspectionPatch([])).toEqual([{ path: '/', code: 'body_invalid' }]);
		const config = { allowed_types: ['image/png'], max_photo_bytes: 100 };
		expect(validatePhotoUpload({ item: 'a', contentType: 'image/png', size: 100 }, config)).toEqual([]);
		expect(validatePhotoUpload({ item: 'a', contentType: 'image/png', size: 101 }, config)).toEqual([
			{ path: '/size', code: 'size_invalid' },
		]);
		expect(validatePhotoUpload('x', config)).toEqual([{ path: '/', code: 'body_invalid' }]);
		expect(validateReportLink(undefined, 10)).toEqual([]);
		expect(validateReportLink(null, 10)).toEqual([]);
		expect(validateReportLink({ days: 10 }, 10)).toEqual([]);
		expect(validateReportLink({ days: 11, x: 1 }, 10).map((p) => p.code)).toEqual(['field_unknown', 'days_invalid']);
		expect(validateReportLink('x', 10)).toEqual([{ path: '/', code: 'body_invalid' }]);
		expect(idList('a,b,a', 5)).toEqual(['a', 'b']);
		expect(idList('a,b,c', 2)).toBeNull();
		expect(idList('a b', 2)).toBeNull();
		expect(idList('', 2)).toBeNull();
		expect(idList(5, 2)).toBeNull();
		expect(idList('a'.repeat(400), 2)).toBeNull();
	});
});

describe('answers', () => {
	it('puts checklist answers in words', () => {
		expect(answerText({ kind: 'pass_fail', value: false, max: null }, t)).toBe('Fail');
		expect(answerText({ kind: 'pass_fail', value: true, max: null }, t)).toBe('Pass');
		expect(answerText({ kind: 'score', value: 3, max: null }, t)).toBe('3 / 3');
		expect(answerText({ kind: 'score', value: 2, max: 5 }, t)).toBe('2 / 5');
		expect(answerText({ kind: 'text', value: 'note', max: null }, t)).toBe('note');
	});
});
