/**
 * Store details with the Portal holding the website's settings (settings-ownership design, step 4): the record is the
 * Portal's Business and Brand sections, read only; the shop read, the business.json and the lists API answer from it;
 * a save, a picture upload or removal is 409 managed_by_portal (also for the website's server with a staff sign-in);
 * until the Portal holds settings the merchant's own record is still saved and read as before.
 */
import { validateBusinessJson } from '@ss/contracts';
import { emptyWebsiteSettings } from '@ss/contracts/website-settings';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOMAIN, readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
beforeAll(async () => {
	shop = await readyShop();
});
afterAll(async () => shop.product.close());

/** What the merchant saved in the Portal. @param {string} websiteId */
const sections = (websiteId) => {
	const empty = emptyWebsiteSettings(websiteId);
	return {
		business: {
			...empty.business,
			name: 'Portal Store',
			tagline: 'Set once',
			email: 'hello@portal-store.test',
			phone: '+1 555 0100',
			phones: [{ label: 'Landline', number: '021 111 222' }],
			whatsapp: '+1 555 0199',
			address: {
				...empty.business.address,
				line1: '1 Main Street',
				city: 'Springfield',
				region: 'IL',
				postalCode: '62701',
				country: 'US',
			},
			hours: {
				weekly: [{ day: 1, start: '09:00', end: '17:00' }],
				exceptions: [{ date: '2026-12-25', name: 'Holiday', hours: [] }],
			},
			social: [{ label: 'Instagram', url: 'https://instagram.com/portalstore' }],
		},
		brand: {
			...empty.brand,
			files: { ...empty.brand.files, logo: 'https://cdn.example.com/logo.png', favicon: 'https://cdn.example.com/fav.png' },
		},
		region: {
			...empty.region,
			country: 'US',
			timeZone: 'America/Chicago',
			currency: 'USD',
			currencies: ['USD'],
			language: 'en-US',
			languages: ['en-US'],
		},
	};
};

/** The Portal saves settings and tells the shop. */
const saveInPortal = async () => {
	shop.portal.setWebsiteSettings(shop.websiteId, sections(shop.websiteId));
	await shop.portal.sendNotice('ecommerce', { type: 'website.settings_changed', websiteId: shop.websiteId, what: 'settings' });
	await shop.flush();
};

describe('before the Portal holds settings', () => {
	it('the merchant’s own record is saved and read as before', async () => {
		const saved = await shop.api('PUT', '/v1/lists/store_details', { value: { name: 'Own Store', email: 'own@store.test' } });
		expect(saved.status).toBe(200);
		const shown = await shop.visitor('GET', '/v1/shop/store');
		expect(shown.json).toMatchObject({ name: 'Own Store', contact: { email: 'own@store.test' } });
		expect((await shop.api('GET', '/v1/lists/store_details')).json.value).not.toHaveProperty('portal');
	});
});

describe('once the Portal holds settings', () => {
	it('the shop read, the lists API and the business.json answer from the Portal’s facts and pictures', async () => {
		await saveInPortal();
		const shown = await shop.visitor('GET', '/v1/shop/store');
		expect(shown.status).toBe(200);
		expect(shown.json).toMatchObject({
			name: 'Portal Store',
			tagline: 'Set once',
			contact: {
				email: 'hello@portal-store.test',
				phone: '+1 555 0100',
				phones: [{ label: 'Landline', number: '021 111 222' }],
			},
			address: { country: 'US', lines: ['1 Main Street', 'Springfield, IL 62701'] },
			hours: { weekly: [{ day: 1, start: '09:00', end: '17:00' }] },
			social: [{ label: 'Instagram', url: 'https://instagram.com/portalstore' }],
			timeZone: 'America/Chicago',
			language: 'en-US',
			logo: { url: 'https://cdn.example.com/logo.png' },
			favicon: { url: 'https://cdn.example.com/fav.png' },
			logoDark: null,
			siteUrl: `https://${DOMAIN}`,
		});
		// the merchant’s server reads the same record, marked as the Portal’s
		const list = await shop.api('GET', '/v1/lists/store_details');
		expect(list.json.value).toMatchObject({ portal: true, name: 'Portal Store', timeZone: 'America/Chicago' });
		// the business.json a headless website serves: the Portal’s facts with the shop currency
		const made = await shop.visitor('GET', '/v1/shop/store/business-json');
		expect(made.status).toBe(200);
		expect(made.json).toMatchObject({
			name: 'Portal Store',
			logo: 'https://cdn.example.com/logo.png',
			email: 'hello@portal-store.test',
			country: 'US',
			timeZone: 'America/Chicago',
			language: 'en-US',
		});
		expect(validateBusinessJson(made.json).ok).toBe(true);
	});

	it('a save of the record, a picture upload and a picture removal are 409 managed_by_portal, also with a staff sign-in', async () => {
		await saveInPortal();
		/** @param {{ status: number, json: any }} res */
		const refusal = (res) => [
			res.status,
			String(res.json?.type ?? '')
				.split('/')
				.pop(),
		];
		expect(refusal(await shop.api('PUT', '/v1/lists/store_details', { value: { name: 'Mine' } }))).toEqual([
			409,
			'managed_by_portal',
		]);
		expect(
			refusal(await shop.api('POST', '/v1/store-details/uploads', { for: 'logo', type: 'image/png', size: 1000 })),
		).toEqual([409, 'managed_by_portal']);
		expect(refusal(await shop.api('PUT', '/v1/store-details/logo', { key: 'ecommerce/store/logo-abcdefghij.png' }))).toEqual([
			409,
			'managed_by_portal',
		]);
		expect(refusal(await shop.api('DELETE', '/v1/store-details/logo'))).toEqual([409, 'managed_by_portal']);
		// the merchant’s dashboard (the editor’s twin routes) is refused the same way
		const cookie = await shop.adminSession();
		const base = `/v1/dashboard/websites/${shop.websiteId}`;
		expect(refusal(await shop.dashboard(cookie, 'PUT', `${base}/lists/store_details`, { value: { name: 'Mine' } }))).toEqual([
			409,
			'managed_by_portal',
		]);
		expect(
			refusal(
				await shop.dashboard(cookie, 'POST', `${base}/store-details/uploads`, { for: 'logo', type: 'image/png', size: 1000 }),
			),
		).toEqual([409, 'managed_by_portal']);
		// nothing changed
		expect((await shop.visitor('GET', '/v1/shop/store')).json.name).toBe('Portal Store');
	});

	it('the pictures list shows the Portal’s addresses', async () => {
		await saveInPortal();
		const cookie = await shop.adminSession();
		const files = await shop.dashboard(cookie, 'GET', `/v1/dashboard/websites/${shop.websiteId}/store-details/files`);
		expect(files.status).toBe(200);
		expect(files.json).toMatchObject({
			logo: { url: 'https://cdn.example.com/logo.png' },
			favicon: { url: 'https://cdn.example.com/fav.png' },
			icon: null,
		});
	});
});
