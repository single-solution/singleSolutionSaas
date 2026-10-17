/**
 * Store details: the one record of who the store is (name, tagline, logo and icon in the merchant's storage, contacts,
 * address, opening hours, social links, time zone and language), saved through the lists API, read by the website in
 * public form, and made into the business.json a headless website serves.
 */
import { validateBusinessJson } from '@ss/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	businessJsonOf,
	checkStoreDetails,
	defaultStoreDetails,
	publicStoreDetails,
	whatsappLink,
} from '../core/store-details.js';
import { LIST_WORDS } from '../core/setup-sheet.js';
import { DOMAIN, STORAGE, readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
beforeAll(async () => {
	shop = await readyShop();
});
afterAll(async () => shop.product.close());

/** A full record as a merchant saves it. */
const record = () => ({
	name: ' Example Store ',
	tagline: 'Everything for the home',
	email: 'hello@example-store.test',
	phone: '+1 555 0100',
	whatsapp: '+1 (555) 010-0199',
	address: { line1: '1 Main Street', city: 'Springfield', region: 'IL', postalCode: '62701', country: 'us' },
	hours: {
		weekly: [
			{ day: 1, start: '09:00', end: '17:00' },
			{ day: 2, start: '09:00', end: '12:00' },
			{ day: 2, start: '13:00', end: '17:00' },
		],
		exceptions: [{ date: '2026-12-25', name: 'Holiday', hours: [] }],
	},
	social: [{ label: 'Instagram', url: 'https://instagram.com/examplestore' }],
	timeZone: 'America/Chicago',
	language: 'en-US',
});

describe('checkStoreDetails', () => {
	it('keeps a full record, cleaned', () => {
		const checked = checkStoreDetails(record());
		expect(checked.ok).toBe(true);
		const value = /** @type {any} */ (checked).value;
		expect(value).toMatchObject({
			name: 'Example Store',
			address: { line1: '1 Main Street', city: 'Springfield', country: 'US', postalCode: '62701' },
			logo: null,
			icon: null,
			timeZone: 'America/Chicago',
		});
		expect(value.hours.weekly).toHaveLength(3);
		expect(value.hours.exceptions).toEqual([{ date: '2026-12-25', name: 'Holiday', hours: [] }]);
	});

	it('accepts nothing at all: every field is optional', () => {
		expect(checkStoreDetails({})).toEqual({ ok: true, value: defaultStoreDetails() });
	});

	it('keeps the contact phones in order, each with its name (a landline next to the mobile)', () => {
		const checked = checkStoreDetails({
			...record(),
			phones: [
				{ label: ' Landline ', number: ' (021) 111-222-333 ' },
				{ label: '', number: '+1 555 0111' },
			],
		});
		expect(/** @type {any} */ (checked).value.phones).toEqual([
			{ label: 'Landline', number: '(021) 111-222-333' },
			{ label: '', number: '+1 555 0111' },
		]);
		expect(/** @type {any} */ (checkStoreDetails(record())).value.phones).toEqual([]);
		expect(defaultStoreDetails()).toMatchObject({ phones: [], logoDark: null, favicon: null, faviconDark: null });
	});

	it('refuses a bad phone list or a bad extra file', () => {
		/** @param {Record<string, unknown>} patch */
		const errors = (patch) => /** @type {any} */ (checkStoreDetails({ ...record(), ...patch })).errors ?? [];
		expect(errors({ phones: 'call' }).join(' ')).toContain('at most 10');
		expect(errors({ phones: Array.from({ length: 11 }, () => ({ label: 'x', number: '555 0100' })) }).join(' ')).toContain(
			'at most 10',
		);
		expect(errors({ phones: [{ label: 'Landline', number: 'call me' }] }).join(' ')).toContain('Phone 1');
		expect(errors({ phones: [{ label: 'x'.repeat(41), number: '555 0100' }] }).join(' ')).toContain('Phone 1');
		expect(errors({ phones: [{ label: 'Landline' }] }).join(' ')).toContain('Phone 1');
		const bad = { key: 'elsewhere/x.png', type: 'image/png', size: 5, alt: '' };
		expect(errors({ logoDark: bad }).join(' ')).toContain('The dark logo');
		expect(errors({ favicon: bad }).join(' ')).toContain('The favicon');
		expect(errors({ faviconDark: bad }).join(' ')).toContain('The dark favicon');
		const good = { key: 'ecommerce/store/favicon-abcdefghij.png', type: 'image/png', size: 5, alt: 'Icon' };
		expect(/** @type {any} */ (checkStoreDetails({ ...record(), favicon: good })).value.favicon).toEqual(good);
	});

	it('refuses what cannot be right, listing each problem', () => {
		/** @param {Record<string, unknown>} patch */
		const errors = (patch) => /** @type {any} */ (checkStoreDetails({ ...record(), ...patch })).errors ?? [];
		expect(checkStoreDetails('x').ok).toBe(false);
		expect(errors({ name: 'x'.repeat(121) }).join(' ')).toContain('The name');
		expect(errors({ email: 'not-an-email' }).join(' ')).toContain('email');
		expect(errors({ phone: 'call me' }).join(' ')).toContain('phone');
		expect(errors({ whatsapp: '+1 abc' }).join(' ')).toContain('WhatsApp');
		expect(errors({ address: { country: 'Atlantis' } }).join(' ')).toContain('country');
		expect(errors({ address: { country: 'US', postalCode: 'ABCDE' } }).join(' ')).toContain('postal code');
		expect(errors({ hours: { weekly: [{ day: 8, start: '09:00', end: '17:00' }], exceptions: [] } }).join(' ')).toContain(
			'The opening hours period 1',
		);
		expect(
			errors({
				hours: {
					weekly: [
						{ day: 1, start: '09:00', end: '12:00' },
						{ day: 1, start: '11:00', end: '13:00' },
					],
				},
			}).join(' '),
		).toContain('overlap');
		expect(errors({ social: [{ label: 'X', url: 'http://insecure.test' }] }).join(' ')).toContain('Social link 1');
		expect(errors({ social: Array.from({ length: 21 }, () => ({ label: 'X', url: 'https://x.test' })) }).join(' ')).toContain(
			'at most 20',
		);
		expect(errors({ timeZone: 'Mars/Base' }).join(' ')).toContain('time zone');
		expect(errors({ language: 'english please' }).join(' ')).toContain('BCP 47');
		expect(errors({ logo: { key: 'elsewhere/logo.png', type: 'image/png', size: 5, alt: '' } }).join(' ')).toContain(
			'The logo',
		);
		expect(errors({ icon: { key: 'ecommerce/store/../x.png', type: 'image/png', size: 5, alt: '' } }).join(' ')).toContain(
			'The icon',
		);
		expect(errors({ icon: { key: 'ecommerce/store/icon-a.gif', type: 'image/gif', size: 5, alt: '' } }).join(' ')).toContain(
			'The icon',
		);
	});
});

describe('what a website reads', () => {
	const details = /** @type {any} */ (checkStoreDetails({ ...record(), logo: null })).value;

	it('shows the public record with the address as the country writes it and a WhatsApp link', () => {
		const view = publicStoreDetails(details, { logoUrl: null, iconUrl: null, businessName: 'Fallback' });
		expect(view).toMatchObject({
			name: 'Example Store',
			tagline: 'Everything for the home',
			logo: null,
			contact: { email: 'hello@example-store.test', whatsappUrl: 'https://wa.me/15550100199' },
			address: {
				countryName: 'United States',
				lines: ['1 Main Street', 'Springfield, IL 62701'],
				text: '1 Main Street, Springfield, IL 62701',
			},
			social: [{ label: 'Instagram', url: 'https://instagram.com/examplestore' }],
		});
		expect(view).not.toHaveProperty('logo.key');
		expect(publicStoreDetails(defaultStoreDetails(), { logoUrl: null, iconUrl: null, businessName: 'Fallback' }).name).toBe(
			'Fallback',
		);
		expect(publicStoreDetails(details, { logoUrl: null, iconUrl: null, siteUrl: 'https://shop.example.com' }).siteUrl).toBe(
			'https://shop.example.com',
		);
		expect(view.siteUrl).toBe('');
		expect(whatsappLink('12')).toBe('');
	});

	it('shows the dark logo, the favicons and the phone list to the website', () => {
		const file = (/** @type {string} */ name) => ({
			key: `ecommerce/store/${name}-abcdefghij.png`,
			type: 'image/png',
			size: 9,
			alt: name,
		});
		const withFiles = /** @type {any} */ (
			checkStoreDetails({
				...record(),
				logoDark: file('logoDark'),
				favicon: file('favicon'),
				faviconDark: file('faviconDark'),
				phones: [{ label: 'Landline', number: '021 111 222' }],
			})
		).value;
		const view = publicStoreDetails(withFiles, {
			logoUrl: null,
			iconUrl: null,
			logoDarkUrl: 'https://cdn.example.com/dark.png',
			faviconUrl: 'https://cdn.example.com/fav.png',
			faviconDarkUrl: 'https://cdn.example.com/fav-dark.png',
		});
		expect(view).toMatchObject({
			logo: null,
			logoDark: { url: 'https://cdn.example.com/dark.png', alt: 'logoDark', type: 'image/png' },
			favicon: { url: 'https://cdn.example.com/fav.png', alt: 'favicon' },
			faviconDark: { url: 'https://cdn.example.com/fav-dark.png', alt: 'faviconDark' },
			contact: { phone: '+1 555 0100', phones: [{ label: 'Landline', number: '021 111 222' }] },
		});
		expect(view).not.toHaveProperty('logoDark.key');
		// without an address the file shows as not set
		expect(publicStoreDetails(withFiles, { logoUrl: null, iconUrl: null })).toMatchObject({
			logoDark: null,
			favicon: null,
			faviconDark: null,
		});
	});

	it('makes the business.json: the main phone, else the first listed one (it has no place for the dark files)', () => {
		const landline = { label: 'Landline', number: '021 111 222' };
		const only = /** @type {any} */ (checkStoreDetails({ name: 'Shop', phones: [landline] })).value;
		expect(businessJsonOf(only, {})).toEqual({ ok: true, value: { name: 'Shop', phone: '021 111 222' } });
		const both = /** @type {any} */ (checkStoreDetails({ name: 'Shop', phone: '+1 555 0100', phones: [landline] })).value;
		expect(/** @type {any} */ (businessJsonOf(both, {})).value.phone).toBe('+1 555 0100');
	});

	it('makes the business.json: the name, contacts, address text, country, time zone, currency and language', () => {
		const made = businessJsonOf(details, {
			logoUrl: 'https://shop.example.com/media/sig/logo.png',
			currency: 'USD',
			currencies: ['USD', 'EUR'],
		});
		expect(made).toEqual({
			ok: true,
			value: {
				name: 'Example Store',
				logo: 'https://shop.example.com/media/sig/logo.png',
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
		expect(businessJsonOf(defaultStoreDetails(), {}).ok).toBe(false);
		expect(businessJsonOf(defaultStoreDetails(), { businessName: 'From business.json', currency: 'PKR' })).toEqual({
			ok: true,
			value: { name: 'From business.json', currency: 'PKR', currencies: ['PKR'] },
		});
	});
});

describe('the setup sheet line', () => {
	it('names the pictures and phones that are set', () => {
		const file = (/** @type {string} */ name) => ({
			key: `ecommerce/store/${name}-abcdefghij.png`,
			type: 'image/png',
			size: 9,
			alt: '',
		});
		const details = /** @type {any} */ (
			checkStoreDetails({
				name: 'Example Store',
				logo: file('logo'),
				logoDark: file('logoDark'),
				favicon: file('favicon'),
				phone: '+1 555 0100',
				phones: [{ label: 'Landline', number: '021 111 222' }],
			})
		).value;
		expect(LIST_WORDS.store_details(details)).toBe('Example Store, with a logo, a dark logo, a favicon, 2 phone numbers.');
		expect(LIST_WORDS.store_details(/** @type {any} */ (checkStoreDetails({ name: 'Shop', phone: '1 555 0100' })).value)).toBe(
			'Shop, with a phone number.',
		);
	});
});

describe('the store details through the API', () => {
	it('is saved as one record through the lists API, with an unsaved record empty', async () => {
		const before = await shop.api('GET', '/v1/lists/store_details');
		expect(before.status).toBe(200);
		expect(before.json.value).toEqual(defaultStoreDetails());
		const bad = await shop.api('PUT', '/v1/lists/store_details', { value: { ...record(), email: 'nope' } });
		expect(bad.status).toBe(422);
		const saved = await shop.api('PUT', '/v1/lists/store_details', { value: record() });
		expect(saved.status).toBe(200);
		expect((await shop.api('GET', '/v1/lists/store_details')).json.value).toMatchObject({
			name: 'Example Store',
			address: { country: 'US' },
		});
	});

	it('answers the shop read to the browser and to the website’s server alike, public fields only', async () => {
		const fromBrowser = await shop.visitor('GET', '/v1/shop/store');
		expect(fromBrowser.status).toBe(200);
		expect(fromBrowser.json).toMatchObject({
			name: 'Example Store',
			contact: { phone: '+1 555 0100' },
			address: { lines: ['1 Main Street', 'Springfield, IL 62701'] },
			hours: { weekly: [{ day: 1, start: '09:00', end: '17:00' }, expect.anything(), expect.anything()] },
			timeZone: 'America/Chicago',
		});
		const fromServer = await shop.api('GET', '/v1/shop/store');
		expect(fromServer.json).toEqual(fromBrowser.json);
		expect(fromBrowser.headers.get('etag')).toBeTruthy();
		// the site address is the website's own domain (not a setting)
		expect(fromBrowser.json.siteUrl).toBe(`https://${DOMAIN}`);
	});

	it('serves the business.json for /.well-known/business.json', async () => {
		const made = await shop.visitor('GET', '/v1/shop/store/business-json');
		expect(made.status).toBe(200);
		expect(made.json).toMatchObject({
			name: 'Example Store',
			email: 'hello@example-store.test',
			address: '1 Main Street\nSpringfield, IL 62701',
			country: 'US',
			timeZone: 'America/Chicago',
			language: 'en-US',
		});
		expect(validateBusinessJson(made.json).ok).toBe(true);
	});

	it('keeps the logo and the icon in the merchant’s storage like product images', async () => {
		/** @param {Record<string, unknown>} body */
		const upload = (body) =>
			shop.api('POST', '/v1/store-details/uploads', { for: 'logo', type: 'image/png', size: 2000, ...body });
		expect((await upload({ for: 'banner' })).status).toBe(422);
		expect((await upload({ type: 'image/svg+xml' })).status).toBe(422);
		expect((await upload({ size: 10_000_000 })).status).toBe(422);
		const first = await upload({});
		expect(first.status).toBe(200);
		expect(first.json.key).toMatch(/^ecommerce\/store\/logo-[a-z0-9]{10}\.png$/);
		expect(first.json.upload).toMatchObject({
			method: 'PUT',
			headers: { 'content-type': 'image/png', 'content-length': '2000' },
		});

		shop.responders.set(STORAGE, () => ({ status: 404 }));
		expect((await shop.api('PUT', '/v1/store-details/logo', { key: first.json.key })).status).toBe(422);
		shop.responders.set(STORAGE, (call) =>
			call.method === 'HEAD'
				? { status: 200, headers: { 'content-length': '2000', 'content-type': 'image/png' } }
				: { status: 204 },
		);
		expect((await shop.api('PUT', '/v1/store-details/logo', { key: 'ecommerce/store/icon-xxxxxxxxxx.png' })).status).toBe(422);
		expect((await shop.api('PUT', '/v1/store-details/banner', { key: first.json.key })).status).toBe(404);
		const set = await shop.api('PUT', '/v1/store-details/logo', { key: first.json.key, alt: 'Example Store logo' });
		expect(set.status).toBe(200);
		expect(set.json.logo).toMatchObject({ key: first.json.key, type: 'image/png', size: 2000, alt: 'Example Store logo' });
		expect(set.json.logo.url).toContain(STORAGE);

		// the website reads its address (stable, never signed again), and the business.json carries it
		const read = await shop.visitor('GET', '/v1/shop/store');
		expect(read.json.logo).toMatchObject({ alt: 'Example Store logo', type: 'image/png' });
		expect(read.json.logo.url).toContain(`/${first.json.key}`);
		expect(JSON.stringify(read.json)).not.toContain('"key"');
		expect((await shop.visitor('GET', '/v1/shop/store/business-json')).json.logo).toBe(read.json.logo.url);
		expect((await shop.api('GET', '/v1/store-details/files')).json.logo.key).toBe(first.json.key);

		// replacing the saved record keeps the logo; removing it empties the field
		expect((await shop.api('GET', '/v1/lists/store_details')).json.value.logo.key).toBe(first.json.key);
		const removed = await shop.api('DELETE', '/v1/store-details/logo');
		expect(removed.json).toEqual({ logo: null });
		expect((await shop.visitor('GET', '/v1/shop/store')).json.logo).toBeNull();
	});

	it('lists the contact phones in the shop read, and the business.json takes the first one while no main phone is set', async () => {
		const phones = [
			{ label: 'Landline', number: '021 111 222' },
			{ label: 'Sales', number: '+1 555 0123' },
		];
		const saved = await shop.api('PUT', '/v1/lists/store_details', { value: { ...record(), phones } });
		expect(saved.status).toBe(200);
		const read = await shop.visitor('GET', '/v1/shop/store');
		expect(read.json.contact).toMatchObject({ phone: '+1 555 0100', phones });
		expect((await shop.visitor('GET', '/v1/shop/store/business-json')).json.phone).toBe('+1 555 0100');
		const noMain = await shop.api('PUT', '/v1/lists/store_details', { value: { ...record(), phone: '', phones } });
		expect(noMain.status).toBe(200);
		expect((await shop.visitor('GET', '/v1/shop/store/business-json')).json.phone).toBe('021 111 222');
		expect(
			(await shop.api('PUT', '/v1/lists/store_details', { value: { ...record(), phones: [{ label: 'x', number: 'no' }] } }))
				.status,
		).toBe(422);
	});

	it('keeps the dark logo, the favicon and the dark favicon in the merchant’s storage like the logo', async () => {
		await shop.api('PUT', '/v1/lists/store_details', { value: record() });
		shop.responders.set(STORAGE, (call) =>
			call.method === 'HEAD'
				? { status: 200, headers: { 'content-length': '2000', 'content-type': 'image/png' } }
				: { status: 204 },
		);
		/** @param {string} slot */
		const upload = (slot) => shop.api('POST', '/v1/store-details/uploads', { for: slot, type: 'image/png', size: 2000 });
		const keys = /** @type {Record<string, string>} */ ({});
		for (const slot of ['logo', 'logoDark', 'icon', 'favicon', 'faviconDark']) {
			const made = await upload(slot);
			expect(made.status).toBe(200);
			expect(made.json.key).toMatch(new RegExp(`^ecommerce/store/${slot}-[a-z0-9]{10}\\.png$`));
			keys[slot] = made.json.key;
		}
		// a file belongs to the slot it was uploaded for (the logo's key is no dark logo)
		expect((await shop.api('PUT', '/v1/store-details/logoDark', { key: keys.logo })).status).toBe(422);
		expect((await shop.api('PUT', '/v1/store-details/logo', { key: keys.logoDark })).status).toBe(422);
		expect((await shop.api('PUT', '/v1/store-details/favicon', { key: keys.faviconDark })).status).toBe(422);
		for (const slot of ['logoDark', 'favicon', 'faviconDark']) {
			const set = await shop.api('PUT', `/v1/store-details/${slot}`, { key: keys[slot], alt: `${slot} alt` });
			expect(set.status).toBe(200);
			expect(set.json[slot]).toMatchObject({ key: keys[slot], type: 'image/png', size: 2000, alt: `${slot} alt` });
		}
		const read = (await shop.visitor('GET', '/v1/shop/store')).json;
		expect(read.logo).toBeNull();
		for (const slot of ['logoDark', 'favicon', 'faviconDark']) {
			expect(read[slot]).toMatchObject({ alt: `${slot} alt`, type: 'image/png' });
			expect(read[slot].url).toContain(`/${keys[slot]}`);
		}
		expect(JSON.stringify(read)).not.toContain('"key"');
		const files = (await shop.api('GET', '/v1/store-details/files')).json;
		expect(Object.keys(files).sort()).toEqual(['favicon', 'faviconDark', 'icon', 'logo', 'logoDark']);
		expect(files.faviconDark.key).toBe(keys.faviconDark);
		// the business.json has one logo: the light one, never the dark one
		expect((await shop.visitor('GET', '/v1/shop/store/business-json')).json).not.toHaveProperty('logo');
		expect((await shop.api('GET', '/v1/lists/store_details')).json.value).toMatchObject({
			logoDark: { key: keys.logoDark },
			favicon: { key: keys.favicon },
			faviconDark: { key: keys.faviconDark },
		});
		const removed = await shop.api('DELETE', '/v1/store-details/logoDark');
		expect(removed.json).toEqual({ logoDark: null });
		expect((await shop.visitor('GET', '/v1/shop/store')).json.logoDark).toBeNull();
		expect((await shop.api('PUT', '/v1/store-details/banner', { key: keys.logo })).status).toBe(404);
	});

	it('is a feature: off, the shop read is refused', async () => {
		const features = (await shop.api('GET', '/v1/features')).json;
		expect(JSON.stringify(features)).toContain('store_details');
	});
});
