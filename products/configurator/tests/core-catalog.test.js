import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
	applyDeleted,
	applyInventory,
	applyItem,
	attributeValues,
	emptyItem,
	itemView,
	linkSchema,
	variantStock,
} from '../core/catalog.js';
import { compileSchema } from '../core/compile.js';
import { resolve } from '../core/resolve.js';
import { parseSchema } from '../core/schema.js';
import { canonicalSearch, decodeSelection, encodeSelection, mergeSearch, paramOf, urlOptionsFrom } from '../core/urlSync.js';
import { PHONE } from './helpers.js';

const T1 = '2026-10-01T10:00:00.000Z';
const T2 = '2026-10-01T11:00:00.000Z';

const SHIRT = {
	itemId: 'itm_shirt',
	title: 'Linen shirt',
	status: 'active',
	currency: 'EUR',
	variants: [
		{ variantId: 'v1', sku: 'LS-S-BL', attributes: { size: 'S', color: 'Blue' }, price: 4900, inventory: 3 },
		{ variantId: 'v2', sku: 'LS-M-BL', attributes: { size: 'M', color: 'Blue' }, price: 4900, inventory: 0 },
		{ variantId: 'v3', sku: 'LS-M-WH', attributes: { size: 'M', color: ['White', 'Ivory'] }, price: 5200 },
		{ variantId: 'v4', attributes: { size: 'XXL', color: 'Blue', fit: 7 }, price: 5900, inventory: 1 },
		{ variantId: 'v5', attributes: {}, price: 100 },
		'junk',
	],
};

describe('catalog snapshots from events', () => {
	it('stores item snapshots and ignores older ones', () => {
		const item = applyItem(null, SHIRT, T1);
		expect(item).toMatchObject({
			itemId: 'itm_shirt',
			title: 'Linen shirt',
			status: 'active',
			currency: 'EUR',
			snapshotAt: T1,
			deleted: false,
		});
		expect(item.variants).toHaveLength(5);
		expect(item.variants[2]).toEqual({
			variantId: 'v3',
			sku: 'LS-M-WH',
			title: null,
			attributes: { size: 'M', color: ['White', 'Ivory'] },
			price: 5200,
			inventory: null,
		});
		const renamed = applyItem(item, { itemId: 'itm_shirt', title: 'Shirt', changed: ['title'] }, T2);
		expect(renamed.title).toBe('Shirt');
		expect(renamed.variants).toBe(item.variants);
		expect(applyItem(renamed, { itemId: 'itm_shirt', title: 'Old' }, T1)).toBe(renamed);
		const deleted = applyDeleted(renamed, 'itm_shirt', T2);
		expect(deleted.deleted).toBe(true);
		expect(applyDeleted(applyItem(null, SHIRT, T2), 'itm_shirt', T1).deleted).toBe(false);
		expect(applyDeleted(null, 'itm_x', T1)).toMatchObject({ itemId: 'itm_x', deleted: true });
		expect(applyItem(deleted, { itemId: 'itm_shirt', title: 'Back' }, '2026-10-01T12:00:00.000Z').deleted).toBe(false);
	});

	it('tracks inventory per variant and location, by id or SKU, and ignores stale figures', () => {
		let item = applyItem(null, SHIRT, T1);
		const [v1, v2, v3, v4] = /** @type {any[]} */ (item.variants);
		expect([variantStock(item, v1), variantStock(item, v2), variantStock(item, v3)]).toEqual([3, 0, null]);
		item = applyInventory(item, { itemId: 'itm_shirt', variantId: 'v2', quantity: 4 }, T1);
		expect(variantStock(item, v2)).toBe(4);
		item = applyInventory(item, { itemId: 'itm_shirt', sku: 'LS-M-WH', locationId: 'loc_a', quantity: 2, available: 1 }, T1);
		item = applyInventory(item, { itemId: 'itm_shirt', sku: 'LS-M-WH', locationId: 'loc_b', quantity: 5 }, T1);
		expect(variantStock(item, v3)).toBe(6);
		item = applyInventory(item, { itemId: 'itm_shirt', variantId: 'v3', quantity: 9 }, T2);
		expect(variantStock(item, v3)).toBe(9);
		expect(applyInventory(item, { itemId: 'itm_shirt', variantId: 'v3', quantity: 1 }, T1)).toBe(item);
		expect(applyInventory(item, { itemId: 'itm_shirt', variantId: 'v3' }, T2)).toBe(item);
		item = applyInventory(item, { itemId: 'itm_shirt', sku: 'UNKNOWN', quantity: 8 }, T2);
		expect(item.stock.some((figure) => figure.key === 'sku:UNKNOWN')).toBe(true);
		const early = applyInventory(null, { itemId: 'itm_new', quantity: 7 }, T1);
		expect(early).toMatchObject({ itemId: 'itm_new', stock: [{ key: '*', location: '*', quantity: 7, at: T1 }] });
		const noSku = { variantId: 'x', sku: null, title: null, attributes: {}, price: null, inventory: null };
		expect(variantStock(early, noSku)).toBe(7);
		expect(variantStock(emptyItem('i'), noSku)).toBeNull();
		expect(variantStock(item, v4)).toBe(1);
		expect(itemView(item).variants.map((variant) => variant.stock)).toEqual([3, 4, 9, 1, null]);
	});

	it('normalises attribute values to option keys', () => {
		const variant = {
			variantId: 'v',
			sku: null,
			title: null,
			attributes: { a: 128, b: true, c: ['x', ' y', ''], d: { no: 1 }, e: null },
			price: null,
			inventory: null,
		};
		expect([
			attributeValues(variant, 'a'),
			attributeValues(variant, 'b'),
			attributeValues(variant, 'c'),
			attributeValues(variant, 'd'),
			attributeValues(variant, 'e'),
			attributeValues(variant, 'z'),
		]).toEqual([['128'], ['true'], ['x'], [], [], []]);
	});
});

describe('linkSchema (catalog-linked configurators)', () => {
	const parsed = parseSchema({
		name: 'Shirt',
		source: { type: 'catalog', itemId: 'itm_shirt' },
		groups: [
			{ key: 'size', default: 'L', options: [{ key: 'S' }, { key: 'M' }, { key: 'L' }] },
			{ key: 'color', label: 'Colour', default: 'Blue' },
			{ key: 'fit', required: true },
			{ key: 'gift', type: 'text', required: false },
		],
	});
	if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));

	it('takes options from the variants (declared options are the pool), combinations, prices and stock', () => {
		const item = applyItem(null, SHIRT, T1);
		const linked = linkSchema(parsed.schema, item);
		if (!linked.ok) throw new Error('link');
		const [size, color, fit] = linked.schema.groups;
		expect(size?.options.map((o) => o.key)).toEqual(['S', 'M']);
		expect(size?.default).toBeNull();
		expect(color?.options.map((o) => o.key)).toEqual(['Blue', 'White', 'Ivory']);
		expect(color?.default).toBe('Blue');
		expect(fit).toMatchObject({ required: true, options: [{ key: '7' }] });
		expect(linked.schema.combinations).toEqual([
			{ id: 'v1', sku: 'LS-S-BL', options: { size: 'S', color: 'Blue' }, stock: 3, price: 4900, available: true },
			{ id: 'v2', sku: 'LS-M-BL', options: { size: 'M', color: 'Blue' }, stock: 0, price: 4900, available: true },
			{
				id: 'v3',
				sku: 'LS-M-WH',
				options: { size: 'M', color: ['White', 'Ivory'] },
				stock: null,
				price: 5200,
				available: true,
			},
		]);
		expect(linked.schema.pricing).toEqual({ base: null, currency: 'EUR', rules: [], rounding: null });
		const built = compileSchema(linked.schema);
		if (!built.ok) throw new Error('compile');
		const result = resolve(built.compiled, { selection: { color: 'Ivory' }, changed: 'color' });
		expect(result.ok && result.selection).toEqual({ size: 'M', color: 'Ivory', fit: '7' });
	});

	it('refuses missing, deleted and archived items and keeps explicit pricing', () => {
		expect(linkSchema(parsed.schema, null)).toEqual({ ok: false, code: 'catalog_item_unavailable' });
		expect(linkSchema(parsed.schema, applyDeleted(applyItem(null, SHIRT, T1), 'itm_shirt', T2)).ok).toBe(false);
		expect(linkSchema(parsed.schema, applyItem(null, { ...SHIRT, status: 'archived' }, T1)).ok).toBe(false);
		const priced = { ...parsed.schema, pricing: { base: 100, currency: null, rules: [], rounding: null } };
		const linked = linkSchema(
			priced,
			applyItem(
				null,
				{ itemId: 'itm_shirt', title: 'x', currency: 'GBP', variants: [{ variantId: 'z', attributes: { size: 'L' } }] },
				T1,
			),
		);
		expect(linked.ok && linked.schema.pricing).toEqual({ base: 100, currency: 'GBP', rules: [], rounding: null });
		const bare = linkSchema(parsed.schema, applyItem(null, { itemId: 'itm_shirt', title: 'x', variants: [] }, T1));
		expect(bare.ok && [bare.schema.pricing, bare.schema.combinations, bare.schema.groups[1]?.required]).toEqual([
			null,
			[],
			false,
		]);
	});
});

describe('URL sync', () => {
	const parsed = parseSchema(PHONE);
	if (!parsed.ok) throw new Error('fixture');
	const groups = parsed.schema.groups;
	const options = urlOptionsFrom({
		param_prefix: 'c_',
		param_names: ['storage=gb', 'bad entry', 7],
		multi_separator: '|',
		omit_defaults: false,
		canonical: 'selection',
		history: 'push',
	});

	it('reads the url_sync settings with safe fallbacks', () => {
		expect(options).toEqual({
			prefix: 'c_',
			names: { storage: 'gb' },
			separator: '|',
			omitDefaults: false,
			canonical: 'selection',
			history: 'push',
		});
		expect(urlOptionsFrom({})).toEqual({
			prefix: '',
			names: {},
			separator: ',',
			omitDefaults: true,
			canonical: 'base',
			history: 'replace',
		});
		expect(paramOf('storage', options)).toBe('c_gb');
	});

	it('encodes, decodes, merges and canonicalises', () => {
		const selection = { storage: '256', color: 'pink', addons: ['case', 'charger'] };
		expect(encodeSelection(groups, selection, options)).toEqual([
			['c_gb', '256'],
			['c_color', 'pink'],
			['c_addons', 'case|charger'],
		]);
		expect(mergeSearch('?ref=mail&c_color=black', groups, selection, options)).toBe(
			'?ref=mail&c_gb=256&c_color=pink&c_addons=case%7Ccharger',
		);
		expect(decodeSelection(groups, '?c_gb=256&c_color=pink&c_addons=case%7Ccharger&c_zz=1', options)).toEqual(selection);
		expect(canonicalSearch(groups, selection, options)).toBe('?c_gb=256&c_color=pink&c_addons=case%7Ccharger');
		expect(canonicalSearch(groups, selection, { ...options, canonical: 'base' })).toBe('');
		expect(mergeSearch('', groups, {}, options)).toBe('');
		expect(canonicalSearch(groups, {}, options)).toBe('');
	});

	it('leaves defaults out, repeats parameters for keys with the separator, parses numbers', () => {
		const custom = parseSchema({
			name: 'x',
			groups: [
				{ key: 'size', default: 'M', options: [{ key: 'S' }, { key: 'M' }] },
				{ key: 'tags', type: 'multi', options: [{ key: 'a,b' }, { key: 'c' }] },
				{ key: 'seats', type: 'range', min: 1, max: 9 },
				{ key: 'note', type: 'text' },
			],
		});
		if (!custom.ok) throw new Error('fixture');
		const plain = urlOptionsFrom({});
		expect(
			encodeSelection(custom.schema.groups, { size: 'M', tags: ['a,b', 'c'], seats: 3, note: '', extra: 1 }, plain),
		).toEqual([
			['tags', 'a,b'],
			['tags', 'c'],
			['seats', '3'],
		]);
		expect(decodeSelection(custom.schema.groups, 'size=S&tags=a%2Cb&tags=c&seats=3&note=hi', plain)).toEqual({
			size: 'S',
			tags: ['a,b', 'c'],
			seats: 3,
			note: 'hi',
		});
		expect(decodeSelection(custom.schema.groups, 'seats=lots&tags=c,a%2Cb', plain)).toEqual({
			seats: 'lots',
			tags: ['c', 'a', 'b'],
		});
	});

	it('round-trips any selection (property)', () => {
		const keys = ['s1', 's2', 's3'];
		const schema = parseSchema({
			name: 'x',
			groups: [
				{ key: 'one', options: keys.map((key) => ({ key })) },
				{ key: 'many', type: 'multi', options: keys.map((key) => ({ key })) },
				{ key: 'n', type: 'range', min: 0, max: 100 },
			],
		});
		if (!schema.ok) throw new Error('fixture');
		fc.assert(
			fc.property(
				fc.option(fc.constantFrom(...keys), { nil: undefined }),
				fc.subarray(keys, { minLength: 1 }),
				fc.option(fc.integer({ min: 0, max: 100 }), { nil: undefined }),
				fc.string({ maxLength: 20 }),
				(one, many, n, junk) => {
					const selection = { ...(one ? { one } : {}), many, ...(n === undefined ? {} : { n }) };
					const search = mergeSearch(`?x=${encodeURIComponent(junk)}`, schema.schema.groups, selection, urlOptionsFrom({}));
					expect(decodeSelection(schema.schema.groups, search, urlOptionsFrom({}))).toEqual(selection);
					expect(new URLSearchParams(search).get('x')).toBe(junk);
				},
			),
			{ numRuns: 200 },
		);
	});
});
