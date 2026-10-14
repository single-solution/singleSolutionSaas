/**
 * Product structured data as Google's merchant listings take it (SEO audit G5, phase S1): every variant has an image and
 * a unique id (its own photo and SKU, else the product's photos and the feed item id), the group id is the feed's,
 * nothing is offered at a price of 0, a product with nothing to offer has no Product node, shipping details only for
 * physical goods and only when complete (country and delivery days), the return policy per item (product, then grade,
 * then the setting) and only with a country, and FAQ markup only while the merchant asks for it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listShown } from '../core/promotions.js';
import { feedGroupId, feedItemId, productJsonLd } from '../core/seo.js';
import { readyShop } from './helpers.js';

/** @typedef {import('../core/model.js').ProductRecord} ProductRecord */
/** @typedef {import('../core/model.js').VariantRecord} VariantRecord */
/** @typedef {import('../core/seo.js').ProductPage} ProductPage */

/**
 * A variant.
 * @param {Partial<VariantRecord>} [input]
 * @returns {VariantRecord}
 */
const variant = (input = {}) => ({
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

/**
 * A product.
 * @param {Partial<ProductRecord>} [input]
 * @returns {ProductRecord}
 */
const product = (input = {}) =>
	/** @type {ProductRecord} */ (
		/** @type {unknown} */ ({
			id: 'prd_1',
			name: 'Mug',
			kind: 'physical',
			trackStock: true,
			options: [],
			rating: { average: 0, count: 0 },
			faqs: [{ question: 'Dishwasher safe?', answer: 'Yes.' }],
			returnDays: null,
			variants: [variant()],
			...input,
		})
	);

const URL = 'https://shop.example.com/products/mug';

/**
 * A product page.
 * @param {ProductRecord} item
 * @param {Partial<ProductPage>} [input]
 * @returns {ProductPage}
 */
const page = (item, input = {}) => ({
	product: item,
	url: URL,
	images: ['https://shop.example.com/media/a.jpg', 'https://shop.example.com/media/b.jpg'],
	description: 'A mug.',
	brand: null,
	currency: 'USD',
	condition: () => 'new',
	seller: 'Shop',
	trail: [{ name: 'Shop', url: 'https://shop.example.com/' }],
	variantName: (variant) => `${item.name} - ${Object.values(variant.options).join(' / ')}`,
	shown: listShown,
	shipping: null,
	returns: null,
	reviews: [],
	faqMarkup: false,
	...input,
});

/** @param {ReturnType<typeof productJsonLd>} jsonLd @param {string} type */
const nodeOf = (jsonLd, type) => /** @type {any} */ (jsonLd['@graph']).find((/** @type {any} */ node) => node['@type'] === type);

const DELIVERY = { handling: { min: 0, max: 1 }, transit: { min: 2, max: 5 } };

describe('variants: images, ids and the group id', () => {
	const two = product({
		options: [{ name: 'Color', values: ['Red', 'Blue'] }],
		variants: [
			variant({ id: 'var_red', options: { Color: 'Red' }, sku: 'MUG-R' }),
			variant({ id: 'var_blue', options: { Color: 'Blue' }, feedId: 'old-42' }),
		],
	});

	it('gives a variant without a photo the product photos and one without a SKU its feed item id', () => {
		const group = nodeOf(
			productJsonLd(
				page(two, { variantImage: (v) => (v.id === 'var_red' ? 'https://shop.example.com/media/red.jpg' : null) }),
			),
			'ProductGroup',
		);
		expect(group.hasVariant.map((/** @type {any} */ v) => [v.sku, v.image])).toEqual([
			['MUG-R', 'https://shop.example.com/media/red.jpg'],
			['old-42', ['https://shop.example.com/media/a.jpg', 'https://shop.example.com/media/b.jpg']],
		]);
		const single = nodeOf(productJsonLd(page(product())), 'Product');
		expect(single.sku).toBe('var_1');
	});

	it('names the group as the feed does: its imported group id, else the product id', () => {
		expect(nodeOf(productJsonLd(page(two)), 'ProductGroup').productGroupID).toBe('prd_1');
		expect(nodeOf(productJsonLd(page({ ...two, feedGroupId: 'grp-7' })), 'ProductGroup').productGroupID).toBe('grp-7');
		expect(feedGroupId(two, true)).toBe('prd_1');
		expect(feedGroupId(two, false)).toBe('');
		expect(feedItemId(variant({ id: 'var_x' }))).toBe('var_x');
		expect(feedItemId(variant({ id: 'var_x', feedId: 'old-1' }))).toBe('old-1');
	});
});

describe('offers', () => {
	it('offers nothing at a price of 0, and a product with nothing to offer has no Product node', () => {
		const mixed = product({
			options: [{ name: 'Size', values: ['S', 'M', 'L'] }],
			variants: [
				variant({ id: 'var_s', options: { Size: 'S' }, price: 0 }),
				variant({ id: 'var_m', options: { Size: 'M' } }),
				variant({ id: 'var_l', options: { Size: 'L' } }),
			],
		});
		const group = nodeOf(productJsonLd(page(mixed)), 'ProductGroup');
		expect(group.hasVariant.map((/** @type {any} */ v) => v.size)).toEqual(['M', 'L']);
		// one sellable variant left: a plain Product
		const one = productJsonLd(page({ ...mixed, variants: mixed.variants.slice(0, 2) }));
		expect(nodeOf(one, 'Product').offers.price).toBe('10.00');
		for (const empty of [
			product({ variants: [variant({ price: 0 })] }),
			product({ variants: [variant({ active: false })] }),
			product({ variants: [] }),
		]) {
			const graph = productJsonLd(page(empty, { faqMarkup: true }))['@graph'].map((/** @type {any} */ n) => n['@type']);
			expect(graph).toEqual(['BreadcrumbList', 'FAQPage']);
		}
	});

	it('gives shipping details only to physical goods, and only with a country and delivery days', () => {
		const complete = { fee: 500, freeOver: 0, country: 'US', deliveryTime: DELIVERY };
		const offers = (/** @type {ProductRecord} */ item, /** @type {Partial<ProductPage>} */ input) =>
			nodeOf(productJsonLd(page(item, input)), 'Product').offers;
		expect(offers(product(), { shipping: complete }).shippingDetails).toEqual({
			'@type': 'OfferShippingDetails',
			shippingRate: { '@type': 'MonetaryAmount', value: '5.00', currency: 'USD' },
			shippingDestination: { '@type': 'DefinedRegion', addressCountry: 'US' },
			deliveryTime: {
				'@type': 'ShippingDeliveryTime',
				handlingTime: { '@type': 'QuantitativeValue', minValue: 0, maxValue: 1, unitCode: 'DAY' },
				transitTime: { '@type': 'QuantitativeValue', minValue: 2, maxValue: 5, unitCode: 'DAY' },
			},
		});
		// free from the free-delivery amount, as the cart charges it (SG-2)
		expect(offers(product(), { shipping: { ...complete, freeOver: 1000 } }).shippingDetails.shippingRate.value).toBe('0.00');
		expect(offers(product({ kind: 'digital' }), { shipping: complete }).shippingDetails).toBeUndefined();
		expect(offers(product({ kind: 'booking' }), { shipping: complete }).shippingDetails).toBeUndefined();
		expect(offers(product(), { shipping: { ...complete, country: '' } }).shippingDetails).toBeUndefined();
		expect(offers(product(), { shipping: { ...complete, deliveryTime: null } }).shippingDetails).toBeUndefined();
	});

	it('gives each item its own return window, and no policy without a country', () => {
		const graded = product({
			options: [{ name: 'Grade', values: ['A', 'B'] }],
			variants: [
				variant({ id: 'var_a', options: { Grade: 'A' }, grade: 'a' }),
				variant({ id: 'var_b', options: { Grade: 'B' }, grade: 'b' }),
			],
		});
		const returns = { country: 'US', days: (/** @type {VariantRecord} */ v) => (v.grade === 'a' ? 30 : 0) };
		const group = nodeOf(productJsonLd(page(graded, { returns })), 'ProductGroup');
		expect(group.hasVariant.map((/** @type {any} */ v) => v.offers.hasMerchantReturnPolicy)).toEqual([
			{
				'@type': 'MerchantReturnPolicy',
				applicableCountry: 'US',
				returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
				merchantReturnDays: 30,
			},
			{
				'@type': 'MerchantReturnPolicy',
				applicableCountry: 'US',
				returnPolicyCategory: 'https://schema.org/MerchantReturnNotPermitted',
			},
		]);
		const noCountry = nodeOf(productJsonLd(page(graded, { returns: { ...returns, country: '' } })), 'ProductGroup');
		expect(noCountry.hasVariant[0].offers.hasMerchantReturnPolicy).toBeUndefined();
		// an item whose window is not known (null) has no policy node
		const unknown = nodeOf(
			productJsonLd(page(product({ kind: 'digital' }), { returns: { country: 'US', days: () => null } })),
			'Product',
		);
		expect(unknown.offers.hasMerchantReturnPolicy).toBeUndefined();
	});
});

describe('FAQ markup', () => {
	it('is left out unless the merchant asks for it (Google shows no FAQ rich results since 2026-05-07)', () => {
		expect(nodeOf(productJsonLd(page(product())), 'FAQPage')).toBeUndefined();
		expect(nodeOf(productJsonLd(page(product(), { faqMarkup: true })), 'FAQPage').mainEntity[0].name).toBe('Dishwasher safe?');
	});
});

describe('the product answer', () => {
	/** @type {Awaited<ReturnType<typeof readyShop>>} */
	let shop;
	beforeAll(async () => {
		shop = await readyShop({ business: { country: 'US' } });
		await shop.list('grades', [
			{ key: 'mint', label: 'Mint', condition: 'refurbished', returnDays: 0 },
			{ key: 'fair', label: 'Fair' },
		]);
		await shop.setting('returns', 'returnDays', 14);
		await shop.setting('delivery_zones', 'defaultFee', 500);
	});
	afterAll(async () => shop.product.close());

	/** @param {string} slug */
	const jsonLdOf = async (slug) => {
		const answer = await shop.api('GET', `/v1/seo/products/${slug}`);
		if (answer.status !== 200) throw new Error(`${slug}: ${answer.status} ${answer.text}`);
		return JSON.parse(answer.json.jsonLd);
	};
	/** @param {any} offer */
	const days = (offer) =>
		offer.hasMerchantReturnPolicy?.merchantReturnDays ?? offer.hasMerchantReturnPolicy?.returnPolicyCategory;

	it('takes each item’s return window: the product’s, else its grade’s, else the setting', async () => {
		const options = [{ name: 'Grade', values: ['Mint', 'Fair', 'New'] }];
		const variants = [
			variant({ id: 'var_mint', options: { Grade: 'Mint' }, grade: 'mint' }),
			variant({ id: 'var_fair', options: { Grade: 'Fair' }, grade: 'fair' }),
			variant({ id: 'var_new', options: { Grade: 'New' } }),
		];
		await shop.seedProduct({
			slug: 'graded',
			options,
			variants,
			media: [{ key: 'ecommerce/products/p/1.jpg', type: 'image/jpeg', size: 10, alt: '' }],
		});
		await shop.seedProduct({
			slug: 'own-window',
			options,
			returnDays: 30,
			variants: variants.map((v) => ({ ...v, id: `${v.id}_own` })),
		});
		const graded = nodeOf(await jsonLdOf('graded'), 'ProductGroup');
		expect(graded.hasVariant.map((/** @type {any} */ v) => days(v.offers))).toEqual([
			'https://schema.org/MerchantReturnNotPermitted',
			14,
			14,
		]);
		expect(graded.hasVariant[0].offers.hasMerchantReturnPolicy.applicableCountry).toBe('US');
		// no delivery days yet: no shipping details (Google needs the delivery time)
		expect(graded.hasVariant[0].offers.shippingDetails).toBeUndefined();
		// a variant without its own photo shows the product's
		expect(graded.hasVariant[0].image).toEqual([expect.stringMatching(/^https:\/\//)]);
		expect(graded.hasVariant.map((/** @type {any} */ v) => v.sku)).toEqual(['var_mint', 'var_fair', 'var_new']);
		const own = nodeOf(await jsonLdOf('own-window'), 'ProductGroup');
		expect(own.hasVariant.map((/** @type {any} */ v) => days(v.offers))).toEqual([30, 30, 30]);
	});

	it('gives digital goods and bookings a return policy only when they name their own window', async () => {
		await shop.seedProduct({ slug: 'ebook', kind: 'digital', trackStock: false });
		await shop.seedProduct({ slug: 'ebook-returns', kind: 'digital', trackStock: false, returnDays: 7 });
		expect(nodeOf(await jsonLdOf('ebook'), 'Product').offers.hasMerchantReturnPolicy).toBeUndefined();
		expect(days(nodeOf(await jsonLdOf('ebook-returns'), 'Product').offers)).toBe(7);
	});

	it('has no Product node for a product with nothing offered', async () => {
		await shop.seedProduct({ slug: 'free', price: 0 });
		const graph = (await jsonLdOf('free'))['@graph'].map((/** @type {any} */ n) => n['@type']);
		expect(graph).toEqual(['BreadcrumbList']);
	});
});
