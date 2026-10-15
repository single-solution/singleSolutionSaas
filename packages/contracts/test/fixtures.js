/**
 * Fixtures only the contracts' own tests use. Each call returns a new object so tests may mutate freely.
 * @module
 */

export const WEBSITE = 'web_0123456789abcdefghjkmnpq';
export const MERCHANT = 'mer_0123456789abcdefghjkmnpq';

/** @returns {import('../src/types.js').PriceList} */
export const priceReport = () => ({
	version: 2,
	features: [
		{ key: 'notes', name: 'Notes', description: 'Visitors leave short notes.', dependsOn: [], millicreditsPerHour: 1500 },
		{
			key: 'inbox',
			name: 'Notes inbox',
			description: 'Staff read the notes in their own admin.',
			dependsOn: ['notes'],
			millicreditsPerHour: 0,
		},
	],
});

/** @returns {import('../src/types.js').StatusResponse} */
export const statusResponse = () => ({
	websiteId: WEBSITE,
	merchantId: MERCHANT,
	merchantName: 'Example Shop',
	domain: 'shop.example.com',
	status: 'active',
	graceEndsAt: null,
	todayMillicredits: 36_000,
	featuresVersion: 3,
	validUntil: '2026-10-01T00:05:00Z',
});

/** @returns {Record<string, unknown>} */
export const businessJson = () => ({
	name: 'Example Shop',
	logo: 'https://shop.example.com/logo.png',
	email: 'hello@shop.example.com',
	phone: '+1 555 0100',
	address: '1 Example Street\nExample City',
	country: 'us',
	timeZone: 'America/New_York',
});
