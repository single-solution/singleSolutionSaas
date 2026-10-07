import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, DOMAIN, item, WEBSITE_2 } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
afterEach(async () => {
	await h?.close();
});

describe('lists (customers)', () => {
	it('saves items for a signed-in customer: default list on first use, any item kind, snapshot cleaned', async () => {
		h = await createHarness();
		const jane = await h.login('cus_jane', { email: 'jane@example.com' });
		const added = await h.call('POST', '/v1/lists/default/items', {
			identity: jane,
			body: item({ title: ' Linen\u0000 shirt ', url: 'https://evil.test/p', variantId: 'v_m' }),
		});
		expect(added.status, added.text).toBe(201);
		expect(added.headers.get('location')).toMatch(/^\/v1\/lists\/wl_[0-9a-z]+\/items\/wli_/);
		expect(added.json).toMatchObject({
			added: true,
			evicted: [],
			list: { name: 'Wishlist', isDefault: true, itemCount: 1, owner: { kind: 'customer' } },
		});
		expect(added.json.list.items[0]).toMatchObject({
			itemId: 'itm_1',
			variantId: 'v_m',
			title: 'Linen shirt',
			url: null,
			image: 'https://cdn.example.net/linen.jpg',
			price: { amount: 5000, currency: 'EUR' },
			savedPrice: { amount: 5000, currency: 'EUR' },
		});
		expect(added.json.list.owner.id).toBeUndefined();
		// saving the same item again keeps it (200) — a booking, a course, an article: anything with an id
		const again = await h.call('POST', '/v1/lists/default/items', {
			identity: jane,
			body: item({ variantId: 'v_m', price: { amount: 4500, currency: 'EUR' } }),
		});
		expect(again.status).toBe(200);
		expect(again.json).toMatchObject({ added: false, list: { itemCount: 1 } });
		expect(again.json.list.items[0]).toMatchObject({ price: { amount: 4500 }, savedPrice: { amount: 5000 } });
		const course = await h.call('POST', '/v1/lists/default/items', {
			identity: jane,
			body: { itemId: 'course:intro-to-pottery', title: 'Pottery, 6 weeks', url: `https://${DOMAIN}/courses/pottery` },
		});
		expect(course.json.list.itemCount).toBe(2);
		const stored = await h.collection('lists').findOne({ ownerId: 'cus_jane' });
		expect(stored).toMatchObject({
			websiteId: expect.any(String),
			merchantId: expect.any(String),
			env: 'live',
			ownerKind: 'customer',
		});
		expect(stored?.expiresAt).toBeNull();
	});

	it('creates named lists up to the limit and reads, renames and deletes them', async () => {
		h = await createHarness({ config: { lists: { max_lists: 2, max_name_length: 10 } } });
		const jane = await h.login('cus_jane');
		const first = await h.call('POST', '/v1/lists', { identity: jane, body: { name: '  Birthday  presents ' } });
		expect(first.status).toBe(201);
		expect(first.headers.get('location')).toBe(`/v1/lists/${first.json.id}`);
		expect(first.json).toMatchObject({ name: 'Birthday p', isDefault: true, items: [] });
		h.clock.advance(1000);
		const second = await h.call('POST', '/v1/lists', { identity: jane, body: { name: 'Home' } });
		expect(second.json.isDefault).toBe(false);
		const third = await h.call('POST', '/v1/lists', { identity: jane, body: { name: 'More' } });
		expect(third.status).toBe(409);
		expect(third.json.type).toMatch(/\/problems\/limit_reached$/);
		expect((await h.call('POST', '/v1/lists', { identity: jane, body: { name: '  ' } })).status).toBe(422);
		const listed = await h.call('GET', '/v1/lists', { identity: jane });
		expect(listed.json.items.map((/** @type {any} */ l) => l.name)).toEqual(['Home', 'Birthday p']);
		const read = await h.call('GET', `/v1/lists/${second.json.id}`, { identity: jane });
		expect(read.json).toMatchObject({ id: second.json.id, items: [] });
		const renamed = await h.call('PATCH', `/v1/lists/${second.json.id}`, { identity: jane, body: { name: 'Kitchen' } });
		expect(renamed.json.name).toBe('Kitchen');
		expect((await h.call('PATCH', `/v1/lists/${second.json.id}`, { identity: jane, body: { name: '' } })).status).toBe(422);
		expect((await h.call('PATCH', `/v1/lists/${second.json.id}`, { identity: jane, body: {} })).status).toBe(422);
		expect((await h.call('PATCH', `/v1/lists/${second.json.id}`, { identity: jane, body: { notify: 'yes' } })).status).toBe(
			422,
		);
		// deleting the default list promotes the oldest remaining one
		const removed = await h.call('DELETE', `/v1/lists/${first.json.id}`, { identity: jane });
		expect(removed.json).toEqual({ id: first.json.id, deleted: true });
		expect((await h.call('GET', '/v1/lists/default', { identity: jane })).json).toMatchObject({
			id: second.json.id,
			isDefault: true,
		});
		expect((await h.call('DELETE', `/v1/lists/${first.json.id}`, { identity: jane })).status).toBe(404);
		expect((await h.call('GET', '/v1/lists/wl_missing', { identity: jane })).status).toBe(404);
	});

	it('keeps customers apart and lets the merchant’s server act for any of them', async () => {
		h = await createHarness();
		const jane = await h.login('cus_jane');
		const bob = await h.login('cus_bob');
		const list = (await h.call('POST', '/v1/lists', { identity: jane, body: { name: 'Mine' } })).json;
		expect((await h.call('GET', `/v1/lists/${list.id}`, { identity: bob })).status).toBe(404);
		expect((await h.call('POST', `/v1/lists/${list.id}/items`, { identity: bob, body: item() })).status).toBe(404);
		expect((await h.call('DELETE', `/v1/lists/${list.id}`, { identity: bob })).status).toBe(404);
		// the other website never sees it
		const pk2 = await h.key('pk', WEBSITE_2);
		expect((await h.call('GET', `/v1/lists/${list.id}`, { key: pk2, identity: jane })).status).toBe(404);
		// server key: merchant-wide reads (owner revealed) and acting for a named customer
		const all = await h.call('GET', '/v1/lists', { key: h.sk });
		expect(all.json.items).toEqual([expect.objectContaining({ id: list.id, owner: { kind: 'customer', id: 'cus_jane' } })]);
		expect((await h.call('GET', '/v1/lists?customerId=cus_bob', { key: h.sk })).json.items).toEqual([]);
		expect((await h.call('GET', '/v1/lists?customerId=bad%20id', { key: h.sk })).status).toBe(422);
		const made = await h.call('POST', '/v1/lists', { key: h.sk, body: { customerId: 'cus_bob', name: 'From the server' } });
		expect(made.status).toBe(201);
		expect((await h.call('POST', '/v1/lists', { key: h.sk, body: { name: 'Nobody' } })).status).toBe(422);
		const saved = await h.call('POST', '/v1/lists/default/items', { key: h.sk, body: { ...item(), customerId: 'cus_bob' } });
		expect(saved.json.list.id).toBe(made.json.id);
		expect((await h.call('POST', '/v1/lists/default/items', { key: h.sk, body: item() })).status).toBe(404);
		const adminAdd = await h.call('POST', `/v1/lists/${list.id}/items`, { key: h.sk, body: item({ itemId: 'itm_9' }) });
		expect(adminAdd.json.list.owner).toEqual({ kind: 'customer', id: 'cus_jane' });
		// pagination with a compound cursor
		const first = await h.call('GET', '/v1/lists?limit=1', { key: h.sk });
		expect(first.json.hasMore).toBe(true);
		const next = await h.call('GET', `/v1/lists?limit=1&cursor=${encodeURIComponent(first.json.nextCursor)}`, { key: h.sk });
		expect(next.json.items[0].id).not.toBe(first.json.items[0].id);
	});

	it('removes items, evicts the oldest or refuses when full, and refuses bad items', async () => {
		h = await createHarness({ config: { lists: { max_items_per_list: 2 } } });
		const jane = await h.login('cus_jane');
		const a = await h.call('POST', '/v1/lists/default/items', { identity: jane, body: item({ itemId: 'a' }) });
		h.clock.advance(1000);
		await h.call('POST', '/v1/lists/default/items', { identity: jane, body: item({ itemId: 'b' }) });
		h.clock.advance(1000);
		const c = await h.call('POST', '/v1/lists/default/items', { identity: jane, body: item({ itemId: 'c' }) });
		expect(c.json.evicted).toEqual([a.json.entryId]);
		expect(c.json.list.items.map((/** @type {any} */ e) => e.itemId)).toEqual(['c', 'b']);
		const removed = await h.call('DELETE', `/v1/lists/${c.json.list.id}/items/${c.json.entryId}`, { identity: jane });
		expect(removed.json).toMatchObject({ removed: true, list: { itemCount: 1 } });
		expect((await h.call('DELETE', `/v1/lists/${c.json.list.id}/items/${c.json.entryId}`, { identity: jane })).status).toBe(
			404,
		);
		const bad = await h.call('POST', '/v1/lists/default/items', {
			identity: jane,
			body: { itemId: 'has space', price: { amount: -1 } },
		});
		expect(bad.status).toBe(422);
		expect(bad.json.errors.map((/** @type {any} */ e) => e.path)).toEqual(['/itemId', '/price']);
		await h.entitle({ config: { lists: { max_items_per_list: 1, when_full: 'refuse' } } });
		const full = await h.call('POST', '/v1/lists/default/items', { identity: jane, body: item({ itemId: 'z' }) });
		expect(full.status).toBe(409);
	});

	it('refuses browsers without a login when guest lists are off, and refuses forged logins', async () => {
		h = await createHarness({ elements: { guest_merge: false } });
		const none = await h.call('POST', '/v1/lists/default/items', { body: item() });
		expect(none.status).toBe(401);
		expect(none.json.type).toMatch(/\/problems\/identity_required$/);
		expect((await h.call('GET', '/v1/lists')).status).toBe(401);
		const forged = await h.call('GET', '/v1/lists', { identity: 'eyJhbGciOiJub25lIn0.e30.' });
		expect(forged.status).toBe(401);
		expect(forged.json.type).toMatch(/\/problems\/identity_invalid$/);
		expect((await h.call('POST', '/v1/guests', { body: {} })).status).toBe(403);
	});

	it('switching the element off answers 403 in every route of it', async () => {
		h = await createHarness({ elements: { lists: false } });
		const jane = await h.login('cus_jane');
		expect((await h.call('GET', '/v1/lists', { identity: jane })).status).toBe(403);
		expect((await h.call('POST', '/v1/lists/default/items', { identity: jane, body: item() })).status).toBe(403);
	});
});

describe('guests and merge', () => {
	it('keeps a guest list under a signed token and merges it into the account on sign-in', async () => {
		h = await createHarness({ config: { guest_merge: { guest_ttl_days: 10 } } });
		const token = await h.guest();
		expect(token).toMatch(/^wg1\./);
		const saved = await h.call('POST', '/v1/lists/default/items', { body: { ...item({ itemId: 'a' }), guest: token } });
		expect(saved.status).toBe(201);
		expect(saved.json.list.owner).toEqual({ kind: 'guest' });
		const named = await h.call('POST', '/v1/lists', { body: { name: 'Ideas', guest: token } });
		await h.call('POST', `/v1/lists/${named.json.id}/items`, { body: { ...item({ itemId: 'b' }), guest: token } });
		const doc = await h.collection('lists').findOne({ id: saved.json.list.id });
		expect(doc?.expiresAt?.getTime()).toBe(h.clock.now() + 10 * 86_400_000);
		expect(JSON.stringify(doc)).not.toContain('@');
		expect((await h.call('POST', '/v1/lists/default/items', { body: { ...item(), guest: 'wg1.x.y' } })).status).toBe(401);
		expect((await h.call('PATCH', `/v1/lists/${named.json.id}`, { body: { notify: true, guest: token } })).status).toBe(401);
		// a guest token of another website is refused there
		const pk2 = await h.key('pk', WEBSITE_2);
		expect((await h.call('POST', '/v1/lists/default/items', { key: pk2, body: { ...item(), guest: token } })).status).toBe(401);

		const jane = await h.login('cus_jane');
		await h.call('POST', '/v1/lists/default/items', { identity: jane, body: item({ itemId: 'a', title: 'Mine' }) });
		const merged = await h.call('POST', '/v1/guests:merge', { identity: jane, body: { guest: token } });
		expect(merged.status, merged.text).toBe(200);
		expect(merged.json).toEqual({ merged: 1, lists: 0 });
		const lists = (await h.call('GET', '/v1/lists/default', { identity: jane })).json;
		expect(lists.items.map((/** @type {any} */ e) => `${e.itemId}:${e.title}`).sort()).toEqual(['a:Mine', 'b:Linen shirt']);
		expect(await h.collection('lists').countDocuments({ ownerKind: 'guest' })).toBe(0);
		// repeating is harmless
		expect((await h.call('POST', '/v1/guests:merge', { identity: jane, body: { guest: token } })).json).toEqual({
			merged: 0,
			lists: 0,
		});
		expect((await h.call('POST', '/v1/guests:merge', { identity: jane, body: { guest: 'nope' } })).status).toBe(401);
		expect((await h.call('POST', '/v1/guests:merge', { body: { guest: token } })).status).toBe(401);
		expect((await h.call('POST', '/v1/guests:merge', { key: h.sk, body: { guest: token } })).status).toBe(422);
	});

	it('keeps guest lists as their own lists with keep_lists, and lets a server merge for a customer', async () => {
		h = await createHarness({ config: { guest_merge: { merge_strategy: 'keep_lists' } } });
		const token = await h.guest();
		await h.call('POST', '/v1/lists/default/items', { body: { ...item({ itemId: 'a' }), guest: token } });
		const ideas = await h.call('POST', '/v1/lists', { body: { name: 'Ideas', guest: token } });
		await h.call('POST', `/v1/lists/${ideas.json.id}/items`, { body: { ...item({ itemId: 'b' }), guest: token } });
		const merged = await h.call('POST', '/v1/guests:merge', { key: h.sk, body: { guest: token, customerId: 'cus_srv' } });
		expect(merged.json).toEqual({ merged: 2, lists: 1 });
		const lists = (await h.call('GET', '/v1/lists?customerId=cus_srv', { key: h.sk })).json.items;
		expect(lists.map((/** @type {any} */ l) => [l.name, l.itemCount]).sort()).toEqual([
			['Ideas', 1],
			['Wishlist', 1],
		]);
	});

	it('limits new guest tokens per visitor IP', async () => {
		h = await createHarness({ config: { guest_merge: { max_guests_per_ip_per_hour: 1 } } });
		const headers = { 'x-forwarded-for': '203.0.113.7' };
		expect((await h.call('POST', '/v1/guests', { body: {}, headers })).status).toBe(201);
		expect((await h.call('POST', '/v1/guests', { body: {}, headers })).status).toBe(429);
		expect((await h.call('POST', '/v1/guests', { body: {}, headers: { 'x-forwarded-for': '203.0.113.8' } })).status).toBe(201);
		expect((await h.call('POST', '/v1/guests', { key: h.sk, body: {}, headers })).status).toBe(201);
	});

	it('limits writes per customer', async () => {
		h = await createHarness({ config: { lists: { max_writes_per_minute: 2 } } });
		const jane = await h.login('cus_jane');
		for (const itemId of ['a', 'b'])
			expect((await h.call('POST', '/v1/lists/default/items', { identity: jane, body: item({ itemId }) })).status).toBe(201);
		expect((await h.call('POST', '/v1/lists/default/items', { identity: jane, body: item({ itemId: 'c' }) })).status).toBe(429);
		const bob = await h.login('cus_bob');
		expect((await h.call('POST', '/v1/lists/default/items', { identity: bob, body: item({ itemId: 'c' }) })).status).toBe(201);
	});
});
