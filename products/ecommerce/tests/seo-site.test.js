/**
 * Baseline SEO with the catalog and the site answer (SEO audit G2, E49, phase S5): every shop with Catalog on gets the
 * product, category and listing heads, the sitemap and the home page's business and website data, following the seo
 * settings' defaults; the SEO feature (the SEO product) makes the merchant's own settings count, and landing and glossary
 * pages stay with Landing pages. The home page describes an OnlineStore (or a LocalBusiness at the pickup point) with
 * only the values the shop has, and the WebSite with the same name.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openingHoursOf, siteJsonLd } from '../core/seo.js';
import { createSnippets } from '../core/snippets.js';
import { BASE, ORIGIN, readyShop } from './helpers.js';

const HOME = `${ORIGIN}/`;

/** @param {string} jsonLd @param {string} type */
const nodeOf = (jsonLd, type) => JSON.parse(jsonLd)['@graph'].find((/** @type {any} */ node) => node['@type'] === type);

describe('the site structured data', () => {
	/** @type {import('../core/seo.js').SitePage} */
	const page = {
		home: HOME,
		name: 'Northwind',
		alternateName: '',
		type: 'OnlineStore',
		logo: null,
		email: null,
		telephone: null,
		address: { street: '', country: '' },
		sameAs: [],
		openingHours: [],
		currency: 'USD',
		returns: null,
		shipping: null,
	};
	/** The return terms by default: by mail, the shopper pays to send the item back. */
	const TERMS = /** @type {const} */ ({ method: 'by_mail', fee: 'shopper_pays', feeAmount: 0 });

	it('names the business and the website alike, with only the values the shop has', () => {
		expect(siteJsonLd(page)['@graph']).toEqual([
			{ '@type': 'OnlineStore', '@id': `${HOME}#organization`, name: 'Northwind', url: HOME },
			{
				'@type': 'WebSite',
				'@id': `${HOME}#website`,
				name: 'Northwind',
				url: HOME,
				publisher: { '@id': `${HOME}#organization` },
			},
		]);
	});

	it('describes the member program of role prices, each a tier with a lower price (G17)', () => {
		const [business] = /** @type {any[]} */ (
			siteJsonLd({
				...page,
				memberTiers: [
					{ role: 'vip', name: 'VIP price' },
					{ role: 'trade:pro', name: 'Trade price' },
				],
			})['@graph']
		);
		expect(business.hasMemberProgram).toEqual({
			'@type': 'MemberProgram',
			'@id': `${HOME}#member_program`,
			name: 'Northwind',
			description: 'VIP price, Trade price',
			url: HOME,
			hasTiers: [
				{
					'@type': 'MemberProgramTier',
					'@id': `${HOME}#member_tier_vip`,
					name: 'VIP price',
					hasTierBenefit: 'https://schema.org/TierBenefitLoyaltyPrice',
				},
				{
					'@type': 'MemberProgramTier',
					'@id': `${HOME}#member_tier_trade%3Apro`,
					name: 'Trade price',
					hasTierBenefit: 'https://schema.org/TierBenefitLoyaltyPrice',
				},
			],
		});
		expect(siteJsonLd({ ...page, memberTiers: [] })['@graph'][0]).not.toHaveProperty('hasMemberProgram');
	});

	it('adds the address on one line, the contacts, profiles and the store-wide return policy', () => {
		const [business, website] = siteJsonLd({
			...page,
			alternateName: 'NW',
			logo: 'https://shop.example.com/logo.png',
			email: 'hello@shop.example.com',
			telephone: '+12025550143',
			address: { street: '1 Main Street\nNew York, NY 10001\n', country: 'US' },
			sameAs: ['https://social.example.com/northwind'],
			returns: { country: 'US', days: 30, terms: TERMS },
		})['@graph'];
		expect(business).toEqual({
			'@type': 'OnlineStore',
			'@id': `${HOME}#organization`,
			name: 'Northwind',
			alternateName: 'NW',
			url: HOME,
			logo: 'https://shop.example.com/logo.png',
			email: 'hello@shop.example.com',
			telephone: '+12025550143',
			address: { '@type': 'PostalAddress', streetAddress: '1 Main Street, New York, NY 10001', addressCountry: 'US' },
			sameAs: ['https://social.example.com/northwind'],
			hasMerchantReturnPolicy: {
				'@type': 'MerchantReturnPolicy',
				'@id': `${HOME}#return_policy`,
				applicableCountry: 'US',
				returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
				merchantReturnDays: 30,
				returnMethod: 'https://schema.org/ReturnByMail',
				returnFees: 'https://schema.org/ReturnFeesCustomerResponsibility',
			},
		});
		expect(website?.alternateName).toBe('NW');
		// a country without a street is still the business's address; no returns: not returnable
		const [onlyCountry] = /** @type {any[]} */ (
			siteJsonLd({ ...page, address: { street: '', country: 'FR' }, returns: { country: 'FR', days: 0, terms: TERMS } })[
				'@graph'
			]
		);
		expect(onlyCountry.address).toEqual({ '@type': 'PostalAddress', addressCountry: 'FR' });
		expect(onlyCountry.hasMerchantReturnPolicy.returnPolicyCategory).toBe('https://schema.org/MerchantReturnNotPermitted');
	});

	it('gives the store-wide shipping policy: the fee until the free-delivery amount, then free, with the delivery days', () => {
		const deliveryTime = { handling: { min: 0, max: 1 }, transit: { min: 2, max: 5 } };
		const [business] = /** @type {any[]} */ (
			siteJsonLd({ ...page, shipping: { country: 'US', fee: 500, freeOver: 5000, deliveryTime } })['@graph']
		);
		const destination = { '@type': 'DefinedRegion', addressCountry: 'US' };
		const transitTime = {
			'@type': 'ServicePeriod',
			duration: { '@type': 'QuantitativeValue', minValue: 2, maxValue: 5, unitCode: 'DAY' },
		};
		expect(business.hasShippingService).toEqual({
			'@type': 'ShippingService',
			'@id': `${HOME}#shipping_policy`,
			fulfillmentType: 'https://schema.org/FulfillmentTypeDelivery',
			handlingTime: {
				'@type': 'ServicePeriod',
				duration: { '@type': 'QuantitativeValue', minValue: 0, maxValue: 1, unitCode: 'DAY' },
			},
			shippingConditions: [
				{
					'@type': 'ShippingConditions',
					shippingDestination: destination,
					orderValue: { '@type': 'MonetaryAmount', minValue: '0.00', maxValue: '49.99', currency: 'USD' },
					shippingRate: { '@type': 'MonetaryAmount', value: '5.00', currency: 'USD' },
					transitTime,
				},
				{
					'@type': 'ShippingConditions',
					shippingDestination: destination,
					orderValue: { '@type': 'MonetaryAmount', minValue: '50.00', currency: 'USD' },
					shippingRate: { '@type': 'MonetaryAmount', value: '0.00', currency: 'USD' },
					transitTime,
				},
			],
		});
		// never free: one condition for every order
		const [flat] = /** @type {any[]} */ (
			siteJsonLd({ ...page, shipping: { country: 'US', fee: 500, freeOver: 0, deliveryTime } })['@graph']
		);
		expect(flat.hasShippingService.shippingConditions).toEqual([
			{
				'@type': 'ShippingConditions',
				shippingDestination: destination,
				shippingRate: { '@type': 'MonetaryAmount', value: '5.00', currency: 'USD' },
				transitTime,
			},
		]);
	});

	it('takes opening hours only when every line is written as schema.org writes them', () => {
		expect(openingHoursOf('Mo-Fr 09:00-17:00\nSa,Su 10:00-14:00')).toEqual(['Mo-Fr 09:00-17:00', 'Sa,Su 10:00-14:00']);
		expect(openingHoursOf(' Mo-Su ; Tu,Th  16:00-20:00 ')).toEqual(['Mo-Su', 'Tu,Th 16:00-20:00']);
		expect(openingHoursOf('Monday to Friday, 9 am to 5 pm')).toEqual([]);
		expect(openingHoursOf('Mo-Fr 09:00-17:00\nweekends by appointment')).toEqual([]);
		expect(openingHoursOf('Mo-Fr 9:00-17:00')).toEqual([]);
		expect(openingHoursOf('')).toEqual([]);
	});
});

describe('baseline SEO with the catalog', () => {
	/** @type {Awaited<ReturnType<typeof readyShop>>} */
	let shop;
	/** @type {Record<string, any>} */
	const ids = {};

	beforeAll(async () => {
		shop = await readyShop({
			features: ['catalog', 'checkout', 'returns', 'delivery_zones'],
			business: {
				name: 'Northwind Goods',
				country: 'US',
				logo: 'https://shop.example.com/logo.png',
				phone: '+12025550143',
				address: '1 Main Street, New York',
			},
		});
		ids.lamps = (await shop.api('POST', '/v1/categories', { name: 'Lamps' })).json;
		ids.lamp = (
			await shop.api('POST', '/v1/products', {
				name: 'Desk Lamp',
				status: 'active',
				categoryIds: [ids.lamps.id],
				price: 4500,
				stock: 3,
			})
		).json;
		// saved while SEO is off (an admin may prepare them): they count only once SEO is on
		await shop.setting('seo', 'titleTemplate', '{name} — {business} shop');
		await shop.setting('seo', 'homeTitle', 'Northwind: lamps and lights');
		await shop.setting('seo', 'socialProfiles', ['https://social.example.com/northwind']);
	});
	afterAll(async () => shop.product.close());

	/** @param {string} path */
	const read = async (path) => {
		const answer = await shop.api('GET', path);
		if (answer.status !== 200) throw new Error(`${path}: ${answer.status} ${answer.text}`);
		return answer;
	};

	it('answers every page head, the sitemap and the site with the defaults while SEO is off', async () => {
		expect((await read('/v1/seo/products/desk-lamp')).json.title).toBe('Desk Lamp | Northwind Goods');
		expect((await read('/v1/seo/categories/lamps')).json.title).toBe('Lamps | Northwind Goods');
		expect((await read('/v1/seo/listing?category=lamps')).json).toMatchObject({
			title: 'Lamps | Northwind Goods',
			robots: 'index, follow',
		});
		expect((await read('/v1/seo/sitemap.xml')).text).toContain(`<loc>${ORIGIN}/products/desk-lamp</loc>`);
		const site = (await read('/v1/seo/site')).json;
		expect(site).toMatchObject({
			title: 'Northwind Goods',
			description: '',
			canonical: HOME,
			image: null,
			siteName: 'Northwind Goods',
		});
		const business = nodeOf(site.jsonLd, 'OnlineStore');
		expect(business).toMatchObject({
			name: 'Northwind Goods',
			logo: 'https://shop.example.com/logo.png',
			telephone: '+12025550143',
			address: { '@type': 'PostalAddress', streetAddress: '1 Main Street, New York', addressCountry: 'US' },
			// the returns setting's window (7 days by default), with the business's country
			hasMerchantReturnPolicy: { applicableCountry: 'US', merchantReturnDays: 7 },
		});
		// the social profiles are the website's (Portal › Business), given whether SEO is on or not
		expect(business.sameAs).toEqual(['https://social.example.com/northwind']);
		expect(nodeOf(site.jsonLd, 'WebSite')).toMatchObject({ name: 'Northwind Goods', url: HOME });
	});

	it('renders the home page head with the docs snippet', async () => {
		const code = createSnippets({ base: BASE, widgets: [], permissions: [] }).homePage;
		// the snippet's head part runs as written (the page itself is JSX), with the server token of the website
		const head = code.slice(0, code.indexOf('export default')).replace(/^export /gm, '');
		const fetch = async (/** @type {string} */ url, /** @type {{ headers: Record<string, string> }} */ init) => {
			const answer = await shop.call('GET', url, { headers: init.headers });
			return { ok: answer.status === 200, json: async () => answer.json };
		};
		const generateMetadata = new Function('fetch', 'process', `${head}\nreturn generateMetadata;`)(fetch, {
			env: { SS_SERVER_TOKEN: shop.server },
		});
		expect(await generateMetadata()).toEqual({
			title: 'Northwind Goods',
			description: '',
			alternates: { canonical: HOME },
			openGraph: { type: 'website', url: HOME, siteName: 'Northwind Goods', images: undefined },
			twitter: { card: 'summary' },
		});
	});

	it('keeps landing and glossary pages with Landing pages', async () => {
		expect((await shop.api('GET', '/v1/landings')).status).toBe(403);
		expect((await shop.api('GET', '/v1/seo/attributes/color')).status).toBe(403);
		expect((await shop.api('GET', '/v1/seo/grades/mint')).status).toBe(403);
	});

	it('follows the merchant’s own seo settings once SEO is on', async () => {
		await shop.switchOn(['catalog', 'checkout', 'returns', 'delivery_zones', 'seo']);
		expect((await read('/v1/seo/products/desk-lamp')).json.title).toBe('Desk Lamp — Northwind Goods shop');
		const site = (await read('/v1/seo/site')).json;
		expect(site.title).toBe('Northwind: lamps and lights');
		expect(nodeOf(site.jsonLd, 'OnlineStore').sameAs).toEqual(['https://social.example.com/northwind']);
	});

	it('describes a local business at the pickup point once the merchant picks it and the point has an address and hours', async () => {
		await shop.setting('seo', 'businessType', 'LocalBusiness');
		await shop.setting('seo', 'alternateName', 'NW');
		// no pickup hours yet: still an online store
		await shop.setting('delivery_zones', 'pickupAddress', '5 Market Street\nNew York');
		expect(nodeOf((await read('/v1/seo/site')).json.jsonLd, 'OnlineStore')).toBeDefined();
		await shop.setting('delivery_zones', 'pickupHours', 'Mo-Fr 09:00-18:00\nSa 10:00-14:00');
		const site = (await read('/v1/seo/site')).json;
		expect(nodeOf(site.jsonLd, 'OnlineStore')).toBeUndefined();
		expect(nodeOf(site.jsonLd, 'LocalBusiness')).toMatchObject({
			name: 'Northwind Goods',
			alternateName: 'NW',
			address: { streetAddress: '5 Market Street, New York', addressCountry: 'US' },
			openingHours: ['Mo-Fr 09:00-18:00', 'Sa 10:00-14:00'],
		});
		expect(nodeOf(site.jsonLd, 'WebSite').alternateName).toBe('NW');
		// hours written in words are shown to shoppers, never guessed into opening hours
		await shop.setting('delivery_zones', 'pickupHours', 'Weekdays 9 to 6');
		expect(nodeOf((await read('/v1/seo/site')).json.jsonLd, 'LocalBusiness').openingHours).toBeUndefined();
	});

	it('describes the business as any schema.org store or local business type the merchant picks (E35)', async () => {
		await shop.setting('seo', 'businessType', 'ClothingStore');
		await shop.setting('delivery_zones', 'pickupHours', '');
		// without a pickup point with an address and hours: an online store
		expect(nodeOf((await read('/v1/seo/site')).json.jsonLd, 'OnlineStore')).toBeDefined();
		await shop.setting('delivery_zones', 'pickupAddress', '5 Market Street');
		await shop.setting('delivery_zones', 'pickupHours', 'Mo-Sa 10:00-19:00');
		const site = (await read('/v1/seo/site')).json;
		expect(nodeOf(site.jsonLd, 'ClothingStore')).toMatchObject({ openingHours: ['Mo-Sa 10:00-19:00'] });
		expect(nodeOf(site.jsonLd, 'OnlineStore')).toBeUndefined();
		// only schema.org's own type names are taken: any other text the Portal holds is an online store
		await shop.setting('seo', 'businessType', 'Shop Of Dreams');
		const other = (await read('/v1/seo/site')).json;
		expect(nodeOf(other.jsonLd, 'OnlineStore')).toBeDefined();
		expect(nodeOf(other.jsonLd, 'ClothingStore')).toBeUndefined();
	});
});
