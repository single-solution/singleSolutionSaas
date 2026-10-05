import { describe, expect, it } from 'vitest';
import { createWishlist, createWishlistStore, GUEST_KEY, wishlistClient } from '../headless/wishlist.js';
import en from '../strings/en.json' with { type: 'json' };
import { createStorage, createWishlistClient } from './helpers.js';

const shirt = { itemId: 'itm_1', title: 'Linen shirt', price: { amount: 4900, currency: 'EUR' } };

describe('createWishlist (Mode B)', () => {
	it('toggles a heart optimistically, shares one store between widgets and announces changes', async () => {
		const client = createWishlistClient();
		const local = createStorage();
		const store = createWishlistStore({ client, strings: en, storage: { local }, consent: (c) => c === 'preferences' });
		/** @type {string[]} */
		const emitted = [];
		const heart = createWishlist({ config: { item: shirt }, strings: en, client, store, emit: (name) => emitted.push(name) });
		const page = createWishlist({ config: { view: 'page' }, strings: en, client, store });
		/** @type {any[]} */
		const seen = [];
		heart.subscribe((state) => seen.push(state));
		expect(heart.state()).toMatchObject({ status: 'idle', view: 'heart', saved: false, item: { itemId: 'itm_1' } });
		await Promise.all([heart.actions.load(), page.actions.load()]);
		expect(client.calls.filter(([name]) => name === 'state')).toHaveLength(1);
		expect(local.map.get(GUEST_KEY)).toBe('wg1.new.token');
		expect(heart.state()).toMatchObject({ status: 'ready', canSave: true, signedIn: false });
		const saved = await heart.actions.toggle();
		expect(saved.ok).toBe(true);
		expect(client.calls.at(-1)).toEqual(['add', { listId: 'default', ...shirt, guest: 'wg1.new.token' }]);
		expect(heart.state()).toMatchObject({ saved: true, message: 'Linen shirt saved to your wishlist' });
		expect(seen.some((s) => s.saved === true)).toBe(true);
		expect(page.state().active).toMatchObject({ name: 'Wishlist', items: [{ itemId: 'itm_1', priceText: '€49.00' }] });
		await heart.actions.toggle();
		expect(heart.state()).toMatchObject({ saved: false, message: 'Linen shirt removed from your wishlist' });
		expect(emitted).toEqual(['widgets.saved', 'widgets.removed']);
		expect(heart.strings).toBe(en);
		heart.destroy();
		await page.actions.load();
		expect(heart.state().status).toBe('ready');
	});

	it('keeps the guest token in memory without consent and forgets it on sign-in', async () => {
		const local = createStorage();
		const session = createStorage();
		const guestClient = createWishlistClient({ settings: { storage: 'session' } });
		let granted = false;
		const store = createWishlistStore({ client: guestClient, storage: { local, session }, consent: () => granted });
		await store.load();
		expect(local.map.size + session.map.size).toBe(0);
		granted = true;
		store.consentChanged();
		expect(session.map.get(GUEST_KEY)).toBe('wg1.new.token');
		granted = false;
		store.consentChanged();
		expect(session.map.size).toBe(0);
		// a returning visitor sends the stored token; signing in drops it
		local.setItem(GUEST_KEY, 'wg1.old.token');
		const customer = createWishlistClient({ owner: 'customer', settings: { consentCategory: 'necessary' } });
		const signedIn = createWishlistStore({ client: customer, storage: { local } });
		await signedIn.load();
		expect(customer.calls[0]).toEqual(['state', { guest: 'wg1.old.token' }]);
		expect(local.map.size).toBe(0);
		expect(signedIn.state().owner).toEqual({ kind: 'customer' });
		signedIn.reset();
		expect(signedIn.state()).toMatchObject({ status: 'idle', owner: null });
		// blocked storage never breaks the widget
		const blocked = createWishlistStore({
			client: createWishlistClient(),
			storage: { local: createStorage({ broken: true }) },
			consent: () => true,
		});
		expect((await blocked.load()).ok).toBe(true);
	});

	it('rolls back and explains failures; asks to sign in when nobody can save', async () => {
		const failing = createWishlistClient({ fail: { add: 'limit_reached' } });
		const heart = createWishlist({ config: { item: shirt }, strings: en, client: failing });
		await heart.actions.load();
		const result = await heart.actions.toggle();
		expect(result.ok).toBe(false);
		expect(heart.state()).toMatchObject({ saved: false, message: en['wishlist.error.limit_reached'] });
		const nobody = createWishlist({ config: { item: shirt }, strings: en, client: createWishlistClient({ owner: null }) });
		await nobody.actions.load();
		expect((await nobody.actions.toggle()).ok).toBe(false);
		expect(nobody.state().message).toBe(en['wishlist.error.identity_required']);
		const noItem = createWishlist({ strings: en, client: createWishlistClient() });
		expect(await noItem.actions.toggle()).toEqual({ ok: false, problem: { code: 'no_item' } });
		const down = createWishlist({ strings: en, client: createWishlistClient({ fail: { state: 'element_disabled' } }) });
		await down.actions.load();
		expect(down.state()).toMatchObject({ status: 'error', message: en['wishlist.error.unavailable'] });
		const odd = createWishlistStore({ client: createWishlistClient({ fail: { state: 'boom' } }), strings: en });
		await odd.load();
		expect(odd.state().message).toBe(en['wishlist.error.request_failed']);
		expect(odd.messageOf({ code: 'rate_limited' })).toBe(en['wishlist.error.rate_limited']);
	});

	it('manages lists, opt-in and share links on the page', async () => {
		const client = createWishlistClient({ owner: 'customer' });
		const page = createWishlist({ config: { view: 'page' }, strings: en, client });
		await page.actions.load();
		expect(page.validate({ name: ' ' })).toEqual([
			{ path: '/name', code: 'required', message: en['page.error.name_required'] },
		]);
		expect((await page.actions.createList('  ')).ok).toBe(false);
		expect(page.state().message).toBe(en['page.error.name_required']);
		const made = await page.actions.createList(' Gifts ');
		expect(made.ok && made.value.name).toBe('Gifts');
		const second = await page.actions.createList('Home');
		const giftsId = made.ok ? made.value.id : '';
		const homeId = second.ok ? second.value.id : '';
		expect(page.state().active?.id).toBe(homeId);
		await page.actions.select(giftsId);
		expect(page.state().active?.name).toBe('Gifts');
		await page.store.add(shirt, giftsId);
		const entry = page.state().active?.items[0];
		await page.actions.remove(giftsId, entry?.id ?? '');
		expect(page.state().active?.items).toEqual([]);
		await page.actions.setNotify(giftsId, true);
		expect(page.state().lists.find((l) => l.id === giftsId)?.notify).toBe(true);
		await page.actions.share(giftsId);
		expect(page.state().share).toEqual({ listId: giftsId, url: 'https://shop.example.com/s?t=tok', token: 'tok' });
		expect(page.state().lists.find((l) => l.id === giftsId)?.shared).toBe(true);
		await page.actions.revoke(giftsId);
		expect(page.state()).toMatchObject({ share: null, message: en['page.share.revoked'] });
		await page.actions.deleteList(giftsId);
		expect(page.state().lists.map((l) => l.id)).toEqual([homeId]);
		const broken = createWishlist({
			config: { view: 'page' },
			strings: en,
			client: createWishlistClient({
				owner: 'customer',
				fail: { share: 'share_not_allowed', revoke: 'x', deleteList: 'x', updateList: 'x', createList: 'x', remove: 'x' },
			}),
		});
		await broken.actions.load();
		for (const run of [
			() => broken.actions.share('l'),
			() => broken.actions.revoke('l'),
			() => broken.actions.deleteList('l'),
			() => broken.actions.setNotify('l', true),
			() => broken.actions.createList('x'),
			() => broken.actions.remove('l', 'e'),
		])
			expect((await run()).ok).toBe(false);
	});

	it('loads a shared list read-only, in the shopper’s locale', async () => {
		const client = createWishlistClient();
		const view = createWishlist({ config: { view: 'share', shareToken: 'tok', lang: 'de-DE' }, strings: en, client });
		await view.actions.load();
		expect(view.state()).toMatchObject({
			status: 'ready',
			view: 'share',
			shared: { name: 'Birthday', items: [{ title: 'Mug' }] },
		});
		expect(view.state().shared?.items[0]?.priceText).toMatch(/15,00/);
		const missing = createWishlist({ config: { view: 'share', shareToken: 'nope' }, strings: en, client });
		await missing.actions.load();
		expect(missing.state()).toMatchObject({ status: 'error', shared: null, message: en['share.error.not_found'] });
		const noToken = createWishlist({ config: { view: 'share' }, strings: en, client });
		await noToken.actions.load();
		expect(client.calls.at(-1)).toEqual(['shared', '']);
	});

	it('adapts an @ss/web element API client', async () => {
		/** @type {Array<[string, string, unknown]>} */
		const sent = [];
		const reply = (/** @type {string} */ method) => async (/** @type {string} */ path, /** @type {unknown} */ body) => {
			sent.push([method, path, body]);
			return path.includes('fail')
				? { ok: false, error: { code: 'not_found' } }
				: path.includes('none')
					? { ok: false }
					: { ok: true, value: { path } };
		};
		const client = wishlistClient({ get: reply('GET'), post: reply('POST'), patch: reply('PATCH'), delete: reply('DELETE') });
		expect(await client.state({})).toEqual({ ok: true, value: { path: '/v1/wishlist' } });
		await client.add('default', { itemId: 'a' });
		await client.remove('wl 1', 'e/1', { guest: 'g' });
		await client.createList({ name: 'x' });
		await client.updateList('wl_1', { notify: true });
		await client.deleteList('wl_1', {});
		await client.share({ listId: 'wl_1' });
		await client.revoke({ listId: 'wl_1' });
		expect(await client.shared('fail')).toEqual({ ok: false, problem: { code: 'not_found' } });
		expect(await client.shared('none')).toEqual({ ok: false, problem: { code: 'request_failed' } });
		expect(sent.map(([method, path]) => `${method} ${path}`)).toEqual([
			'POST /v1/wishlist',
			'POST /v1/lists/default/items',
			'DELETE /v1/lists/wl%201/items/e%2F1',
			'POST /v1/lists',
			'PATCH /v1/lists/wl_1',
			'DELETE /v1/lists/wl_1',
			'POST /v1/shares',
			'POST /v1/shares:revoke',
			'GET /v1/shares/fail',
			'GET /v1/shares/none',
		]);
		expect(sent[2]?.[2]).toEqual({ body: { guest: 'g' } });
	});
});
