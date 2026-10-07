import { createConnectRequest } from '@ss/protocol';
import { describe, expect, it } from 'vitest';
import { configFromEnv, createProduct } from '../src/index.js';
import { createFakePortal, createMemoryStore } from '../src/testing.js';
import { BASE, SECRET, createClock, manifest, productRoutes, setup } from './helpers.js';

describe('configFromEnv', () => {
	it('reads exactly the three variables and names problems without values', () => {
		const good = configFromEnv({
			MONGODB_URI: 'mongodb://db.example.com/notes',
			CONNECT_SECRET: 'x'.repeat(32),
			ENCRYPTION_KEY: 'y'.repeat(40),
		});
		expect(good.problems).toEqual([]);
		expect(good.config).toEqual({
			mongodbUri: 'mongodb://db.example.com/notes',
			connectSecret: 'x'.repeat(32),
			encryptionKey: 'y'.repeat(40),
		});
		const bad = configFromEnv({ CONNECT_SECRET: 'short-secret-value' });
		expect(bad.problems).toHaveLength(3);
		expect(bad.problems.join(' ')).toMatch(/MONGODB_URI.*CONNECT_SECRET.*ENCRYPTION_KEY/);
		expect(bad.problems.join(' ')).not.toContain('short-secret-value');
		expect(configFromEnv().problems.length).toBeGreaterThanOrEqual(0);
	});

	it('answers every route 503 with the problems when misconfigured', async () => {
		const product = createProduct({ manifest: manifest(), problems: ['CONNECT_SECRET is missing.'] });
		const response = await product.handler([])(new Request(`${BASE}/v1/anything`));
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ status: 503, problems: ['CONNECT_SECRET is missing.'] });
	});

	it('refuses an invalid manifest, strings or a missing config', () => {
		expect(() => createProduct({ manifest: /** @type {any} */ ({ id: 'x' }) })).toThrow(/manifest is invalid/);
		expect(() => createProduct({ manifest: manifest(), strings: /** @type {any} */ ({ a: 1 }) })).toThrow(/strings/);
		expect(() => createProduct({ manifest: manifest() })).toThrow(/config is required/);
	});
});

describe('connect handshake', () => {
	it('answers the manifest, price list version 1 and pins the Portal', async () => {
		const { portal } = await setup();
		const prices = portal.prices('notes');
		expect(prices).toEqual({
			version: 1,
			features: [
				{ key: 'notes', name: 'Notes', description: 'Visitors leave short notes.', dependsOn: [], millicreditsPerHour: 0 },
				{
					key: 'inbox',
					name: 'Notes inbox',
					description: 'Staff read the notes in their own admin.',
					dependsOn: ['notes'],
					millicreditsPerHour: 0,
				},
			],
		});
	});

	it('continues from a higher Portal price-list version on reconnect and keeps its key', async () => {
		const { portal, handler, call, server } = await setup();
		const again = await portal.connect({ handler, baseUrl: BASE, secret: SECRET, priceListVersion: 7 });
		expect(again.prices.version).toBe(7);
		expect((await call('GET', '/v1/server/open', { token: server.token })).status).toBe(200);
	});

	it('refuses bad signatures, replays and plain http addresses', async () => {
		const clock = createClock();
		const portal = await createFakePortal({ now: clock.now });
		const product = createProduct({
			manifest: manifest(),
			config: { mongodbUri: '', connectSecret: SECRET, encryptionKey: 'k'.repeat(32) },
			store: createMemoryStore({ now: clock.now }),
			fetch: portal.fetch,
			now: clock.now,
			nodeEnv: 'production',
		});
		const handler = product.handler(productRoutes());
		await expect(portal.connect({ handler, baseUrl: BASE, secret: 'another-secret-0123456789-abcdefghij' })).rejects.toThrow(
			/401/,
		);
		await expect(portal.connect({ handler, baseUrl: 'http://localhost:3000', secret: SECRET })).rejects.toThrow(/400/);
		const request = createConnectRequest({
			secret: SECRET,
			productUrl: BASE,
			portalUrl: portal.url,
			jwks: portal.jwks,
			priceListVersion: 0,
			now: clock.now,
		});
		const send = () => handler(new Request(request.url, { method: 'POST', headers: request.headers, body: request.body }));
		expect((await send()).status).toBe(200);
		expect((await send()).status).toBe(401);
	});

	it('answers 503 before a Portal connects, except public routes', async () => {
		const { call, server } = await setup({ connect: false });
		const response = await call('GET', '/v1/server/open', { token: server.token });
		expect(response.status).toBe(503);
		expect((await call('GET', '/docs')).status).toBe(200);
		const notice = await call('POST', '/.well-known/ss-events', { body: '{}' });
		expect(notice.status).toBe(503);
		expect((await call('GET', '/sso?launch=x')).status).toBe(503);
	});

	it('accepts a local http address outside production', async () => {
		const { portal, handler } = await setup({ connect: false });
		const result = await portal.connect({ handler, baseUrl: 'http://localhost:3000', secret: SECRET });
		expect(/** @type {any} */ (result.manifest).endpoints.base).toBe('http://localhost:3000');
	});
});

describe('price reports after a manifest change', () => {
	it('sends kept prices, new features at 0 and retries only that report', async () => {
		const ctx = await setup();
		const { portal, clock, store, settle, call } = ctx;
		const accepted = await store.get('state', 'prices');
		// an older deploy had a feature that is gone and priced notes
		await store.put('state', 'prices', {
			...accepted,
			features: [
				{ ...accepted.features[0], millicreditsPerHour: 2000 },
				{ key: 'old', name: 'Old', description: 'Gone.', dependsOn: [], millicreditsPerHour: 5 },
			],
		});
		portal.setReachable(false);
		await call('GET', '/docs');
		await settle();
		expect((await store.get('state', 'prices')).pending).toBe(true);
		portal.setReachable(true);
		await call('GET', '/docs');
		await settle();
		expect(portal.priceReports).toHaveLength(0);
		clock.advance(61_000);
		await call('GET', '/docs');
		await settle();
		expect(portal.priceReports).toHaveLength(1);
		expect(portal.priceReports[0]?.body).toMatchObject({
			version: 2,
			features: [
				{ key: 'notes', millicreditsPerHour: 2000 },
				{ key: 'inbox', millicreditsPerHour: 0 },
			],
		});
		const saved = await store.get('state', 'prices');
		expect(saved).toMatchObject({ version: 2, pending: false });
		clock.advance(61_000);
		await call('GET', '/docs');
		await settle();
		expect(portal.priceReports).toHaveLength(1);
	});

	it('does not overwrite a newer list when another instance reported first', async () => {
		const memory = createMemoryStore({ now: () => Date.parse('2026-10-01T10:00:00Z') });
		let armed = false;
		let reads = 0;
		const store = {
			...memory,
			/** @type {typeof memory.get} */
			get: async (collection, id) => {
				const doc = await memory.get(collection, id);
				if (!armed || collection !== 'state' || id !== 'prices' || !doc) return doc;
				reads += 1;
				// first read: the drifted list; second read (after the refusal): another instance saved version 9
				return reads === 1 ? { ...doc, features: doc.features.slice(0, 1) } : { ...doc, version: 9 };
			},
		};
		const { portal, clock, settle, call } = await setup({ store });
		const prices = /** @type {{ version: number }} */ (portal.prices('notes'));
		prices.version = 9;
		armed = true;
		clock.advance(61_000);
		await call('GET', '/docs');
		await settle();
		expect(reads).toBe(2);
		expect((await memory.get('state', 'prices'))?.pending).toBe(false);
	});
});
