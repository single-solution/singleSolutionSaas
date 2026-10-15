/**
 * Conditional reads of the SEO and shop answers (SEO audit G10, phase S9; parity P3-11), light on free plans: each JSON
 * answer carries an ETag (the same for the same answer, a new one once the content changes) and Cache-Control (a server
 * may keep it a minute and serve it while it reads it again; a browser checks it again each time), and an If-None-Match
 * naming it is answered 304 without a body. The SEO answers carry lastModified (the page's last content change) for the
 * website's own Last-Modified header, and the docs' webhook route clears the website's cache when the catalog changes.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSnippets } from '../core/snippets.js';
import { COLLECTIONS } from '../core/model.js';
import { BASE, readyShop, storedCategory } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
/** @type {Record<string, any>} */
const ids = {};

beforeAll(async () => {
	shop = await readyShop({ features: ['catalog', 'checkout'] });
	const data = await shop.db();
	await data.collection(COLLECTIONS.categories).insertOne(storedCategory({ id: 'cat_lamps', slug: 'lamps', name: 'Lamps' }));
	ids.lamp = (
		await shop.api('POST', '/v1/products', {
			name: 'Desk Lamp',
			status: 'active',
			categoryIds: ['cat_lamps'],
			price: 4500,
			stock: 3,
		})
	).json;
});
afterAll(async () => shop.product.close());

/** The server reads of SEO answers and shop reads, each answered with an ETag. */
const SERVER_READS = [
	'/v1/seo/site',
	'/v1/seo/products/desk-lamp',
	'/v1/seo/categories/lamps',
	'/v1/seo/listing?category=lamps',
	'/v1/shop/products?category=lamps',
	'/v1/shop/products/desk-lamp',
	'/v1/shop/categories',
	'/v1/shop/brands',
];

describe('conditional reads', () => {
	it('gives each answer an ETag and Cache-Control, and 304 without a body for an ETag it names', async () => {
		for (const path of SERVER_READS) {
			const first = await shop.api('GET', path);
			expect(first.status, path).toBe(200);
			const etag = first.headers.get('etag');
			expect(etag, path).toMatch(/^"[\w-]{20,}"$/);
			expect(first.headers.get('cache-control'), path).toBe('private, max-age=60, stale-while-revalidate=600');
			// the same answer, the same ETag
			expect((await shop.api('GET', path)).headers.get('etag'), path).toBe(etag);
			const again = await shop.api('GET', path, undefined, { 'if-none-match': `"other", W/${etag}` });
			expect(again.status, path).toBe(304);
			expect(again.text, path).toBe('');
			expect(again.headers.get('etag'), path).toBe(etag);
		}
	});

	it('asks a browser to check a shop answer again each time, and answers it 304 too', async () => {
		const first = await shop.visitor('GET', '/v1/shop/products/desk-lamp');
		expect(first.headers.get('cache-control')).toBe('private, no-cache');
		const etag = String(first.headers.get('etag'));
		const again = await shop.call('GET', '/v1/shop/products/desk-lamp', {
			token: shop.browser,
			origin: 'https://shop.example.com',
			headers: { 'if-none-match': etag },
		});
		expect(again.status).toBe(304);
	});

	it('gives a new ETag once the product changes, with its lastModified', async () => {
		const before = await shop.api('GET', '/v1/seo/products/desk-lamp');
		expect(before.json.lastModified).toBe(new Date(shop.now()).toISOString());
		shop.advance(60_000);
		await shop.api('PATCH', `/v1/products/${ids.lamp.id}`, { summary: 'A lamp for your desk, with a warm light.' });
		const after = await shop.api('GET', '/v1/seo/products/desk-lamp');
		expect(after.headers.get('etag')).not.toBe(before.headers.get('etag'));
		expect(after.json.lastModified).toBe(new Date(shop.now()).toISOString());
		expect(
			(await shop.api('GET', '/v1/seo/products/desk-lamp', undefined, { 'if-none-match': String(before.headers.get('etag')) }))
				.status,
		).toBe(200);
		// a listing and a category page date their newest product
		expect((await shop.api('GET', '/v1/seo/listing?category=lamps')).json.lastModified).toBe(after.json.lastModified);
		expect((await shop.api('GET', '/v1/seo/categories/lamps')).json.lastModified).toBe(after.json.lastModified);
	});

	it('keeps the ETag of an answer whose image links were only signed again, within ten minutes (review M9)', async () => {
		/** @param {unknown[]} media */
		const photos = async (media) =>
			(await shop.db())
				.collection(COLLECTIONS.products)
				.updateOne({ websiteId: shop.websiteId, id: ids.lamp.id }, { $set: { media } });
		await photos([{ key: `ecommerce/products/${ids.lamp.id}/lamp.png`, type: 'image/png', size: 1, alt: '' }]);
		try {
			const first = await shop.api('GET', '/v1/shop/products/desk-lamp');
			expect(first.text).toContain('X-Amz-Signature=');
			const etag = String(first.headers.get('etag'));
			// a second later its links are signed again (another X-Amz-Date): the same answer for a cache
			shop.advance(1000);
			const again = await shop.api('GET', '/v1/shop/products/desk-lamp', undefined, { 'if-none-match': etag });
			expect(again.status).toBe(304);
			// past the window it answers whole, with links signed now (a kept answer's links always still work)
			shop.advance(10 * 60_000);
			const later = await shop.api('GET', '/v1/shop/products/desk-lamp', undefined, { 'if-none-match': etag });
			expect(later.status).toBe(200);
			expect(later.headers.get('etag')).not.toBe(etag);
		} finally {
			await photos([]);
		}
	});
});

describe('the docs’ webhook route', () => {
	it('clears the cached answers when the catalog or the settings change, for a signed event only', async () => {
		const code = createSnippets({ base: BASE, widgets: [], permissions: [] }).cacheRoute;
		/** @type {string[]} */
		const cleared = [];
		// the route as written, its imports given
		const POST = new Function(
			'createHmac',
			'timingSafeEqual',
			'revalidateTag',
			'process',
			`${code.replace(/^import .*$/gm, '').replace(/^export /gm, '')}\nreturn POST;`,
		)(createHmac, timingSafeEqual, (/** @type {string} */ tag) => cleared.push(tag), {
			env: { SS_WEBHOOK_SECRET: 'webhook-secret-0123456789abcdef' },
		});
		/** @param {object} event @param {string} [secret] @param {number} [at] */
		const post = (event, secret = 'webhook-secret-0123456789abcdef', at = Math.floor(Date.now() / 1000)) => {
			const body = JSON.stringify(event);
			const v1 = createHmac('sha256', secret).update(`${at}.${body}`).digest('hex');
			return POST(
				new Request('https://shop.example.com/api/ss-ecommerce-events', {
					method: 'POST',
					headers: { 'ss-signature': `t=${at},v1=${v1}` },
					body,
				}),
			);
		};
		expect((await post({ type: 'ecommerce.catalog.changed', data: {} })).status).toBe(204);
		expect(cleared).toEqual(['ss-ecommerce']);
		expect((await post({ type: 'ecommerce.order.placed', data: {} })).status).toBe(204);
		expect((await post({ type: 'ecommerce.settings.changed', data: {} })).status).toBe(204);
		expect(cleared).toEqual(['ss-ecommerce', 'ss-ecommerce']);
		expect((await post({ type: 'ecommerce.catalog.changed' }, 'another-secret-0123456789')).status).toBe(401);
		expect((await post({ type: 'ecommerce.catalog.changed' }, undefined, 1_000)).status).toBe(401);
		expect(cleared).toHaveLength(2);
		// every SEO and served answer is fetched with the tag the route clears
		const snippets = createSnippets({ base: BASE, widgets: [], permissions: [] });
		for (const fetched of [snippets.homePage, snippets.productMeta, snippets.listingPage, snippets.policies])
			expect(fetched).toContain("tags: ['ss-ecommerce']");
	});
});
