/**
 * Product feeds for the shopping catalogs (SEO audit G11, phase S11; parity P3-8): extra photos, the apparel attributes,
 * product highlights and details from fields, the Google product category per category, delivery days with shipping
 * and its switch, {grade} and field placeholders in item titles, an item description pattern, and the Meta CSV's extra
 * photos, apparel attributes and identifier_exists. Rows first as pure functions, then through the feed routes.
 */
import { createId } from '@ss/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { META_HEADER, feedRows, googleItem, metaLine } from '../core/feeds.js';
import { listShown } from '../core/promotions.js';
import { ALL, readyShop } from './helpers.js';

/** @typedef {import('../core/model.js').ProductRecord} ProductRecord */
/** @typedef {import('../core/model.js').VariantRecord} VariantRecord */
/** @typedef {import('../core/feeds.js').FeedRow} FeedRow */

/** @param {Partial<VariantRecord>} [input] @returns {VariantRecord} */
const variant = (input = {}) => ({
	id: createId('var'),
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

/** @type {ProductRecord} */
const shirt = /** @type {any} */ ({
	id: 'prd_0123456789abcdef01234567',
	name: 'Linen Shirt',
	kind: 'physical',
	summary: 'Cool in summer.',
	description: 'Woven from flax.',
	seo: { title: '', description: '' },
	trackStock: true,
	variants: [variant({ options: { Size: 'M' }, grade: 'a', price: 6000 }), variant({ options: { Size: 'L' }, price: 4000 })],
});

const context = {
	link: 'https://shop.example.com/p',
	image: 'https://cdn.example.com/1.jpg',
	brand: 'Maison',
	productType: 'Clothing > Shirts',
	currency: 'USD',
	condition: () => /** @type {const} */ ('new'),
	skuAs: /** @type {const} */ ('none'),
	includeOutOfStock: true,
	shown: listShown,
	now: Date.parse('2026-10-05T10:00:00Z'),
};

/** @param {string} target @param {string} name @param {string[]} values @param {string[]} [raw] */
const target = (target, name, values, raw = values) => ({ target, name, value: values.join(', '), values, raw });

describe('feed rows', () => {
	it('sends up to 10 more photos, never the main one twice', () => {
		const photos = Array.from({ length: 13 }, (_, index) => `https://cdn.example.com/${index + 1}.jpg`);
		const [first, second] = /** @type {FeedRow[]} */ (
			feedRows(shirt, {
				...context,
				variantImage: (v) => (v === shirt.variants[0] ? 'https://cdn.example.com/v.jpg' : ''),
				extraImages: (v) => (v === shirt.variants[0] ? ['https://cdn.example.com/v.jpg', ...photos] : photos),
			})
		);
		expect(first?.image).toBe('https://cdn.example.com/v.jpg');
		expect(first?.additionalImages).toEqual(photos.slice(0, 10));
		// the second has the product's main photo as its own
		expect(second?.image).toBe('https://cdn.example.com/1.jpg');
		expect(second?.additionalImages).toEqual(photos.slice(1, 11));
		const xml = googleItem(/** @type {FeedRow} */ (first));
		expect(xml.split('<g:additional_image_link>')).toHaveLength(11);
		expect(feedRows(shirt, context)[0]?.additionalImages).toEqual([]);
	});

	it('sends the apparel attributes in the catalogs’ own values, and leaves out values they would refuse', () => {
		const [row] = feedRows(shirt, {
			...context,
			values: () => [
				target('gender', 'For', ['Men'], ['male']),
				target('age_group', 'Age', ['Grown-ups', 'Kids'], ['grown', 'KIDS']),
				target('size_system', 'Sizes', ['us']),
				target('gender', 'Again', ['Female']),
			],
		});
		expect(row).toMatchObject({ gender: 'male', ageGroup: 'kids', sizeSystem: 'US' });
		const xml = googleItem(/** @type {FeedRow} */ (row));
		expect(xml).toContain('<g:gender>male</g:gender><g:age_group>kids</g:age_group><g:size_system>US</g:size_system>');
		const [none] = feedRows(shirt, { ...context, values: () => [target('gender', 'For', ['Everyone'])] });
		expect(none?.gender).toBe('');
		expect(googleItem(/** @type {FeedRow} */ (none))).not.toContain('g:gender');
	});

	it('sends product highlights and details from fields', () => {
		const long = 'x'.repeat(200);
		const [row] = feedRows(shirt, {
			...context,
			values: () => [
				target('product_highlight', 'Highlights', ['Breathes <well>', long]),
				target('product_detail', 'Fabric', ['Linen & cotton']),
				target('product_detail', 'Weight', ['180 g']),
			],
		});
		expect(row?.highlights).toEqual(['Breathes <well>', 'x'.repeat(150)]);
		expect(row?.details).toEqual([
			{ name: 'Fabric', value: 'Linen & cotton' },
			{ name: 'Weight', value: '180 g' },
		]);
		const xml = googleItem(/** @type {FeedRow} */ (row));
		expect(xml).toContain('<g:product_highlight>Breathes &lt;well&gt;</g:product_highlight>');
		expect(xml).toContain(
			'<g:product_detail><g:attribute_name>Fabric</g:attribute_name><g:attribute_value>Linen &amp; cotton</g:attribute_value></g:product_detail>',
		);
	});

	it('fills {grade} and field placeholders in titles, and the item description pattern', () => {
		const rows = feedRows(shirt, {
			...context,
			title: '{name} [{grade}] {attr.fabric} - {variant}',
			grade: (v) => (v.grade === 'a' ? 'Like new' : ''),
			placeholders: (v) => ({ 'attr.fabric': v === shirt.variants[0] ? 'Linen' : '' }),
			description: 'pattern',
			descriptionPattern: '{description} {summary} Size {options}. [Grade: {grade}.]',
		});
		expect(rows.map((row) => row.title)).toEqual(['Linen Shirt Like new Linen - M', 'Linen Shirt - L']);
		expect(rows.map((row) => row.description)).toEqual([
			'Woven from flax. Cool in summer. Size M. Grade: Like new.',
			'Woven from flax. Cool in summer. Size L.',
		]);
		// an empty pattern falls back to the description
		expect(feedRows(shirt, { ...context, description: 'pattern', descriptionPattern: '' })[0]?.description).toBe(
			'Woven from flax.',
		);
	});

	it('sends delivery days with shipping, and no shipping without it', () => {
		const shipping = {
			fee: 500,
			freeOver: 0,
			country: 'US',
			deliveryTime: { handling: { min: 0, max: 1 }, transit: { min: 2, max: 5 } },
		};
		const [row] = feedRows(shirt, { ...context, shipping });
		expect(googleItem(/** @type {FeedRow} */ (row))).toContain(
			'<g:shipping><g:country>US</g:country><g:price>5.00 USD</g:price><g:min_handling_time>0</g:min_handling_time>' +
				'<g:max_handling_time>1</g:max_handling_time><g:min_transit_time>2</g:min_transit_time>' +
				'<g:max_transit_time>5</g:max_transit_time></g:shipping>',
		);
		const [plain] = feedRows(shirt, { ...context, shipping: { fee: 500, country: 'US', deliveryTime: null } });
		expect(googleItem(/** @type {FeedRow} */ (plain))).toContain('<g:price>5.00 USD</g:price></g:shipping>');
		expect(googleItem(/** @type {FeedRow} */ (feedRows(shirt, { ...context, shipping: null })[0]))).not.toContain('g:shipping');
		// a digital item or a service ships nothing: checkout charges it no delivery (review M6)
		for (const kind of /** @type {const} */ (['digital', 'service'])) {
			const [item] = feedRows({ ...shirt, kind }, { ...context, shipping, parcels: true });
			expect(item).toMatchObject({ shipping: '', shippingCountry: '', deliveryTime: null, shippingWeight: '' });
			expect(googleItem(/** @type {FeedRow} */ (item))).not.toContain('g:shipping');
		}
	});

	it('writes the Meta CSV with more photos, the apparel attributes and identifier_exists', () => {
		expect(META_HEADER).toBe(
			'id,title,description,availability,condition,price,sale_price,sale_price_effective_date,link,image_link,' +
				'additional_image_link,brand,gtin,mpn,identifier_exists,item_group_id,color,material,size,pattern,gender,age_group,' +
				'google_product_category,shipping_weight,custom_label_0,custom_label_1,custom_label_2,custom_label_3,custom_label_4\r\n',
		);
		const [row] = feedRows(shirt, {
			...context,
			identifierExists: 'no',
			extraImages: () => ['https://cdn.example.com/2.jpg', 'https://cdn.example.com/3.jpg'],
			values: () => [target('gender', 'For', ['unisex']), target('age_group', 'Age', ['adult'])],
		});
		expect(metaLine(/** @type {FeedRow} */ (row))).toContain(
			',https://cdn.example.com/1.jpg,"https://cdn.example.com/2.jpg,https://cdn.example.com/3.jpg",Maison,,,no,',
		);
		expect(metaLine(/** @type {FeedRow} */ (row))).toContain(',,,,,unisex,adult,');
	});
});

describe('feed routes', () => {
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
	/** The Google feed's item of a product, by its name. @param {string} name */
	const itemOf = async (name) => {
		const xml = (await shop.api('GET', '/v1/feeds/products.xml')).text;
		return xml.split('<item>').find((item) => item.includes(`<title>${name}`)) ?? '';
	};

	beforeAll(async () => {
		shop = await readyShop({ features: ALL.filter((feature) => feature !== 'multi_location'), business: { country: 'US' } });
		await shop.setting('catalog', 'mediaBaseUrl', 'https://cdn.example.com');
		await shop.setting('feeds', 'items', 'all');
		await shop.list('grades', [{ key: 'a', label: 'Like new', condition: 'used' }]);
		ids.clothing = await api('POST', '/v1/categories', { name: 'Clothing', googleCategory: '1604' });
		ids.shirts = await api('POST', '/v1/categories', { name: 'Shirts', parentId: ids.clothing.id });
		ids.mugs = await api('POST', '/v1/categories', { name: 'Mugs' });
		ids.fabric = await api('POST', '/v1/attributes', { name: 'Fabric', slug: 'fabric', show: { page: true } });
		ids.gender = await api('POST', '/v1/attributes', {
			name: 'For',
			type: 'choice',
			choices: [
				{ value: 'male', label: 'Men' },
				{ value: 'female', label: 'Women' },
			],
			show: { feeds: 'gender' },
		});
		ids.notes = await api('POST', '/v1/attributes', { name: 'Notes', slug: 'notes', show: { page: false, chat: false } });
		ids.highlights = await api('POST', '/v1/attributes', {
			name: 'Highlights',
			multiple: true,
			maxValues: 5,
			show: { feeds: 'product_highlight' },
		});
		await shop.seedProduct({
			name: 'Oxford shirt',
			categoryIds: [ids.shirts.id],
			specs: {
				[ids.fabric.id]: 'Cotton',
				[ids.gender.id]: 'male',
				[ids.notes.id]: 'Staff only',
				[ids.highlights.id]: ['Easy iron', 'Button-down collar'],
			},
			media: [1, 2, 3].map((n) => ({ key: `ecommerce/products/x/${n}.jpg`, type: 'image/jpeg', size: 1, alt: '' })),
			variants: [variant({ grade: 'a' })],
		});
		await shop.seedProduct({ name: 'Plain mug', categoryIds: [ids.mugs.id] });
	});
	afterAll(async () => shop?.product.close());

	it('takes the Google product category of the category or the nearest one above it, else the shop’s', async () => {
		expect(ids.shirts.googleCategory).toBe('');
		expect(await itemOf('Oxford shirt')).toContain('<g:google_product_category>1604</g:google_product_category>');
		expect(await itemOf('Plain mug')).not.toContain('google_product_category');
		await shop.setting('feeds', 'googleCategory', '640');
		expect(await itemOf('Plain mug')).toContain('<g:google_product_category>640</g:google_product_category>');
		expect(await itemOf('Oxford shirt')).toContain('<g:google_product_category>1604</g:google_product_category>');
		const long = await shop.api('PATCH', `/v1/categories/${ids.mugs.id}`, { googleCategory: 'x'.repeat(251) });
		expect(long.json.errors[0].path).toBe('/googleCategory');
	});

	it('sends the photos, fields, title and description patterns the settings name', async () => {
		await shop.setting('feeds', 'itemTitle', '{name} {grade} {attr.fabric} {attr.notes}');
		await shop.setting('feeds', 'itemDescription', 'pattern');
		await shop.setting('feeds', 'descriptionPattern', '{name}: {attr.fabric}.');
		const item = await itemOf('Oxford shirt');
		// a field shoppers never see stays out of the feed
		expect(item).toContain('<title>Oxford shirt Like new Cotton</title>');
		expect(item).toContain('<description>Oxford shirt: Cotton.</description>');
		expect(item).toContain('<g:image_link>https://cdn.example.com/ecommerce/products/x/1.jpg</g:image_link>');
		expect(item).toContain(
			'<g:additional_image_link>https://cdn.example.com/ecommerce/products/x/2.jpg</g:additional_image_link>' +
				'<g:additional_image_link>https://cdn.example.com/ecommerce/products/x/3.jpg</g:additional_image_link>',
		);
		expect(item).toContain('<g:gender>male</g:gender>');
		expect(item).toContain('<g:product_highlight>Easy iron</g:product_highlight>');
		const csv = (await shop.api('GET', '/v1/feeds/products.csv')).text;
		expect(csv).toContain(
			'"https://cdn.example.com/ecommerce/products/x/2.jpg,https://cdn.example.com/ecommerce/products/x/3.jpg"',
		);
	});

	it('sends delivery days with shipping, and nothing of shipping when switched off', async () => {
		await shop.setting('delivery_zones', 'defaultFee', 500);
		await shop.setting('delivery_zones', 'handlingDays', [0, 1]);
		await shop.setting('delivery_zones', 'transitDays', [3]);
		expect(await itemOf('Plain mug')).toContain(
			'<g:shipping><g:country>US</g:country><g:price>5.00 USD</g:price><g:min_handling_time>0</g:min_handling_time>' +
				'<g:max_handling_time>1</g:max_handling_time><g:min_transit_time>3</g:min_transit_time>' +
				'<g:max_transit_time>3</g:max_transit_time></g:shipping>',
		);
		await shop.setting('feeds', 'shipping', false);
		expect(await itemOf('Plain mug')).not.toContain('g:shipping');
	});
});
