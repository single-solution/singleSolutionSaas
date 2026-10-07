import { afterEach, describe, expect, it } from 'vitest';
import { shareUrl } from '../api/shares.js';
import { createHarness, item } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
afterEach(async () => {
	await h?.close();
});

describe('share links', () => {
	it('shares a list read-only with an opaque token, rotates and revokes it', async () => {
		h = await createHarness({ config: { share: { page_url: 'https://shop.example.com/wishlist/shared?t={token}' } } });
		const jane = await h.login('cus_jane', { email: 'jane@example.com' });
		const saved = await h.call('POST', '/v1/lists/default/items', { identity: jane, body: item() });
		const listId = saved.json.list.id;
		const share = await h.call('POST', '/v1/shares', { identity: jane, body: { listId } });
		expect(share.status, share.text).toBe(201);
		expect(share.json).toMatchObject({ listId, token: expect.stringMatching(/^[0-9a-z]{26}$/), expiresAt: null });
		expect(share.json.url).toBe(`https://shop.example.com/wishlist/shared?t=${share.json.token}`);
		for (const secret of ['cus_jane', 'jane', listId]) expect(share.json.url).not.toContain(secret);
		const stored = await h.collection('lists').findOne({ id: listId });
		expect(JSON.stringify(stored)).not.toContain(share.json.token);
		// any visitor of the website (pk_, no login) reads it; nothing about the owner
		const view = await h.call('GET', `/v1/shares/${share.json.token}`);
		expect(view.status).toBe(200);
		expect(view.json).toMatchObject({ name: 'Wishlist', itemCount: 1, items: [{ itemId: 'itm_1', price: { amount: 5000 } }] });
		expect(JSON.stringify(view.json)).not.toMatch(/cus_jane|jane@|wl_|wli_/);
		expect((await h.call('GET', '/v1/lists/default', { identity: jane })).json.shared).toBe(true);
		// rotating kills the old link
		const rotated = await h.call('POST', '/v1/shares', { identity: jane, body: { listId } });
		expect((await h.call('GET', `/v1/shares/${share.json.token}`)).status).toBe(404);
		expect((await h.call('GET', `/v1/shares/${rotated.json.token}`)).status).toBe(200);
		// only the owner may share or revoke
		const bob = await h.login('cus_bob');
		expect((await h.call('POST', '/v1/shares', { identity: bob, body: { listId } })).status).toBe(404);
		expect((await h.call('POST', '/v1/shares:revoke', { identity: bob, body: { listId } })).status).toBe(404);
		expect((await h.call('POST', '/v1/shares', { identity: jane, body: {} })).status).toBe(422);
		expect((await h.call('POST', '/v1/shares:revoke', { identity: jane, body: { listId: 5 } })).status).toBe(422);
		const revoked = await h.call('POST', '/v1/shares:revoke', { identity: jane, body: { listId } });
		expect(revoked.json).toEqual({ listId, shared: false });
		expect((await h.call('GET', `/v1/shares/${rotated.json.token}`)).status).toBe(404);
		expect((await h.call('POST', '/v1/shares:revoke', { identity: jane, body: { listId } })).status).toBe(200);
		expect((await h.call('GET', '/v1/shares/not-a-token')).status).toBe(404);
	});

	it('expires links, hides prices and keeps guests from sharing unless allowed', async () => {
		h = await createHarness({ config: { share: { ttl_days: 1, show_prices: false } } });
		const jane = await h.login('cus_jane');
		const listId = (await h.call('POST', '/v1/lists/default/items', { identity: jane, body: item() })).json.list.id;
		const share = await h.call('POST', '/v1/shares', { identity: jane, body: { listId } });
		expect(share.json.url).toBeNull();
		expect(share.json.expiresAt).toBe(new Date(h.clock.now() + 86_400_000).toISOString());
		expect((await h.call('GET', `/v1/shares/${share.json.token}`)).json.items[0].price).toBeNull();
		h.clock.advance(86_400_001);
		expect((await h.call('GET', `/v1/shares/${share.json.token}`)).status).toBe(404);
		const token = await h.guest();
		const guestList = (await h.call('POST', '/v1/lists/default/items', { body: { ...item(), guest: token } })).json.list.id;
		const refused = await h.call('POST', '/v1/shares', { body: { listId: guestList, guest: token } });
		expect(refused.status).toBe(403);
		expect(refused.json.type).toMatch(/\/problems\/share_not_allowed$/);
		await h.entitle({ config: { share: { allow_guests: true } } });
		expect((await h.call('POST', '/v1/shares', { body: { listId: guestList, guest: token } })).status).toBe(201);
		await h.entitle({ elements: { share: false } });
		expect((await h.call('GET', `/v1/shares/${share.json.token}`)).status).toBe(403);
	});

	it('builds share URLs only from https templates with a token placeholder', () => {
		expect(shareUrl('https://shop.test/s/{token}', 'abc')).toBe('https://shop.test/s/abc');
		expect(shareUrl('https://shop.test/s', 'abc')).toBeNull();
		expect(shareUrl('http://shop.test/s/{token}', 'abc')).toBeNull();
		expect(shareUrl('https://u:p@shop.test/{token}', 'abc')).toBeNull();
		expect(shareUrl('{token}', 'abc')).toBeNull();
	});
});
