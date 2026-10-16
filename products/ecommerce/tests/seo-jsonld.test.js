/**
 * Product structured data as Google's merchant listings take it (SEO audit G5, phases S1 and S6): every variant has an
 * image and a unique id (its own photo and SKU, else the product's photos and the feed item id), the group id is the
 * feed's, nothing is offered at a price of 0, a product with nothing to offer has no Product node, physical goods point
 * to the store-wide shipping policy (only once it is complete: a country and delivery days), each item's return policy
 * (product, then grade, then the setting) points to the store-wide one when it is the same and carries its own node,
 * with the return method and fees, when it differs, and FAQ markup only while the merchant asks for it.
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
	warrantyTime: null,
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
			returnTime: null,
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
	shippingPolicy: null,
	returns: null,
	reviews: [],
	faqMarkup: false,
	...input,
});

/** @param {ReturnType<typeof productJsonLd>} jsonLd @param {string} type */
const nodeOf = (jsonLd, type) => /** @type {any} */ (jsonLd['@graph']).find((/** @type {any} */ node) => node['@type'] === type);

/** The return terms by default: by mail, the shopper pays to send the item back. */
const TERMS = /** @type {const} */ ({ method: 'by_mail', fee: 'shopper_pays', feeAmount: 0 });

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
		expect(single.gtin).toBeUndefined();
	});

	it("names each variant's GTIN and MPN when the merchant gave them (G5.6)", () => {
		const coded = {
			...two,
			variants: [
				{ ...variant({ id: 'var_red', options: { Color: 'Red' } }), gtin: '96385074', mpn: 'MUG-01' },
				two.variants[1],
			],
		};
		const group = nodeOf(productJsonLd(page(/** @type {any} */ (coded))), 'ProductGroup');
		expect(group.hasVariant.map((/** @type {any} */ v) => [v.gtin, v.mpn])).toEqual([
			['96385074', 'MUG-01'],
			[undefined, undefined],
		]);
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
		// the option names schema.org's size through its variant field's mapping (E34)
		const group = nodeOf(productJsonLd(page(mixed, { axes: new Map([['Size', 'size']]) })), 'ProductGroup');
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

	it('adds a member price for each tier of the member program, beside the struck-through price (G17)', () => {
		const tiers = [
			{ tierId: 'https://shop.example.com/#member_tier_vip', percent: 10, unit: 1 },
			{ tierId: 'https://shop.example.com/#member_tier_trade', percent: 25, unit: 100 },
		];
		const offer = nodeOf(
			productJsonLd(page(product({ variants: [variant({ price: 1999, compareAtPrice: 2500 })] }), { memberPrices: tiers })),
			'Product',
		).offers;
		expect(offer.price).toBe('19.99');
		expect(offer.priceSpecification).toEqual([
			{
				'@type': 'UnitPriceSpecification',
				priceType: 'https://schema.org/StrikethroughPrice',
				price: '25.00',
				priceCurrency: 'USD',
			},
			// 10 % off 19.99, rounded half up to a cent; 25 % off in whole units
			{
				'@type': 'UnitPriceSpecification',
				price: '17.99',
				priceCurrency: 'USD',
				validForMemberTier: { '@id': 'https://shop.example.com/#member_tier_vip' },
			},
			{
				'@type': 'UnitPriceSpecification',
				price: '14.99',
				priceCurrency: 'USD',
				validForMemberTier: { '@id': 'https://shop.example.com/#member_tier_trade' },
			},
		]);
		// one member price alone is one specification
		const vip = { tierId: 'https://shop.example.com/#member_tier_vip', percent: 10, unit: 1 };
		const single = nodeOf(productJsonLd(page(product(), { memberPrices: [vip] })), 'Product').offers;
		expect(single.priceSpecification).toMatchObject({ price: '9.00', validForMemberTier: { '@id': vip.tierId } });
	});

	it('adds the member price of a price-list tier only to the variants it lists, never raising a price (G17, E31)', () => {
		const item = product({ variants: [variant({ price: 1999 })] });
		const [only] = item.variants;
		const listed = (/** @type {number} */ price) => ({
			tierId: 'https://shop.example.com/#member_tier_trade',
			percent: 0,
			unit: 1,
			prices: new Map([[item.id, price]]),
		});
		const offers = nodeOf(productJsonLd(page(item, { memberPrices: [listed(1500)] })), 'Product').offers;
		expect(offers.priceSpecification).toMatchObject({
			price: '15.00',
			validForMemberTier: { '@id': 'https://shop.example.com/#member_tier_trade' },
		});
		// the variant's own price beats its product's
		const byVariant = {
			...listed(1500),
			prices: new Map([
				[item.id, 1500],
				[String(only?.id), 1200],
			]),
		};
		expect(nodeOf(productJsonLd(page(item, { memberPrices: [byVariant] })), 'Product').offers.priceSpecification).toMatchObject(
			{
				price: '12.00',
			},
		);
		// a listed price at or above the price is no member price
		expect(
			nodeOf(productJsonLd(page(item, { memberPrices: [listed(2500)] })), 'Product').offers.priceSpecification,
		).toBeUndefined();
	});

	it('points physical goods to the store-wide shipping policy, once it is complete', () => {
		const policy = 'https://shop.example.com/#shipping_policy';
		const offers = (/** @type {ProductRecord} */ item, /** @type {Partial<ProductPage>} */ input) =>
			nodeOf(productJsonLd(page(item, input)), 'Product').offers;
		expect(offers(product(), { shippingPolicy: policy }).shippingDetails).toEqual({
			'@type': 'OfferShippingDetails',
			hasShippingService: { '@id': policy },
		});
		expect(offers(product({ kind: 'digital' }), { shippingPolicy: policy }).shippingDetails).toBeUndefined();
		expect(offers(product({ kind: 'service' }), { shippingPolicy: policy }).shippingDetails).toBeUndefined();
		expect(offers(product(), { shippingPolicy: null }).shippingDetails).toBeUndefined();
	});

	it('points an item to the store-wide return policy when its window is the store’s, else gives its own', () => {
		const graded = product({
			options: [{ name: 'Grade', values: ['A', 'B', 'C'] }],
			variants: [
				variant({ id: 'var_a', options: { Grade: 'A' }, grade: 'a' }),
				variant({ id: 'var_b', options: { Grade: 'B' }, grade: 'b' }),
				variant({ id: 'var_c', options: { Grade: 'C' }, grade: 'c' }),
			],
		});
		const store = { id: 'https://shop.example.com/#return_policy', days: 14 };
		/** @type {NonNullable<ProductPage['returns']>} */
		const returns = {
			country: 'US',
			terms: TERMS,
			store,
			days: (v) => (v.grade === 'a' ? 30 : v.grade === 'b' ? 0 : 14),
		};
		const group = nodeOf(productJsonLd(page(graded, { returns })), 'ProductGroup');
		expect(group.hasVariant.map((/** @type {any} */ v) => v.offers.hasMerchantReturnPolicy)).toEqual([
			{
				'@type': 'MerchantReturnPolicy',
				applicableCountry: 'US',
				returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
				merchantReturnDays: 30,
				returnMethod: 'https://schema.org/ReturnByMail',
				returnFees: 'https://schema.org/ReturnFeesCustomerResponsibility',
			},
			{
				'@type': 'MerchantReturnPolicy',
				applicableCountry: 'US',
				returnPolicyCategory: 'https://schema.org/MerchantReturnNotPermitted',
			},
			{ '@id': 'https://shop.example.com/#return_policy' },
		]);
		// no store-wide policy: every item gives its own
		const own = nodeOf(productJsonLd(page(graded, { returns: { ...returns, store: null } })), 'ProductGroup');
		expect(own.hasVariant[2].offers.hasMerchantReturnPolicy).toMatchObject({ merchantReturnDays: 14 });
		// an item whose window is not known (null) has no policy node
		const unknown = nodeOf(
			productJsonLd(page(product({ kind: 'digital' }), { returns: { ...returns, days: () => null } })),
			'Product',
		);
		expect(unknown.offers.hasMerchantReturnPolicy).toBeUndefined();
	});

	it('says how items come back and who pays to send them (G5.3)', () => {
		/** @param {Partial<typeof TERMS> | Record<string, unknown>} terms */
		const policyOf = (terms) =>
			nodeOf(
				productJsonLd(
					page(product(), {
						returns: { country: 'US', terms: /** @type {any} */ ({ ...TERMS, ...terms }), store: null, days: () => 30 },
					}),
				),
				'Product',
			).offers.hasMerchantReturnPolicy;
		expect(policyOf({ method: 'in_store', fee: 'free' })).toMatchObject({
			returnMethod: 'https://schema.org/ReturnInStore',
			returnFees: 'https://schema.org/FreeReturn',
		});
		expect(policyOf({ method: 'both', fee: 'fixed', feeAmount: 499 })).toMatchObject({
			returnMethod: ['https://schema.org/ReturnByMail', 'https://schema.org/ReturnInStore'],
			returnFees: 'https://schema.org/ReturnShippingFees',
			returnShippingFeesAmount: { '@type': 'MonetaryAmount', value: '4.99', currency: 'USD' },
		});
		// a fixed fee of nothing is a free return (Google takes ReturnShippingFees only with a fee above 0)
		expect(policyOf({ fee: 'fixed', feeAmount: 0 }).returnFees).toBe('https://schema.org/FreeReturn');
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
			{ key: 'mint', label: 'Mint', condition: 'refurbished', returnTime: { amount: 0, unit: /** @type {const} */ ('days') } },
			{ key: 'fair', label: 'Fair' },
		]);
		await shop.setting('returns', 'returnTime', 14);
		await shop.list('delivery_zones', [
			{ key: 'everywhere', name: 'Everywhere', rates: [{ key: 'standard', name: 'Standard', price: 500 }] },
		]);
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
		offer.hasMerchantReturnPolicy?.merchantReturnDays ??
		offer.hasMerchantReturnPolicy?.returnPolicyCategory ??
		(offer.hasMerchantReturnPolicy?.['@id'] ? 'store' : undefined);

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
			returnTime: { amount: 30, unit: /** @type {const} */ ('days') },
			variants: variants.map((v) => ({ ...v, id: `${v.id}_own` })),
		});
		const graded = nodeOf(await jsonLdOf('graded'), 'ProductGroup');
		expect(graded.hasVariant.map((/** @type {any} */ v) => days(v.offers))).toEqual([
			'https://schema.org/MerchantReturnNotPermitted',
			'store',
			'store',
		]);
		expect(graded.hasVariant[0].offers.hasMerchantReturnPolicy.applicableCountry).toBe('US');
		// no delivery days yet: no shipping details (Google needs the delivery time)
		expect(graded.hasVariant[0].offers.shippingDetails).toBeUndefined();
		// the items whose window is the store's point to the store-wide policy on the home page
		expect(graded.hasVariant[1].offers.hasMerchantReturnPolicy).toEqual({ '@id': 'https://shop.example.com/#return_policy' });
		// a variant without its own photo shows the product's
		expect(graded.hasVariant[0].image).toEqual([expect.stringMatching(/^https:\/\//)]);
		expect(graded.hasVariant.map((/** @type {any} */ v) => v.sku)).toEqual(['var_mint', 'var_fair', 'var_new']);
		const own = nodeOf(await jsonLdOf('own-window'), 'ProductGroup');
		expect(own.hasVariant.map((/** @type {any} */ v) => days(v.offers))).toEqual([30, 30, 30]);
	});

	it('gives digital goods and bookings a return policy only when they name their own window', async () => {
		await shop.seedProduct({ slug: 'ebook', kind: 'digital', trackStock: false });
		await shop.seedProduct({
			slug: 'ebook-returns',
			kind: 'digital',
			trackStock: false,
			returnTime: { amount: 7, unit: /** @type {const} */ ('days') },
		});
		expect(nodeOf(await jsonLdOf('ebook'), 'Product').offers.hasMerchantReturnPolicy).toBeUndefined();
		expect(days(nodeOf(await jsonLdOf('ebook-returns'), 'Product').offers)).toBe(7);
	});

	it('has no Product node for a product with nothing offered', async () => {
		await shop.seedProduct({ slug: 'free', price: 0 });
		const graph = (await jsonLdOf('free'))['@graph'].map((/** @type {any} */ n) => n['@type']);
		expect(graph).toEqual(['BreadcrumbList']);
	});
});
