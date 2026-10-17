/**
 * The product's own key and its ticket key are kept sealed with `ENCRYPTION_KEY`, their public keys readable (PLAN
 * 0.4.8, K-21): a product key that no longer opens leaves the product not connected until the owner connects it again
 * (a new key); a ticket key that no longer opens is replaced. The Owner's Re-seal covers both (RT-14).
 */
import { describe, expect, it, vi } from 'vitest';
import { createProduct } from '../src/index.js';
import { createMemoryStore, productKeyOf } from '../src/testing.js';
import { createSealer, openKey } from '../src/sealing.js';
import { BASE, ENCRYPTION_KEY, SECRET, manifest, productRoutes, setup } from './helpers.js';

const ADMIN = 'https://admin.shop.example.com';
const USER = { id: 'u1', name: 'Sam Staff', email: 'sam@shop.example.com' };
const KEY_B = 'encryption-key-b-0123456789-abcdefghij';
const IDS = /** @type {const} */ (['productKey', 'ticketKey']);

/** @param {Awaited<ReturnType<typeof setup>>} ctx @param {string} encryptionKey @param {string | null} [previousEncryptionKey] */
const instance = (ctx, encryptionKey, previousEncryptionKey = null) => {
	const product = createProduct({
		manifest: manifest(),
		config: { mongodbUri: '', connectSecret: SECRET, encryptionKey, previousEncryptionKey },
		store: ctx.store,
		fetch: ctx.portal.fetch,
		now: ctx.clock.now,
		nodeEnv: 'test',
		outbound: { allowHosts: ['127.0.0.1', 'localhost'] },
		outboundSend: ctx.network.send,
	});
	const handler = product.handler(productRoutes());
	/** A ticket asked with the server token (the status is fetched with the product key, the ticket signed). */
	const ticket = async () =>
		handler(
			new Request(`${BASE}/v1/tickets`, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${ctx.server.token}`,
					'content-type': 'application/json',
					...(await ctx.staffHeaders({ staff: USER })),
				},
				body: JSON.stringify({ permissions: [], origin: ADMIN }),
			}),
		);
	return { product, handler, ticket };
};

/** @param {Awaited<ReturnType<typeof setup>>} ctx */
const ticketOf = (ctx) =>
	ctx.call('POST', '/v1/tickets', { token: ctx.server.token, staff: USER, body: { permissions: [], origin: ADMIN } });

describe('signing keys sealed (K-21)', () => {
	it('keeps the product key and the ticket key sealed, their public keys readable', async () => {
		const ctx = await setup();
		expect((await ticketOf(ctx)).status).toBe(200);
		const productKey = await productKeyOf({ store: ctx.store, encryptionKey: ENCRYPTION_KEY });
		expect(productKey?.kid).toBe((await ctx.store.get('state', 'productKey')).publicJwk.kid);
		expect(await productKeyOf({ store: createMemoryStore(), encryptionKey: ENCRYPTION_KEY })).toBeNull();
		for (const id of IDS) {
			const doc = await ctx.store.get('state', id);
			expect(doc).toEqual({ sealed: expect.stringMatching(/^ss2\./), publicJwk: expect.objectContaining({ crv: 'Ed25519' }) });
			expect(JSON.stringify(doc)).not.toContain('"d"');
		}
	});

	it('a product key that no longer opens: not connected until connected again (a new key); the ticket key is replaced', async () => {
		const ctx = await setup();
		expect((await ticketOf(ctx)).status).toBe(200);
		const before = { product: await ctx.store.get('state', 'productKey'), ticket: await ctx.store.get('state', 'ticketKey') };
		const lost = instance(ctx, KEY_B);
		expect((await lost.ticket()).status).toBe(503);
		expect(await ctx.store.get('state', 'productKey')).toEqual(before.product); // nothing destroyed
		await ctx.portal.connect({ handler: lost.handler, baseUrl: BASE, secret: SECRET });
		// the link to Accounts (the staff sign-in keys) was sealed with the lost key too: the Portal delivers it again at the
		// next status fetch or notice, with no one pasting anything
		await ctx.portal.sendNotice('notes', { type: 'website.settings_changed', websiteId: ctx.websiteId, what: 'links' });
		await vi.waitFor(async () => expect((await lost.ticket()).status).toBe(200));
		const after = { product: await ctx.store.get('state', 'productKey'), ticket: await ctx.store.get('state', 'ticketKey') };
		expect(after.product.publicJwk.kid).not.toBe(before.product.publicJwk.kid);
		expect(after.ticket.sealed).not.toBe(before.ticket.sealed);
		const sealer = createSealer({ encryptionKey: KEY_B });
		expect(openKey(sealer, after.product, 'state|productKey')).not.toBeNull();
		expect(openKey(sealer, after.ticket, 'state|ticketKey')).not.toBeNull();
	});

	// (the third sealed item is the website's Accounts token, pasted for the staff sign-ins)
	it('the Owner’s Re-seal moves both keys to the new ENCRYPTION_KEY (RT-14)', async () => {
		const ctx = await setup();
		expect((await ticketOf(ctx)).status).toBe(200);
		const kid = (await ctx.store.get('state', 'productKey')).publicJwk.kid;
		const changing = instance(ctx, KEY_B, ENCRYPTION_KEY);
		expect((await changing.ticket()).status).toBe(200);
		const owner = await ctx.session();
		const reseal = () =>
			changing.handler(
				new Request(`${BASE}/v1/dashboard/reseal`, { method: 'POST', headers: { cookie: owner, origin: BASE } }),
			);
		expect(await (await reseal()).json()).toMatchObject({ resealed: 3, current: 0, unreadable: 0 });
		expect(await (await reseal()).json()).toMatchObject({ resealed: 0, current: 3, unreadable: 0 });
		// the previous key removed: both keys open with the new one alone, the product key unchanged
		const after = instance(ctx, KEY_B);
		expect((await after.ticket()).status).toBe(200);
		expect((await ctx.store.get('state', 'productKey')).publicJwk.kid).toBe(kid);
	});
});
