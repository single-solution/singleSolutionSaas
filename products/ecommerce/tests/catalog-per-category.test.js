/**
 * Attributes and grades per category (PLAN E45): the same attribute slug or grade key once per category, with its own
 * name, choices, unit, texts and SEO, and once for every category; products, listings and glossary pages take the
 * definition of their category or the nearest one above it first, then the one for every category; glossary addresses
 * with `{category}`; every active
 * attribute's page in the sitemap once its address is set (SG-20); the import keeps one attribute per category.
 */
import { createId } from '@ss/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attributeOf } from '../core/catalog-query.js';
import { lineageOf } from '../core/catalog-taxonomy.js';
import { resolveLines } from '../core/checkout.js';
import { gradeLabels } from '../core/compare.js';
import { checkGrades, gradesByKey, gradesFor } from '../core/grades.js';
import { returnableLines } from '../core/returns.js';
import { ORIGIN, readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
/** @type {{ dresses: any, evening: any, shirts: any, fabric: any, dressFabric: any }} */
const ids = /** @type {any} */ ({});

/** @param {string} method @param {string} path @param {unknown} [body] */
const api = async (method, path, body) => {
	const answer = await shop.api(method, path, body);
	if (answer.status >= 300) throw new Error(`${method} ${path}: ${answer.status} ${answer.text}`);
	return answer.json;
};

/** A variant of a grade. @param {string | null} grade */
const variant = (grade) => ({
	id: createId('var'),
	sku: '',
	options: {},
	price: 1000,
	compareAtPrice: null,
	cost: null,
	stock: 5,
	locations: {},
	grade,
	active: true,
});

beforeAll(async () => {
	shop = await readyShop();
	ids.dresses = await api('POST', '/v1/categories', { name: 'Dresses' });
	ids.evening = await api('POST', '/v1/categories', { name: 'Evening', parentId: ids.dresses.id });
	ids.shirts = await api('POST', '/v1/categories', { name: 'Shirts' });
	ids.fabric = await api('POST', '/v1/attributes', { name: 'Fabric', slug: 'fabric', show: { filter: true } });
	// glossary pages are indexed and listed with text of their own (G7.2)
	ids.dressFabric = await api('POST', '/v1/attributes', {
		name: 'Dress fabric',
		slug: 'fabric',
		categoryId: ids.dresses.id,
		seo: { body: 'How each dress fabric drapes.' },
		unit: 'gsm',
		type: 'choice',
		choices: [{ value: 'silk', label: 'Pure silk' }, 'linen'],
		show: { filter: true },
	});
	await shop.list('grades', [
		{ key: 'a', label: 'Grade A', description: 'Light marks.', warrantyDays: 30 },
		{
			key: 'a',
			label: 'Like new',
			description: 'As new.',
			categoryId: ids.dresses.id,
			warrantyDays: 90,
			seo: { title: '', description: '', body: 'Worn once at most.', faqs: [] },
		},
	]);
});

afterAll(async () => shop?.product.close());

describe('grades per category (E45)', () => {
	it('keeps one key per category and picks a product category first, then the one for every category', () => {
		// as the list is stored: every entry names its category, null for every category
		const list = [
			{ key: 'a', label: 'Grade A', categoryId: null },
			{ key: 'b', label: 'B for dresses', categoryId: 'cat_d' },
			{ key: 'a', label: 'Like new', categoryId: 'cat_d' },
			{ key: 'a', label: 'Mint', categoryId: 'cat_s' },
		];
		expect([...gradesFor(list, ['cat_d']).values()].map((grade) => grade.label)).toEqual(['B for dresses', 'Like new']);
		expect([...gradesFor(list, ['cat_x', 'cat_s']).values()].map((grade) => grade.label)).toEqual(['Mint']);
		expect([...gradesFor(list, ['cat_x']).values()].map((grade) => grade.label)).toEqual(['Grade A']);
		// no category known: the entry for every category, else the first for one
		expect([...gradesByKey(list).values()].map((grade) => grade.label)).toEqual(['Grade A', 'B for dresses']);
		expect(gradesByKey([{ key: 'x', categoryId: null }]).size).toBe(0);
		const checked = checkGrades([
			{ key: 'a', label: 'A' },
			{ key: 'a', label: 'A2', categoryId: 'cat_d' },
			{ key: 'a', label: 'A3', categoryId: 'cat_d' },
			{ key: 'b', label: 'B', categoryId: 5 },
		]);
		expect(checked).toEqual({
			ok: false,
			errors: [
				'Grade 3: the key a is used twice for the same category.',
				'Grade 4: the category is a category id, or null for every category.',
			],
		});
		expect(
			checkGrades([
				{ key: 'a', label: 'A' },
				{ key: 'a', label: 'B' },
			]),
		).toMatchObject({ ok: false });
	});

	it('applies a category definition to the categories below it, the nearest one up the tree winning', () => {
		// Dresses > Evening > Gala, and Sale at the top
		const tree = new Map([
			['cat_d', { path: [] }],
			['cat_e', { path: ['cat_d'] }],
			['cat_g', { path: ['cat_d', 'cat_e'] }],
			['cat_s', { path: [] }],
		]);
		expect(lineageOf(['cat_g', 'cat_s'], tree)).toEqual(['cat_g', 'cat_e', 'cat_d', 'cat_s']);
		expect(lineageOf(['cat_e', 'cat_d', null, '', 'cat_unknown'], tree)).toEqual(['cat_e', 'cat_d', 'cat_unknown']);
		const list = [
			{ key: 'a', label: 'Grade A', categoryId: null },
			{ key: 'a', label: 'Like new', categoryId: 'cat_d' },
			{ key: 'a', label: 'Evening mint', categoryId: 'cat_e' },
			{ key: 'a', label: 'Sale A', categoryId: 'cat_s' },
		];
		/** @param {string[]} categoryIds */
		const label = (categoryIds) => gradesFor(list, lineageOf(categoryIds, tree)).get('a')?.label;
		expect(label(['cat_g'])).toBe('Evening mint');
		expect(label(['cat_e'])).toBe('Evening mint');
		expect(label(['cat_d'])).toBe('Like new');
		// the first category and those above it come before the second category
		expect(label(['cat_g', 'cat_s'])).toBe('Evening mint');
		expect(label(['cat_s', 'cat_g'])).toBe('Sale A');
		expect(label(['cat_unknown'])).toBe('Grade A');
		const attributes = new Map(
			/** @type {Array<[string, any]>} */ ([
				['att_all', { id: 'att_all', slug: 'fabric', categoryId: null }],
				['att_d', { id: 'att_d', slug: 'fabric', categoryId: 'cat_d' }],
				['att_e', { id: 'att_e', slug: 'fabric', categoryId: 'cat_e' }],
			]),
		);
		expect(attributeOf(attributes, 'fabric', lineageOf(['cat_g'], tree))?.id).toBe('att_e');
		expect(attributeOf(attributes, 'fabric', lineageOf(['cat_d'], tree))?.id).toBe('att_d');
		expect(attributeOf(attributes, 'fabric', lineageOf(['cat_s'], tree))?.id).toBe('att_all');
	});

	it('takes a product category grade for compare labels, order lines and claim windows', () => {
		const list = [
			{ key: 'a', label: 'Grade A', returnDays: 3, warrantyDays: 30 },
			{ key: 'a', label: 'Like new', categoryId: 'cat_d', returnDays: 10, warrantyDays: 90 },
		];
		const product = { categoryIds: ['cat_d'], variants: [{ active: true, grade: 'a' }] };
		expect(gradeLabels(/** @type {any} */ (product), list, new Map())).toEqual(['Like new']);
		expect(gradeLabels(/** @type {any} */ ({ ...product, categoryIds: [] }), list, new Map())).toEqual(['Grade A']);
		// a product of a category below one with its own entry takes that entry
		const below = new Map([['cat_e', { path: ['cat_d'] }]]);
		expect(gradeLabels(/** @type {any} */ ({ ...product, categoryIds: ['cat_e'] }), list, below)).toEqual(['Like new']);
		/** @type {Array<[string, string[]]>} */
		const asked = [];
		resolveLines([{ productId: 'prd_1', variantId: 'var_1', quantity: 1, slot: null }], {
			products: new Map([
				[
					'prd_1',
					/** @type {any} */ ({
						id: 'prd_1',
						name: 'Dress',
						kind: 'physical',
						status: 'active',
						categoryIds: ['cat_d'],
						brandId: null,
						trackStock: false,
						media: [],
						variants: [{ ...variant('a'), id: 'var_1' }],
					}),
				],
			]),
			ancestors: (categoryIds) => categoryIds,
			gradeLabel: (key, categoryIds) => {
				asked.push([key, categoryIds]);
				return gradesFor(list, categoryIds).get(key)?.label ?? key;
			},
			features: { digital: false, bookings: false },
			slots: () => false,
			licences: new Map(),
			booked: new Set(),
			slotOf: () => null,
		});
		expect(asked).toEqual([['a', ['cat_d']]]);
		const line = {
			id: 'oln_1',
			productId: 'prd_1',
			kind: 'physical',
			quantity: 1,
			grade: 'a',
			categoryIds: ['cat_d'],
			serials: [],
			returnedQuantity: 0,
		};
		const delivered = new Date(Date.parse('2026-10-01T00:00:00Z'));
		const windows = returnableLines({
			order: /** @type {any} */ ({ lines: [line, { ...line, id: 'oln_2', categoryIds: [] }], deliveredAt: delivered }),
			claims: [],
			products: new Map([['prd_1', { returnDays: null, warrantyDays: null }]]),
			grades: list,
			lineage: (categoryIds) => lineageOf(categoryIds, new Map([['cat_e', { path: ['cat_d'] }]])),
			defaults: { returnDays: 7, warrantyDays: 0 },
			now: Date.parse('2026-10-05T00:00:00Z'),
		});
		expect(windows.map((entry) => [entry.return.days, entry.warranty.days])).toEqual([
			[10, 90],
			[3, 30],
		]);
		const evening = returnableLines({
			order: /** @type {any} */ ({ lines: [{ ...line, categoryIds: ['cat_e'] }], deliveredAt: delivered }),
			claims: [],
			products: new Map([['prd_1', { returnDays: null, warrantyDays: null }]]),
			grades: list,
			lineage: (categoryIds) => lineageOf(categoryIds, new Map([['cat_e', { path: ['cat_d'] }]])),
			defaults: { returnDays: 7, warrantyDays: 0 },
			now: Date.parse('2026-10-05T00:00:00Z'),
		});
		expect(evening.map((entry) => [entry.return.days, entry.warranty.days])).toEqual([[10, 90]]);
	});

	it('names a variant grade as its product category defines it', async () => {
		const dress = await shop.seedProduct({ name: 'Silk dress', categoryIds: [ids.dresses.id], variants: [variant('a')] });
		const shirt = await shop.seedProduct({ name: 'Oxford shirt', categoryIds: [ids.shirts.id], variants: [variant('a')] });
		const page = (await shop.visitor('GET', `/v1/shop/products/${dress.slug}`)).json;
		expect(page.variants[0].grade).toMatchObject({ key: 'a', label: 'Like new', warrantyDays: 90 });
		expect((await shop.visitor('GET', `/v1/shop/products/${shirt.slug}`)).json.variants[0].grade.label).toBe('Grade A');
		const cards = (await shop.visitor('GET', '/v1/shop/products?q=Silk')).json.items;
		expect(cards[0].grades).toEqual(['Like new']);
		// the first page of a category's listing names its grades as the category defines them
		const listing = (await shop.visitor('GET', `/v1/shop/products?category=${ids.dresses.slug}`)).json;
		expect(listing.facets.grades).toEqual([{ key: 'a', label: 'Like new', count: 1 }]);
		const all = (await shop.visitor('GET', '/v1/shop/products')).json;
		expect(all.facets.grades).toEqual([{ key: 'a', label: 'Grade A', count: 2 }]);
	});

	it('names a grade as the nearest category above a product defines it (sub-categories)', async () => {
		const gown = await shop.seedProduct({ name: 'Evening gown', categoryIds: [ids.evening.id], variants: [variant('a')] });
		expect((await shop.visitor('GET', `/v1/shop/products/${gown.slug}`)).json.variants[0].grade).toMatchObject({
			label: 'Like new',
			warrantyDays: 90,
		});
		expect((await shop.visitor('GET', '/v1/shop/products?q=gown')).json.items[0].grades).toEqual(['Like new']);
		const listing = (await shop.visitor('GET', `/v1/shop/products?category=${ids.evening.slug}`)).json;
		expect(listing.facets.grades).toEqual([{ key: 'a', label: 'Like new', count: 1 }]);
		expect(await api('GET', `/v1/seo/grades/${ids.evening.slug}/a`)).toMatchObject({
			label: 'Like new',
			categoryId: ids.dresses.id,
			category: { id: ids.evening.id },
		});
	});

	it('answers a grade glossary page per category', async () => {
		await shop.setting('landing_pages', 'gradeUrl', '/grades/{category}/{key}');
		const dresses = await api('GET', `/v1/seo/grades/${ids.dresses.slug}/a`);
		expect(dresses).toMatchObject({
			key: 'a',
			label: 'Like new',
			categoryId: ids.dresses.id,
			category: { id: ids.dresses.id, slug: ids.dresses.slug, name: 'Dresses' },
			canonical: `${ORIGIN}/grades/${ids.dresses.slug}/a`,
			robots: 'index, follow',
		});
		expect(await api('GET', `/v1/seo/grades/${ids.shirts.id}/a`)).toMatchObject({
			label: 'Grade A',
			categoryId: null,
			canonical: `${ORIGIN}/grades/${ids.shirts.slug}/a`,
		});
		// without a category: the entry for every category, which has no page of its own at a {category} address
		expect(await api('GET', '/v1/seo/grades/a')).toMatchObject({ label: 'Grade A', canonical: null, category: null });
		expect((await shop.api('GET', '/v1/seo/grades/nowhere/a')).status).toBe(404);
		expect((await shop.api('GET', `/v1/seo/grades/${ids.shirts.slug}/zz`)).status).toBe(404);
	});
});

describe('attributes per category (E45)', () => {
	it('keeps one slug per category and for every category', async () => {
		expect(ids.fabric.categoryId).toBeNull();
		expect(ids.dressFabric).toMatchObject({ slug: 'fabric', categoryId: ids.dresses.id, unit: 'gsm' });
		expect(
			(await shop.api('POST', '/v1/attributes', { name: 'Again', slug: 'fabric', categoryId: ids.dresses.id })).status,
		).toBe(409);
		expect((await shop.api('POST', '/v1/attributes', { name: 'Again', slug: 'fabric' })).status).toBe(409);
		// a name alone takes the slug free in its category
		const shirtFabric = await api('POST', '/v1/attributes', { name: 'Fabric', categoryId: ids.shirts.id });
		expect(shirtFabric.slug).toBe('fabric');
		const moved = await shop.api('PATCH', `/v1/attributes/${shirtFabric.id}`, { categoryId: ids.dresses.id });
		expect(moved.status).toBe(409);
		const unknown = await shop.api('POST', '/v1/attributes', { name: 'Weave', categoryId: 'cat_nothing' });
		expect(unknown.status).toBe(422);
		expect(unknown.json.errors[0].path).toBe('/categoryId');
		expect((await api('GET', '/v1/attributes')).items.filter((/** @type {any} */ a) => a.slug === 'fabric')).toHaveLength(3);
		expect((await shop.api('DELETE', `/v1/categories/${ids.shirts.id}`)).status).toBe(409);
		await api('DELETE', `/v1/attributes/${shirtFabric.id}`);
	});

	it('filters a listing by the slug as its category defines it, then the one for every category', async () => {
		const attributes = new Map([ids.fabric, ids.dressFabric].map((attribute) => [attribute.id, attribute]));
		expect(attributeOf(attributes, 'fabric', [ids.dresses.id])?.id).toBe(ids.dressFabric.id);
		expect(attributeOf(attributes, 'fabric', [ids.shirts.id])?.id).toBe(ids.fabric.id);
		expect(attributeOf(attributes, 'fabric')?.id).toBe(ids.fabric.id);
		expect(attributeOf(new Map([[ids.dressFabric.id, ids.dressFabric]]), 'fabric')?.id).toBe(ids.dressFabric.id);
		await shop.seedProduct({
			name: 'Fabric silk dress',
			categoryIds: [ids.dresses.id],
			specs: { [ids.dressFabric.id]: 'silk' },
		});
		await shop.seedProduct({ name: 'Fabric silk shirt', categoryIds: [ids.shirts.id], specs: { [ids.fabric.id]: 'silk' } });
		/** @param {string} category */
		const names = async (category) =>
			(await shop.visitor('GET', `/v1/shop/products?q=Fabric&category=${category}&attr.fabric=silk`)).json.items.map(
				(/** @type {any} */ item) => item.name,
			);
		expect(await names(ids.dresses.slug)).toEqual(['Fabric silk dress']);
		expect(await names(ids.shirts.slug)).toEqual(['Fabric silk shirt']);
	});

	it('takes the nearest category above a listing for its filters and glossary pages (sub-categories)', async () => {
		await shop.seedProduct({
			name: 'Fabric silk gown',
			categoryIds: [ids.evening.id],
			specs: { [ids.dressFabric.id]: 'silk' },
		});
		const found = await shop.visitor('GET', `/v1/shop/products?q=Fabric&category=${ids.evening.slug}&attr.fabric=silk`);
		expect(found.json.items.map((/** @type {any} */ item) => item.name)).toEqual(['Fabric silk gown']);
		expect(await api('GET', `/v1/seo/attributes/${ids.evening.slug}/fabric`)).toMatchObject({
			name: 'Dress fabric',
			categoryId: ids.dresses.id,
			category: { id: ids.evening.id },
		});
	});

	it('answers glossary pages per category, with {category} in the address and the patterns', async () => {
		await shop.setting('landing_pages', 'attributeUrl', '/attributes/{category}/{slug}');
		await shop.setting('landing_pages', 'attributeDescription', '{name} for {category} ({unit}) {values}');
		const dress = await api('GET', `/v1/seo/attributes/${ids.dresses.slug}/fabric`);
		expect(dress).toMatchObject({
			name: 'Dress fabric',
			unit: 'gsm',
			categoryId: ids.dresses.id,
			category: { id: ids.dresses.id, slug: ids.dresses.slug, name: 'Dresses' },
			description: 'How each dress fabric drapes.',
			canonical: `${ORIGIN}/attributes/${ids.dresses.slug}/fabric`,
			robots: 'index, follow',
		});
		// without text of its own: the patterns, not indexed (G7.2)
		expect(await api('GET', `/v1/seo/attributes/${ids.shirts.slug}/fabric`)).toMatchObject({
			name: 'Fabric',
			categoryId: null,
			description: 'Fabric for Shirts',
			canonical: `${ORIGIN}/attributes/${ids.shirts.slug}/fabric`,
			robots: 'noindex, follow',
		});
		// the one for every category, read without one: no page of its own at a {category} address
		expect(await api('GET', '/v1/seo/attributes/fabric')).toMatchObject({
			name: 'Fabric',
			category: null,
			canonical: null,
			robots: 'noindex, follow',
		});
		expect((await shop.api('GET', '/v1/seo/attributes/nowhere/fabric')).status).toBe(404);
		// an attribute for every category limited to others does not apply here
		await api('PATCH', `/v1/attributes/${ids.fabric.id}`, { categoryIds: [ids.dresses.id] });
		expect((await shop.api('GET', `/v1/seo/attributes/${ids.shirts.slug}/fabric`)).status).toBe(404);
	});

	it('lists every active attribute with its own text per category in the sitemap once the address is set (SG-20)', async () => {
		await shop.setting('landing_pages', 'attributeDescription', '');
		const sitemap = (await shop.api('GET', '/v1/seo/sitemap.xml')).text;
		expect(sitemap).toContain(`<loc>${ORIGIN}/attributes/${ids.dresses.slug}/fabric</loc>`);
		expect(sitemap).not.toContain(`/attributes/${ids.shirts.slug}/fabric`);
		await api('PATCH', `/v1/attributes/${ids.fabric.id}`, {
			categoryIds: [ids.shirts.id],
			seo: { body: 'What each fabric feels like.' },
		});
		expect((await shop.api('GET', '/v1/seo/sitemap.xml')).text).toContain(
			`<loc>${ORIGIN}/attributes/${ids.shirts.slug}/fabric</loc>`,
		);
		// without {category}: one page per slug, the one for every category first
		await shop.setting('landing_pages', 'attributeUrl', '/glossary/{slug}');
		const plain = (await shop.api('GET', '/v1/seo/sitemap.xml')).text;
		expect(plain.split(`<loc>${ORIGIN}/glossary/fabric</loc>`)).toHaveLength(2);
		await shop.setting('landing_pages', 'attributeUrl', '');
		expect((await shop.api('GET', '/v1/seo/sitemap.xml')).text).not.toContain('/glossary/');
	});

	it('imports one attribute per category, never merged by slug', async () => {
		const record = (/** @type {number} */ n, /** @type {string | null} */ categoryId) => ({
			id: `att_${n.toString(16).padStart(24, '0')}`,
			name: 'Length',
			slug: 'length',
			type: 'text',
			categoryId,
		});
		const body = (/** @type {any[]} */ records) => `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;
		const answer = await shop.api(
			'POST',
			'/v1/import/attributes',
			body([record(1, null), record(2, ids.dresses.id), record(3, ids.dresses.id), record(4, 'cat_missing')]),
			{ 'content-type': 'application/x-ndjson' },
		);
		expect(answer.status).toBe(200);
		expect(
			answer.json.failed.map((/** @type {any} */ row) => [row.line, row.errors.map((/** @type {any} */ e) => e.path)]),
		).toEqual([
			[3, ['/slug']],
			[4, ['/categoryId']],
		]);
		const stored = (await api('GET', '/v1/attributes')).items.filter((/** @type {any} */ a) => a.slug === 'length');
		expect(stored.map((/** @type {any} */ a) => a.categoryId).sort()).toEqual([ids.dresses.id, null].sort());
	});
});
