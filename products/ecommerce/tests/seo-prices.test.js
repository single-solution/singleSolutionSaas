/**
 * One shown price (SEO audit G4, phase S4): the price shoppers see on a card and the product page is the price in
 * structured data and feeds — the variant's price less the best live item deal on one unit as the cart prices it, with
 * the strikethrough "was" price, the sale's dates for search engines (`validFrom`, `priceValidUntil`) and feeds
 * (`sale_price`, `sale_price_effective_date`, also in the Meta CSV). A deal that needs more than one unit, a cart total
 * above the price or a payment method is an offer of the cart, not the price; one limited to weekdays or hours shows
 * while it runs but gives no sale dates and stays out of feeds (they are read at the catalogs' own pace).
 */
import { Collection } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { feedRows, googleItem, metaLine, META_HEADER } from '../core/feeds.js';
import { listShown, shownPrice } from '../core/promotions.js';
import { productJsonLd } from '../core/seo.js';
import { ALL, readyShop } from './helpers.js';

/** @typedef {import('../core/model.js').DealRecord} DealRecord */
/** @typedef {import('../core/model.js').VariantRecord} VariantRecord */
/** @typedef {import('../core/model.js').ProductRecord} ProductRecord */

const NOW = Date.parse('2026-10-05T10:00:00Z');
const CLOCK = { weekday: 1, minutes: 600 };

/** @param {Partial<DealRecord>} [o] @returns {DealRecord} */
const deal = (o = {}) => ({
	id: 'deal_1',
	name: 'Autumn sale',
	description: '',
	type: 'percent',
	value: 10,
	scope: { productIds: [], categoryIds: [], brandIds: [] },
	startsAt: null,
	endsAt: null,
	limit: null,
	used: 0,
	priority: 0,
	active: true,
	slug: '',
	badgeLabel: '',
	discountLabel: '',
	color: '',
	banner: null,
	content: '',
	seo: { title: '', description: '' },
	sort: 0,
	conditions: null,
	target: 'items',
	days: [],
	timeFrom: '',
	timeTo: '',
	allowPoints: true,
	...o,
});

/** @param {Partial<VariantRecord>} [o] @returns {VariantRecord} */
const variant = (o = {}) => ({
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
	...o,
});

/** @type {ProductRecord} */
const product = /** @type {any} */ ({
	id: 'prd_1',
	name: 'Mug',
	kind: 'physical',
	trackStock: true,
	brandId: null,
	categoryIds: [],
	specs: {},
	options: [],
	rating: { average: 0, count: 0 },
	faqs: [],
	variants: [variant()],
});

/** @param {VariantRecord} v @param {DealRecord[]} deals */
const shown = (v, deals) => shownPrice({ product, variant: v, deals, now: NOW, categoryIds: [], clock: CLOCK, unit: 1 });

/** @param {Partial<DealRecord['conditions']>} o */
const conditions = (o) =>
	/** @type {DealRecord['conditions']} */ ({
		match: 'all',
		rules: [],
		groups: [],
		priceRange: null,
		minQuantity: 0,
		cartTotal: 0,
		paymentMethods: [],
		...o,
	});

describe('the shown price', () => {
	it('is the price less the deal on one unit, with the higher price struck through', () => {
		expect(shown(variant(), [])).toEqual({ price: 1000, was: null, savings: 0, deal: null, sale: null });
		expect(listShown(variant({ compareAtPrice: 1200 }))).toEqual({
			price: 1000,
			was: 1200,
			savings: 0,
			deal: null,
			sale: null,
		});
		const ends = new Date('2026-10-20T00:00:00Z');
		const starts = new Date('2026-10-01T00:00:00Z');
		const sale = deal({ startsAt: starts, endsAt: ends });
		expect(shown(variant(), [sale])).toEqual({
			price: 900,
			was: 1000,
			savings: 100,
			deal: { id: 'deal_1', name: 'Autumn sale' },
			sale: { from: starts, until: ends },
		});
		expect(shown(variant({ compareAtPrice: 1500 }), [sale])).toMatchObject({ price: 900, was: 1500, savings: 100 });
		// a "was" price at or under the price is not struck through
		expect(shown(variant({ compareAtPrice: 1000 }), [])).toMatchObject({ was: null });
	});

	it('leaves the cart’s offers out of the price', () => {
		for (const off of [
			deal({ conditions: conditions({ minQuantity: 2 }) }),
			deal({ conditions: conditions({ cartTotal: 1001 }) }),
			deal({ conditions: conditions({ paymentMethods: ['online'] }) }),
			deal({ target: 'cart' }),
			deal({ type: 'free_delivery', value: 0 }),
			deal({ startsAt: new Date('2026-11-01T00:00:00Z') }),
			deal({ active: false }),
		])
			expect(shown(variant(), [off])).toMatchObject({ price: 1000, savings: 0, deal: null });
		// a cart total the unit alone reaches is met
		expect(shown(variant(), [deal({ conditions: conditions({ cartTotal: 1000 }) })]).price).toBe(900);
	});

	it('shows a deal limited to weekdays or hours while it runs, without sale dates', () => {
		const evenings = deal({ timeFrom: '09:00', timeTo: '11:00', endsAt: new Date('2026-10-20T00:00:00Z') });
		expect(shown(variant(), [evenings])).toMatchObject({ price: 900, sale: null });
		expect(shown(variant(), [deal({ days: [3] })])).toMatchObject({ price: 1000, deal: null });
	});
});

describe('structured data and feeds', () => {
	const ends = new Date('2026-10-20T00:00:00Z');
	const starts = new Date('2026-10-01T08:00:00Z');
	const sale = deal({ startsAt: starts, endsAt: ends });
	/** @param {DealRecord[]} deals @param {Partial<VariantRecord>} [o] @param {string} [timeZone] */
	const offerOf = (deals, o = {}, timeZone = undefined) => {
		const item = { ...product, variants: [variant(o)] };
		return /** @type {any} */ (
			productJsonLd({
				...(timeZone ? { timeZone } : {}),
				product: item,
				url: 'https://shop.example.com/products/mug',
				images: ['https://shop.example.com/media/s/a.jpg'],
				description: '',
				brand: null,
				currency: 'USD',
				condition: () => 'new',
				seller: 'Shop',
				trail: [],
				variantName: () => 'Mug',
				shown: (v) => shown(v, deals),
			})['@graph'][0]
		).offers;
	};

	it('marks the shown price, the struck-through price and the sale’s dates', () => {
		expect(offerOf([sale])).toMatchObject({
			price: '9.00',
			priceSpecification: {
				'@type': 'UnitPriceSpecification',
				priceType: 'https://schema.org/StrikethroughPrice',
				price: '10.00',
				priceCurrency: 'USD',
			},
			validFrom: '2026-10-01T08:00:00.000Z',
			priceValidUntil: '2026-10-19',
		});
		const was = offerOf([], { compareAtPrice: 1500 });
		expect(was).toMatchObject({ price: '10.00', priceSpecification: { price: '15.00' } });
		expect(was.validFrom).toBeUndefined();
		expect(was.priceValidUntil).toBeUndefined();
		const plain = offerOf([]);
		expect(plain.priceSpecification).toBeUndefined();
		// a sale with no end gives no dates to keep
		expect(offerOf([deal({ startsAt: starts })]).priceValidUntil).toBeUndefined();
		// its last day is a day in the business time zone (review L8): midnight in New York is 04:00 UTC
		const newYork = deal({ startsAt: starts, endsAt: new Date('2026-10-20T04:00:00Z') });
		expect(offerOf([newYork], {}, 'America/New_York').priceValidUntil).toBe('2026-10-19');
		expect(offerOf([newYork]).priceValidUntil).toBe('2026-10-20');
		// a variant the deal makes free is not offered (merchant listings need a price above 0)
		expect(offerOf([deal({ value: 100 })])).toBeUndefined();
	});

	it('sends sale_price and its dates to Google and Meta', () => {
		const item = { ...product, variants: [variant({ id: 'var_a', compareAtPrice: 1200 }), variant({ id: 'var_b' })] };
		const context = {
			link: 'https://shop.example.com/products/mug',
			image: 'https://shop.example.com/media/s/a.jpg',
			brand: 'Acme',
			productType: '',
			currency: 'USD',
			condition: () => /** @type {const} */ ('new'),
			skuAs: /** @type {const} */ ('none'),
			includeOutOfStock: true,
			now: NOW,
		};
		const [onSale, plain] = feedRows(item, { ...context, shown: (v) => shown(v, v.id === 'var_b' ? [sale] : []) });
		expect(onSale).toMatchObject({ price: '12.00 USD', salePrice: '10.00 USD', saleDates: '' });
		expect(plain).toMatchObject({
			price: '10.00 USD',
			salePrice: '9.00 USD',
			saleDates: '2026-10-01T08:00:00.000Z/2026-10-20T00:00:00.000Z',
		});
		expect(googleItem(/** @type {any} */ (plain))).toContain(
			'<g:sale_price>9.00 USD</g:sale_price><g:sale_price_effective_date>2026-10-01T08:00:00.000Z/2026-10-20T00:00:00.000Z</g:sale_price_effective_date>',
		);
		expect(META_HEADER).toContain(',price,sale_price,sale_price_effective_date,');
		expect(metaLine(/** @type {any} */ (plain))).toContain(
			',10.00 USD,9.00 USD,2026-10-01T08:00:00.000Z/2026-10-20T00:00:00.000Z,',
		);
		// a sale with no start runs from the feed's read
		const [open] = feedRows(
			{ ...item, variants: [variant()] },
			{ ...context, shown: (v) => shown(v, [deal({ endsAt: ends })]) },
		);
		expect(open?.saleDates).toBe('2026-10-05T10:00:00.000Z/2026-10-20T00:00:00.000Z');
	});
});

describe('one price everywhere', () => {
	/** @type {Awaited<ReturnType<typeof readyShop>>} */
	let shop;
	beforeAll(async () => {
		shop = await readyShop({ features: ALL.filter((feature) => feature !== 'multi_location') });
		const made = await shop.api('POST', '/v1/products', {
			name: 'Kettle',
			status: 'active',
			variants: [{ price: 5000, compareAtPrice: 6000, stock: 3 }],
		});
		if (made.status !== 201) throw new Error(made.text);
		await shop.setting('feeds', 'items', 'all');
		const created = await shop.api('POST', '/v1/deals', {
			name: 'Kettle week',
			type: 'percent',
			value: 20,
			endsAt: '2026-10-12T00:00:00Z',
		});
		if (created.status !== 201) throw new Error(created.text);
	});
	afterAll(async () => shop.product.close());

	it('gives the card, the product page, structured data and feeds the same price', async () => {
		const card = (await shop.visitor('GET', '/v1/shop/products')).json.items.find(
			(/** @type {any} */ item) => item.slug === 'kettle',
		);
		expect(card).toMatchObject({ price: 4000, compareAtPrice: 6000, priceMax: 4000 });
		const page = (await shop.visitor('GET', '/v1/shop/products/kettle')).json;
		expect(page).toMatchObject({ price: 4000, compareAtPrice: 6000 });
		expect(page.variants[0]).toMatchObject({
			price: 4000,
			compareAtPrice: 6000,
			deal: { name: 'Kettle week', savings: 1000 },
		});
		const offer = JSON.parse((await shop.api('GET', '/v1/seo/products/kettle')).json.jsonLd)['@graph'][0].offers;
		expect(offer).toMatchObject({ price: '40.00', priceSpecification: { price: '60.00' }, priceValidUntil: '2026-10-11' });
		const google = (await shop.api('GET', '/v1/feeds/products.xml')).text;
		expect(google).toContain('<g:price>60.00 USD</g:price>');
		expect(google).toContain('<g:sale_price>40.00 USD</g:sale_price>');
		expect(google).toContain('/2026-10-12T00:00:00.000Z</g:sale_price_effective_date>');
		const meta = (await shop.api('GET', '/v1/feeds/products.csv')).text;
		expect(meta).toContain(',60.00 USD,40.00 USD,');
		// the quote of one unit says the same
		const quote = (await shop.visitor('GET', `/v1/shop/products/${page.id}/quote`)).json;
		expect(quote).toMatchObject({ price: 5000, priceAfterDeals: 4000, savings: 1000 });
	});

	it('gives Chat the price shoppers see, with the price struck through and the deal in it', async () => {
		const id = (await shop.visitor('GET', '/v1/shop/products/kettle')).json.id;
		const card = (await shop.api('GET', '/v1/chat/products?q=kettle')).json.items[0];
		expect(card).toMatchObject({
			price: 4000,
			priceText: 'USD 40.00',
			compareAtPrice: 6000,
			compareAtPriceText: 'USD 60.00',
			deal: { name: 'Kettle week', savings: 1000, savingsText: 'USD 10.00' },
			priceMax: 4000,
		});
		expect((await shop.api('GET', '/v1/chat/products/top?kind=new')).json.items[0]).toMatchObject({ price: 4000 });
		const details = (await shop.api('GET', `/v1/chat/products/${id}`)).json;
		expect(details).toMatchObject({ price: 4000, compareAtPrice: 6000, priceRange: { min: 4000, max: 4000 } });
		expect(details.variants[0]).toMatchObject({ price: 4000, compareAtPrice: 6000, deal: { name: 'Kettle week' } });
		const context = (await shop.api('GET', '/v1/chat/context?productId=kettle')).json;
		expect(context.products[0].prices).toEqual([
			{
				grade: null,
				price: 4000,
				priceText: 'USD 40.00',
				compareAtPrice: 6000,
				compareAtPriceText: 'USD 60.00',
				inStock: true,
			},
		]);
		expect(context.text).toContain('- Kettle: USD 40.00 (was USD 60.00) ');
		expect(context.text).toContain('- Standard, USD 40.00 (was USD 60.00), in stock');
		// the quote prices the cart, with the variant's own "was" price
		const quote = (await shop.api('GET', `/v1/chat/products/${id}/quote`)).json;
		expect(quote).toMatchObject({
			price: 5000,
			compareAtPrice: 6000,
			compareAtPriceText: 'USD 60.00',
			priceAfterDeals: 4000,
			savings: 1000,
		});
	});

	it('gives llms.txt and llms-full.txt the price shoppers see (review L7)', async () => {
		const short = (await shop.api('GET', '/v1/llms.txt')).text;
		expect(short).toContain('USD 40.00');
		expect(short).not.toContain('USD 50.00');
		await shop.setting('llms_txt', 'full', true);
		try {
			const full = (await shop.api('GET', '/v1/llms-full.txt')).text;
			expect(full).toContain('USD 40.00');
			expect(full).not.toContain('USD 50.00');
		} finally {
			await shop.setting('llms_txt', 'full', false);
		}
	});

	it('reads the categories as often for many products as for few (review M8)', async () => {
		const category = (await shop.api('POST', '/v1/categories', { name: 'Kitchen' })).json;
		/** @param {number} from @param {number} to */
		const pots = async (from, to) => {
			for (let n = from; n < to; n += 1)
				await shop.seedProduct({ name: `Pot ${n}`, slug: `pot-${n}`, categoryIds: [category.id], price: 2000 + n });
		};
		const find = vi.spyOn(Collection.prototype, 'find');
		/** How often each read of a grid, Chat's search and the listing's server HTML reads the categories. */
		const categoryReads = async () => {
			/** @type {number[]} */
			const counts = [];
			for (const read of [
				() => shop.visitor('GET', '/v1/shop/products?limit=40'),
				() => shop.api('GET', '/v1/chat/products?q=pot&limit=20'),
				() => shop.api('GET', `/v1/seo/listing?category=${category.slug}&html=1&limit=40`),
			]) {
				find.mockClear();
				await read();
				const used = /** @type {Collection[]} */ (/** @type {unknown[]} */ (find.mock.instances));
				counts.push(used.filter((collection) => /categories$/.test(collection.collectionName)).length);
			}
			return counts;
		};
		try {
			await pots(0, 2);
			const few = await categoryReads();
			await pots(2, 14);
			// a deal is live: each product's price needs its categories, read once for all of them
			expect(await categoryReads()).toEqual(few);
		} finally {
			find.mockRestore();
		}
	});
});
