import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { JSDOM } from './dom.js';
import { closeMongoClients } from '../../../src/infra/db.js';
import { startMongo } from '../../helpers.js';
import { M1, M2, PACK, SERVICE, W1, bootDelivery } from './fixtures.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

/** @type {Awaited<ReturnType<typeof startMongo>>} */
let mongo;
beforeAll(async () => {
	mongo = await startMongo();
}, 120_000);
afterAll(async () => {
	await closeMongoClients();
	await mongo?.stop();
});

const SITE = `/v1/merchants/${M1}/websites/${W1}`;
const PAGE =
	'<!doctype html><html lang="en"><head><meta charset="utf-8"><base href="https://cdn.other.example/">' +
	'<meta http-equiv="Content-Security-Policy" content="script-src \'none\'"><title>Shop</title>' +
	'<link rel="stylesheet" href="/styles.css"></head><body class="home"><h1>Welcome to the shop</h1>' +
	'<img src="img/hero.png"><script src="/app.js"></script></body></html>';

/** @param {{ status: number, json: any, text?: string }} res @param {number} status @param {string} [code] */
const problemOf = (res, status, code) => {
	if (res.status !== status || (code && !String(res.json?.type).endsWith(`/${code}`)))
		throw new Error(`expected ${status} ${code ?? ''}, got ${res.status} ${res.text ?? JSON.stringify(res.json)}`);
	return res.json;
};

/**
 * A fake upstream recording every call.
 * @param {(url: string) => { status?: number, type?: string, body?: string, url?: string }} [respond]
 */
const upstream = (respond = () => ({})) => {
	/** @type {Array<{ url: string, init: any, policy: any }>} */
	const calls = [];
	/** @type {any} */
	const fetch = async (/** @type {string} */ url, /** @type {any} */ init, /** @type {any} */ policy) => {
		calls.push({ url, init, policy });
		const r = respond(url);
		return {
			status: r.status ?? 200,
			headers: { 'content-type': r.type ?? 'text/html; charset=utf-8' },
			body: Buffer.from(r.body ?? PAGE),
			url: r.url ?? url,
		};
	};
	return { fetch, calls };
};

/** @param {Partial<Parameters<typeof bootDelivery>[0]>} [options] */
const boot = async (options = {}) => {
	const t = await bootDelivery({ db: mongo.db(), ...options });
	await t.uploadAll(PACK);
	await t.subscribe(W1, PACK);
	return t;
};

describe('preview sessions', () => {
	it('creates a signed 10-minute session with a candidate element set (subscribed or not)', async () => {
		const up = upstream();
		const t = await boot({ delivery: { fetch: up.fetch } });
		const owner = await t.cookie();
		const created = await t.request('POST', `${SITE}/preview`, {
			cookie: owner,
			body: {
				path: '/collections/sale',
				elements: [
					{ appId: SERVICE, key: 'launcher' }, // not subscribed: product defaults
					{ appId: PACK, key: 'bar', config: { message: 'Try me' } }, // subscribed: override
				],
			},
		});
		expect(created.status).toBe(200);
		expect(created.json.url).toMatch(/^https:\/\/portal\.test\/p\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}\/collections\/sale$/);
		expect(created.json.elements.map((/** @type {any} */ e) => e.key)).toEqual(['bar', 'launcher']);
		expect(Date.parse(created.json.expiresAt) - t.clock.now()).toBe(10 * 60_000);
		// nothing was published: the alias is untouched
		expect((await t.db.collection('delivery_aliases').findOne({ websiteId: W1 }))?.version).toBeNull();

		// base: 'empty' previews only the candidates; unknown elements are reported
		const empty = await t.request('POST', `${SITE}/preview`, {
			cookie: owner,
			body: {
				base: 'empty',
				elements: [
					{ appId: SERVICE, key: 'launcher' },
					{ appId: SERVICE, key: 'nope' },
				],
			},
		});
		expect(empty.json.elements.map((/** @type {any} */ e) => e.key)).toEqual(['launcher']);
		expect(empty.json.warnings).toContainEqual(expect.objectContaining({ code: 'unknown_element', key: 'nope' }));

		// invalid requests and foreign websites
		problemOf(await t.request('POST', `${SITE}/preview`, { cookie: owner, body: { path: 'https://evil.example/' } }), 422);
		problemOf(await t.request('POST', `${SITE}/preview`, { cookie: owner, body: { path: '//evil.example/' } }), 422);
		problemOf(
			await t.request('POST', `${SITE}/preview`, { cookie: owner, body: { elements: [{ appId: 'x', key: 'Bad' }] } }),
			422,
		);
		problemOf(
			await t.request('POST', `/v1/merchants/${M2}/websites/${W1}/preview`, { cookie: await t.cookie({ merchantId: M2 }) }),
			404,
		);
	});

	it('serves the merchant page with the candidate injected, sandboxed, never cached or indexed', async () => {
		const up = upstream();
		const t = await boot({ delivery: { fetch: up.fetch } });
		const owner = await t.cookie();
		const created = await t.request('POST', `${SITE}/preview`, {
			cookie: owner,
			body: { path: '/collections/sale', elements: [{ appId: PACK, key: 'bar', config: { message: 'Try me' } }] },
		});
		const path = new URL(created.json.url).pathname;
		const page = await t.request('GET', `${path}?ref=ad`, {
			headers: { cookie: 'session=merchant-cookie', authorization: 'Bearer x' },
		});
		expect(page.status).toBe(200);

		// upstream: the website's own origin, GET, no cookies or credentials forwarded, size-capped policy
		expect(up.calls).toHaveLength(1);
		const call = /** @type {any} */ (up.calls[0]);
		expect(call.url).toBe('https://shop.example.com/collections/sale?ref=ad');
		expect(call.init.method).toBe('GET');
		expect(Object.keys(call.init.headers)).toEqual(['accept']);
		expect(call.policy.maxBytes).toBe(2 * 1024 * 1024);

		// response policy
		expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
		expect(page.headers.get('cache-control')).toBe('no-store');
		expect(page.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive');
		const csp = /** @type {string} */ (page.headers.get('content-security-policy'));
		expect(csp).toMatch(/^sandbox allow-scripts/);
		const nonce = /script-src 'nonce-([^']+)' 'strict-dynamic'/.exec(csp)?.[1];
		expect(nonce).toBeTruthy();
		expect(csp).toContain('base-uri https://shop.example.com');
		expect(csp).toContain("form-action 'none'");

		// injection, checked with a real HTML parser
		const dom = new JSDOM(page.text);
		const doc = dom.window.document;
		const bases = doc.querySelectorAll('base');
		expect(bases).toHaveLength(1);
		expect(bases[0]?.getAttribute('href')).toBe('https://shop.example.com/collections/sale?ref=ad');
		expect(doc.head.firstElementChild?.tagName).toBe('BASE');
		expect(doc.querySelector('meta[http-equiv]')).toBeNull();
		const ribbon = doc.getElementById('ss-preview-ribbon');
		expect(ribbon?.textContent).toBe('Preview');
		expect(doc.body.firstElementChild).toBe(ribbon);
		const injected = [...doc.querySelectorAll('script[nonce]')];
		expect(injected).toHaveLength(1);
		expect(injected[0]?.getAttribute('nonce')).toBe(nonce);
		expect(injected[0]?.textContent).toContain('__ssr.start(');
		expect(injected[0]?.textContent).toContain('Try me');
		expect(doc.querySelector('h1')?.textContent).toBe('Welcome to the shop');
		expect(doc.querySelector('img')?.getAttribute('src')).toBe('img/hero.png'); // resolved by <base> against the origin
		expect(/** @type {any} */ (doc.querySelector('img')).src).toBe('https://shop.example.com/collections/img/hero.png');
		expect(doc.body.className).toBe('home');
	});

	it('a dedicated PREVIEW_ORIGIN serves previews (merchant scripts allowed, still sandboxed) and nothing else (F.16)', async () => {
		const up = upstream();
		const t = await boot({ env: { PREVIEW_ORIGIN: 'https://preview.example-previews.test' }, delivery: { fetch: up.fetch } });
		const created = await t.request('POST', `${SITE}/preview`, {
			cookie: await t.cookie(),
			body: { path: '/', elements: [{ appId: PACK, key: 'bar' }] },
		});
		expect(created.json.url).toMatch(/^https:\/\/preview\.example-previews\.test\/p\//);
		const path = new URL(created.json.url).pathname;
		// the Portal host refuses previews once the dedicated origin is configured
		problemOf(await t.request('GET', path), 422, 'delivery_preview_refused');
		const page = await t.portal.handle(new Request(`https://preview.example-previews.test${path}`));
		expect(page.status).toBe(200);
		const csp = String(page.headers.get('content-security-policy'));
		expect(csp).toMatch(/^sandbox allow-scripts allow-same-origin /);
		expect(csp).toContain("script-src https: 'unsafe-inline'");
		expect(csp).not.toContain('nonce-');
		expect(await page.text()).toContain('__ssr.start(');
		// the preview host serves nothing but /p/*
		for (const other of ['/v1/system/info', `/w/${W1}/loader.js`, '/cron/drain'])
			expect((await t.portal.handle(new Request(`https://preview.example-previews.test${other}`))).status).toBe(404);
	});

	it('refuses redirects off the website, private addresses, non-HTML and failures', async () => {
		/** @type {(url: string) => any} */
		let respond = () => ({});
		const up = upstream((url) => respond(url));
		const t = await boot({ delivery: { fetch: up.fetch } });
		const owner = await t.cookie();
		const created = await t.request('POST', `${SITE}/preview`, { cookie: owner, body: {} });
		const path = new URL(created.json.url).pathname;

		respond = () => ({ url: 'https://evil.example/' });
		problemOf(await t.request('GET', path), 422, 'delivery_preview_refused');
		respond = () => ({ type: 'application/json', body: '{}' });
		problemOf(await t.request('GET', path), 422, 'delivery_preview_refused');
		respond = () => ({ status: 500 });
		problemOf(await t.request('GET', path), 502, 'upstream_error');

		// the real @ss/net client: the website's domain resolving to a private address is refused before connecting
		const real = await boot({ db: mongo.db('real'), delivery: { resolve: async () => [{ address: '10.0.0.7', family: 4 }] } });
		const own = await real.cookie();
		const session = await real.request('POST', `${SITE}/preview`, { cookie: own, body: {} });
		const refused = problemOf(await real.request('GET', new URL(session.json.url).pathname), 422, 'delivery_preview_refused');
		expect(refused.detail).toContain('ssrf_blocked');
		const loopback = await bootDelivery({
			db: mongo.db('loop'),
			delivery: { resolve: async () => [{ address: '127.0.0.1', family: 4 }] },
		});
		await loopback.subscribe(W1, PACK);
		const s2 = await loopback.request('POST', `${SITE}/preview`, { cookie: await loopback.cookie(), body: {} });
		problemOf(await loopback.request('GET', new URL(s2.json.url).pathname), 422, 'delivery_preview_refused');
	});

	it('expires after 10 minutes, rejects forged tokens and rate-limits per merchant', async () => {
		const up = upstream();
		const t = await boot({ delivery: { fetch: up.fetch } });
		const owner = await t.cookie();
		const created = await t.request('POST', `${SITE}/preview`, { cookie: owner, body: {} });
		const path = new URL(created.json.url).pathname;
		expect((await t.request('GET', path)).status).toBe(200);
		const [, , token = ''] = path.split('/');
		const forged = `${token.slice(0, -2)}${token.endsWith('AA') ? 'BB' : 'AA'}`;
		problemOf(await t.request('GET', `/p/${forged}`), 404, 'not_found');
		problemOf(await t.request('GET', '/p/not-a-token'), 404, 'not_found');
		t.clock.advance(10 * 60_000 + 1);
		problemOf(await t.request('GET', path), 404, 'not_found');

		// creating sessions is limited per merchant
		/** @type {number[]} */
		const statuses = [];
		for (let i = 0; i < 21; i += 1)
			statuses.push((await t.request('POST', `${SITE}/preview`, { cookie: owner, body: {} })).status);
		expect(statuses.slice(0, 19).every((s) => s === 200)).toBe(true);
		expect(statuses.at(-1)).toBe(429);
	});
});
