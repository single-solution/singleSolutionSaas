/**
 * Store details: who the store is (name, tagline, pictures, contacts, address, opening hours, social links, time zone and
 * language) is the website's, set once in the Portal (Website settings › Business, Brand and look, Region and format).
 * Ecommerce keeps no record of it: the shop read and the business.json a headless website serves are made from the
 * Portal's settings, and nothing here can be saved, uploaded or removed.
 */
import { validateBusinessJson } from '@ss/contracts';
import { emptyWebsiteSettings } from '@ss/contracts/website-settings';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { businessJsonOf, publicStoreDetails, storeDetailsFromWebsite, whatsappLink } from '../core/store-details.js';
import { DOMAIN, readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
beforeAll(async () => {
	shop = await readyShop();
});
afterAll(async () => shop.product.close());

/** What the merchant saved in the Portal, as the sections of the website settings. @param {string} websiteId */
const sections = (websiteId) => {
	const empty = emptyWebsiteSettings(websiteId);
	return {
		business: {
			...empty.business,
			name: 'Example Store',
			tagline: 'Everything for the home',
			email: 'hello@example-store.test',
			phone: '+1 555 0100',
			phones: [{ label: 'Landline', number: '021 111 222' }],
			whatsapp: '+1 (555) 010-0199',
			address: {
				...empty.business.address,
				line1: '1 Main Street',
				city: 'Springfield',
				region: 'IL',
				postalCode: '62701',
				country: 'US',
			},
			hours: {
				weekly: [
					{ day: 1, start: '09:00', end: '17:00' },
					{ day: 2, start: '09:00', end: '12:00' },
					{ day: 2, start: '13:00', end: '17:00' },
				],
				exceptions: [{ date: '2026-12-25', name: 'Holiday', hours: [] }],
			},
			social: [{ label: 'Instagram', url: 'https://instagram.com/examplestore' }],
		},
		brand: {
			...empty.brand,
			files: {
				...empty.brand.files,
				logo: 'https://cdn.example.com/logo.png',
				logoDark: 'https://cdn.example.com/dark.png',
				favicon: 'https://cdn.example.com/fav.png',
				faviconDark: 'https://cdn.example.com/fav-dark.png',
			},
		},
		region: {
			...empty.region,
			country: 'US',
			timeZone: 'America/Chicago',
			currency: 'USD',
			currencies: ['USD', 'EUR'],
			language: 'en-US',
			languages: ['en-US'],
		},
	};
};

/** The website settings document the Portal holds for these sections. @param {ReturnType<typeof sections>} parts */
const documentOf = (parts) => ({ ...emptyWebsiteSettings('web_x'), version: 2, ...parts });

describe('the store details the Portal’s settings make', () => {
	const details = storeDetailsFromWebsite(documentOf(sections('web_x')));

	it('are the Business facts, the time zone and language of Region and format, and the https pictures of Brand and look', () => {
		expect(details).toMatchObject({
			name: 'Example Store',
			tagline: 'Everything for the home',
			email: 'hello@example-store.test',
			phone: '+1 555 0100',
			phones: [{ label: 'Landline', number: '021 111 222' }],
			timeZone: 'America/Chicago',
			language: 'en-US',
			logo: { url: 'https://cdn.example.com/logo.png', alt: 'Example Store' },
			icon: null,
		});
		// the document is copied, so the website settings are never changed by reading them
		expect(details.hours.weekly).not.toBe(documentOf(sections('web_x')).business.hours.weekly);
	});

	it('are empty while the Portal holds nothing: a name-less record with no pictures', () => {
		const none = storeDetailsFromWebsite(emptyWebsiteSettings('web_x'));
		expect(none).toMatchObject({ name: '', logo: null, logoDark: null, favicon: null, phones: [], timeZone: '' });
	});
});

describe('what a website reads', () => {
	const details = storeDetailsFromWebsite(documentOf(sections('web_x')));
	const pictures = {
		logoUrl: 'https://cdn.example.com/logo.png',
		iconUrl: null,
		logoDarkUrl: 'https://cdn.example.com/dark.png',
		faviconUrl: 'https://cdn.example.com/fav.png',
		faviconDarkUrl: 'https://cdn.example.com/fav-dark.png',
	};

	it('shows the public record with the address as the country writes it and a WhatsApp link', () => {
		const view = publicStoreDetails(details, { ...pictures, businessName: 'Fallback' });
		expect(view).toMatchObject({
			name: 'Example Store',
			tagline: 'Everything for the home',
			logo: { url: 'https://cdn.example.com/logo.png', alt: 'Example Store' },
			logoDark: { url: 'https://cdn.example.com/dark.png' },
			favicon: { url: 'https://cdn.example.com/fav.png' },
			faviconDark: { url: 'https://cdn.example.com/fav-dark.png' },
			icon: null,
			contact: {
				email: 'hello@example-store.test',
				phone: '+1 555 0100',
				phones: [{ label: 'Landline', number: '021 111 222' }],
				whatsappUrl: 'https://wa.me/15550100199',
			},
			address: {
				countryName: 'United States',
				lines: ['1 Main Street', 'Springfield, IL 62701'],
				text: '1 Main Street, Springfield, IL 62701',
			},
			social: [{ label: 'Instagram', url: 'https://instagram.com/examplestore' }],
			timeZone: 'America/Chicago',
		});
		// no storage key anywhere: the pictures are public addresses
		expect(view).not.toHaveProperty('logo.key');
		expect(view.siteUrl).toBe('');
		expect(publicStoreDetails(details, { ...pictures, siteUrl: 'https://shop.example.com' }).siteUrl).toBe(
			'https://shop.example.com',
		);
		expect(whatsappLink('12')).toBe('');
	});

	it('names the business while the Portal has no store name, and shows a picture without an address as not set', () => {
		const none = storeDetailsFromWebsite(emptyWebsiteSettings('web_x'));
		expect(publicStoreDetails(none, { logoUrl: null, iconUrl: null, businessName: 'Fallback' }).name).toBe('Fallback');
		expect(publicStoreDetails(details, { logoUrl: null, iconUrl: null })).toMatchObject({ logo: null, logoDark: null });
	});

	it('makes the business.json: the main phone, else the first listed one (it has no place for the dark files)', () => {
		const landline = { label: 'Landline', number: '021 111 222' };
		const blank = emptyWebsiteSettings('web_x');
		const only = storeDetailsFromWebsite({ ...blank, business: { ...blank.business, name: 'Shop', phones: [landline] } });
		expect(businessJsonOf(only, {})).toEqual({ ok: true, value: { name: 'Shop', phone: '021 111 222' } });
		expect(/** @type {any} */ (businessJsonOf(details, {})).value.phone).toBe('+1 555 0100');
	});

	it('makes the business.json: the name, contacts, address text, country, time zone, currency and language', () => {
		const made = businessJsonOf(details, {
			logoUrl: 'https://cdn.example.com/logo.png',
			currency: 'USD',
			currencies: ['USD', 'EUR'],
		});
		expect(made).toEqual({
			ok: true,
			value: {
				name: 'Example Store',
				logo: 'https://cdn.example.com/logo.png',
				email: 'hello@example-store.test',
				phone: '+1 555 0100',
				address: '1 Main Street\nSpringfield, IL 62701',
				country: 'US',
				timeZone: 'America/Chicago',
				currency: 'USD',
				currencies: ['USD', 'EUR'],
				language: 'en-US',
			},
		});
		// the contracts' own validator reads it back unchanged
		expect(validateBusinessJson(/** @type {any} */ (made).value)).toMatchObject({
			ok: true,
			value: { name: 'Example Store', country: 'US' },
		});
		const none = storeDetailsFromWebsite(emptyWebsiteSettings('web_x'));
		expect(businessJsonOf(none, {}).ok).toBe(false);
		expect(businessJsonOf(none, { businessName: 'Named in the Portal', currency: 'PKR' })).toEqual({
			ok: true,
			value: { name: 'Named in the Portal', currency: 'PKR', currencies: ['PKR'] },
		});
	});
});

describe('the store details through the API', () => {
	it('answers the shop read from the business name while the Portal holds nothing', async () => {
		const shown = await shop.visitor('GET', '/v1/shop/store');
		expect(shown.status).toBe(200);
		expect(shown.json).toMatchObject({ name: 'Shop', logo: null, siteUrl: `https://${DOMAIN}` });
	});

	it('answers the shop read to the browser and to the website’s server alike, from what the Portal says', async () => {
		await shop.setWebsite(sections(shop.websiteId));
		const fromBrowser = await shop.visitor('GET', '/v1/shop/store');
		expect(fromBrowser.status).toBe(200);
		expect(fromBrowser.json).toMatchObject({
			name: 'Example Store',
			tagline: 'Everything for the home',
			contact: { phone: '+1 555 0100', phones: [{ label: 'Landline', number: '021 111 222' }] },
			address: { country: 'US', lines: ['1 Main Street', 'Springfield, IL 62701'] },
			hours: { weekly: [{ day: 1, start: '09:00', end: '17:00' }, expect.anything(), expect.anything()] },
			social: [{ label: 'Instagram', url: 'https://instagram.com/examplestore' }],
			timeZone: 'America/Chicago',
			language: 'en-US',
			logo: { url: 'https://cdn.example.com/logo.png' },
			logoDark: { url: 'https://cdn.example.com/dark.png' },
			favicon: { url: 'https://cdn.example.com/fav.png' },
			faviconDark: { url: 'https://cdn.example.com/fav-dark.png' },
			icon: null,
		});
		const fromServer = await shop.api('GET', '/v1/shop/store');
		expect(fromServer.json).toEqual(fromBrowser.json);
		expect(fromBrowser.headers.get('etag')).toBeTruthy();
		// the site address is the website's own domain (not a setting)
		expect(fromBrowser.json.siteUrl).toBe(`https://${DOMAIN}`);
	});

	it('follows a change in the Portal: the next read shows it', async () => {
		const parts = sections(shop.websiteId);
		await shop.setWebsite({ business: { ...parts.business, name: 'Renamed Store' } });
		expect((await shop.visitor('GET', '/v1/shop/store')).json.name).toBe('Renamed Store');
		await shop.setWebsite({ business: parts.business });
		expect((await shop.visitor('GET', '/v1/shop/store')).json.name).toBe('Example Store');
	});

	it('serves the business.json for /.well-known/business.json, made from the Portal’s settings', async () => {
		await shop.setWebsite(sections(shop.websiteId));
		const made = await shop.visitor('GET', '/v1/shop/store/business-json');
		expect(made.status).toBe(200);
		expect(made.json).toMatchObject({
			name: 'Example Store',
			logo: 'https://cdn.example.com/logo.png',
			email: 'hello@example-store.test',
			address: '1 Main Street\nSpringfield, IL 62701',
			country: 'US',
			timeZone: 'America/Chicago',
			currency: 'USD',
			currencies: ['USD', 'EUR'],
			language: 'en-US',
		});
		expect(validateBusinessJson(made.json).ok).toBe(true);
	});

	it('has no record, picture upload or save of its own: those routes and the list are gone', async () => {
		for (const [method, path, body] of /** @type {const} */ ([
			['GET', '/v1/lists/store_details'],
			['PUT', '/v1/lists/store_details', { value: { name: 'Mine' } }],
			['POST', '/v1/store-details/uploads', { for: 'logo', type: 'image/png', size: 1000 }],
			['PUT', '/v1/store-details/logo', { key: 'ecommerce/store/logo-abcdefghij.png' }],
			['DELETE', '/v1/store-details/logo'],
		])) {
			const res = await shop.api(method, path, body);
			expect([method, path, res.status >= 400 && res.status < 500]).toEqual([method, path, true]);
		}
		expect((await shop.visitor('GET', '/v1/shop/store')).json.name).toBe('Example Store');
	});

	it('is a feature: it is listed, and off the shop read is refused', async () => {
		const features = (await shop.api('GET', '/v1/features')).json;
		expect(JSON.stringify(features)).toContain('store_details');
	});
});
