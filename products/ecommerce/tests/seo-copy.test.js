/**
 * A merchant's own SEO kept as written, and better default copy from facts (SEO audit G6, phase S2): who wrote a
 * record's SEO (`seo.source`: merchant, import or ai), a title used as written (`seo.titleMode`), the name in titles
 * never added twice, own descriptions never cut, formula copy computed on every read (never stored), the facts
 * placeholders ({minPrice}, {maxPrice}, {price}, {options}, {inStockOptions}, {conditions}, {topSpecs}), optional
 * groups in patterns, the default description (a written summary, else the facts pattern) and the variant pattern.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asWritten, fillTemplate, fillTitle, metaDescription, pageTitle, productFacts } from '../core/seo.js';
import { ALL, readyShop } from './helpers.js';

/** @typedef {import('../core/model.js').ProductRecord} ProductRecord */
/** @typedef {import('../core/model.js').VariantRecord} VariantRecord */

/** @param {Partial<VariantRecord>} input @returns {VariantRecord} */
const variant = (input) => ({
	id: 'var_1',
	sku: '',
	options: {},
	price: 1000,
	compareAtPrice: null,
	cost: null,
	stock: 5,
	locations: {},
	grade: null,
	active: true,
	attributes: {},
	media: [],
	soldOut: false,
	warrantyDays: null,
	...input,
});

describe('patterns and titles', () => {
	it('drops an optional group whose placeholder is empty, and keeps other brackets as typed', () => {
		expect(fillTemplate('{name}[ by {brand}]', { name: 'Mug', brand: 'Acme' })).toBe('Mug by Acme');
		expect(fillTemplate('{name}[ by {brand}]', { name: 'Mug', brand: '' })).toBe('Mug');
		expect(fillTemplate('{name}[ by {brand} in {category}].', { name: 'Mug', brand: 'Acme', category: '' })).toBe('Mug.');
		expect(fillTemplate('[Sale] {name}', { name: 'Mug' })).toBe('[Sale] Mug');
		expect(fillTemplate('{name} ({options})', { name: 'Mug', options: '' })).toBe('Mug');
	});

	it('never adds the name in titles twice', () => {
		expect(fillTitle('{name} | {business}', { name: 'Blue Mug — Northwind Store', business: 'Northwind Store' })).toBe(
			'Blue Mug — Northwind Store',
		);
		expect(fillTitle('{name} | {business}', { name: 'northwind store mugs', business: 'Northwind Store' })).toBe(
			'northwind store mugs',
		);
		expect(fillTitle('Buy {name} online | {business}', { name: 'Northwind Mug', business: 'Northwind' })).toBe(
			'Buy Northwind Mug online',
		);
		// only the whole name counts
		expect(fillTitle('{name} | {business}', { name: 'Northwinds Mug', business: 'Northwind' })).toBe(
			'Northwinds Mug | Northwind',
		);
		expect(fillTitle('{name} | {business}', { name: 'Mug', business: 'Northwind' })).toBe('Mug | Northwind');
	});

	it('uses a record’s own title as written in as_written mode', () => {
		const values = { name: 'Mug', business: 'Shop' };
		expect(pageTitle('{name} | {business}', { ...values, own: 'Mugs we love', mode: 'as_written' })).toBe('Mugs we love');
		expect(pageTitle('{name} | {business}', { ...values, own: 'Mugs we love', mode: 'template' })).toBe('Mugs we love | Shop');
		expect(pageTitle('{name} | {business}', { ...values, own: '', mode: 'as_written' })).toBe('Mug | Shop');
	});

	it('sends a merchant’s own description as written and cuts only derived text', () => {
		const own = `${'Hand made in small batches. '.repeat(10)}`.trim();
		expect(own.length).toBeGreaterThan(160);
		expect(metaDescription(asWritten(own), 'Summary')).toBe(own);
		expect(metaDescription(asWritten('  two\n lines '), 'Summary')).toBe('two lines');
		expect(metaDescription(asWritten(''), own).length).toBeLessThanOrEqual(160);
		expect(metaDescription(asWritten(''), own).endsWith('…')).toBe(true);
		expect(metaDescription(asWritten(null), '', asWritten('Default.'))).toBe('Default.');
	});
});

describe('facts', () => {
	/** @type {ProductRecord} */
	const product = /** @type {any} */ ({
		id: 'prd_1',
		name: 'Mug',
		kind: 'physical',
		trackStock: true,
		options: [
			{ name: 'Color', values: ['Red', 'Blue', 'Green'] },
			{ name: 'Size', values: ['S', 'L'] },
		],
		variants: [
			variant({ id: 'var_1', options: { Color: 'Red', Size: 'S' }, price: 1200, grade: 'mint' }),
			variant({ id: 'var_2', options: { Color: 'Blue', Size: 'L' }, price: 1500, stock: 0, grade: 'fair' }),
			variant({ id: 'var_3', options: { Color: 'Green', Size: 'S' }, price: 900, active: false }),
			variant({ id: 'var_4', options: { Color: 'Green', Size: 'L' }, price: 0 }),
		],
	});
	const context = {
		money: (/** @type {number} */ amount) => `$${(amount / 100).toFixed(2)}`,
		grades: new Map([
			['fair', { label: 'Fair' }],
			['mint', { label: 'Mint' }],
		]),
		specs: [
			{ name: 'Material', label: 'Stoneware', unit: '' },
			{ name: 'Capacity', label: '350', unit: 'ml' },
			{ name: 'Made in', label: 'Portugal', unit: '' },
			{ name: 'Weight', label: '300', unit: 'g' },
		],
	};

	it('fills the placeholders from what is offered now', () => {
		expect(productFacts(product, context)).toEqual({
			minPrice: '$12.00',
			maxPrice: '$15.00',
			price: '$12.00 – $15.00',
			options: 'Red, Blue, S, L',
			inStockOptions: 'Red, S',
			conditions: 'Fair, Mint',
			topSpecs: 'Material: Stoneware, Capacity: 350 ml, Made in: Portugal',
		});
		const one = productFacts({ ...product, options: [], variants: [variant({ price: 700 })] }, { ...context, specs: [] });
		expect(one).toEqual({
			minPrice: '$7.00',
			maxPrice: '$7.00',
			price: '$7.00',
			options: '',
			inStockOptions: '',
			conditions: '',
			topSpecs: '',
		});
		expect(productFacts({ ...product, variants: [] }, context)).toMatchObject({ price: '', minPrice: '', options: '' });
	});
});

describe('through the API', () => {
	/** @type {Awaited<ReturnType<typeof readyShop>>} */
	let shop;
	/** @type {Record<string, any>} */
	const ids = {};
	/** @param {string} method @param {string} path @param {unknown} [body] */
	const api = async (method, path, body) => {
		const answer = await shop.api(method, path, body);
		if (answer.status >= 300) throw new Error(`${method} ${path}: ${answer.status} ${answer.text}`);
		return answer.json;
	};
	/** @param {string} slug */
	const head = (slug) => api('GET', `/v1/seo/products/${slug}`);

	beforeAll(async () => {
		shop = await readyShop({ features: ALL.filter((feature) => feature !== 'multi_location') });
		ids.kitchen = await api('POST', '/v1/categories', { name: 'Kitchen' });
		ids.acme = await api('POST', '/v1/brands', { name: 'Acme' });
		ids.mug = await api('POST', '/v1/products', {
			name: 'Mug',
			status: 'active',
			summary: 'A mug.',
			categoryIds: [ids.kitchen.id],
			brandId: ids.acme.id,
			options: [{ name: 'Color', values: ['Red', 'Blue'] }],
			variants: [
				{ options: { Color: 'Red' }, price: 1200, stock: 3 },
				{ options: { Color: 'Blue' }, price: 1500, stock: 0 },
			],
		});
	});
	afterAll(async () => shop.product.close());

	it('describes a product by its facts by default, filled on every read', async () => {
		expect((await head('mug')).description).toBe('Mug by Acme — Kitchen. USD 12.00 – USD 15.00. In stock: Red.');
		await api('PATCH', `/v1/products/${ids.mug.id}`, {
			variants: ids.mug.variants.map((/** @type {any} */ v) => ({ ...v, price: v.price + 100 })),
		});
		// Blue comes back in stock
		await (
			await shop.db()
		)
			.collection('products')
			.updateOne({ websiteId: shop.websiteId, id: ids.mug.id }, { $set: { 'variants.1.stock': 4 } });
		expect((await head('mug')).description).toBe('Mug by Acme — Kitchen. USD 13.00 – USD 16.00. In stock: Red, Blue.');
		// a written summary (50 characters or more) comes first
		const summary = 'A stoneware mug glazed by hand, for coffee and tea alike.';
		await api('PATCH', `/v1/products/${ids.mug.id}`, { summary });
		expect((await head('mug')).description).toBe(summary);
		await shop.setting('seo', 'productDescription', '{name}[: {topSpecs}][ ({conditions})]. From {minPrice}.');
		await api('PATCH', `/v1/products/${ids.mug.id}`, { summary: '' });
		expect((await head('mug')).description).toBe('Mug. From USD 13.00.');
		await shop.setting('seo', 'productDescription', '');
		expect((await head('mug')).description).toBe('');
	});

	it('names each variant by the variant pattern', async () => {
		/** @param {string} jsonLd */
		const names = (jsonLd) => JSON.parse(jsonLd)['@graph'][0].hasVariant.map((/** @type {any} */ v) => v.name);
		expect(names((await head('mug')).jsonLd)).toEqual(['Mug - Red', 'Mug - Blue']);
		await shop.setting('seo', 'variantTitle', '{brand} {name} in {options}');
		expect(names((await head('mug')).jsonLd)).toEqual(['Acme Mug in Red', 'Acme Mug in Blue']);
	});

	it('keeps the merchant’s own SEO as written and records who wrote it', async () => {
		const own = 'Our everyday mug, glazed by hand in small batches. '.repeat(5).trim();
		const saved = await api('PATCH', `/v1/products/${ids.mug.id}`, { seo: { title: 'Mug at Shop', description: own } });
		expect(saved.seo).toMatchObject({ source: 'merchant', titleMode: 'template' });
		expect(await head('mug')).toMatchObject({ title: 'Mug at Shop', description: own });
		await api('PATCH', `/v1/products/${ids.mug.id}`, { seo: { title: 'Everyday mug', titleMode: 'as_written' } });
		expect((await head('mug')).title).toBe('Everyday mug');
		// copy an AI suggestion gave, applied by staff
		const ai = await api('PATCH', `/v1/products/${ids.mug.id}`, { seo: { title: 'Mug for tea', source: 'ai' } });
		expect(ai.seo.source).toBe('ai');
		// a save that leaves the texts alone keeps who wrote them
		expect((await api('PATCH', `/v1/products/${ids.mug.id}`, { summary: 'Short.' })).seo.source).toBe('ai');
		expect((await api('PATCH', `/v1/products/${ids.mug.id}`, { seo: { title: '', description: '' } })).seo.source).toBe(null);
		const wrong = await shop.api('PATCH', `/v1/products/${ids.mug.id}`, { seo: { source: 'import', titleMode: 'x' } });
		expect(wrong.status).toBe(422);
		expect(wrong.json.errors.map((/** @type {any} */ e) => e.path)).toEqual(['/seo/titleMode', '/seo/source']);
		const category = await api('PATCH', `/v1/categories/${ids.kitchen.id}`, { seo: { title: 'Kitchen | Shop' } });
		expect(category.seo.source).toBe('merchant');
		expect((await api('GET', `/v1/seo/categories/${ids.kitchen.slug}`)).title).toBe('Kitchen | Shop');
	});
});
