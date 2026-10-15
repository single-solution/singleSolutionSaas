/**
 * Shop health's data and setup checks (SEO audit §3.2 A, phase S12; parity P5-18): products that cannot be bought,
 * variants priced 0, photos without their text or too small, short descriptions, names and SEO copy used twice, long
 * titles, canonical addresses on another site, products without the identifiers the feeds need, empty categories,
 * glossary pages without their text; the business phone, storage, bank details shoppers pay to, staff alerts that
 * reach someone and link to the admin, and no products at all.
 */
import { createId } from '@ss/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PAYMENTS, readyShop } from './helpers.js';

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
/** The checks by key. @returns {Promise<Record<string, any>>} */
const checks = async () =>
	Object.fromEntries((await api('GET', '/v1/reports/health')).checks.map((/** @type {any} */ check) => [check.key, check]));
/** A check's state and count. @param {string} key */
const state = async (key) => {
	const check = (await checks())[key];
	return `${check.status} ${check.count}`;
};

/** A variant. @param {Record<string, unknown>} [more] */
const variant = (more = {}) => ({
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
	...more,
});
/** A photo. @param {Record<string, unknown>} [more] */
const photo = (more = {}) => ({
	key: `ecommerce/products/x/${createId('img')}.jpg`,
	type: 'image/jpeg',
	size: 1,
	alt: 'Front',
	...more,
});

beforeAll(async () => {
	shop = await readyShop();
	expect(await state('no_products')).toBe('attention 1');
	const words = 'A well made lamp with a linen shade and a solid oak base for any room.'.repeat(2);
	const seo = { title: '', description: '', canonicalUrl: '', ogImage: '', noindex: false, nofollow: false, focusKeyword: '' };
	ids.brand = await api('POST', '/v1/brands', { name: 'Nova', seo: { title: 'Lighting you love' } });
	ids.lamps = await api('POST', '/v1/categories', { name: 'Lamps', seo: { title: 'Lighting you love' } });
	ids.empty = await api('POST', '/v1/categories', { name: 'Rugs' });
	const product = (/** @type {Record<string, unknown>} */ more) =>
		shop.seedProduct({ description: words, media: [photo()], categoryIds: [ids.lamps.id], ...more });
	await product({ name: 'Desk lamp', seo: { ...seo, title: 'Desk lamp' }, variants: [variant({ gtin: '4006381333931' })] });
	await product({ name: 'desk LAMP', seo: { ...seo, title: 'Desk lamp' }, variants: [variant({ mpn: 'DL-2' })] });
	await product({ name: 'Floor lamp', brandId: ids.brand.id, media: [photo({ alt: '', width: 300, height: 300 })] });
	await product({
		name: 'Wall lamp',
		description: 'Short.',
		seo: { ...seo, title: 'x'.repeat(61), canonicalUrl: 'https://other.example.org/wall-lamp' },
		variants: [variant({ price: 0, mpn: 'WL-1' })],
	});
	await product({ name: 'Old lamp', variants: [variant({ active: false, mpn: 'OL-1' })] });
});
afterAll(async () => shop?.product.close());

describe('shop health: the catalog data', () => {
	it('finds what keeps products from selling and from good listings', async () => {
		/** @type {Record<string, any>} */
		const found = await checks();
		const of = (/** @type {string} */ key) => `${found[key].status} ${found[key].count}`;
		expect(of('no_products')).toBe('ok 0');
		// the wall lamp is priced 0 and the old lamp has no variant on sale
		expect(of('products_not_buyable')).toBe('attention 2');
		expect(of('variants_priced_zero')).toBe('attention 1');
		expect(of('images_without_alt')).toBe('attention 1');
		expect(of('images_too_small')).toBe('attention 1');
		expect(of('short_descriptions')).toBe('attention 1');
		expect(of('duplicate_names')).toBe('attention 2');
		// two products share a title, and a category shares one with a brand
		expect(of('duplicate_titles')).toBe('attention 4');
		expect(of('duplicate_descriptions')).toBe('ok 0');
		expect(of('long_titles')).toBe('attention 1');
		expect(of('canonical_elsewhere')).toBe('attention 1');
		// the floor lamp has a brand and no GTIN, and no product lacks both a brand and an identifier
		expect(of('branded_without_gtin')).toBe('attention 1');
		expect(of('missing_identifiers')).toBe('ok 0');
		expect(of('empty_categories')).toBe('attention 1');
		expect(of('glossary_without_text')).toBe('skipped 0');
	});

	it('counts a category whose only products are of a hidden brand as empty: shoppers see none (review L10)', async () => {
		const shades = await api('POST', '/v1/categories', { name: 'Shades' });
		await shop.seedProduct({ name: 'Nova shade', media: [photo()], categoryIds: [shades.id], brandId: ids.brand.id });
		expect(await state('empty_categories')).toBe('attention 1');
		await api('PATCH', `/v1/brands/${ids.brand.id}`, { status: 'hidden' });
		try {
			expect(await state('empty_categories')).toBe('attention 2');
		} finally {
			await api('PATCH', `/v1/brands/${ids.brand.id}`, { status: 'active' });
		}
	});

	it('counts glossary pages without text once they have an address, and identifiers by the feeds settings', async () => {
		await api('POST', '/v1/attributes', { name: 'Shade', seo: { body: 'What each shade does to the light.' } });
		await api('POST', '/v1/attributes', { name: 'Base' });
		await shop.setting('landing_pages', 'attributeUrl', '/glossary/{slug}');
		expect(await state('glossary_without_text')).toBe('attention 1');
		await shop.seedProduct({ name: 'Plain lamp', description: 'x', media: [photo()], categoryIds: [ids.lamps.id] });
		expect(await state('missing_identifiers')).toBe('attention 1');
		await shop.setting('feeds', 'skuAs', 'mpn');
		await shop.seedProduct({
			name: 'Coded lamp',
			description: 'x',
			media: [photo()],
			categoryIds: [ids.lamps.id],
			variants: [variant({ sku: 'CL-1' })],
		});
		expect(await state('missing_identifiers')).toBe('attention 1');
		await shop.setting('feeds', 'identifierExists', 'no');
		expect(await state('missing_identifiers')).toBe('skipped 0');
	});
});

describe('shop health: the setup (P5-18)', () => {
	it('checks the business phone, storage, bank details and staff alerts', async () => {
		expect(await state('business_phone')).toBe('attention 1');
		// Payments has no bank details saved: shoppers are not told where to pay
		shop.responders.set(`${PAYMENTS}/v1/bank-transfer`, () => ({ status: 200, body: { ready: false } }));
		expect(await state('bank_details')).toBe('attention 1');
		shop.responders.set(`${PAYMENTS}/v1/bank-transfer`, () => ({ status: 200, body: { ready: true } }));
		expect(await state('bank_details')).toBe('ok 0');
		await shop.setting('checkout', 'paymentMethods', ['online']);
		expect(await state('bank_details')).toBe('skipped 0');
		await shop.setting('checkout', 'paymentMethods', ['online', 'bank_transfer', 'pickup']);
		// staff alerts to someone through Notifications, linking to the admin
		expect(await state('staff_alerts')).toBe('attention 1');
		await shop.setting('staff_alerts', 'recipients', ['orders@shop.example.com']);
		await shop.setting('staff_alerts', 'adminUrl', 'https://admin.shop.example.com/orders/{id}');
		expect([await state('staff_alerts'), await state('admin_url')]).toEqual(['ok 0', 'ok 0']);
		await shop.dashboard(
			await shop.adminSession(),
			'DELETE',
			`/v1/dashboard/websites/${shop.websiteId}/connections/notifications`,
		);
		expect(await state('staff_alerts')).toBe('attention 1');
		await shop.dashboard(await shop.adminSession(), 'DELETE', `/v1/dashboard/websites/${shop.websiteId}/connections/storage`);
		expect(await state('storage')).toBe('attention 1');
		// without Payments, staff record transfers: the bank transfer note tells shoppers where to pay
		await shop.dashboard(await shop.adminSession(), 'DELETE', `/v1/dashboard/websites/${shop.websiteId}/connections/payments`);
		await shop.setting('checkout', 'bankTransferVia', 'manual');
		expect(await state('bank_details')).toBe('attention 1');
		await shop.setting('checkout', 'noteBankTransfer', 'Pay to account 0000 0000, quoting your order number.');
		expect(await state('bank_details')).toBe('ok 0');
	});
});
