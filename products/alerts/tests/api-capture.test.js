/** Capture (sign-ups) on MongoDB through the real routes. */
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, WEBSITE } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>> | null} */
let h = null;
afterEach(async () => {
	await h?.close();
	h = null;
});
/** @param {Parameters<typeof createHarness>[0]} [options] */
const harness = async (options) => (h = await createHarness(options));

describe('subscribe', () => {
	it('creates, then updates the active subscription of the same contact, type and target', async () => {
		const t = await harness();
		const first = await t.subscribe({ item: { name: 'Phone', url: 'https://evil.example/x' } }, { key: t.pk });
		expect(first.status).toBe(201);
		expect(first.headers.get('location')).toBe(`/v1/subscriptions/${first.json.id}`);
		expect(first.json.item).toEqual({ name: 'Phone' });
		const again = await t.subscribe({ item: { url: 'https://shop.example.com/p' }, lang: 'de' }, { key: t.pk });
		expect(again.status).toBe(200);
		expect(again.json).toMatchObject({
			id: first.json.id,
			created: false,
			lang: 'de',
			item: { name: 'Phone', url: 'https://shop.example.com/p' },
		});
		const other = await t.subscribe({ variantId: 'v2' }, { key: t.pk });
		expect(other.json.id).not.toBe(first.json.id);
		expect(await t.collection('subscriptions').countDocuments({ websiteId: WEBSITE })).toBe(2);
		const stored = await t.collection('subscriptions').findOne({ websiteId: WEBSITE, id: first.json.id });
		expect(stored).toMatchObject({ consent: { given: true }, source: 'widget', contactKey: expect.stringMatching(/^ck_/) });
		expect(stored?.consent.textVersion).toEqual(expect.any(String));
	});

	it('validates input and contacts', async () => {
		const t = await harness();
		const bad = await t.subscribe({ email: 'nope' }, { key: t.pk });
		expect(bad.status).toBe(422);
		expect(bad.json).toMatchObject({
			type: expect.stringMatching(/contact_invalid$/),
			errors: [{ path: '/email', code: 'contact_invalid' }],
		});
		const consent = await t.subscribe({ consent: false }, { key: t.pk });
		expect(consent.status).toBe(422);
		expect(consent.json.errors).toEqual([{ path: '/consent', code: 'consent_required', message: 'consent required' }]);
		expect((await t.subscribe({ channel: 'sms', phone: '+15550001111' }, { key: t.pk })).json.errors[0].code).toBe(
			'channel_not_enabled',
		);
		expect((await t.subscribe({ type: 'availability' }, { key: t.pk })).json.errors[0].code).toBe('type_not_enabled');
		expect((await t.subscribe({ email: undefined }, { key: t.pk })).json.type).toMatch(/contact_required$/);
		expect((await t.subscribe({ customerId: 'cus_1' }, { key: t.pk })).json.errors[0].code).toBe('server_key_required');
	});

	it('lets servers subscribe any address with a customer id and tier (address revealed)', async () => {
		const t = await harness({ config: { capture: { channels: ['email', 'whatsapp'] } } });
		const created = await t.subscribe({
			consent: undefined,
			channel: 'whatsapp',
			phone: '0044 7700 900123',
			email: undefined,
			customerId: 'cus_9',
			tier: 'gold',
		});
		expect(created.status).toBe(201);
		expect(created.json).toMatchObject({
			contact: { phone: '+447700900123' },
			customerId: 'cus_9',
			tier: 'gold',
			source: 'api',
			consent: { given: false },
		});
	});

	it('takes the address and customer from the website’s own login (bring-your-own identity)', async () => {
		const t = await harness({ identity: true });
		const token = await t.login({ sub: 'cus_42', email: 'login@example.com' });
		const headers = { 'ss-identity': token };
		const created = await t.subscribe({ email: 'typed@example.com' }, { key: t.pk, headers });
		expect(created.status, JSON.stringify(created.json)).toBe(201);
		expect(created.json).toMatchObject({ customerId: 'cus_42', contactMasked: 'l•••@example.com' });
		const mine = await t.call('GET', '/v1/subscriptions', { key: t.pk, headers });
		expect(mine.json.items.map((/** @type {any} */ s) => s.id)).toEqual([created.json.id]);
		expect((await t.call('GET', '/v1/subscriptions', { key: t.pk })).json.items).toEqual([]);
		expect((await t.call('GET', `/v1/subscriptions/${created.json.id}`, { key: t.pk, headers })).status).toBe(200);
		const stranger = { 'ss-identity': await t.login({ sub: 'cus_7', email: 'x@example.com' }) };
		expect((await t.call('GET', `/v1/subscriptions/${created.json.id}`, { key: t.pk, headers: stranger })).status).toBe(404);
		expect((await t.call('DELETE', `/v1/subscriptions/${created.json.id}`, { key: t.pk, headers: stranger })).status).toBe(404);
		const removed = await t.call('DELETE', `/v1/subscriptions/${created.json.id}`, { key: t.pk, headers });
		expect(removed.json).toMatchObject({ status: 'unsubscribed', contact: null });
		expect((await t.call('DELETE', `/v1/subscriptions/als_missing`)).status).toBe(404);
		const byServer = await t.subscribe({ itemId: 'itm_2' });
		expect((await t.call('DELETE', `/v1/subscriptions/${byServer.json.id}`)).json.contact).toEqual({
			email: 'jane@example.com',
		});
	});

	it('requires a login when contact entry is off', async () => {
		const t = await harness({ identity: true, config: { capture: { allow_contact_entry: false } } });
		const guest = await t.subscribe({}, { key: t.pk });
		expect(guest.status).toBe(401);
		expect(guest.json.type).toMatch(/entry_not_allowed$/);
		const signedIn = await t.subscribe(
			{ email: 'other@example.com' },
			{ key: t.pk, headers: { 'ss-identity': await t.login({ sub: 'c1', email: 'me@example.com' }) } },
		);
		expect(signedIn.json.contactMasked).toBe('m•••@example.com');
	});

	it('limits sign-ups per IP, per contact, per contact active and per website', async () => {
		const t = await harness({
			config: {
				capture: {
					max_per_ip_per_hour: 2,
					max_per_contact_per_day: 3,
					max_active_per_contact: 2,
					max_active_subscriptions: 3,
				},
			},
		});
		const ip = { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' };
		expect((await t.subscribe({ itemId: 'a' }, { key: t.pk, headers: ip })).status).toBe(201);
		expect((await t.subscribe({ itemId: 'b' }, { key: t.pk, headers: ip })).status).toBe(201);
		const limited = await t.subscribe({ itemId: 'c' }, { key: t.pk, headers: ip });
		expect(limited.status).toBe(429);
		expect(limited.json.type).toMatch(/rate_limited$/);
		// another IP: the contact still has its active maximum
		const full = await t.subscribe({ itemId: 'c' }, { key: t.pk, headers: { 'x-forwarded-for': '203.0.113.10' } });
		expect(full.status).toBe(409);
		expect(full.json.type).toMatch(/limit_reached$/);
		const daily = await t.subscribe({ itemId: 'd' }, { key: t.pk, headers: { 'x-forwarded-for': '203.0.113.11' } });
		expect(daily.status).toBe(429);
		expect((await t.subscribe({ itemId: 'e', email: 'b@example.com' })).status).toBe(201);
		const website = await t.subscribe({ itemId: 'f', email: 'c@example.com' });
		expect(website.status).toBe(409);
		expect(website.json.detail).toMatch(/website/);
	});

	it('refuses back-in-stock for available items and anchors price drops on the known price', async () => {
		const t = await harness();
		await t.call('POST', '/v1/triggers', { body: { kind: 'inventory', itemId: 'itm_1', quantity: 3 } });
		await t.call('POST', '/v1/triggers', {
			body: { kind: 'price', itemId: 'itm_1', price: { amount: 1000, currency: 'EUR' } },
		});
		const inStock = await t.subscribe({}, { key: t.pk });
		expect(inStock.status).toBe(409);
		expect(inStock.json.type).toMatch(/in_stock$/);
		const tooHigh = await t.subscribe({ type: 'price_drop', threshold: { targetAmount: 1000 } }, { key: t.pk });
		expect(tooHigh.json.errors).toEqual([
			{ path: '/threshold/targetAmount', code: 'not_below_current_price', message: 'not below current price' },
		]);
		const drop = await t.subscribe(
			{ type: 'price_drop', price: { amount: 5, currency: 'EUR' }, threshold: { percent: 10 } },
			{ key: t.pk },
		);
		expect(drop.json).toMatchObject({ priceAtSubscribe: { amount: 1000, currency: 'EUR' }, threshold: { percent: 10 } });
		const unknown = await t.subscribe(
			{ type: 'price_drop', itemId: 'itm_9', price: { amount: 700, currency: 'EUR' } },
			{ key: t.pk },
		);
		expect(unknown.json.priceAtSubscribe).toEqual({ amount: 700, currency: 'EUR' });
	});

	it('honours suppressions: a new browser consent lifts them, servers cannot', async () => {
		const t = await harness();
		const created = await t.subscribe({}, { key: t.pk });
		const repos = (await t.site()).repos;
		await repos.suppressions.add(created.json ? (await repos.subscriptions.get(created.json.id)).contactKey : '', 'test');
		expect((await t.subscribe({ itemId: 'itm_2' })).status).toBe(409);
		const lifted = await t.subscribe({ itemId: 'itm_2' }, { key: t.pk });
		expect(lifted.status).toBe(201);
		const off = await createHarness({ config: { unsubscribe: { resubscribe_lifts_suppression: false } } });
		try {
			const first = await off.subscribe({}, { key: off.pk });
			const offRepos = (await off.site()).repos;
			await offRepos.suppressions.add((await offRepos.subscriptions.get(first.json.id)).contactKey, 'test');
			expect((await off.subscribe({ itemId: 'itm_2' }, { key: off.pk })).status).toBe(409);
		} finally {
			await off.close();
		}
	});

	it('runs double opt-in: unconfirmed → confirmation message → confirmed by POST only', async () => {
		const t = await harness({ config: { capture: { double_opt_in: true } } });
		const created = await t.subscribe({ item: { name: 'Phone' } }, { key: t.pk });
		expect(created.json.status).toBe('unconfirmed');
		expect(t.provider.sent).toHaveLength(1);
		const [confirmation] = t.provider.sent;
		expect(confirmation.subject).toBe('Confirm your alert for Phone');
		const url = /https:\/\/alerts\.example\.com(\/c\/\S+)/.exec(confirmation.text)?.[1] ?? '';
		const page = await t.call('GET', url, { key: null });
		expect(page.status).toBe(200);
		expect(page.text).toContain('Confirm your alert');
		expect((await t.collection('subscriptions').findOne({ websiteId: WEBSITE, id: created.json.id }))?.status).toBe(
			'unconfirmed',
		);
		const done = await t.call('POST', url, {
			key: null,
			raw: '',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
		});
		expect(done.status).toBe(200);
		expect(done.text).toContain('Alert confirmed');
		expect((await t.collection('subscriptions').findOne({ websiteId: WEBSITE, id: created.json.id }))?.status).toBe('pending');
		expect(t.published('alerts.subscribed@1').map((/** @type {any} */ e) => e.data.status)).toEqual(['unconfirmed', 'pending']);
		// confirming again is harmless; the API route works with the same token
		const token = decodeURIComponent(url.slice(3));
		const api = await t.call('POST', '/v1/subscriptions:confirm', { key: t.pk, body: { token } });
		expect(api.json.status).toBe('pending');
		expect((await t.call('POST', '/v1/subscriptions:confirm', { key: t.pk, body: { token: 'nope' } })).json.type).toMatch(
			/token_invalid$/,
		);
		expect((await t.call('GET', '/c/cf1.bad.sig', { key: null })).status).toBe(404);
	});

	it('lists subscriptions for servers with filters and cursors', async () => {
		const t = await harness();
		await t.subscribe({ itemId: 'a' });
		t.clock.advance(1000);
		await t.subscribe({ itemId: 'b', email: 'b@example.com', type: 'price_drop' });
		t.clock.advance(1000);
		await t.subscribe({ itemId: 'c', customerId: 'cus_1' });
		const page = await t.call('GET', '/v1/subscriptions?limit=2');
		expect(page.json.items.map((/** @type {any} */ s) => s.itemId)).toEqual(['c', 'b']);
		const next = await t.call('GET', `/v1/subscriptions?limit=2&cursor=${encodeURIComponent(page.json.nextCursor)}`);
		expect(next.json.items.map((/** @type {any} */ s) => s.itemId)).toEqual(['a']);
		expect((await t.call('GET', '/v1/subscriptions?type=price_drop')).json.items).toHaveLength(1);
		expect((await t.call('GET', '/v1/subscriptions?email=B@example.com')).json.items).toHaveLength(1);
		expect((await t.call('GET', '/v1/subscriptions?customerId=cus_1&status=pending&itemId=c')).json.items).toHaveLength(1);
		expect((await t.call('GET', '/v1/subscriptions?phone=%2B15550001111')).json.items).toHaveLength(0);
		expect((await t.call('GET', '/v1/subscriptions?email=bad')).status).toBe(422);
		expect((await t.call('GET', '/v1/subscriptions/als_missing')).status).toBe(404);
	});

	it('handles concurrent double submits as one subscription', async () => {
		const t = await harness();
		// warm the key revocation cache first: concurrent first requests of a cold instance get 503 from app-kit
		// (platform gap, see README), which is not what this test is about
		await t.call('GET', '/v1/alert-types', { key: t.pk });
		const results = await Promise.all([
			t.subscribe({}, { key: t.pk }),
			t.subscribe({}, { key: t.pk }),
			t.subscribe({}, { key: t.pk }),
		]);
		expect(
			results.every((r) => r.status === 200 || r.status === 201),
			JSON.stringify(results.map((r) => r.json)),
		).toBe(true);
		expect(new Set(results.map((r) => r.json.id)).size).toBe(1);
		expect(await t.collection('subscriptions').countDocuments({ websiteId: WEBSITE })).toBe(1);
	});

	it('is gated by the capture element', async () => {
		const t = await harness({ elements: { capture: false } });
		const refused = await t.subscribe({}, { key: t.pk });
		expect(refused.status).toBe(403);
		expect(refused.json.type).toMatch(/element_disabled$/);
	});
});
