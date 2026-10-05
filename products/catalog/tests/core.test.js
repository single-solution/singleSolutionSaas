/** core/: pure rules with plain inputs and outputs (validation branches, rollups, CSV, money, feeds, views). */
import { describe, expect, it } from 'vitest';
import {
	attributeApplies,
	attributeValue,
	facetsOf,
	optionLabel,
	optionValueOf,
	validateAttribute,
	validateItemAttributes,
} from '../core/attributes.js';
import { brandAllowed, validateBrand } from '../core/brands.js';
import {
	buildTree,
	descendantPlaces,
	imageRef,
	placeIn,
	validateCollection,
	visibleCollectionIds,
	withDescendants,
} from '../core/collections.js';
import { defaultsOf, effectiveConfig } from '../core/config.js';
import { formatCell, parseCsv, recordsOf, toCsv, unescapeFormula } from '../core/csv.js';
import { eventAttributes, inventoryData, itemSnapshot, priceChanges, stockChanges } from '../core/events.js';
import { feedRows, mappingOf, renderFeed, resolveSource, sourceValid } from '../core/feeds.js';
import { fieldValue, fieldsForType, publicCustom, validateCustom } from '../core/fields.js';
import { diffOf, exportCsv, knownColumn, parseImport, planGroup, rowProblems, templateCsv } from '../core/importing.js';
import {
	changedFields,
	defaultVariantInput,
	isPublic,
	nextTransition,
	rollupOf,
	statusDef,
	validateItem,
} from '../core/items.js';
import { mediaUrl, mediaView, urlAllowed, validateMedia } from '../core/media.js';
import { currencyOf, exponentOf, formatMajor, formatMoney, isAmount, parseMajor, priceRange } from '../core/money.js';
import { afterFilter, cursorKey, parseItemQuery, sortSpec } from '../core/query.js';
import { cleanText, fill, isNil, seoOf, slugify, textList } from '../core/text.js';
import {
	availabilityOf,
	canTake,
	checkVariantSet,
	comboOf,
	validateDimensions,
	validateStockLines,
	validateVariant,
} from '../core/variants.js';
import {
	attributeView,
	brandView,
	collectionView,
	itemUrl,
	localized,
	optionsView,
	ownerItem,
	publicItem,
} from '../core/views.js';
import { settingsFrom } from '../api/settings.js';

const settings = settingsFrom({
	can: () => true,
	config: () => ({}),
	domain: 'shop.example.com',
	website: { currency: 'EUR', language: 'en' },
});
const codes = (/** @type {{ problems: Array<{ code: string }> }} */ result) => result.problems.map((p) => p.code);

describe('text, money, config, csv', () => {
	it('cleans text, slugs any script, fills templates, bounds lists, parses SEO', () => {
		expect(cleanText('  a\tb\n ', 10)).toBe('a b');
		expect(cleanText('a\r\nb', 10, { multiline: true })).toBe('a\nb');
		expect(cleanText('x'.repeat(11), 10)).toBeNull();
		expect(cleanText(5, 10)).toBeNull();
		expect(slugify('Crème Brûlée — 250 g')).toBe('creme-brulee-250-g');
		expect(slugify('Чай зелёный')).toBe('чаи-зеленыи');
		expect(slugify(null)).toBe('');
		expect(fill('{a} {b} {c}', { a: 1, b: null })).toBe('1  {c}');
		expect(textList(['a', 'a', 'b'], { max: 3, itemMax: 5 })).toEqual(['a', 'b']);
		expect(textList('a', { max: 3, itemMax: 5 })).toBeNull();
		expect(textList(['', 'a'], { max: 3, itemMax: 5 })).toBeNull();
		expect(textList(['a'], { max: 3, itemMax: 5, check: () => false })).toBeNull();
		expect(isNil(undefined) && isNil(null) && !isNil(0)).toBe(true);
		expect(seoOf({ title: '', description: 'x'.repeat(600) }).problems.map((p) => p.path)).toEqual([
			'/seo/title',
			'/seo/description',
		]);
		expect(seoOf({}).value).toEqual({ title: null, description: null });
	});

	it('handles minor units, currencies and price ranges', () => {
		expect(isAmount(0) && !isAmount(-1) && !isAmount(1.5)).toBe(true);
		expect(currencyOf({ itemCurrency: true, catalogCurrency: '', websiteCurrency: 'EUR' }, { currency: 'USD' })).toBe('USD');
		expect(currencyOf({ itemCurrency: false, catalogCurrency: 'GBP', websiteCurrency: 'EUR' }, { currency: 'USD' })).toBe(
			'GBP',
		);
		expect(currencyOf({ itemCurrency: false, catalogCurrency: '', websiteCurrency: null })).toBeNull();
		expect(exponentOf('JPY')).toBe(0);
		expect(exponentOf('KWD')).toBe(3);
		expect(exponentOf(null)).toBe(2);
		expect(exponentOf('ZZZ1')).toBe(2);
		expect(parseMajor('12.5', 2)).toBe(1250);
		expect(parseMajor('1 000', 0)).toBe(1000);
		expect(parseMajor('1.234', 2)).toBeNull();
		expect(parseMajor('abc', 2)).toBeNull();
		expect(formatMajor(5, 2)).toBe('0.05');
		expect(formatMajor(5, 0)).toBe('5');
		expect(formatMoney(1250, 'EUR', 'en')).toBe('€12.50');
		expect(formatMoney(1250, null, 'en')).toBe('12.50');
		expect(formatMoney(1250, 'EUR', 'not a locale !')).toBe('12.50 EUR');
		expect(priceRange([{ price: 5 }, { price: 3, status: 'inactive' }, { price: 9 }, { price: -1 }])).toEqual({
			priceMin: 5,
			priceMax: 9,
		});
		expect(priceRange([])).toEqual({ priceMin: null, priceMax: null });
	});

	it('overlays configuration on schema defaults by type', () => {
		const schema = {
			properties: {
				a: { type: 'integer', default: 1 },
				b: { type: 'number', default: 1.5 },
				c: { type: 'string', default: 'x' },
				d: { type: 'boolean', default: true },
				e: { type: 'array', default: [] },
				f: { type: 'object', default: {} },
				g: { default: null },
			},
		};
		expect(defaultsOf(schema)).toMatchObject({ a: 1, c: 'x' });
		expect(effectiveConfig(schema, { a: 2.5, b: 2, c: 3, d: false, e: [1], f: [], g: 'any', z: 1 })).toEqual({
			a: 1,
			b: 2,
			c: 'x',
			d: false,
			e: [1],
			f: {},
			g: 'any',
		});
		expect(effectiveConfig({}, null)).toEqual({});
	});

	it('writes and parses RFC 4180 CSV with the formula guard', () => {
		expect(formatCell(null)).toBe('');
		expect(formatCell(Number.NaN)).toBe('');
		expect(formatCell(true)).toBe('true');
		expect(formatCell('=SUM(A1)')).toBe("'=SUM(A1)");
		expect(formatCell('a,"b"')).toBe('"a,""b"""');
		expect(formatCell('a;b', ';')).toBe('"a;b"');
		const text = toCsv(['a', 'b'], [['=x', 'line\nbreak']], { bom: true });
		const parsed = parseCsv(text);
		expect(parsed.ok && parsed.rows).toEqual([
			['a', 'b'],
			["'=x", 'line\nbreak'],
		]);
		expect(recordsOf(parsed.ok ? parsed.rows : []).records[0]).toEqual({ line: 2, values: { a: '=x', b: 'line\nbreak' } });
		expect(parseCsv('a\rb\r\n\r\nc')).toEqual({ ok: true, rows: [['a'], ['b'], ['c']] });
		expect(parseCsv('"open')).toEqual({ ok: false, code: 'unterminated_quote' });
		expect(parseCsv('')).toEqual({ ok: false, code: 'empty' });
		expect(parseCsv('h\n1\n2\n3', { maxRows: 1 })).toEqual({ ok: false, code: 'too_many_rows' });
		expect(parseCsv('h\n1\n2', { maxRows: 1 })).toEqual({ ok: false, code: 'too_many_rows' });
		expect(parseCsv('a;b', { delimiter: ';' })).toEqual({ ok: true, rows: [['a', 'b']] });
		expect(unescapeFormula("'plain")).toBe("'plain");
		expect(
			recordsOf([
				['A', 'A', ''],
				['1', '2', '3'],
			]).records[0]?.values,
		).toEqual({ a: '1' });
	});
});

describe('fields, attributes, variants', () => {
	const fields = /** @type {any[]} */ ([
		{ key: 't', label: 'T', type: 'text', max_length: 3, required: true },
		{ key: 'l', label: 'L', type: 'long_text', public: true },
		{ key: 'u', label: 'U', type: 'url' },
		{ key: 'n', label: 'N', type: 'number' },
		{ key: 'i', label: 'I', type: 'integer' },
		{ key: 'b', label: 'B', type: 'boolean' },
		{ key: 'd', label: 'D', type: 'date' },
		{ key: 's', label: 'S', type: 'select', options: ['a'] },
		{ key: 'm', label: 'M', type: 'multi_select', options: ['a', 'b'] },
	]);

	it('validates every custom field type and keeps public ones', () => {
		expect(fieldValue(fields[0], 'abcd')).toEqual({ code: 'too_long' });
		expect(fieldValue(fields[0], 5)).toEqual({ code: 'text_invalid' });
		expect(fieldValue(fields[1], 'a\nb')).toEqual({ value: 'a\nb' });
		expect(fieldValue(fields[2], 'ftp://x')).toEqual({ code: 'url_invalid' });
		expect(fieldValue(fields[3], Infinity)).toEqual({ code: 'number_invalid' });
		expect(fieldValue(fields[4], 1.5)).toEqual({ code: 'integer_invalid' });
		expect(fieldValue(fields[5], 'yes')).toEqual({ code: 'boolean_invalid' });
		expect(fieldValue(fields[6], '2026-02-30x')).toEqual({ code: 'date_invalid' });
		expect(fieldValue(fields[6], '2026-02-03')).toEqual({ value: '2026-02-03' });
		expect(fieldValue(fields[7], 'z')).toEqual({ code: 'option_invalid' });
		expect(fieldValue(fields[8], ['a', 'a'])).toEqual({ value: ['a'] });
		expect(fieldValue(fields[8], ['c'])).toEqual({ code: 'option_invalid' });
		expect(fieldValue(/** @type {any} */ ({ type: 'weird' }), 1)).toEqual({ code: 'type_unknown' });
		const result = validateCustom(fields, { t: 'ok', n: 1, unknown: 1 });
		expect(codes(result)).toEqual(['field_unknown']);
		expect(codes(validateCustom(fields, {}))).toEqual(['required']);
		expect(codes(validateCustom(fields, 'x'))).toEqual(['object_required']);
		expect(validateCustom(fields, { t: null, n: 2 }, { current: { t: 'x', i: 1 }, partial: true }).value).toEqual({
			i: 1,
			n: 2,
		});
		expect(fieldsForType(fields, { custom_fields: ['n'] }).map((f) => f.key)).toEqual(['n']);
		expect(fieldsForType(fields, undefined)).toHaveLength(9);
		expect(publicCustom(fields, { l: 'x', t: 'y' })).toEqual({ l: 'x' });
		expect(publicCustom(fields, undefined)).toEqual({});
	});

	it('validates attribute definitions, values, visibility and facets', () => {
		const context = { cardPositions: ['title_chips', 'hidden'], maxOptions: 2 };
		expect(codes(validateAttribute('x', context))).toEqual(['object_required']);
		expect(codes(validateAttribute({ key: 'k', label: 'K', options: ['a', 'b', 'c'] }, context))).toEqual([
			'options_invalid',
			'options_required',
		]);
		expect(codes(validateAttribute({ key: 'k', label: 'K', options: ['a', 'A'] }, context))).toEqual(['option_duplicate']);
		expect(
			codes(validateAttribute({ key: 'k', label: 'K', type: 'text', options: ['a'], variantOption: true }, context)),
		).toEqual(['options_not_allowed', 'select_required']);
		expect(codes(validateAttribute({ key: 'k', label: 'K', options: [{ value: 'BAD', label: 'x' }] }, context))).toContain(
			'option_invalid',
		);
		expect(
			codes(
				validateAttribute(
					{
						key: 'k',
						label: 'K',
						options: ['a'],
						cardPosition: 'x',
						collectionIds: ['bad id'],
						visibility: { type: 'brand', brandIds: [] },
						position: -1,
						filterable: 'yes',
						unit: '',
					},
					context,
				),
			),
		).toEqual(
			expect.arrayContaining(['position_invalid', 'ids_invalid', 'visibility_invalid', 'boolean_invalid', 'text_invalid']),
		);
		expect(
			codes(
				validateAttribute(
					{ key: 'k', label: 'K', options: ['a'], visibility: { type: 'attribute', attributeKey: 'k', values: ['a'] } },
					context,
				),
			),
		).toEqual(['self_reference']);
		expect(
			codes(
				validateAttribute(
					{ key: 'k', label: 'K', options: ['a'], visibility: { type: 'attribute', attributeKey: 'o', values: [] } },
					context,
				),
			),
		).toEqual(['visibility_invalid']);
		expect(codes(validateAttribute({ key: 'k', label: 'K', options: ['a'], visibility: { type: 'nope' } }, context))).toEqual([
			'visibility_invalid',
		]);
		const ok = validateAttribute(
			{ key: 'k', label: 'K', options: ['a'], visibility: { type: 'brand', brandIds: ['b1'] } },
			context,
		).value;
		const current = /** @type {any} */ ({ ...ok, id: 'att_1' });
		expect(codes(validateAttribute({ key: 'z', type: 'text' }, { ...context, current }))).toEqual([
			'immutable',
			'immutable',
			'options_not_allowed',
		]);
		expect(validateAttribute({ unit: null }, { ...context, current }).value?.unit).toBeNull();
		expect(optionValueOf('256', 'GB')).toBe('256gb');
		expect(optionLabel({ options: [{ value: 'x', label: 'X' }], unit: 'cm' }, 'x')).toBe('X cm');
		expect(optionLabel({ options: [], unit: 'cm' }, 'y')).toBe('y');
		const attribute = /** @type {any} */ ({ ...ok, type: 'multi_select', collectionIds: ['c1'] });
		expect(attributeApplies(attribute, { brandId: 'b1', collectionIds: ['c2'] })).toBe(false);
		expect(attributeApplies(attribute, { brandId: 'b1', collectionIds: ['c1'] })).toBe(true);
		expect(attributeApplies(attribute, { brandId: null })).toBe(false);
		expect(
			attributeApplies(
				{ collectionIds: [], visibility: { type: 'attribute', attributeKey: 'o', values: ['a'] } },
				{ values: { o: ['a'] } },
			),
		).toBe(true);
		expect(attributeValue(attribute, ['a', 'a'])).toEqual({ value: ['a'] });
		expect(attributeValue(attribute, 'a')).toEqual({ code: 'option_invalid' });
		expect(attributeValue({ ...attribute, type: 'text' }, '')).toEqual({ code: 'text_invalid' });
		expect(attributeValue({ ...attribute, type: 'number' }, 'x')).toEqual({ code: 'number_invalid' });
		expect(attributeValue({ ...attribute, type: 'boolean' }, true)).toEqual({ value: true });
		expect(attributeValue({ ...attribute, type: 'boolean' }, 1)).toEqual({ code: 'boolean_invalid' });
		const required = /** @type {any} */ ({ ...ok, required: true, visibility: { type: 'always' }, collectionIds: [] });
		expect(codes(validateItemAttributes([required], {}, { brandId: null, collectionIds: [] }))).toEqual(['required']);
		expect(codes(validateItemAttributes([required], 'x', { brandId: null, collectionIds: [] }))).toEqual(['object_required']);
		expect(
			validateItemAttributes(
				[required],
				{ k: null },
				{ brandId: null, collectionIds: ['c'], current: { k: 'a', z: 1 }, partial: true },
			).problems[0]?.code,
		).toBe('required');
		expect(
			facetsOf([{ ...required, filterable: true }], {
				attributes: { k: ['a', 'b'], other: 'x' },
				variants: [{ options: { k: 'c' } }, { options: { k: 'd' }, status: 'inactive' }],
			}),
		).toEqual(['k:a', 'k:b', 'k:c']);
		expect(facetsOf([], {})).toEqual([]);
	});

	it('validates variants, sets, dimensions, stock lines and availability', () => {
		expect(codes(validateVariant('x'))).toEqual(['object_required']);
		expect(codes(validateVariant({}))).toEqual(['required']);
		const bad = validateVariant({
			sku: 5,
			options: { Bad: 'x' },
			price: 1,
			compareAtPrice: -1,
			cost: 'x',
			quantity: 1.5,
			trackInventory: 'y',
			backorder: 'maybe',
			forceOutOfStock: 1,
			status: 'x',
			mediaIds: ['bad id'],
			position: -2,
		});
		expect(codes(bad)).toEqual(
			expect.arrayContaining([
				'text_invalid',
				'option_invalid',
				'amount_invalid',
				'quantity_invalid',
				'boolean_invalid',
				'backorder_invalid',
				'status_invalid',
				'ids_invalid',
				'position_invalid',
			]),
		);
		expect(codes(validateVariant({ price: 1, options: [] }))).toEqual(['options_invalid']);
		const current = /** @type {any} */ ({ ...validateVariant({ sku: 'A', price: 5, cost: 2 }).value, id: 'v1' });
		const patched = validateVariant({ sku: '', compareAtPrice: null, cost: null }, { current });
		expect(patched.value).toMatchObject({ sku: null, price: 5, cost: null });
		expect(codes(validateVariant({ price: 'x' }, { current }))).toEqual(['amount_invalid']);
		const pools = new Map([['size', ['s', 'm']]]);
		const set = checkVariantSet(
			/** @type {any} */ ([
				{ options: { size: 's', extra: 'x' }, sku: 'A' },
				{ options: { size: 's' }, sku: 'A' },
				{ options: { size: 'q' }, sku: null },
				{ options: {}, sku: null },
			]),
			{
				optionKeys: ['size'],
				optionPool: { size: ['m'] },
				poolsOn: true,
				attributeOptions: pools,
				uniqueness: 'options_and_sku',
				maxVariants: 2,
			},
		);
		expect(set.map((p) => p.code)).toEqual(
			expect.arrayContaining([
				'limit_reached',
				'option_unknown',
				'not_in_pool',
				'duplicate_options',
				'duplicate_sku',
				'option_invalid',
				'required',
			]),
		);
		expect(
			checkVariantSet(/** @type {any} */ ([{ options: {} }, { options: {} }]), {
				optionKeys: [],
				optionPool: {},
				poolsOn: false,
				attributeOptions: pools,
				uniqueness: 'options',
				maxVariants: 9,
			})[0]?.code,
		).toBe('dimensions_required');
		expect(
			checkVariantSet(
				/** @type {any} */ ([
					{ options: {}, sku: 'A' },
					{ options: {}, sku: 'A' },
				]),
				{ optionKeys: [], optionPool: {}, poolsOn: false, attributeOptions: pools, uniqueness: 'sku', maxVariants: 9 },
			)[0]?.code,
		).toBe('duplicate_sku');
		expect(comboOf(['a', 'b'], { a: '1' })).toBe('a=1&b=');
		expect(codes(validateDimensions(['size', 'size'], undefined, pools))).toEqual(['options_invalid']);
		expect(codes(validateDimensions(['size'], 'x', pools))).toEqual(['object_required']);
		expect(codes(validateDimensions(['size'], { color: ['x'], size: [] }, pools))).toEqual([
			'option_unknown',
			'option_invalid',
		]);
		expect(validateDimensions(['size'], { size: ['s', 's'] }, pools).optionPool).toEqual({ size: ['s'] });
		expect(codes(validateStockLines([], 5))).toEqual(['lines_invalid']);
		expect(codes(validateStockLines([{ quantity: 0 }, 'x'], 5))).toEqual([
			'variant_required',
			'quantity_invalid',
			'variant_required',
			'quantity_invalid',
		]);
		const defaults = { trackInventory: true, backorders: /** @type {const} */ ('deny'), lowStock: 2 };
		const variant = {
			quantity: 0,
			trackInventory: null,
			backorder: null,
			forceOutOfStock: false,
			status: /** @type {const} */ ('active'),
		};
		expect(availabilityOf(variant, defaults).state).toBe('sold_out');
		expect(availabilityOf({ ...variant, backorder: 'allow' }, defaults).state).toBe('backorder');
		expect(availabilityOf({ ...variant, trackInventory: false }, defaults).state).toBe('in_stock');
		expect(availabilityOf({ ...variant, status: 'inactive' }, defaults).state).toBe('unavailable');
		expect(availabilityOf({ ...variant, quantity: 9, forceOutOfStock: true }, defaults).state).toBe('sold_out');
		expect(availabilityOf({ ...variant, quantity: 2 }, defaults).state).toBe('low_stock');
		expect(canTake({ ...variant, quantity: 1 }, 2, defaults)).toBe(false);
		expect(canTake({ ...variant, trackInventory: false }, 2, defaults)).toBe(true);
		expect(canTake({ ...variant, backorder: 'allow' }, 2, defaults)).toBe(true);
		expect(canTake({ ...variant, status: 'inactive' }, 1, defaults)).toBe(false);
	});
});

describe('items, collections, brands, media', () => {
	it('validates items (create and patch) with every rule', () => {
		const items = { ...settings.items, languages: ['de'], item_currency: true };
		expect(codes(validateItem(null, { settings: items, maxCollections: 2 }))).toEqual(['object_required']);
		const bad = validateItem(
			{
				title: 'x',
				slug: 'Bad Slug',
				status: 'nope',
				summary: 'y'.repeat(1001),
				description: 5,
				brandId: 'bad id',
				collectionIds: ['a', 'b', 'c'],
				tags: 'x',
				currency: 'eur',
				seo: 'x',
				translations: { fr: {} },
				publishAt: 'never',
				externalId: 'bad id',
			},
			{ settings: items, maxCollections: 2 },
		);
		expect(codes(bad)).toEqual(
			expect.arrayContaining([
				'slug_invalid',
				'status_unknown',
				'too_long',
				'text_invalid',
				'id_invalid',
				'ids_invalid',
				'tags_invalid',
				'currency_invalid',
				'object_required',
				'translations_invalid',
				'time_invalid',
			]),
		);
		expect(codes(validateItem({ title: 'x', currency: 'USD' }, { settings: settings.items, maxCollections: 2 }))).toEqual([
			'item_currency_disabled',
		]);
		expect(
			codes(
				validateItem(
					{ title: 'x', publishAt: '2026-01-01T00:00:00Z' },
					{ settings: { ...settings.items, scheduled_publish: false }, maxCollections: 2 },
				),
			),
		).toEqual(['scheduling_disabled']);
		const translated = validateItem(
			{
				title: 'x',
				translations: { de: { title: 'y', summary: 's', description: 'd', seo: { title: 't', description: 'u' } } },
				seo: { title: 'S' },
			},
			{ settings: items, maxCollections: 2 },
		);
		expect(translated.value?.translations).toEqual({
			de: { title: 'y', summary: 's', description: 'd', seo: { title: 't', description: 'u' } },
		});
		for (const broken of [{ de: 'x' }, { de: { title: '' } }, { de: { seo: 'x' } }, { de: { seo: { title: '' } } }])
			expect(codes(validateItem({ title: 'x', translations: broken }, { settings: items, maxCollections: 2 }))).toEqual([
				'translations_invalid',
			]);
		const current = /** @type {any} */ (
			validateItem(
				{ title: 'x', summary: 's', currency: 'USD', translations: { de: { title: 'a' } } },
				{ settings: items, maxCollections: 2 },
			).value
		);
		const patch = validateItem(
			{ summary: null, currency: null, translations: null, publishAt: null },
			{ settings: items, current, maxCollections: 2 },
		);
		expect(patch.value).toMatchObject({ title: 'x', summary: null, currency: null, translations: {}, publishAt: null });
		expect(defaultVariantInput({ title: 'x' })).toBeNull();
		expect(defaultVariantInput({ price: 1, sku: 'a', title: 'x' })).toEqual({ price: 1, sku: 'a' });
		expect(statusDef(settings.items.statuses, 'nope')).toMatchObject({ base: 'draft', visible: false });
		const now = Date.parse('2026-01-02T00:00:00Z');
		const base = { status: 'active', publishAt: '2026-01-01T00:00:00Z', unpublishAt: '2026-01-03T00:00:00Z' };
		expect(isPublic(base, { statuses: settings.items.statuses, now, scheduled: true })).toBe(true);
		expect(isPublic({ ...base, deletedAt: new Date() }, { statuses: settings.items.statuses, now, scheduled: true })).toBe(
			false,
		);
		expect(
			isPublic({ ...base, unpublishAt: '2026-01-01T12:00:00Z' }, { statuses: settings.items.statuses, now, scheduled: true }),
		).toBe(false);
		expect(
			isPublic({ ...base, publishAt: '2026-01-05T00:00:00Z' }, { statuses: settings.items.statuses, now, scheduled: false }),
		).toBe(true);
		expect(nextTransition(base, now)?.toISOString()).toBe('2026-01-03T00:00:00.000Z');
		expect(nextTransition({}, now)).toBeNull();
		const rollup = rollupOf(
			/** @type {any} */ ({
				title: 'Ä',
				variants: [
					{
						price: 5,
						quantity: 3,
						status: 'active',
						forceOutOfStock: false,
						trackInventory: null,
						backorder: null,
						options: {},
					},
				],
			}),
			{ attributes: [], stock: settings.stock },
		);
		expect(rollup).toMatchObject({ priceMin: 5, available: 3, inStock: true, titleSort: 'ä' });
		expect(changedFields({ title: 'a', tags: [] }, { title: 'b', tags: [] })).toEqual(['title']);
	});

	it('places collections, cascades visibility, builds trees; checks brand scope and media references', () => {
		expect(codes(validateCollection(1, { seoFields: true }))).toEqual(['object_required']);
		expect(
			codes(
				validateCollection(
					{
						title: 'T',
						heading: 5,
						parentId: 'bad id',
						position: 1.5,
						visible: 'y',
						seo: { title: 'x' },
						image: { url: 'http://x' },
					},
					{ seoFields: false },
				),
			),
		).toEqual(
			expect.arrayContaining([
				'text_invalid',
				'id_invalid',
				'position_invalid',
				'boolean_invalid',
				'seo_disabled',
				'media_invalid',
			]),
		);
		expect(codes(validateCollection({ title: 'T', seo: 'x' }, { seoFields: true }))).toEqual(['object_required']);
		const current = /** @type {any} */ ({
			...validateCollection({ title: 'T', seo: { title: 'S' }, image: { key: 'a/b.jpg' } }, { seoFields: true }).value,
			id: 'c1',
		});
		expect(validateCollection({ heading: '', image: null }, { current, seoFields: true }).value).toMatchObject({
			heading: null,
			image: null,
			seo: { title: 'S' },
		});
		expect(imageRef({ key: '../x' })).toBeNull();
		expect(imageRef('x')).toBeNull();
		const all = [
			{ id: 'a', parentId: null, ancestors: [], depth: 1, visible: false, position: 0, title: 'A' },
			{ id: 'b', parentId: 'a', ancestors: ['a'], depth: 2, visible: true, position: 0, title: 'B' },
			{ id: 'c', parentId: null, ancestors: [], depth: 1, visible: true, position: 1, title: 'C' },
		];
		expect([...visibleCollectionIds(all)]).toEqual(['c']);
		expect(withDescendants(all, 'a')).toEqual(['a', 'b']);
		expect(placeIn(all, { id: 'a', parentId: null, maxDepth: 1 })).toEqual({ ok: false, code: 'too_deep' });
		expect(placeIn(all, { id: null, parentId: 'b', maxDepth: 2 })).toEqual({ ok: false, code: 'too_deep' });
		expect(placeIn(all, { id: 'a', parentId: 'b', maxDepth: 5 })).toEqual({ ok: false, code: 'cycle' });
		expect(descendantPlaces(/** @type {any} */ (all), 'a', { ancestors: ['c'], depth: 2 })).toEqual([
			{ id: 'b', ancestors: ['c', 'a'], depth: 3 },
		]);
		expect(buildTree(all.filter((c) => c.id !== 'a')).map((n) => n.id)).toEqual(['b', 'c']);
		expect(codes(validateBrand(1))).toEqual(['object_required']);
		expect(
			codes(validateBrand({ name: 'N', description: 5, logo: { url: 'nope' }, collectionIds: 'x', visible: 1, position: -1 })),
		).toEqual(expect.arrayContaining(['text_invalid', 'media_invalid', 'ids_invalid', 'boolean_invalid', 'position_invalid']));
		const brand = /** @type {any} */ ({
			...validateBrand({ name: 'N', description: 'd', logo: { url: 'https://x.example/l.svg' } }).value,
			id: 'b1',
		});
		expect(validateBrand({ description: '', logo: null }, { current: brand }).value).toMatchObject({
			description: null,
			logo: null,
		});
		expect(brandAllowed({ collectionIds: ['a'] }, ['b'], all)).toBe(true);
		expect(brandAllowed({ collectionIds: ['a'] }, ['c'], all)).toBe(false);
		expect(brandAllowed({ collectionIds: ['a'] }, ['zz'], all)).toBe(false);
		expect(urlAllowed('https://u:p@x.example/a', [])).toBe(false);
		expect(urlAllowed('https://[bad', [])).toBe(false);
		expect(codes(validateMedia(1, { kinds: ['image'], allowedHosts: [] }))).toEqual(['object_required']);
		expect(codes(validateMedia({}, { kinds: ['image'], allowedHosts: [] }))).toEqual(['url_or_key_required']);
		expect(
			codes(validateMedia({ kind: 'video', url: 'https://x/a', key: 'a' }, { kinds: ['image'], allowedHosts: [] })),
		).toEqual(['kind_invalid', 'url_or_key_required']);
		expect(
			codes(
				validateMedia(
					{ key: '/abs', alt: 5, role: 'Bad', width: 0, variantIds: 'x', position: -1 },
					{ kinds: ['image'], allowedHosts: [] },
				),
			),
		).toEqual(
			expect.arrayContaining([
				'key_invalid',
				'text_invalid',
				'role_invalid',
				'size_invalid',
				'ids_invalid',
				'position_invalid',
			]),
		);
		const media = /** @type {any} */ ({
			...validateMedia({ key: 'a b/c.jpg'.replace(' ', '_'), alt: 'x' }, { kinds: ['image'], allowedHosts: [] }).value,
			id: 'm1',
		});
		expect(validateMedia({ alt: '' }, { current: media, kinds: ['image'], allowedHosts: [] }).value).toMatchObject({
			key: 'a_b/c.jpg',
			alt: null,
		});
		expect(mediaUrl({ url: null, key: 'a/b c.jpg' }, { baseUrl: 'https://m.example/' })).toBe('https://m.example/a/b%20c.jpg');
		expect(mediaUrl({ url: null, key: 'k' }, { baseUrl: '', signed: new Map([['k', 'https://signed']]) })).toBe(
			'https://signed',
		);
		expect(mediaUrl({ url: null, key: null }, { baseUrl: '' })).toBeNull();
		expect(
			mediaView(
				{ ...media, kind: 'video', url: 'https://v', alt: null },
				{ settings: { ...settings.media, url_template: '{url}?w={width}' }, index: 1, title: 'T', brand: 'B' },
			),
		).toMatchObject({ srcset: null, alt: 'T' });
	});
});

describe('events, query, views', () => {
	const item = {
		id: 'itm_1',
		slug: 'polo',
		type: 'item',
		title: 'Polo',
		status: 'active',
		collectionIds: ['col_1'],
		attributes: { material: 'linen', 'bad-key': 'x', long: 'y'.repeat(600), list: ['a', { x: 1 }], none: [] },
		options: ['size'],
		variants: [
			{
				id: 'v1',
				sku: 'P1',
				title: null,
				options: { size: 's' },
				price: 100,
				compareAtPrice: null,
				cost: 50,
				quantity: 3,
				status: 'active',
				position: 1,
				mediaIds: [],
			},
			{
				id: 'v2',
				sku: null,
				title: 'M',
				options: {},
				price: 200,
				compareAtPrice: 300,
				cost: null,
				quantity: 0,
				status: 'inactive',
				position: 0,
				mediaIds: [],
			},
		],
		media: [],
		custom: { secret: 'x' },
	};

	it('builds event data in the contract shape without cost or nulls', () => {
		expect(eventAttributes(item.attributes)).toEqual({ material: 'linen', list: ['a'] });
		const snapshot = itemSnapshot(item, { currency: 'EUR', brandName: 'Acme', statuses: settings.items.statuses });
		expect(snapshot).toMatchObject({ itemId: 'itm_1', brand: 'Acme', currency: 'EUR' });
		expect(JSON.stringify(snapshot)).not.toContain('cost');
		expect(itemSnapshot(item, { currency: null, brandName: null, statuses: settings.items.statuses }).variants).toBeUndefined();
		expect(
			inventoryData({ itemId: 'i', variant: { id: 'v', sku: null }, quantity: 1, previousQuantity: 0, reason: 'r' }),
		).toEqual({ itemId: 'i', variantId: 'v', quantity: 1, previousQuantity: 0, reason: 'r' });
		expect(priceChanges({ itemId: 'i', before: item.variants, after: item.variants, currency: null, reason: 'r' })).toEqual([]);
		expect(priceChanges({ itemId: 'i', before: [], after: item.variants, currency: 'EUR', reason: 'r' })).toEqual([]);
		expect(
			stockChanges({
				itemId: 'i',
				before: [],
				after: [
					{ id: 'n', quantity: 0 },
					{ id: 'm', quantity: 2 },
				],
				reason: 'r',
			}).map((c) => c.variantId),
		).toEqual(['m']);
	});

	it('parses list queries and keyset cursors', () => {
		const context = { owner: true, sorts: ['newest'], defaultSort: 'newest', statuses: ['draft', 'active'] };
		expect(parseItemQuery({ 'filter[status]': 'nope' }, context).problems[0]?.code).toBe('status_invalid');
		expect(
			parseItemQuery(
				{ 'filter[type]': 'Bad', 'filter[priceMin]': '-1', 'filter[inStock]': 'maybe', 'filter[deleted]': 'x' },
				context,
			).problems.map((p) => p.code),
		).toEqual(['value_invalid', 'amount_invalid', 'boolean_invalid', 'not_allowed']);
		const many = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`filter[attr.k${i}]`, 'a']));
		expect(parseItemQuery(many, context).problems[0]?.code).toBe('too_many_filters');
		expect(parseItemQuery({ 'filter[attr.size]': 'S M' }, context).problems[0]?.code).toBe('value_invalid');
		expect(parseItemQuery({ 'filter[attr.weight]': '1.5,true' }, context).filter.facets).toEqual([
			['weight:1.5', 'weight:true'],
		]);
		expect(sortSpec('nope')).toEqual(sortSpec('newest'));
		expect(cursorKey({ createdAt: new Date(0), id: 'a' }, sortSpec('newest'))).toEqual(['1970-01-01T00:00:00.000Z', 'a']);
		expect(afterFilter(sortSpec('newest'), ['x', 'a'])).toBeNull();
		expect(afterFilter(sortSpec('newest'), 'x')).toBeNull();
		expect(afterFilter(sortSpec('title'), [1, 'a'])).toBeNull();
		expect(afterFilter(sortSpec('price_asc'), ['1', 'a'])).toBeNull();
		expect(afterFilter(sortSpec('price_asc'), [1, 2])).toBeNull();
		expect(afterFilter(sortSpec('price_desc'), [5, 'a'])).toEqual({
			$or: [{ sortPriceHigh: { $lt: 5 } }, { sortPriceHigh: 5, id: { $lt: 'a' } }],
		});
	});

	it('renders owner and public views, translations, options, taxonomy views', () => {
		const context = {
			items: settings.items,
			stock: { ...settings.stock, showQuantity: false },
			media: settings.media,
			attributes: [],
			currency: 'EUR',
			brand: null,
			domain: 'shop.example.com',
			lang: 'de',
			visibleCollections: new Set(['col_2']),
		};
		const pub = publicItem({ ...item, translations: { de: { title: 'Polohemd' } } }, context);
		expect(pub).toMatchObject({ title: 'Polohemd', lang: 'de', collectionIds: [], custom: {}, kind: 'physical' });
		expect(pub.variants).toHaveLength(1);
		expect(pub.options).toEqual([{ key: 'size', label: 'size', values: [{ value: 's', label: 's' }] }]);
		const owner = ownerItem(item, { ...context, exposeCost: false, visibleCollections: null });
		expect(owner.variants.map((v) => v.id)).toEqual(['v2', 'v1']);
		expect(owner.variants[0]).not.toHaveProperty('cost');
		expect(owner.createdAt).toBeNull();
		expect(localized({ title: 'T' }, null)).toEqual({
			title: 'T',
			summary: null,
			description: null,
			seo: { title: null, description: null },
			lang: null,
		});
		expect(
			itemUrl({ id: 'i d', slug: 'a b', type: 't' }, { template: 'https://{domain}/{type}/{slug}/{id}', domain: 'x.example' }),
		).toBe('https://x.example/t/a%20b/i%20d');
		expect(optionsView({}, [])).toEqual([]);
		const collection = /** @type {any} */ ({
			id: 'c',
			slug: 'c',
			title: 'C',
			heading: null,
			description: null,
			parentId: null,
			ancestors: [],
			depth: 1,
			position: 0,
			seo: {},
			image: { key: 'k.png' },
			visible: false,
		});
		expect(collectionView(collection, { owner: true, mediaBase: 'https://m.example/' }).image).toEqual({
			url: 'https://m.example/k.png',
			alt: null,
			key: 'k.png',
		});
		expect(collectionView({ ...collection, image: { key: 'k' } }, { owner: false, mediaBase: '' }).image?.url).toBeNull();
		expect(
			brandView(
				/** @type {any} */ ({
					id: 'b',
					slug: 'b',
					name: 'B',
					description: null,
					logo: null,
					collectionIds: [],
					position: 0,
					visible: true,
				}),
				{ owner: false, mediaBase: '' },
			),
		).not.toHaveProperty('visible');
		expect(
			attributeView(
				/** @type {any} */ ({
					id: 'a',
					key: 'k',
					label: 'K',
					type: 'select',
					unit: 'cm',
					options: [{ value: 'v', label: 'V' }],
					filterable: true,
					variantOption: false,
					cardPosition: 'x',
					collectionIds: [],
					visibility: { type: 'always' },
					position: 0,
					required: false,
				}),
			).options[0]?.display,
		).toBe('V cm');
	});
});

describe('import and feeds', () => {
	const attributes = new Map([
		['n', /** @type {any} */ ({ key: 'n', type: 'number', options: [] })],
		['b', /** @type {any} */ ({ key: 'b', type: 'boolean', options: [] })],
		['m', /** @type {any} */ ({ key: 'm', type: 'multi_select', options: [] })],
	]);
	const context = {
		separator: '|',
		exponentOf: () => 2,
		catalogCurrency: 'EUR',
		brandId: (/** @type {string} */ s) => (s === 'acme' ? 'brd_1' : null),
		collectionId: (/** @type {string} */ s) => (s === 'c' ? 'col_1' : null),
		attributes,
		includeCost: false,
	};

	it('parses import files into groups with column mapping and row problems', () => {
		expect(knownColumn('attr.x') && knownColumn('price') && !knownColumn('nope')).toBe(true);
		expect(parseImport('', { maxRows: 5 })).toEqual({ ok: false, code: 'empty' });
		expect(parseImport('price\r\n1', { maxRows: 5 })).toEqual({ ok: false, code: 'item_column_required' });
		expect(parseImport('title', { maxRows: 5 })).toEqual({ ok: false, code: 'empty' });
		const parsed = parseImport('Name,item_id,junk\r\nA,,x\r\n,bad id,\r\n,,\r\nA,,', {
			maxRows: 9,
			mapping: { Name: 'title' },
		});
		if (!parsed.ok) throw new Error('parse');
		expect(parsed.ignored).toEqual(['junk']);
		expect(parsed.groups).toHaveLength(1);
		expect(parsed.groups[0]?.rows).toHaveLength(2);
		expect(parsed.problems.map((p) => p.code)).toEqual(['id_invalid', 'item_required']);
		expect(rowProblems([{ line: 2, path: '/x', code: 'c' }])).toEqual([{ path: '/x', code: 'c', line: 2 }]);
	});

	it('plans item writes from rows (attributes, options, prices, collections, brands, errors)', () => {
		const group = {
			key: 'slug:x',
			ref: { id: null, slug: 'x' },
			rows: [
				{
					line: 2,
					item: { id: null, slug: 'x' },
					values: {
						title: 'X',
						brand: 'nobody',
						collections: 'c|zz',
						tags: 'a|b',
						currency: 'usd',
						'attr.n': 'NaN',
						'attr.b': 'maybe',
						'attr.m': 'p|q',
						'custom.k': 'v',
						options: 'size=s|bad',
						price: '1.999',
						cost: '1.00',
						quantity: 'x',
					},
				},
				{ line: 3, item: { id: null, slug: 'x' }, values: { 'attr.zz': '1', 'option.size': 'm', price: '2.00' } },
			],
		};
		const plan = planGroup(/** @type {any} */ (group), null, context);
		expect(plan.item).toMatchObject({
			title: 'X',
			slug: 'x',
			tags: ['a', 'b'],
			currency: 'USD',
			collectionIds: ['col_1'],
			attributes: { m: ['p', 'q'] },
			custom: { k: 'v' },
		});
		expect(plan.errors.map((e) => e.code)).toEqual(
			expect.arrayContaining([
				'brand_unknown',
				'collection_unknown',
				'number_invalid',
				'boolean_invalid',
				'attribute_unknown',
				'options_invalid',
				'amount_invalid',
				'quantity_invalid',
			]),
		);
		expect(plan.variants[1]?.fields).toEqual({ price: 200, options: { size: 'm' } });
		const ok = planGroup(
			{
				key: 'k',
				ref: { id: null, slug: 'y' },
				rows: [{ line: 2, item: { id: null, slug: 'y' }, values: { 'attr.n': '5', 'attr.b': 'yes' } }],
			},
			null,
			context,
		);
		expect(ok.item.attributes).toEqual({ n: 5, b: true });
		expect(ok.errors.map((e) => e.code)).toEqual(['required']);
		const current = {
			id: 'itm_1',
			slug: 'z',
			title: 'Z',
			variants: [{ id: 'v1', sku: 'A', price: 100, options: {} }],
			media: [{ url: 'https://u' }],
			attributes: {},
		};
		const update = planGroup(
			{
				key: 'id:itm_1',
				ref: { id: 'itm_1', slug: null },
				rows: [
					{
						line: 2,
						item: { id: 'itm_1', slug: null },
						values: { item_slug: 'z2', variant_id: 'v9', image_urls: 'https://u|https://w' },
					},
				],
			},
			current,
			context,
		);
		expect(update.item.slug).toBe('z2');
		expect(update.errors.map((e) => e.code)).toEqual(['variant_unknown', 'required']);
		expect(diffOf(current, update).map((d) => d.field)).toEqual(['slug', 'media']);
		expect(
			planGroup(
				{
					key: 'k',
					ref: { id: null, slug: 'q' },
					rows: [{ line: 2, item: { id: null, slug: 'q' }, values: { title: '\u0000' } }],
				},
				null,
				context,
			).errors.map((e) => e.code),
		).toContain('text_invalid');
	});

	it('exports rows per variant and a template', () => {
		const csv = exportCsv(
			[
				{
					id: 'i1',
					slug: 's',
					title: 'T',
					type: 'item',
					status: 'active',
					tags: ['a'],
					collectionIds: ['c1', 'c9'],
					brandId: 'b1',
					attributes: { m: ['p', 'q'] },
					custom: { k: 'v' },
					media: [{ url: 'https://u' }],
					variants: [
						{
							id: 'v',
							sku: 'S',
							barcode: null,
							options: { size: 's' },
							price: 100,
							compareAtPrice: null,
							cost: 40,
							quantity: 2,
						},
					],
				},
				{ id: 'i2', slug: 's2', title: 'U', type: 'item', status: 'draft', variants: [] },
			],
			{
				columns: [
					'item_id',
					'brand',
					'collections',
					'tags',
					'currency',
					'image_urls',
					'variant_id',
					'sku',
					'barcode',
					'options',
					'price',
					'compare_at_price',
					'cost',
					'quantity',
					'attr.m',
					'custom.k',
					'option.size',
					'summary',
					'external_id',
					'weird',
				],
				separator: '|',
				includeCost: false,
				brandSlug: (id) => (id ? 'acme' : ''),
				collectionSlug: (id) => (id === 'c1' ? 'c' : null),
				currencyOf: () => 'EUR',
				exponentOf: () => 2,
				mediaUrl: (m) => m.url ?? null,
			},
		);
		const [header, first, second] = csv.split('\r\n');
		expect(header).not.toContain('cost');
		expect(first).toBe('i1,acme,c,a,EUR,https://u,v,S,,size=s,1.00,,2,p|q,v,s,,,');
		expect(second?.startsWith('i2,,,,EUR,,,,,,,,,,,,,,')).toBe(true);
		expect(templateCsv(['a', 'b'])).toBe('a,b\r\n');
	});

	it('maps feed rows, resolves sources and renders every format', () => {
		const feedItem = {
			id: 'itm_1',
			slug: 'phone',
			type: 'item',
			title: 'Phone & <Co>',
			summary: null,
			description: null,
			brandId: 'b1',
			attributes: { grade: 'b', colors: ['red', 'blue'] },
			custom: { note: 'n', secret: 's' },
			media: [
				{ id: 'm1', url: 'https://u/1', key: null, variantIds: [], position: 0 },
				{ id: 'm2', url: null, key: 'k.png', variantIds: ['v2'], position: 1 },
			],
			variants: [
				{
					id: 'v1',
					sku: null,
					barcode: null,
					title: 'Black',
					options: { size: 's' },
					price: 1000,
					compareAtPrice: 1500,
					quantity: 0,
					status: 'active',
					forceOutOfStock: false,
					trackInventory: null,
					backorder: 'allow',
				},
				{
					id: 'v2',
					sku: 'P2',
					barcode: '123',
					title: null,
					options: {},
					price: 900,
					compareAtPrice: null,
					quantity: 5,
					status: 'active',
					forceOutOfStock: false,
					trackInventory: null,
					backorder: null,
				},
				{ id: 'v3', sku: 'P3', options: {}, price: 900, quantity: 0, status: 'active', forceOutOfStock: true },
				{ id: 'v4', sku: 'P4', options: {}, price: 1, quantity: 1, status: 'inactive' },
			],
		};
		const context = {
			domain: 'shop.example.com',
			urlTemplate: 'https://{domain}/p/{slug}?x=1',
			stock: settings.stock,
			media: { ...settings.media, storage_base_url: 'https://m.example' },
			currencyOf: () => null,
			exponentOf: () => 2,
			brandName: (/** @type {string | null} */ id) => (id ? 'Acme' : null),
			productType: () => null,
			condition: { source: 'attr.grade', map: [{ from: 'b', to: 'used' }], fallback: 'new' },
			publicCustom: ['note'],
			maxRows: 10,
		};
		const mapping = [
			{ target: 'id', source: 'id' },
			{ target: 'note', source: 'custom.note' },
			{ target: 'secret', source: 'custom.secret' },
			{ target: 'colors', source: 'attr.colors' },
			{ target: 'size', source: 'option.size' },
			{ target: 'label', source: '{title}|{price}' },
			{ target: 'k', source: '=fixed' },
			{ target: 'missing', source: 'attr.nope' },
			{ target: 'cost', source: 'cost' },
		];
		const { rows, truncated } = feedRows([feedItem], { format: 'json', include_out_of_stock: false, mapping }, context);
		expect(truncated).toBe(false);
		expect(rows).toHaveLength(2);
		expect(Object.fromEntries(rows[0] ?? [])).toEqual({
			id: 'v1',
			note: 'n',
			secret: '',
			colors: 'red,blue',
			size: 's',
			label: 'Phone & <Co> – Black|15.00',
			k: 'fixed',
			missing: '',
		});
		const google = feedRows([feedItem], { format: 'google_xml' }, { ...context, maxRows: 1 });
		expect(google.truncated).toBe(true);
		const row = Object.fromEntries(google.rows[0] ?? []);
		expect(row).toMatchObject({
			'g:availability': 'backorder',
			'g:price': '15.00',
			'g:sale_price': '10.00',
			'g:condition': 'used',
			link: 'https://shop.example.com/p/phone?x=1&variant=v1',
		});
		const all = feedRows([feedItem], { format: 'google_xml' }, context);
		const xml = renderFeed({ format: 'google_xml', key: 'g', name: 'Feed & Co' }, all.rows, {
			domain: 'shop.example.com',
			generatedAt: '2026-01-01T00:00:00Z',
		});
		expect(xml).toContain('<title>Phone &amp; &lt;Co&gt; – Black</title>');
		expect(xml).toContain('<g:additional_image_link>https://m.example/k.png</g:additional_image_link>');
		expect(xml).toContain('<g:availability>out_of_stock</g:availability>');
		const csv = renderFeed({ format: 'csv', key: 'c', name: 'C' }, all.rows, { domain: 'd', generatedAt: 'g' });
		expect(csv.split('\r\n')[0]).toBe(
			mappingOf({ format: 'google_xml' })
				.map((m) => m.target)
				.join(','),
		);
		expect(
			renderFeed({ format: 'google_xml', key: 'x', name: 'X' }, [[['x:y', 'v']]], { domain: 'd', generatedAt: 'g' }),
		).toContain('<x_y>v</x_y>');
		const tsv = renderFeed({ format: 'tsv', key: 't', name: 'T' }, [[['a', 'x\ty']]], { domain: 'd', generatedAt: 'g' });
		expect(tsv).toBe('a\nx y\n');
		expect(renderFeed({ format: 'csv', key: 'e', name: 'E' }, [], { domain: 'd', generatedAt: 'g' })).toBe('\r\n');
		expect(mappingOf({ format: 'csv' }).map((m) => m.target)).toContain('image_link');
		expect(sourceValid('cost')).toBe(false);
		expect(sourceValid('custom.x') && sourceValid('=c') && sourceValid('{id}')).toBe(true);
		expect(resolveSource('nope', {}, { item: {}, variant: {}, publicCustom: [] })).toBe('');
	});
});
