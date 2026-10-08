/**
 * The catalog's pure rules (PLAN 0.8.8 Catalog): product checks, categories and the tree, listings and facets, views,
 * CSV files, grades, AI copy, plus the AI provider adapter and the change notice with doubles.
 */
import { describe, expect, it } from 'vitest';
import { checkAiConnection, createAi } from '../adapters/ai.js';
import { createCatalogCommon } from '../api/catalog-common.js';
import {
	changedPrice,
	changedStock,
	checkPriceChange,
	checkProduct,
	checkStockChanges,
	cleanText,
	freeSlug,
	slugify,
	specValue,
	summarize,
	variantName,
} from '../core/catalog.js';
import { aiPrompt, checkAiRequest, readSuggestions } from '../core/catalog-ai.js';
import { importGroups, importInput, orderRows, productRows } from '../core/catalog-csv.js';
import {
	afterFilter,
	cursorKey,
	facetsOf,
	readShopQuery,
	searchFilter,
	shopFilter,
	staffFilter,
	storedValues,
} from '../core/catalog-query.js';
import {
	categoryTree,
	checkAttribute,
	checkBrand,
	checkCategory,
	checkLocation,
	movedPaths,
	placeCategory,
} from '../core/catalog-taxonomy.js';
import { cardOf, compareAtOf, pageOf, specsOf } from '../core/catalog-views.js';
import { formatCell, parseCsv, recordsOf, toCsv, unescapeFormula } from '../core/csv.js';
import { checkGrades, gradesByKey } from '../core/grades.js';

/** @typedef {import('../core/catalog.js').CatalogRules} CatalogRules */

let counter = 0;
/** @param {Partial<CatalogRules>} [over] @returns {CatalogRules} */
const rules = (over = {}) => ({
	variants: true,
	locations: false,
	grades: true,
	digital: true,
	bookings: true,
	gradeKeys: new Set(['a']),
	locationIds: new Set(['loc_1']),
	categoryIds: new Set(['cat_1']),
	brandIds: new Set(['brd_1']),
	attributes: new Map([
		['att_n', { id: 'att_n', name: 'N', type: 'number', choices: [], unit: 'cm', filterable: true, comparable: true, sort: 0 }],
		['att_b', { id: 'att_b', name: 'B', type: 'boolean', choices: [], unit: '', filterable: true, comparable: false, sort: 1 }],
		[
			'att_c',
			{ id: 'att_c', name: 'C', type: 'choice', choices: ['x'], unit: '', filterable: false, comparable: false, sort: 2 },
		],
		['att_t', { id: 'att_t', name: 'T', type: 'text', choices: [], unit: '', filterable: false, comparable: false, sort: 3 }],
	]),
	newId: (prefix) => `${prefix}_${(counter += 1)}`,
	...over,
});

/** @param {unknown} body @param {Partial<CatalogRules>} [over] @param {any} [existing] */
const paths = (body, over, existing = null) => {
	const checked = checkProduct(body, rules(over), existing);
	return checked.ok ? [] : checked.errors.map((error) => error.path);
};

/** @param {any} [over] @returns {any} */
const record = (over = {}) => {
	const checked = checkProduct({ name: 'P', ...(over.variants ? {} : { price: 100, stock: 1 }), ...over }, rules(), null);
	if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
	return { id: 'prd_1', price: 100, inStock: true, media: [], rating: { average: 0, count: 0 }, ...checked.value };
};

describe('text and slugs', () => {
	it('cleans text and makes slugs of any script', () => {
		expect(cleanText('  a\tb\r\nc ', 10)).toBe('a b c');
		expect(cleanText('a\r\nb', 10, { multiline: true })).toBe('a\nb');
		expect(cleanText(5, 10)).toBeNull();
		expect(cleanText('abc', 2)).toBeNull();
		expect(slugify('Ça va? Ünïcode — Тест')).toBe('ca-va-unicode-тест');
		expect(slugify(null)).toBe('');
		expect(freeSlug('a', [])).toBe('a');
		expect(freeSlug('a', ['a', 'a-2'])).toBe('a-3');
		expect(freeSlug('x'.repeat(120), ['x'.repeat(120)])).toHaveLength(120);
		expect(variantName([{ name: 'Size' }, { name: 'Colour' }], { Colour: 'Red', Size: 'M' })).toBe('M / Red');
		expect(summarize([], true)).toEqual({ price: 0, inStock: false });
		expect(summarize([{ active: true, price: 5, stock: 0 }], false)).toEqual({ price: 5, inStock: true });
	});
});

describe('product checks', () => {
	it('checks specs against attribute types', () => {
		const attributes = rules().attributes;
		const of = (/** @type {string} */ id) => /** @type {any} */ (attributes.get(id));
		expect(specValue(of('att_n'), 'x')).toBeNull();
		expect(specValue(of('att_b'), 1)).toBeNull();
		expect(specValue(of('att_c'), 'y')).toBeNull();
		expect(specValue(of('att_c'), 'x')).toBe('x');
		expect(specValue(of('att_t'), '')).toBeNull();
		expect(paths({ name: 'P', price: 1, specs: { att_n: 'x', att_t: null, att_b: '' } })).toEqual(['/specs/att_n']);
		expect(paths({ name: 'P', price: 1, specs: [] })).toEqual(['/specs']);
	});

	it('checks options and variants', () => {
		const ok = { name: 'P', options: [{ name: 'S', values: ['a', 'b'] }] };
		expect(
			paths({
				...ok,
				variants: [
					{ options: { S: 'a' }, price: 1 },
					{ options: { S: 'a' }, price: 1 },
				],
			}),
		).toEqual(['/variants/1/options']);
		expect(paths({ ...ok, variants: [{ options: { S: 'c' }, price: 1 }] })).toEqual(['/variants/0/options']);
		expect(paths({ ...ok, variants: [] })).toEqual(['/variants']);
		expect(paths({ ...ok, variants: [5] })).toEqual(['/variants/0', '/variants/0/options']);
		expect(
			paths({
				...ok,
				variants: [
					{ options: { S: 'a' }, price: 1, sku: 'A' },
					{ options: { S: 'b' }, price: 1, sku: 'A' },
				],
			}),
		).toEqual(['/variants']);
		expect(paths({ ...ok, price: 1, variants: [{ options: { S: 'a' }, price: 1 }] })).toEqual(['/variants']);
		expect(paths({ name: 'P', options: 'x', price: 1 })).toEqual(['/options']);
		expect(
			paths({ name: 'P', options: [{ name: '' }, { name: 'S', values: [] }, { name: 'T', values: ['a', 'a'] }], price: 1 }),
		).toEqual(['/options/0/name', '/options/1/values', '/options/2/values']);
		expect(paths({ name: 'P', variants: [{ price: 1 }, { price: 2 }] })).toEqual(['/variants']);
		expect(paths({ ...ok, variants: [{ options: { S: 'a' }, price: 1 }] }, { variants: false })).toEqual(['/options']);
		expect(paths({ name: 'P', variants: [{ price: 1 }, { price: 1 }] }, { variants: false })).toEqual([
			'/variants',
			'/variants',
		]);
		expect(
			paths({
				name: 'P',
				variants: [{ price: 1, sku: 'x'.repeat(70), compareAtPrice: -1, cost: 'a', grade: 'z', active: 1, options: 5 }],
			}),
		).toEqual([
			'/variants/0/sku',
			'/variants/0/compareAtPrice',
			'/variants/0/cost',
			'/variants/0/grade',
			'/variants/0/active',
			'/variants/0/options',
		]);
		expect(paths({ name: 'P', price: 1, grade: 'a' }, { grades: false })).toEqual(['/grade']);
		expect(paths({ name: 'P', price: 1, stock: -1 })).toEqual(['/stock']);
		expect(paths({ name: 'P', price: 1, locations: { loc_1: 1 } })).toEqual([]);
		const graded = checkProduct({ name: 'P', price: 1, grade: '' }, rules(), null);
		expect(graded.ok && graded.value.variants[0]?.grade).toBeNull();
	});

	it('changes existing products', () => {
		const existing = record({
			options: [{ name: 'S', values: ['a', 'b'] }],
			variants: [
				{ options: { S: 'a' }, price: 1 },
				{ options: { S: 'b' }, price: 2 },
			],
		});
		expect(paths({ price: 5 }, {}, existing)).toEqual(['/variants']);
		expect(paths({ variants: [{ id: 'var_none', price: 1 }] }, {}, existing)).toEqual([
			'/variants/0/id',
			'/variants/0/options',
		]);
		const [a] = existing.variants;
		expect(paths({ variants: [{ id: a.id }, { id: a.id }] }, {}, existing)).toContain('/variants/1/id');
		const kept = checkProduct({ name: 'Q', status: 'archived' }, rules(), existing);
		expect(kept.ok && kept.value.variants).toEqual(existing.variants);
		const single = record();
		const changed = checkProduct(
			{ price: 7, grade: null, brandId: 'brd_1', returnDays: null, warrantyDays: 30 },
			rules(),
			single,
		);
		expect(changed.ok && changed.value).toMatchObject({ brandId: 'brd_1', warrantyDays: 30, returnDays: null });
		expect(changed.ok && changed.value.variants[0]?.price).toBe(7);
		const cleared = checkProduct({ brandId: '' }, rules(), { ...single, brandId: 'brd_1' });
		expect(cleared.ok && cleared.value.brandId).toBeNull();
		// a kind that is now off may stay, but not be chosen again
		const digital = record({ kind: 'digital', digital: { licenceKeys: true } });
		expect(paths({ name: 'E' }, { digital: false }, digital)).toEqual([]);
		expect(paths({ kind: 'digital' }, { digital: false }, digital)).toEqual(['/kind']);
		expect(paths({ digital: 'x' }, {}, digital)).toEqual(['/digital']);
		expect(paths({ digital: { licenceKeys: 1, downloadLimit: -1 } }, {}, digital)).toEqual([
			'/digital/licenceKeys',
			'/digital/downloadLimit',
		]);
		const booking = record({ kind: 'booking', booking: { durationMinutes: 30 } });
		const longer = checkProduct({ booking: { durationMinutes: 60 } }, rules(), booking);
		expect(longer.ok && longer.value.booking).toEqual({ durationMinutes: 60 });
		expect(paths({ seo: { description: 'x'.repeat(600) } }, {}, single)).toEqual(['/seo/description']);
		expect(paths({ seo: { title: 'T' } }, {}, single)).toEqual([]);
		expect(paths({ serialized: 'yes', slug: 'Bad Slug', warrantyDays: -1 }, {}, single)).toEqual([
			'/slug',
			'/serialized',
			'/warrantyDays',
		]);
	});

	it('changes prices and stock', () => {
		expect(changedPrice(999, { mode: 'percent', value: -10 })).toBe(899);
		expect(changedPrice(100, { mode: 'fixed', value: -500 })).toBe(0);
		expect(checkPriceChange(null)).toBeNull();
		expect(checkPriceChange({ mode: 'fixed', value: 1.5 })).toBeNull();
		expect(checkPriceChange({ mode: 'percent', value: -101 })).toBeNull();
		expect(checkPriceChange({ mode: 'fixed', value: -5 })).toEqual({ mode: 'fixed', value: -5 });
		expect(changedStock({ stock: 3, locations: {} }, { adjust: -4 })).toBeNull();
		expect(changedStock({ stock: 3, locations: {} }, { set: 2 })).toEqual({ stock: 2, locations: {} });
		expect(changedStock({ stock: 3, locations: { a: 3 } }, { adjust: -4, locationId: 'a' })).toBeNull();
		expect(changedStock({ stock: 3, locations: { a: 3 } }, { set: 1, locationId: 'b' })).toEqual({
			stock: 4,
			locations: { a: 3, b: 1 },
		});
		const bad = checkStockChanges(
			{ changes: [5, { variantId: 'v' }, { variantId: 'v', set: -1 }, { variantId: 'v', adjust: 0.5 }] },
			{ locations: false },
		);
		expect(bad.ok ? [] : bad.errors.map((e) => e.path)).toEqual([
			'/changes/0',
			'/changes/1',
			'/changes/2/set',
			'/changes/3/adjust',
		]);
		expect(checkStockChanges({}, { locations: false }).ok).toBe(false);
	});
});

describe('categories, brands, attributes and locations', () => {
	it('checks records and places categories', () => {
		expect(checkCategory(null, null).ok).toBe(false);
		expect(checkBrand({ name: 'B', description: 5 }, null).ok).toBe(false);
		expect(checkAttribute(null, null).ok).toBe(false);
		expect(checkAttribute({ name: 'A', unit: 'x'.repeat(30), comparable: 1 }, null).ok).toBe(false);
		const attribute = checkAttribute({ name: 'A', type: 'text', choices: ['x'] }, null);
		expect(attribute.ok && attribute.value.choices).toEqual([]);
		expect(checkLocation(null, null).ok).toBe(false);
		expect(checkLocation({}, null).ok).toBe(false);
		expect(
			checkCategory(
				{ seo: { description: 'x'.repeat(600) }, description: 5 },
				{
					id: 'c',
					slug: 'c',
					name: 'C',
					parentId: null,
					path: [],
					description: '',
					seo: { title: '', description: '' },
					image: null,
					sort: 0,
				},
			).ok,
		).toBe(false);
		const byId = new Map(
			Array.from({ length: 10 }, (_, i) => [`c${i}`, { id: `c${i}`, path: Array.from({ length: i }, (__, j) => `c${j}`) }]),
		);
		expect(placeCategory('x', 'c9', byId)).toEqual({ ok: false, message: 'Categories go at most 10 levels deep.' });
		expect(placeCategory(null, 'c1', byId)).toEqual({ ok: true, path: ['c0', 'c1'] });
		expect(movedPaths('c1', ['z'], [...byId.values()]).find((c) => c.id === 'c3')?.path).toEqual(['z', 'c1', 'c2']);
	});

	it('counts products in the tree once per branch', () => {
		const category = (/** @type {string} */ id, /** @type {string | null} */ parentId, /** @type {string[]} */ path) => ({
			id,
			slug: id,
			name: id.toUpperCase(),
			parentId,
			path,
			description: '',
			seo: { title: '', description: '' },
			image: null,
			sort: 0,
		});
		const tree = categoryTree(
			[category('a', null, []), category('b', 'a', ['a']), category('c', null, [])],
			[
				{ categoryIds: ['a', 'b'], count: 2 },
				{ categoryIds: ['b', 'gone'], count: 1 },
			],
		);
		expect(tree.map((n) => [n.id, n.count, n.children.map((c) => [c.id, c.count])])).toEqual([
			['a', 3, [['b', 3]]],
			['c', 0, []],
		]);
	});
});

describe('listings', () => {
	it('reads queries and builds filters', () => {
		expect(searchFilter('   ')).toBeNull();
		expect(JSON.stringify(searchFilter('a.b'))).toContain('a\\\\.b');
		const read = readShopQuery({ q: 'x', inStock: '1', 'attr.att_n': ' 1, ,2', 'attr.att_b': '', grade: 'a' });
		expect(read.ok && read.value).toMatchObject({
			inStock: true,
			attributes: [{ id: 'att_n', values: ['1', '2'] }],
			sort: 'newest',
		});
		expect(readShopQuery({ maxPrice: '-1' }).ok).toBe(false);
		const attributes = rules().attributes;
		expect(storedValues(attributes.get('att_n'), ['1', 'x'])).toEqual([1]);
		expect(storedValues(attributes.get('att_b'), ['true', 'no'])).toEqual([true]);
		expect(storedValues(undefined, ['a'])).toEqual([]);
		expect(
			shopFilter(/** @type {any} */ ({ q: '', minPrice: null, maxPrice: null, inStock: false, attributes: [], grade: null }), {
				categoryIds: null,
				brandId: null,
				attributes,
			}),
		).toEqual({
			status: 'active',
		});
		expect(staffFilter({}, { categoryIds: null, brandId: null, lowStock: 1 })).toEqual({});
		expect(afterFilter({ field: 'publishedAt', dir: -1 }, ['x', 'id'])).toBeNull();
		expect(afterFilter({ field: 'price', dir: 1 }, 'x')).toBeNull();
		expect(cursorKey({ id: 'a', rating: null }, { field: 'rating.average', dir: -1 })).toEqual([null, 'a']);
		expect(cursorKey({ id: 'a' }, { field: 'price', dir: 1 })).toEqual([null, 'a']);
	});

	it('names facets and drops unknown records', () => {
		const facets = facetsOf(
			{
				categories: [{ _id: 'gone', count: 1 }],
				brands: [],
				price: [],
				attributes: [
					{ _id: { k: 'att_x', v: 1 }, count: 1 },
					{ _id: { k: 'att_c', v: 'b' }, count: 1 },
					{ _id: { k: 'att_c', v: 'a' }, count: 2 },
				],
				grades: [{ _id: 'gone', count: 1 }],
			},
			{ categories: new Map(), brands: new Map(), attributes: rules().attributes, grades: new Map() },
		);
		expect(facets).toEqual({
			categories: [],
			brands: [],
			price: null,
			attributes: [
				{
					id: 'att_c',
					name: 'C',
					unit: '',
					type: 'choice',
					values: [
						{ value: 'a', count: 2 },
						{ value: 'b', count: 1 },
					],
				},
			],
			grades: [],
		});
		expect(
			facetsOf(undefined, { categories: new Map(), brands: new Map(), attributes: new Map(), grades: new Map() }).price,
		).toBeNull();
	});
});

describe('views', () => {
	it('builds cards and pages without stock counts', () => {
		const product = { ...record({ seo: { title: 'T', description: 'D' }, specs: { att_n: 3 } }), specs: { att_n: 3, gone: 1 } };
		const grades = gradesByKey([{ key: 'a', label: 'A', description: '' }, { nothing: true }]);
		expect(compareAtOf({ ...product, variants: [] })).toBeNull();
		const card = cardOf(/** @type {any} */ ({ ...product, rating: undefined }), {
			currency: 'EUR',
			image: null,
			url: 'u',
			brand: null,
			grades,
		});
		expect(card.rating).toEqual({ average: 0, count: 0 });
		const page = pageOf(/** @type {any} */ ({ ...product, rating: undefined }), {
			currency: 'EUR',
			url: 'u',
			media: [],
			brand: null,
			breadcrumb: [],
			attributes: rules().attributes,
			grades,
		});
		expect(page.seo).toEqual({ title: 'T', description: 'D' });
		expect(page.rating).toEqual({ average: 0, count: 0 });
		expect(page.variants[0]).not.toHaveProperty('stock');
		expect(specsOf(/** @type {any} */ ({ specs: undefined }), new Map())).toEqual([]);
	});
});

describe('CSV', () => {
	it('writes and reads cells safely', () => {
		expect(formatCell(null)).toBe('');
		expect(formatCell(Number.NaN)).toBe('');
		expect(formatCell(false)).toBe('false');
		expect(formatCell('-1')).toBe("'-1");
		expect(formatCell('a;b', ';')).toBe('"a;b"');
		expect(toCsv(['a'], [['x']], { bom: false })).toBe('a\r\nx\r\n');
		expect(unescapeFormula("'x")).toBe("'x");
		expect(parseCsv('a,b\r\n\r\n"x ""y""",z\rq,"line\nbreak"')).toEqual({
			ok: true,
			rows: [
				['a', 'b'],
				['x "y"', 'z'],
				['q', 'line\nbreak'],
			],
		});
		expect(parseCsv('a\n1\n2\n3', { maxRows: 1 })).toEqual({ ok: false, code: 'too_many_rows' });
		expect(parseCsv('a\n1\n2', { maxRows: 1 })).toEqual({ ok: false, code: 'too_many_rows' });
		expect(parseCsv('a,')).toEqual({ ok: true, rows: [['a', '']] });
		expect(
			recordsOf([
				[' Name ', '', 'name'],
				['x', 'y', 'z'],
			]).records[0]?.values,
		).toEqual({ name: 'x' });
		expect(recordsOf([]).header).toEqual([]);
	});

	it('reads import rows into products', () => {
		const file = recordsOf(
			/** @type {any} */ (
				parseCsv(
					'name,option1_name,option1_value,option2_name,option2_value,cost,compare_at_price,track_stock,stock,grade\n' +
						'A,Size,S,Colour,,abc,,maybe,1,\n' +
						',,,,,,,,,\n' +
						'B,Size,M,,,,,false,,a',
				)
			).rows,
		);
		const read = importGroups(file, { currency: 'USD', locationIds: new Set() });
		expect(read.errors.map((e) => `${e.line}${e.path}`)).toEqual(['2/option2_value', '2/cost', '2/track_stock', '3/name']);
		const b = /** @type {any} */ (read.groups[1]);
		expect(b.fields).toEqual({ name: 'B', trackStock: false });
		expect(b.rows[0].variant).toEqual({ options: { Size: 'M' }, compareAtPrice: null, cost: null, grade: 'a' });
		const lookups = { categoryIds: new Map([['phones', 'cat_1']]), brandIds: new Map([['acme', 'brd_1']]) };
		const existing = record({ sku: 'S1' });
		const input = importInput(
			{
				...b,
				categories: ['PHONES'],
				brand: 'ACME',
				rows: [
					{ line: 2, variant: { sku: 'S1', stock: 4 } },
					{ line: 3, variant: { id: 'var_none' } },
				],
			},
			existing,
			lookups,
		);
		expect(input.ok ? [] : input.errors.map((e) => e.path)).toEqual(['/variant_id']);
		const fine = importInput(
			{ ...b, categories: ['phones'], brand: null, rows: [{ line: 2, variant: { sku: 'S1', stock: 4, options: {} } }] },
			existing,
			lookups,
		);
		expect(fine.ok && fine.input).toMatchObject({ categoryIds: ['cat_1'], brandId: null, options: [] });
		expect(fine.ok && [...fine.stock.values()]).toEqual([{ stock: 4 }]);
		const fresh = importInput({ ...b, fields: {}, rows: [{ line: 2, variant: {} }] }, null, lookups);
		expect(fresh.ok ? [] : fresh.errors.map((e) => e.path)).toEqual(['/name', '/price']);
		expect(importGroups({ header: ['x'], records: [] }, { currency: 'USD', locationIds: new Set() }).errors[0]?.line).toBe(1);
	});

	it('writes product and order rows', () => {
		const product = record({ categoryIds: ['cat_1'], brandId: 'brd_1', variants: undefined, price: 100, compareAtPrice: 150 });
		const rows = productRows(
			[
				{
					...product,
					options: [{ name: 'S', values: ['a'] }],
					variants: [{ ...product.variants[0], options: {}, locations: {} }],
				},
			],
			{
				currency: 'USD',
				categorySlugs: new Map(),
				brandSlugs: new Map(),
				locationIds: ['loc_1'],
			},
		);
		expect(rows[0]?.slice(5, 7)).toEqual(['cat_1', 'brd_1']);
		expect(rows[0]?.at(-1)).toBe(0);
		const order = /** @type {any} */ ({
			number: '1',
			placedAt: new Date(0),
			status: 's',
			customer: { name: 'N' },
			address: null,
			lines: [{ name: 'L', variantName: '', sku: '', quantity: 1, unitPrice: 1, discount: 0, total: 1 }],
			totals: { currency: 'JPY' },
			payment: { method: 'cod', state: 'unpaid' },
		});
		expect(orderRows([order])[0]).toEqual([
			'1',
			'1970-01-01T00:00:00.000Z',
			's',
			'N',
			'',
			'L',
			'',
			'',
			1,
			'1',
			'0',
			'1',
			'JPY',
			'cod',
			'unpaid',
		]);
	});
});

describe('grades', () => {
	it('checks the grades list', () => {
		expect(checkGrades('x')).toEqual({ ok: false, errors: ['A list is expected.'] });
		expect(checkGrades(Array.from({ length: 21 }, () => ({})))).toEqual({ ok: false, errors: ['At most 20 grades.'] });
		const bad = checkGrades([
			null,
			{ key: 'A' },
			{ key: 'a', label: 'A', description: 5, returnDays: -1, warrantyDays: 1.5 },
			{ key: 'a', label: 'x'.repeat(61) },
		]);
		expect(bad.ok ? 0 : bad.errors.length).toBe(8);
		expect(checkGrades([{ key: ' new ', label: ' New ', description: ' Box ', returnDays: 7 }])).toEqual({
			ok: true,
			value: [{ key: 'new', label: 'New', description: 'Box', returnDays: 7, warrantyDays: null }],
		});
		expect(gradesByKey('x').size).toBe(0);
	});
});

describe('AI copy', () => {
	it('checks requests, writes prompts and reads answers', () => {
		expect(checkAiRequest(null)).toMatchObject({ ok: false, path: '/fields' });
		expect(checkAiRequest({ fields: ['summary', 'summary'] })).toEqual({
			ok: true,
			value: { fields: ['summary'], tone: '', language: '' },
		});
		const prompt = aiPrompt(
			{
				name: 'N',
				summary: '',
				description: '',
				brand: null,
				categories: [],
				specs: [{ name: 'W', value: 2, unit: '' }],
				options: [],
				kind: 'physical',
			},
			{ fields: ['description', 'summary', 'seoTitle', 'seoDescription'], tone: '', language: '', words: 80 },
		);
		expect(prompt.system).toContain('the language of the product facts');
		expect(prompt.prompt).toContain('W: 2\n');
		expect(prompt.prompt).toContain('about 80 words');
		expect(readSuggestions('nothing', ['summary', 'seoTitle'])).toBeNull();
		expect(readSuggestions('{ broken', ['summary', 'seoTitle'])).toBeNull();
		expect(readSuggestions('[1]', ['summary', 'seoTitle'])).toBeNull();
		expect(readSuggestions('{"summary": 5, "seoTitle": "x"}', ['summary', 'seoTitle'])).toEqual({ seoTitle: 'x' });
		expect(readSuggestions(`{"seoTitle": "${'x'.repeat(100)}"}`, ['seoTitle'])?.seoTitle).toHaveLength(70);
	});

	it('talks to an OpenAI-compatible provider', async () => {
		/** @type {any[]} */
		const calls = [];
		/** @type {any} */
		let reply = { status: 200, body: '{}' };
		const ai = createAi({
			send: async (url, init) => {
				calls.push({ url, init });
				if (reply === 'throw') throw new Error('down');
				return { status: reply.status, headers: {}, body: Buffer.from(reply.body), url };
			},
		});
		const value = { baseUrl: 'https://ai.example.org/v1/', apiKey: 'sk-12345678', model: 'gpt' };
		expect(checkAiConnection(null).ok).toBe(false);
		expect(checkAiConnection({ baseUrl: 'http://x' }).ok).toBe(false);
		expect(checkAiConnection({ baseUrl: 'https://x', apiKey: 'short' }).ok).toBe(false);
		expect(checkAiConnection({ baseUrl: 'https://x', apiKey: 'long-enough', model: 'bad model' }).ok).toBe(false);
		expect(await ai.test(null)).toMatchObject({ ok: false });
		expect(await ai.test(value)).toEqual({ ok: true });
		expect(calls[0].url).toBe('https://ai.example.org/v1/models');
		reply = { status: 401, body: '' };
		expect(await ai.test(value)).toEqual({ ok: false, message: 'The provider refused the key.' });
		reply = { status: 500, body: '' };
		expect(await ai.test(value)).toEqual({ ok: false, message: 'The provider answered 500.' });
		reply = 'throw';
		expect(await ai.test(value)).toEqual({ ok: false, message: 'The provider cannot be reached.' });
		const request = { system: 's', prompt: 'p', maxTokens: 10 };
		expect(await ai.write(null, request)).toEqual({ ok: false, code: 'not_connected' });
		expect(await ai.write(value, request)).toEqual({ ok: false, code: 'provider_error' });
		reply = { status: 200, body: '{"choices":[{"message":{"content":"  "}}]}' };
		expect(await ai.write(value, request)).toEqual({ ok: false, code: 'provider_error' });
		reply = { status: 200, body: '' };
		expect(await ai.write(value, request)).toEqual({ ok: false, code: 'provider_error' });
		reply = { status: 200, body: '{"choices":[{"message":{"content":"Hi"}}]}' };
		expect(await ai.write(value, request)).toEqual({ ok: true, text: 'Hi' });
		expect(JSON.parse(calls.at(-1).init.body)).toMatchObject({ model: 'gpt', max_tokens: 10 });
	});
});

describe('change notices', () => {
	it('tells the other parts which products changed, with their price and availability before', async () => {
		/** @type {any[]} */
		const emitted = [];
		const common = createCatalogCommon(
			/** @type {any} */ ({ connections: {} }),
			/** @type {any} */ ({ emit: async (/** @type {any[]} */ ...args) => emitted.push(args) }),
		);
		const s = /** @type {any} */ ({});
		await common.changed(s, []);
		expect(emitted).toEqual([]);
		await common.changed(s, [{ id: 'prd_1', price: 5, inStock: false }], ['prd_1', 'prd_2', 'prd_1']);
		expect(emitted[0][0]).toBe('products.changed');
		expect(emitted[0][2].productIds).toEqual(['prd_1', 'prd_2']);
		expect([...emitted[0][2].before.entries()]).toEqual([['prd_1', { price: 5, inStock: false }]]);
	});
});
