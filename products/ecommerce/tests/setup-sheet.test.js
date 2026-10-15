import { adviseFeatures, validateManifest, validateProductBlueprint } from '@ss/contracts';
import { describe, expect, it } from 'vitest';
import guide from '../docs/guide.json' with { type: 'json' };
import nextConfig from '../next.config.js';
import openapi from '../openapi.json' with { type: 'json' };
import { manifest } from '../adapters/product.js';
import { EVENT_TYPES } from '../core/events.js';
import { LIST_WORDS, setupSummaries } from '../core/setup-sheet.js';
import { ALL, BASE, setup } from './helpers.js';

/** @param {Awaited<ReturnType<typeof setup>>} env */
const partOf = async (env) => {
	const response = await env.portal.callAsPortal('ecommerce', 'GET', `/v1/blueprint?websiteId=${env.websiteId}`);
	const body = await response.json();
	await env.flush();
	return body;
};

/** @param {any} part @param {string} feature */
const listsOf = (part, feature) =>
	part.features
		.find((/** @type {any} */ f) => f.key === feature)
		.lists.map((/** @type {any} */ list) => [list.name, list.summary]);

const build = /** @type {Record<string, string>} */ (guide.build);

describe('the website Setup sheet: tags and what the website builds', () => {
	it('tags features with the business profile answers they suit, and says what the website builds for every one', () => {
		expect(validateManifest(manifest).ok).toBe(true);
		expect(Object.keys(build)).toEqual(manifest.features.map((feature) => feature.key));
		for (const text of Object.values(build)) expect(text.length).toBeLessThanOrEqual(1000);
	});

	it('recommends only what the profile asks for, and flags what does not fit', () => {
		const features = manifest.features.map((feature) => ({
			key: feature.key,
			on: true,
			recommendFor: feature.recommendFor ?? [],
		}));
		// a shop of physical goods that said nothing about coupons, bundles, wishlists, alerts, returns, invoices, tax
		// or courier booking gets none of them
		const advice = adviseFeatures(features, {
			sells: ['physical'],
			pays: ['online', 'cod'],
			delivers: ['courier'],
			signIn: ['email'],
			messages: ['email', 'whatsapp'],
			marketing: ['google', 'seo'],
			offers: ['discounts', 'reviews'],
			taxes: false,
		});
		expect(advice.recommended.map((entry) => entry.feature)).toEqual([
			'catalog',
			'variants',
			'checkout',
			'delivery_zones',
			'deals',
			'reviews',
			'staff_alerts',
			'seo',
			'landing_pages',
			'feeds',
			'llms_txt',
		]);
		expect(advice.recommended.find((entry) => entry.feature === 'seo')?.because).toEqual(['marketing.seo']);
		expect(advice.notRecommended.map((entry) => entry.feature)).toEqual([
			'digital_goods',
			'bookings',
			'courier_apis',
			'taxes',
			'coupons',
			'loyalty',
			'role_pricing',
			'bundles',
			'wishlist',
			'alerts',
			'returns',
			'invoices',
		]);
		expect(advice.notRecommended.find((entry) => entry.feature === 'taxes')?.missing).toEqual(['taxes.yes']);

		// each of them once the profile asks for it
		const asked = adviseFeatures(features, {
			sells: ['physical'],
			delivers: ['courier_api'],
			offers: ['coupons', 'bundles', 'wishlist', 'alerts', 'returns', 'invoices'],
			taxes: true,
		});
		expect(asked.recommended.map((entry) => entry.feature)).toEqual(
			expect.arrayContaining(['courier_apis', 'taxes', 'coupons', 'bundles', 'wishlist', 'alerts', 'returns', 'invoices']),
		);
		expect(asked.recommended.find((entry) => entry.feature === 'courier_apis')?.because).toEqual(['delivers.courier_api']);

		// a services business that takes no deliveries: bookings, not shipping
		const services = adviseFeatures(features, { sells: ['services'], pays: ['online'], delivers: ['none'] });
		expect(services.recommended.map((entry) => entry.feature)).toEqual(['catalog', 'bookings', 'checkout']);
		expect(services.notRecommended.map((entry) => entry.feature)).toEqual([
			'variants',
			'digital_goods',
			'delivery_zones',
			'courier_apis',
			'feeds',
		]);
	});

	it('shows what the website builds in each feature of the docs', async () => {
		const env = await setup();
		const docs = await env.call('GET', '/docs');
		expect(docs.text).toContain(
			'<p><strong>What your website builds.</strong> Serve /llms.txt from your domain with the llms.txt route',
		);
		expect(docs.text.match(/What your website builds\./g)?.length).toBe(manifest.features.length);
	});

	it('reaches the docs and the OpenAPI document through the Next.js rewrites', async () => {
		const rewrites = /** @type {Array<{ source: string, destination: string }>} */ (await nextConfig.rewrites?.());
		expect(rewrites).toEqual(
			expect.arrayContaining([
				{ source: '/docs', destination: '/api/docs' },
				{ source: '/openapi.json', destination: '/api/openapi.json' },
			]),
		);
	});
});

describe('the website Setup sheet: Ecommerce’s part', () => {
	it('answers the OpenAPI document and nothing of its own while every feature is off', async () => {
		const env = await setup();
		const off = await partOf(env);
		expect(validateProductBlueprint(off).ok).toBe(true);
		expect(off.docs).toEqual({ guide: `${BASE}/docs`, openapi: `${BASE}/openapi.json` });
		expect(off.events).toEqual(['ecommerce.settings.changed']);
		expect(off.summaries).toEqual([]);
		expect(off.build).toEqual([]);
		expect(off.features.find((/** @type {any} */ f) => f.key === 'feeds').recommendFor).toEqual([
			'marketing.google+sells.physical',
			'marketing.meta+sells.physical',
		]);
		// the OpenAPI document itself, public
		const served = await env.call('GET', '/openapi.json');
		expect(served.json).toEqual(openapi);
	});

	it('answers its events, its lists in its own words, its pages, what the website serves and the SEO tags', async () => {
		const env = await setup();
		await env.switchOn(ALL);
		await env.list('couriers', [{ key: 'fastship', name: 'FastShip', trackingUrl: 'https://track.example/{tracking}' }]);
		await env.list('delivery_zones', [
			{ key: 'city', name: 'Springfield', match: { cities: ['Springfield'] }, fee: 300, freeOver: 0, minDays: 1, maxDays: 2 },
			{
				key: 'state',
				name: 'Rest of the state',
				match: { cities: ['Shelbyville'] },
				fee: 900,
				freeOver: 0,
				minDays: 2,
				maxDays: 4,
			},
		]);
		await env.list('tax_rules', [
			{ name: 'Sales tax', percent: 8.25, categoryIds: [], regions: [{ country: 'US', city: '' }] },
		]);
		await env.list('grades', [
			{ key: 'a', label: 'Like new', description: 'As new.', condition: 'refurbished' },
			{ key: 'b', label: 'Good', description: 'Light marks.' },
			{ key: 'c', label: 'Fair', description: 'Marks.', active: false, condition: 'used' },
		]);
		await env.list('booking_hours', [
			{ day: 1, from: '13:00', to: '17:30' },
			{ day: 1, from: '09:00', to: '12:00' },
			{ day: 6, from: '10:00', to: '14:00' },
		]);
		await env.list('role_prices', [{ role: 'wholesale', percent: 10, label: 'Trade price' }]);
		await env.list('item_types', [
			{ key: 'used_phone', name: 'Used phone', elements: { grades: true, units: {} } },
			{ key: 'gift_card', name: 'Gift card', kind: 'digital', active: false },
		]);
		await env.setting('catalog', 'variantQuery', 'grade={grade}&{attributes}');
		await env.setting('landing_pages', 'attributeUrl', '/glossary/{slug}');
		await env.setting('alerts', 'stopUrl', '/alerts/stop/{token}');
		await env.setting('llms_txt', 'full', true);

		const on = await partOf(env);
		const checked = validateProductBlueprint(on);
		expect(checked.ok, JSON.stringify(checked.ok ? [] : checked.problems.slice(0, 3))).toBe(true);
		expect(on.events).toEqual(['ecommerce.settings.changed', ...EVENT_TYPES.map((type) => `ecommerce.${type}`)]);
		expect(listsOf(on, 'checkout')).toEqual([
			[
				'order_flow',
				'9 statuses: Awaiting payment, Awaiting confirmation, Confirmed, Packed, Dispatched, Delivered, Canceled, Returned to origin, Refunded; 14 moves; 5 statuses message the shopper.',
			],
			[
				'payment_methods',
				'4 payment methods: Online payment (gateway), Bank transfer (pay_first), Cash on delivery (on_delivery), Pay at pickup (at_pickup).',
			],
			['couriers', '1 courier: FastShip.'],
			[
				'policies',
				'5 policies: Delivery policy (no text), Returns policy (no text), Warranty policy (no text), Privacy policy (no text), Terms and conditions (no text).',
			],
			['address_regions', 'No countries with regions yet.'],
			['customer_segments', '3 customer segments: Loyalty members, Active customers, Guests.'],
		]);
		expect(listsOf(on, 'delivery_zones')).toEqual([['delivery_zones', '2 zones: Springfield, Rest of the state.']]);
		expect(listsOf(on, 'taxes')).toEqual([['tax_rules', '1 tax rule: Sales tax 8.25%.']]);
		expect(listsOf(on, 'grades_serials')).toEqual([
			['grades', '3 grades: Like new (refurbished), Good (used), Fair (used, not offered).'],
			['unit_states', '1 unit state: Faulty.'],
		]);
		expect(listsOf(on, 'bookings')).toEqual([
			['booking_hours', 'Bookable 2 days a week: Mon 9:00 AM–12:00 PM and 1:00 PM–5:30 PM, Sat 10:00 AM–2:00 PM.'],
		]);
		expect(listsOf(on, 'role_pricing')).toEqual([['role_prices', '1 role price: wholesale 10% off.']]);
		expect(listsOf(on, 'catalog')).toEqual([
			['item_types', '2 item types: Used phone (physical, unit numbers), Gift card (digital, not offered).'],
		]);
		expect(on.summaries).toEqual([
			{
				title: 'Pages on your website',
				text: "Product pages at /products/{slug}, category pages at /categories/{slug}, variants at their product's address with ?grade={grade}&{attributes}, landing pages at {categoryUrl}?brand={brand}&{facet}={value}, attribute glossary pages at /glossary/{slug}, a cart page and an orders page (the cart and my_orders widgets), a wishlist page, a compare page, the alert stop page at /alerts/stop/{token}.",
			},
			{
				title: 'Served from your domain',
				text: 'Your server fetches these with the server token, never from the browser, and serves them from your domain: /sitemap.xml (GET /v1/seo/sitemap.xml), /media/<signature>/<file> (GET /v1/media), /feeds/products.xml (GET /v1/feeds/products.xml), /feeds/products.csv (GET /v1/feeds/products.csv), /llms.txt (GET /v1/llms.txt), /llms-full.txt (GET /v1/llms-full.txt), your policy pages (GET /v1/policies).',
			},
			{
				title: 'SEO tags',
				text: 'Each product, category and listing page puts its SEO answer in its head: the title, meta description, canonical link, robots and the JSON-LD script (GET /v1/seo/products/<slug>, /v1/seo/categories/<slug> and /v1/seo/listing), and the home page the business and website data (GET /v1/seo/site); an answer { moved } is a 308 to its url. Page titles follow {name} | {business}.',
			},
		]);
		expect(on.build.map((/** @type {any} */ entry) => entry.feature)).toEqual(ALL);
		expect(on.build.find((/** @type {any} */ entry) => entry.feature === 'seo')).toEqual({
			feature: 'seo',
			what: build.seo,
			docs: `${BASE}/docs#feature-seo`,
		});

		// with a public media address, images need no route of the website; SEO comes with the catalog (baseline SEO),
		// its titles following the defaults while SEO is off (a saved pattern counts once SEO is on)
		await env.setting('catalog', 'mediaBaseUrl', 'https://cdn.shop.example.com');
		await env.setting('seo', 'titleTemplate', '{name} · {business}');
		await env.switchOn(['catalog', 'variants']);
		const few = await partOf(env);
		expect(few.events).toEqual(['ecommerce.settings.changed']);
		expect(few.summaries).toEqual([
			{ title: 'Pages on your website', text: expect.stringMatching(/^Product pages at /) },
			{
				title: 'Served from your domain',
				text: 'Your server fetches these with the server token, never from the browser, and serves them from your domain: /sitemap.xml (GET /v1/seo/sitemap.xml).',
			},
			{ title: 'SEO tags', text: expect.stringMatching(/Page titles follow \{name\} \| \{business\}\.$/) },
		]);
	});

	it('leaves a list that cannot be read to the kit’s own count', async () => {
		const env = await setup({
			store: (store) => ({
				...store,
				get: (collection, id) =>
					String(id).endsWith('|ecommerce|list.couriers')
						? Promise.reject(new Error('read failed'))
						: store.get(collection, id),
			}),
		});
		await env.switchOn(['catalog', 'checkout']);
		const part = await partOf(env);
		expect(listsOf(part, 'checkout')).toEqual([
			['order_flow', expect.stringMatching(/^9 statuses: /)],
			['payment_methods', expect.stringMatching(/^4 payment methods: /)],
			['couriers', 'Not available right now'],
			[
				'policies',
				'5 policies: Delivery policy (no text), Returns policy (no text), Warranty policy (no text), Privacy policy (no text), Terms and conditions (no text).',
			],
			['address_regions', 'No countries with regions yet.'],
			['customer_segments', expect.stringMatching(/^3 customer segments: /)],
		]);
	});
});

describe('Ecommerce’s Setup sheet words', () => {
	it('says when a list is empty, and fits a long list into a summary', () => {
		expect(LIST_WORDS.couriers([])).toBe('No couriers yet.');
		expect(LIST_WORDS.grades([])).toBe('No grades yet.');
		expect(LIST_WORDS.item_types([])).toBe('No item types yet: every item has the built-in type of its kind.');
		expect(LIST_WORDS.booking_hours([])).toBe('No booking hours yet, so no slot can be booked.');
		const zones = Array.from({ length: 40 }, (_, at) => ({ name: `Zone number ${at + 1}` }));
		const text = LIST_WORDS.delivery_zones(zones);
		expect(text.length).toBeLessThanOrEqual(300);
		expect(text).toMatch(/^40 zones: Zone number 1, Zone number 2, .* and \d+ more\.$/);
		// a name longer than a summary is cut
		expect(LIST_WORDS.couriers([{ name: 'X'.repeat(500) }])).toBe(`1 courier: ${'X'.repeat(59)}….`);
		const flow = { statuses: [{ key: 'open', label: 'Open', notify: true }], moves: [] };
		expect(LIST_WORDS.order_flow(/** @type {any} */ (flow))).toBe('1 status: Open; 0 moves; 1 status messages the shopper.');
		expect(LIST_WORDS.order_flow(/** @type {any} */ ({ ...flow, statuses: [{ ...flow.statuses[0], notify: false }] }))).toBe(
			'1 status: Open; 0 moves; no status messages the shopper.',
		);
	});

	it('writes booking times the way the Portal shows them', () => {
		const hours = ['00:00', '00:30', '09:05', '12:00', '23:59'].map((from, day) => ({ day, from, to: '23:59' }));
		expect(LIST_WORDS.booking_hours(hours)).toBe(
			'Bookable 5 days a week: Sun 12:00 AM–11:59 PM, Mon 12:30 AM–11:59 PM, Tue 9:05 AM–11:59 PM, Wed 12:00 PM–11:59 PM, Thu 11:59 PM–11:59 PM.',
		);
	});

	it('has nothing to summarize while Catalog is off', () => {
		expect(setupSummaries({ on: [], catalog: null, seo: null, landing: null, alerts: null, llms: null })).toEqual([]);
	});
});
