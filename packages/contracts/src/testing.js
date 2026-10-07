/**
 * `@ss/contracts/testing` — fresh, valid fixtures. Each call returns a new object so tests may mutate freely.
 * @module
 */

export const WEBSITE = 'web_0123456789abcdefghjkmnpq';
export const MERCHANT = 'mer_0123456789abcdefghjkmnpq';

/**
 * A valid manifest of a sample product `notes`: two features (`inbox` depends on `notes`), one ticket permission, a
 * visitor widget and an admin widget.
 * @returns {import('./types.js').Manifest}
 */
export const manifest = () => ({
	id: 'notes',
	name: 'Notes',
	version: '1.0.0',
	endpoints: { base: 'https://notes.example.dev', dashboard: '/dashboard' },
	widgetScriptUrl: 'https://notes.example.dev/widget.js',
	docsUrl: '/docs',
	features: [
		{
			key: 'notes',
			name: 'Notes',
			description: 'Visitors leave short notes.',
			dependsOn: [],
			settings: {
				type: 'object',
				additionalProperties: false,
				properties: {
					maxNotes: {
						type: 'integer',
						title: 'Notes per visitor per day',
						default: 5,
						minimum: 1,
						maximum: 50,
						'x-ui': { group: 'Limits' },
					},
					greeting: { type: 'string', title: 'Greeting', default: 'Leave us a note', maxLength: 200 },
				},
			},
		},
		{
			key: 'inbox',
			name: 'Notes inbox',
			description: 'Staff read the notes in their own admin.',
			dependsOn: ['notes'],
			settings: {
				type: 'object',
				properties: {
					sort: { type: 'string', title: 'Sort order', default: 'newest', enum: ['newest', 'oldest'] },
					labels: { type: 'array', title: 'Labels', default: [], items: { type: 'string', maxLength: 40 } },
				},
			},
		},
	],
	permissions: [{ key: 'notes.read', name: 'Read notes', feature: 'inbox' }],
	widgets: [
		{ key: 'note_form', feature: 'notes', kind: 'visitor' },
		{ key: 'inbox', feature: 'inbox', kind: 'admin' },
	],
});

/** @returns {import('./types.js').PriceList} */
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

/** @returns {import('./types.js').StatusResponse} */
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
	timeZone: 'Europe/London',
});
