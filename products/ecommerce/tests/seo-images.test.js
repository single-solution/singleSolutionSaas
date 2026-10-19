/**
 * Stable image addresses for search engines and shopping catalogs (SEO audit G1, phase S3): no SEO answer, sitemap or
 * feed ever carries a signed link (they last an hour); while the storage connection has no public address they point at
 * the website's own media route (always `/media`) with a signature that never changes, and the route the guide gives
 * fetches the file through `GET /v1/media`. Shop health says while images go out on short-lived links.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORIGIN, STORAGE, readyShop, storedCategory } from './helpers.js';
import { mediaRoute } from '../core/snippets.js';
import { COLLECTIONS } from '../core/model.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;

const KEY = 'ecommerce/products/prd_cup/img_cup one.jpg';
const VARIANT_KEY = 'ecommerce/products/prd_cup/img_red.jpg';
const CATEGORY_KEY = 'ecommerce/categories/cat_cups/img_cups.jpg';
/** A signed link's marks (S3 and similar). */
const SIGNED = /X-Amz-|Signature=|Expires=/;

/** Every SEO answer, sitemap and feed, as text. */
const everything = async () => {
	const paths = [
		'/v1/seo/products/cup',
		'/v1/seo/categories/cups',
		'/v1/seo/listing?category=cups',
		'/v1/seo/sitemap.xml',
		'/v1/seo/sitemaps/products-1',
		'/v1/feeds/products.xml',
		'/v1/feeds/products.csv',
	];
	const texts = [];
	for (const path of paths) {
		const answer = await shop.api('GET', path);
		if (answer.status !== 200) throw new Error(`${path}: ${answer.status} ${answer.text}`);
		texts.push(answer.text);
	}
	return texts.join('\n');
};

beforeAll(async () => {
	shop = await readyShop();
	const data = await shop.db();
	await data.collection(COLLECTIONS.categories).insertOne(
		storedCategory({
			id: 'cat_cups',
			slug: 'cups',
			name: 'Cups',
			image: { key: CATEGORY_KEY, type: 'image/jpeg', size: 9, alt: '' },
		}),
	);
	await shop.seedProduct({
		id: 'prd_cup',
		slug: 'cup',
		name: 'Cup',
		categoryIds: ['cat_cups'],
		media: [{ key: KEY, type: 'image/jpeg', size: 10, alt: '' }],
		options: [{ name: 'Color', values: ['Red', 'Blue'] }],
		variants: [
			{
				id: 'var_red',
				sku: '',
				options: { Color: 'Red' },
				price: 1000,
				compareAtPrice: null,
				cost: null,
				stock: 3,
				locations: {},
				grade: null,
				active: true,
				media: [{ key: VARIANT_KEY, type: 'image/jpeg', size: 10, alt: '' }],
			},
			{
				id: 'var_blue',
				sku: '',
				options: { Color: 'Blue' },
				price: 1000,
				compareAtPrice: null,
				cost: null,
				stock: 3,
				locations: {},
				grade: null,
				active: true,
			},
		],
	});
});
afterAll(async () => shop.product.close());

describe('image addresses in SEO answers, sitemaps and feeds', () => {
	it('are never signed links: the website’s media route without a public address', async () => {
		const text = await everything();
		expect(text).not.toMatch(SIGNED);
		expect(text).not.toContain(STORAGE);
		const answer = (await shop.api('GET', '/v1/seo/products/cup')).json;
		expect(answer.image).toMatch(
			/^https:\/\/shop\.example\.com\/media\/[A-Za-z0-9_-]{16}\/ecommerce\/products\/prd_cup\/img_cup%20one\.jpg$/,
		);
		// the same file always has the same address
		expect((await shop.api('GET', '/v1/seo/products/cup')).json.image).toBe(answer.image);
		const sitemap = (await shop.api('GET', '/v1/seo/sitemap.xml')).text;
		expect(sitemap).toContain(`<image:loc>${answer.image}</image:loc>`);
		expect(text).toContain(`${ORIGIN}/media/`);
		// the shop's own widgets still read signed links (they show at once, nothing to set up)
		const card = (await shop.visitor('GET', '/v1/shop/products/cup')).json;
		expect(card.media[0].url).toMatch(SIGNED);
	});

	it('are the public address once it is set', async () => {
		// the storage connection's public address, then <prefix><product>/<website>/<key>
		await shop.connectStorage({ publicBaseUrl: 'https://cdn.example.com/shop/' });
		const folder = `https://cdn.example.com/shop/ecommerce/${shop.websiteId}`;
		const text = await everything();
		expect(text).not.toMatch(SIGNED);
		expect((await shop.api('GET', '/v1/seo/products/cup')).json.image).toBe(
			`${folder}/ecommerce/products/prd_cup/img_cup%20one.jpg`,
		);
		expect(text).toContain(`${folder}/ecommerce/categories/cat_cups/img_cups.jpg`);
		expect(text).not.toContain(`${ORIGIN}/media/`);
		await shop.connectStorage();
	});
});

describe('the media route', () => {
	/** The signature and key of the product's main image. */
	const partsOf = async () => {
		const image = String((await shop.api('GET', '/v1/seo/products/cup')).json.image);
		const [signature = '', ...key] = new URL(image).pathname.split('/').slice(2).map(decodeURIComponent);
		return { signature, key: key.join('/') };
	};

	it('gives a fresh link to a file it named, and nothing else', async () => {
		const { signature, key } = await partsOf();
		expect(key).toBe(KEY);
		const query = (/** @type {string} */ k, /** @type {string} */ sig) =>
			`/v1/media?${new URLSearchParams({ key: k, signature: sig })}`;
		const ok = await shop.api('GET', query(key, signature));
		expect(ok.status).toBe(200);
		expect(ok.json.url).toMatch(SIGNED);
		expect(ok.json.url).toContain(STORAGE);
		expect(Date.parse(ok.json.expiresAt)).toBeGreaterThan(shop.now());
		expect((await shop.api('GET', query('ecommerce/digital/prd_cup/book.pdf', signature))).status).toBe(404);
		// The first character always changes the signature (the last one carries spare bits and can already be the swap).
		const tampered = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
		expect((await shop.api('GET', query(key, tampered))).status).toBe(404);
		expect((await shop.api('GET', query(key, ''))).status).toBe(404);
		expect((await shop.api('GET', '/v1/media')).status).toBe(404);
	});

	it('works through the route the guide gives the website', async () => {
		const { signature, key } = await partsOf();
		const code = mediaRoute('https://ecommerce.example.dev');
		expect(code).toContain('app/media/[...key]/route.js');
		/** @type {string[]} */
		const fetched = [];
		/** @param {string} url @param {RequestInit} [init] */
		const fetchStub = async (url, init) => {
			fetched.push(url);
			if (url.startsWith('https://ecommerce.example.dev/')) {
				const path = url.slice('https://ecommerce.example.dev'.length);
				const answer = await shop.api('GET', path);
				expect(/** @type {Record<string, string>} */ (init?.headers ?? {}).authorization).toBe(`Bearer ${shop.server}`);
				return new Response(answer.text, { status: answer.status, headers: { 'content-type': 'application/json' } });
			}
			return new Response('image bytes', { status: 200, headers: { 'content-type': 'image/jpeg' } });
		};
		const GET = new Function('fetch', 'process', `${code.replace('export async function GET', 'return async function GET')}`)(
			fetchStub,
			{ env: { SS_SERVER_TOKEN: shop.server } },
		);
		const served = await GET(new Request(`${ORIGIN}/media/x`), {
			params: Promise.resolve({ key: [signature, ...key.split('/')] }),
		});
		expect(served.status).toBe(200);
		expect(served.headers.get('content-type')).toBe('image/jpeg');
		expect(served.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
		expect(await served.text()).toBe('image bytes');
		expect(fetched[1]).toMatch(SIGNED);
		const refused = await GET(new Request(`${ORIGIN}/media/x`), { params: Promise.resolve({ key: ['nope', 'a.jpg'] }) });
		expect(refused.status).toBe(404);
	});
});

describe('shop health', () => {
	it('asks for the public address while images go out on short-lived links', async () => {
		const check = async () =>
			(await shop.api('GET', '/v1/reports/health')).json.checks.find(
				(/** @type {any} */ found) => found.key === 'images_short_lived',
			);
		// the link opens the Portal's Data and files, where the storage connection's public address is entered
		expect(await check()).toEqual({
			key: 'images_short_lived',
			status: 'attention',
			count: 1,
			link: `${shop.portal.url}/websites/${shop.websiteId}/settings#connections`,
		});
		await shop.connectStorage({ publicBaseUrl: 'https://cdn.example.com' });
		expect(await check()).toMatchObject({ status: 'ok', count: 0 });
		await shop.connectStorage();
	});
});
