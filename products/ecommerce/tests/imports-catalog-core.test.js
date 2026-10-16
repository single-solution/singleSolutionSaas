/**
 * The catalog's import checks on their own (PLAN 0.8.10 Migration; `core/imports-catalog.js`): what each check
 * refuses by name, what it takes as given and what it derives, and the category tree finish rebuilds.
 */
import { describe, expect, it } from 'vitest';
import { showDefaults } from '../core/fields.js';
import {
	categoryPaths,
	checkImportedAttribute,
	checkImportedBrand,
	checkImportedBundle,
	checkImportedCategory,
	checkImportedDeal,
	checkImportedLanding,
	checkImportedProduct,
	checkImportedSerial,
	checkImportedSizeChart,
	importedDate,
	importedMedia,
	offerProductIds,
	unknownFields,
} from '../core/imports-catalog.js';

/** @param {string} prefix @param {number} n */
const idOf = (prefix, n) => `${prefix}_${n.toString(16).padStart(24, '0')}`;
const NOW = Date.parse('2026-10-14T12:00:00Z');
const CAT = idOf('cat', 1);
const BRD = idOf('brd', 1);
const SZC = idOf('szc', 1);
const LOC = idOf('loc', 1);
const ATT = idOf('att', 1);

/**
 * A website's context for the checks.
 * @param {{ features?: string[] }} [options]
 * @returns {import('../core/imports-catalog.js').ImportContext}
 */
const contextOf = ({ features = ['variants', 'grades_serials', 'digital_goods', 'bookings', 'size_charts'] } = {}) => ({
	now: NOW,
	features: new Set(features),
	categoryIds: new Set([CAT]),
	brandIds: new Set([BRD]),
	sizeChartIds: new Set([SZC]),
	gradeKeys: new Set(['a-plus']),
	locationIds: new Set([LOC]),
	types: [],
	categories: new Map([[CAT, { path: [] }]]),
	rules: {
		variants: features.includes('variants'),
		locations: features.includes('multi_location'),
		grades: true,
		digital: true,
		bookings: true,
		parcels: true,
		gradeKeys: new Set(['a-plus']),
		gradeTypes: new Map([['a-plus', []]]),
		locationIds: new Set([LOC]),
		categoryIds: new Set([CAT]),
		categoryPaths: new Map([[CAT, []]]),
		categoryTypes: new Map([[CAT, null]]),
		types: [],
		brandIds: new Set([BRD]),
		attributes: new Map([
			[
				ATT,
				{
					id: ATT,
					name: 'Color',
					type: 'choice',
					choices: [
						{ value: 'red', label: 'Red' },
						{ value: 'blue', label: 'Blue' },
					],
					unit: '',
					min: null,
					max: null,
					decimals: 0,
					dates: 'any',
					format: null,
					required: false,
					requiredAt: null,
					show: { ...showDefaults('variant'), filter: true },
					sort: 0,
					on: 'variant',
					categoryId: null,
					slug: 'color',
					categoryIds: [],
					multiple: false,
					maxValues: 1,
					visibility: { when: 'always', ids: [], attributeId: null, value: null },
					active: true,
					seo: { title: '', description: '', body: '', faqs: [] },
				},
			],
		]),
		newId: (prefix) => `${prefix}_new0000000000`,
		sizeCharts: true,
		sizeChartIds: new Set([SZC]),
	},
});

/** @param {import('../core/imports-catalog.js').ImportChecked} checked */
const paths = (checked) => (checked.ok ? [] : checked.errors.map((error) => error.path));

/** A product with one variant. @param {Record<string, unknown>} [extra] */
const product = (extra = {}) => ({
	id: idOf('prd', 1),
	slug: 'lamp',
	name: 'Lamp',
	status: 'active',
	variants: [{ id: idOf('var', 1), sku: 'L-1', price: 1000, stock: 2 }],
	...extra,
});

describe('shared rules', () => {
	it('names fields a record type does not have', () => {
		expect(unknownFields({ id: 'x', merchantId: 'm', extra: 1 }, ['id'], 'a thing')).toEqual([
			{ path: '/merchantId', message: "merchantId is the token's website: leave it out." },
			{ path: '/extra', message: 'extra is not a field of a thing.' },
		]);
	});

	it('takes ISO times in the past, null when allowed, and refuses the rest', () => {
		/** @type {Array<{ path: string, message: string }>} */
		const errors = [];
		expect(importedDate(undefined, '/a', errors, { now: NOW })).toBeUndefined();
		expect(importedDate(null, '/a', errors, { now: NOW, nullable: true })).toBeNull();
		expect(importedDate('2024-01-02', '/a', errors, { now: NOW })?.toISOString()).toBe('2024-01-02T00:00:00.000Z');
		expect(importedDate('2999-01-01T00:00:00Z', '/b', errors, { now: NOW, future: true })).toBeInstanceOf(Date);
		expect(importedDate('2999-01-01T00:00:00Z', '/c', errors, { now: NOW })).toBeUndefined();
		expect(importedDate('Jan 2 2024', '/d', errors, { now: NOW })).toBeUndefined();
		expect(importedDate(null, '/e', errors, { now: NOW })).toBeUndefined();
		expect(errors.map((error) => error.path)).toEqual(['/c', '/d', '/e']);
	});

	it('keeps photo keys of any folder with their facts, and refuses bad ones by field', () => {
		/** @type {Array<{ path: string, message: string }>} */
		const errors = [];
		expect(importedMedia({ key: 'a/b.webp', sizes: { card: 'a/b-card.webp' }, blur: '' }, '/m', errors)).toEqual({
			key: 'a/b.webp',
			type: '',
			size: 0,
			alt: '',
			sizes: { card: 'a/b-card.webp' },
		});
		expect(importedMedia('a/b.webp', '/n', errors)).toBeNull();
		expect(
			importedMedia({ key: '../x', type: 7, size: -1, alt: 'x'.repeat(201), url: 'https://x', width: 0 }, '/o', errors),
		).toBeNull();
		expect(errors.map((error) => error.path)).toEqual(['/n', '/o/url', '/o/key', '/o/type', '/o/size', '/o/alt', '/o/width']);
	});

	it('never makes a private file a public photo (review L15)', () => {
		// a transfer proof, a digital good or a claim photo, or a file whose type is not an image, as a product photo
		for (const media of [
			{ key: 'ecommerce/proofs/ord_1/prf_1.pdf' },
			{ key: 'ecommerce/digital/prd_1/book.pdf' },
			{ key: 'ecommerce/returns/usr_1/pho_1.jpg' },
			{ key: 'uploads/manual.pdf', type: 'application/pdf' },
		])
			expect(paths(checkImportedProduct(product({ media: [media] }), contextOf())), media.key).toEqual(['/media/0/key']);
		expect(
			paths(
				checkImportedCategory(
					{ id: idOf('cat', 9), name: 'X', slug: 'x', image: { key: 'ecommerce/digital/a.zip' } },
					contextOf(),
				),
			),
		).toEqual(['/image/key']);
		// a photo of any other folder, and a digital product's files, are taken
		expect(
			paths(checkImportedProduct(product({ media: [{ key: 'uploads/lamp.jpg', type: 'image/jpeg' }] }), contextOf())),
		).toEqual([]);
	});

	it('lists the products an offer names', () => {
		expect(
			offerProductIds({
				scope: { productIds: ['a'] },
				getScope: { productIds: ['b', 'a'] },
				items: [{ productId: 'c' }],
			}),
		).toEqual(['a', 'b', 'c']);
	});
});

describe('taxonomy', () => {
	it('checks categories: parents, size charts, images and earlier slugs', () => {
		const context = contextOf();
		const ok = checkImportedCategory(
			{ id: idOf('cat', 2), slug: 'lamps', name: 'Lamps', parentId: CAT, sizeChartId: SZC, previousSlugs: ['lights'] },
			context,
		);
		expect(ok).toMatchObject({ ok: true, value: { path: [CAT], parentId: CAT, image: null, status: 'active' } });
		const self = idOf('cat', 3);
		expect(
			paths(
				checkImportedCategory(
					{
						id: self,
						slug: 'Bad Slug',
						name: 'Self',
						parentId: self,
						previousSlugs: ['self', 'self'],
						image: { key: '' },
						sizeChartId: idOf('szc', 9),
					},
					context,
				),
			),
		).toEqual(['/slug', '/parentId', '/sizeChartId', '/image/key', '/previousSlugs']);
		expect(
			paths(
				checkImportedCategory({ id: self, slug: 'c', name: 'C', sizeChartId: SZC }, contextOf({ features: ['variants'] })),
			),
		).toEqual(['/sizeChartId']);
		// its item type: one of the imported list, or a built-in one
		expect(paths(checkImportedCategory({ id: self, slug: 'c', name: 'C', typeKey: 'used_phone' }, context))).toEqual([
			'/typeKey',
		]);
		expect(checkImportedCategory({ id: self, slug: 'c', name: 'C', typeKey: 'physical' }, context)).toMatchObject({
			ok: true,
			value: { typeKey: 'physical' },
		});
	});

	it('checks brands, attributes, size charts and landing pages against what is imported', () => {
		const context = contextOf();
		expect(
			paths(checkImportedBrand({ id: BRD, slug: 'b', name: 'B', categoryIds: [idOf('cat', 9)], logo: 'x' }, context)),
		).toEqual(['/categoryIds', '/logo']);
		expect(checkImportedBrand({ id: BRD, slug: 'b', name: 'B', categoryIds: [CAT] }, context)).toMatchObject({
			ok: true,
			value: { logo: null, categoryIds: [CAT] },
		});
		/** @param {unknown} visibility */
		const attribute = (visibility) =>
			checkImportedAttribute({ id: ATT, slug: 'color', name: 'Color', type: 'text', visibility }, context);
		expect(paths(attribute({ when: 'brands', ids: [idOf('brd', 9)] }))).toEqual(['/visibility/ids']);
		expect(paths(attribute({ when: 'grades', ids: ['z'] }))).toEqual(['/visibility/ids']);
		expect(paths(attribute({ when: 'attribute', attributeId: ATT, value: 'x' }))).toEqual(['/visibility/attributeId']);
		expect(attribute({ when: 'attribute', attributeId: idOf('att', 2), value: 'x' }).ok).toBe(true);
		expect(paths(attribute({ when: 'nobody' }))).toEqual(['/visibility']);
		expect(
			checkImportedAttribute({ id: ATT, slug: 'size', name: 'Size', type: 'choice', choices: ['S', 'M'] }, context),
		).toMatchObject({
			value: {
				choices: [
					{ value: 'S', label: 'S' },
					{ value: 'M', label: 'M' },
				],
			},
		});
		expect(
			checkImportedSizeChart(
				{
					id: SZC,
					name: 'Tops',
					columns: [{ key: '2-sleeve', label: 'Sleeve' }],
					rows: [{ size: 's', values: { '2-sleeve': 60 } }],
				},
				context,
			),
		).toMatchObject({ ok: true, value: { rows: [{ size: 's', label: 's', values: { '2-sleeve': '60' } }] } });
		expect(paths(checkImportedSizeChart({ id: SZC, name: 'Tops' }, context))).toEqual(['/columns']);
		expect(
			paths(
				checkImportedLanding(
					{
						id: idOf('lnd', 1),
						categoryId: idOf('cat', 9),
						brandId: idOf('brd', 9),
						facet: { field: 'grade', value: 'z' },
						h1: 'H',
					},
					context,
				),
			),
		).toEqual(['/categoryId', '/brandId', '/facet/value']);
		// a field's slug must name a field shoppers filter by
		expect(
			paths(
				checkImportedLanding(
					{ id: idOf('lnd', 1), facet: { field: 'color', value: 'red' } },
					{ ...context, fieldSlugs: new Set(['size']) },
				),
			),
		).toEqual(['/facet/field']);
		expect(
			paths(
				checkImportedLanding(
					{ id: idOf('lnd', 1), facet: { field: 'size', value: 'M' } },
					{ ...context, fieldSlugs: new Set(['size']) },
				),
			),
		).toEqual([]);
		expect(paths(checkImportedLanding({ id: idOf('lnd', 1) }, context))).toEqual(['/categoryId']);
	});

	it('builds the tree: orphans and loops stay at the top, deep branches are named', () => {
		const chain = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, parentId: i === 0 ? null : `c${i - 1}` }));
		const tree = categoryPaths([
			...chain,
			{ id: 'orphan', parentId: 'missing' },
			{ id: 'below-orphan', parentId: 'orphan' },
			{ id: 'loop-a', parentId: 'loop-b' },
			{ id: 'loop-b', parentId: 'loop-a' },
		]);
		expect(tree.paths.get('c2')).toEqual(['c0', 'c1']);
		expect(tree.paths.get('below-orphan')).toEqual(['orphan']);
		expect(tree.paths.get('loop-a')).toEqual([]);
		expect(tree).toMatchObject({ orphans: ['orphan'], cycles: ['loop-a', 'loop-b'], tooDeep: ['c10', 'c11'] });
	});
});

describe('SEO copy moved in (G6)', () => {
	it('is marked as the import’s and keeps its title mode', () => {
		const seo = { title: 'Lamps | Old Shop', description: 'Every lamp.', titleMode: 'as_written' };
		const product = checkImportedProduct(
			{ id: idOf('prd', 1), slug: 'lamp', name: 'Lamp', status: 'draft', variants: [], seo },
			contextOf(),
		);
		expect(product).toMatchObject({ ok: true, value: { seo: { ...seo, source: 'import' } } });
		const category = checkImportedCategory({ id: idOf('cat', 2), slug: 'lamps', name: 'Lamps', seo }, contextOf());
		expect(category).toMatchObject({ ok: true, value: { seo: { source: 'import', titleMode: 'as_written' } } });
		const brand = checkImportedBrand({ id: BRD, slug: 'b', name: 'B', seo: { description: 'Our brand.' } }, contextOf());
		expect(brand).toMatchObject({ ok: true, value: { seo: { source: 'import', titleMode: 'template' } } });
		const none = checkImportedBrand({ id: BRD, slug: 'b', name: 'B' }, contextOf());
		expect(none).toMatchObject({ ok: true, value: { seo: { source: null } } });
		expect(paths(checkImportedBrand({ id: BRD, slug: 'b', name: 'B', seo: { source: 'import' } }, contextOf()))).toEqual([
			'/seo/source',
		]);
	});
});

describe('products', () => {
	it('derives what a save derives and takes the given numbers, times and files', () => {
		const checked = checkImportedProduct(
			product({
				kind: 'digital',
				trackStock: false,
				digital: { files: [{ key: 'files/guide.pdf', type: 'application/pdf', size: 10 }], downloadLimit: 3 },
				createdAt: '2024-05-01T00:00:00Z',
			}),
			contextOf(),
		);
		expect(checked).toMatchObject({
			ok: true,
			value: {
				price: 1000,
				priceMax: 1000,
				inStock: true,
				stockState: 'none',
				sold: 0,
				rating: { average: 0, count: 0 },
				digital: { files: [{ key: 'files/guide.pdf', size: 10 }], downloadLimit: 3, licenseKeys: false },
				previousSlugs: [],
			},
		});
		// on sale since it was made (Migration: publishedAt = createdAt)
		expect(checked.ok && checked.value.publishedAt.toISOString()).toBe('2024-05-01T00:00:00.000Z');
		const draft = checkImportedProduct(product({ status: 'draft' }), contextOf());
		expect(draft.ok && draft.value.publishedAt).toBeNull();
		const shell = checkImportedProduct(product({ variants: [] }), contextOf());
		expect(shell).toMatchObject({ ok: true, value: { status: 'draft', variants: [], stockState: 'none' } });
		// the barcode and part numbers an earlier shop kept come along, checked (G5.6)
		const [first] = /** @type {any[]} */ (product().variants);
		const coded = checkImportedProduct(product({ variants: [{ ...first, gtin: '036000291452', mpn: 'P-1' }] }), contextOf());
		expect(coded).toMatchObject({ ok: true, value: { variants: [{ gtin: '036000291452', mpn: 'P-1' }] } });
		expect(paths(checkImportedProduct(product({ variants: [{ ...first, gtin: '036000291453' }] }), contextOf()))).toEqual([
			'/variants/0/gtin',
		]);
	});

	it('refuses a product by field', () => {
		const context = contextOf();
		expect(
			paths(
				checkImportedProduct(
					{
						id: idOf('prd', 1),
						slug: 'lamp',
						name: 'Lamp',
						variants: 'one',
						sold: -1,
						rating: { average: 6, count: 1 },
						booking: { durationMinutes: 30 },
						media: [{ key: 'a.webp' }, { key: 'a.webp' }],
						publishedAt: 'soon',
					},
					context,
				),
			),
		).toEqual(['/status', '/variants', '/booking', '/media/1/key', '/sold', '/rating', '/publishedAt']);
		expect(
			paths(
				checkImportedProduct(
					product({
						variants: [
							{ sku: 'A', price: 1 },
							{
								id: idOf('var', 2),
								sku: 'B',
								price: 2,
								attributes: { [ATT]: 'red' },
								media: [{ key: 'x.webp', extra: 1 }],
							},
							{ id: idOf('var', 2), sku: 'C', price: 3, attributes: { [ATT]: 'blue' } },
						],
						video: { kind: 'file', key: 'v.mov', type: 'video/quicktime' },
						media: 'none',
					}),
					context,
				),
			),
		).toEqual(['/variants/1/media/0/extra', '/variants/0/id', '/variants/2/id', '/video/type', '/media']);
		expect(paths(checkImportedProduct(product({ variants: ['one'] }), context))).toEqual(['/variants/0']);
	});

	it('keeps stock as the website counts it: overall, or per location adding up', () => {
		const located = contextOf({ features: ['variants', 'multi_location'] });
		const variant = { id: idOf('var', 1), price: 1000 };
		expect(
			checkImportedProduct(product({ variants: [{ ...variant, stock: 5, locations: { [LOC]: 5 } }] }), located),
		).toMatchObject({ ok: true, value: { variants: [{ stock: 5, locations: { [LOC]: 5 } }] } });
		expect(
			paths(checkImportedProduct(product({ variants: [{ ...variant, stock: 4, locations: { [LOC]: 5 } }] }), located)),
		).toEqual(['/variants/0/stock']);
		expect(paths(checkImportedProduct(product({ variants: [{ ...variant, stock: 4 }] }), located))).toEqual([
			'/variants/0/stock',
		]);
		expect(
			paths(checkImportedProduct(product({ variants: [{ ...variant, stock: 4, locations: { [LOC]: 4 } }] }), contextOf())),
		).toEqual(['/variants/0/locations']);
		expect(checkImportedProduct(product({ variants: [{ ...variant, stock: 4, locations: {} }] }), contextOf())).toMatchObject({
			ok: true,
			value: { variants: [{ stock: 4, locations: {} }] },
		});
	});
});

describe('serials and offers', () => {
	it('checks serials: ids, numbers, statuses, orders and locations', () => {
		const serial = {
			id: idOf('ser', 1),
			productId: idOf('prd', 1),
			variantId: idOf('var', 1),
			serial: '356938035643809',
			status: 'in_stock',
			orderId: idOf('ord', 1),
			lineId: idOf('oln', 1),
			locationId: null,
		};
		// a unit in stock belongs to no order
		expect(checkImportedSerial(serial, contextOf())).toMatchObject({ ok: true, value: { orderId: null, lineId: null } });
		expect(checkImportedSerial({ ...serial, status: 'sold', typed: true }, contextOf())).toMatchObject({
			ok: true,
			value: { orderId: idOf('ord', 1), typed: true },
		});
		expect(
			paths(
				checkImportedSerial(
					{
						...serial,
						productId: 'p',
						variantId: 'v',
						serial: ' spaced',
						status: 'sold',
						orderId: null,
						lineId: 'l',
						locationId: LOC,
						typed: 'yes',
					},
					contextOf(),
				),
			),
		).toEqual(['/productId', '/variantId', '/lineId', '/orderId', '/locationId', '/typed']);
		// the number is the unit's serial, or its values by unit field (checked against the product's fields on import)
		expect(paths(checkImportedSerial({ ...serial, serial: 5 }, contextOf()))).toEqual(['/serial', '/serial']);
		expect(paths(checkImportedSerial({ ...serial, serial: undefined }, contextOf()))).toEqual(['/serial']);
		expect(paths(checkImportedSerial({ ...serial, values: 'x' }, contextOf()))).toEqual(['/serial']);
		expect(checkImportedSerial({ ...serial, serial: undefined, values: { att_1: ['a'] } }, contextOf())).toMatchObject({
			ok: true,
			value: { values: { att_1: ['a'] } },
		});
		expect(
			paths(
				checkImportedSerial(
					{ ...serial, status: 'lost', locationId: idOf('loc', 9) },
					contextOf({ features: ['multi_location'] }),
				),
			),
		).toEqual(['/status', '/locationId']);
		expect(checkImportedSerial({ ...serial, locationId: LOC }, contextOf({ features: ['multi_location'] })).ok).toBe(true);
	});

	it('checks deals and bundles with their use counts and scopes', () => {
		const deal = {
			id: idOf('deal', 1),
			name: 'Deal',
			type: 'fixed',
			value: 100,
			used: 3,
			banner: { key: 'old/banner.webp', alt: '' },
			scope: { categoryIds: [CAT], brandIds: [BRD] },
		};
		expect(checkImportedDeal(deal, contextOf())).toMatchObject({
			ok: true,
			value: { used: 3, banner: { key: 'old/banner.webp' } },
		});
		expect(
			paths(
				checkImportedDeal(
					{ ...deal, used: -1, scope: { categoryIds: [idOf('cat', 9)], brandIds: [idOf('brd', 9)] } },
					contextOf(),
				),
			),
		).toEqual(['/scope/categoryIds', '/scope/brandIds', '/used']);
		expect(paths(checkImportedDeal({ ...deal, limit: 0 }, contextOf()))).toEqual(['/limit']);
		expect(paths(checkImportedDeal({ ...deal, banner: { key: 'a/../b' } }, contextOf()))).toEqual(['/banner']);
		const bundle = {
			id: idOf('bnd', 1),
			name: 'Two',
			type: 'buy_x_get_y',
			buy: 2,
			get: 1,
			getScope: { brandIds: [idOf('brd', 9)] },
		};
		expect(paths(checkImportedBundle(bundle, contextOf()))).toEqual(['/scope/brandIds']);
		expect(checkImportedBundle({ ...bundle, getScope: {} }, contextOf())).toMatchObject({
			ok: true,
			value: { used: 0, value: 100 },
		});
		expect(paths(checkImportedBundle({ ...bundle, buy: 0 }, contextOf()))).toEqual(['/buy']);
	});
});
