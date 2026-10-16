/**
 * Merchant-listing details from the shop's settings (SEO audit G5, phase S6): the store-wide shipping policy needs the
 * business's country and the delivery days (handling and transit, from the delivery settings; none set: no shipping
 * markup), the store-wide return policy says how items come back and who pays (returns settings), a shop without the
 * Returns feature says nothing about returns unless it says it takes none (checkout setting `returnsAccepted`), product
 * offers point to both by `@id`, and Shop health asks for what the merchant must fill (country, logo, delivery days).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORIGIN, readyShop } from './helpers.js';

const HOME = `${ORIGIN}/`;

/** @param {string} jsonLd @param {string} type */
const nodeOf = (jsonLd, type) => JSON.parse(jsonLd)['@graph'].find((/** @type {any} */ node) => node['@type'] === type);

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;

beforeAll(async () => {
	shop = await readyShop({
		features: ['catalog', 'checkout', 'returns', 'delivery_zones', 'reports'],
		business: { country: 'US' },
	});
	await shop.api('POST', '/v1/products', { name: 'Desk Lamp', status: 'active', price: 4500, stock: 3 });
	await shop.list('delivery_zones', [
		{ key: 'abroad', name: 'Abroad', rates: [{ key: 'standard', name: 'Standard', price: 9900 }] },
		{
			key: 'home',
			name: 'Home',
			match: { countries: ['US'] },
			rates: [{ key: 'standard', name: 'Standard', price: 500, freeOver: 5000 }],
		},
	]);
});
afterAll(async () => shop.product.close());

/** @param {string} path */
const read = async (path) => {
	const answer = await shop.api('GET', path);
	if (answer.status !== 200) throw new Error(`${path}: ${answer.status} ${answer.text}`);
	return answer.json;
};
const business = async () => nodeOf((await read('/v1/seo/site')).jsonLd, 'OnlineStore');
const offer = async () => nodeOf((await read('/v1/seo/products/desk-lamp')).jsonLd, 'Product').offers;
/** @param {string} key */
const health = async (key) => (await read('/v1/reports/health')).checks.find((/** @type {any} */ check) => check.key === key);

describe('the store-wide shipping policy', () => {
	it('is left out, and Shop health asks for the delivery days, until both are set', async () => {
		expect((await business()).hasShippingService).toBeUndefined();
		expect((await offer()).shippingDetails).toBeUndefined();
		expect(await health('delivery_days')).toEqual({ key: 'delivery_days', status: 'attention', count: 1, link: null });
		await shop.setting('delivery_zones', 'handlingDays', [1]);
		expect((await business()).hasShippingService).toBeUndefined();
		expect((await health('delivery_days')).status).toBe('attention');
	});

	it('gives the fee, free delivery and delivery days to the business’s country, and offers point to it', async () => {
		await shop.list('delivery_zones', [
			{ key: 'abroad', name: 'Abroad', rates: [{ key: 'standard', name: 'Standard', price: 9900, minDays: 9, maxDays: 20 }] },
			{
				key: 'home',
				name: 'Home',
				match: { countries: ['US'] },
				// the business country's first plain rate: its days are the days in transit (E5)
				rates: [{ key: 'standard', name: 'Standard', price: 500, freeOver: 5000, minDays: 2, maxDays: 5 }],
			},
		]);
		const service = (await business()).hasShippingService;
		expect(service).toMatchObject({
			'@id': `${HOME}#shipping_policy`,
			handlingTime: { duration: { minValue: 1, maxValue: 1 } },
		});
		expect(service.shippingConditions.map((/** @type {any} */ c) => [c.shippingRate.value, c.orderValue])).toEqual([
			['5.00', { '@type': 'MonetaryAmount', minValue: '0.00', maxValue: '49.99', currency: 'USD' }],
			['0.00', { '@type': 'MonetaryAmount', minValue: '50.00', currency: 'USD' }],
		]);
		expect(service.shippingConditions[0].transitTime.duration).toMatchObject({ minValue: 2, maxValue: 5 });
		expect((await offer()).shippingDetails).toEqual({
			'@type': 'OfferShippingDetails',
			hasShippingService: { '@id': `${HOME}#shipping_policy` },
		});
		expect((await health('delivery_days')).status).toBe('ok');
	});
});

describe('the store-wide return policy', () => {
	it('says how items come back and who pays to send them', async () => {
		expect((await business()).hasMerchantReturnPolicy).toEqual({
			'@type': 'MerchantReturnPolicy',
			'@id': `${HOME}#return_policy`,
			applicableCountry: 'US',
			returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
			merchantReturnDays: 7,
			returnMethod: 'https://schema.org/ReturnByMail',
			returnFees: 'https://schema.org/ReturnFeesCustomerResponsibility',
		});
		await shop.setting('returns', 'returnMethod', 'both');
		await shop.setting('returns', 'returnShippingFee', 'fixed');
		await shop.setting('returns', 'returnShippingFeeAmount', 350);
		expect((await business()).hasMerchantReturnPolicy).toMatchObject({
			returnMethod: ['https://schema.org/ReturnByMail', 'https://schema.org/ReturnInStore'],
			returnFees: 'https://schema.org/ReturnShippingFees',
			returnShippingFeesAmount: { '@type': 'MonetaryAmount', value: '3.50', currency: 'USD' },
		});
		expect((await offer()).hasMerchantReturnPolicy).toEqual({ '@id': `${HOME}#return_policy` });
	});

	it('says nothing without the Returns feature, unless the shop takes no returns', async () => {
		await shop.switchOn(['catalog', 'checkout', 'delivery_zones', 'reports']);
		expect((await business()).hasMerchantReturnPolicy).toBeUndefined();
		expect((await offer()).hasMerchantReturnPolicy).toBeUndefined();
		await shop.setting('checkout', 'returnsAccepted', 'no');
		expect((await business()).hasMerchantReturnPolicy).toEqual({
			'@type': 'MerchantReturnPolicy',
			'@id': `${HOME}#return_policy`,
			applicableCountry: 'US',
			returnPolicyCategory: 'https://schema.org/MerchantReturnNotPermitted',
		});
		expect((await offer()).hasMerchantReturnPolicy).toEqual({ '@id': `${HOME}#return_policy` });
	});
});

describe('what Shop health asks the merchant to fill', () => {
	it('asks for the business’s country and logo', async () => {
		expect(await health('business_country')).toEqual({
			key: 'business_country',
			status: 'ok',
			count: 0,
			link: `${ORIGIN}/.well-known/business.json`,
		});
		expect(await health('business_logo')).toMatchObject({ status: 'attention', count: 1 });
		// without delivery zones there are no delivery days to ask for
		await shop.switchOn(['catalog', 'checkout', 'reports']);
		expect((await health('delivery_days')).status).toBe('skipped');
	});
});
