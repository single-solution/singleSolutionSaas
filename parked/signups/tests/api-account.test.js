/**
 * Profiles, magic links, account pages, consent, data rights, order events, the daily job and the dashboard API — through the real routes on MongoDB.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, WEBSITE } from './harness.js';

const DAY = 24 * 3_600_000;

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
beforeAll(async () => {
	h = await createHarness({
		config: { account_pages: { pages: ['profile', 'addresses', 'sessions', 'orders', 'consents', 'data'] } },
	});
});
afterAll(async () => h?.close());

describe('customers (server API)', () => {
	it('imports, lists, reads, updates, blocks and deletes customers with sk_ keys only', async () => {
		expect((await h.call('GET', '/v1/customers')).status).toBe(403);
		const created = await h.call('POST', '/v1/customers', {
			key: h.sk,
			body: {
				email: 'Import@Example.com',
				phone: '+1 415 555 0100',
				externalId: 'crm-42',
				verified: { email: true },
				profile: { given_name: 'Ida' },
			},
		});
		expect(created.status).toBe(201);
		expect(Object.keys(created.json).sort()).toEqual(['createdAt', 'id', 'status']); // no personal data in the answer
		const id = created.json.id;
		expect((await h.call('GET', `/v1/customers/${id}`, { key: h.sk })).json).toMatchObject({
			email: 'import@example.com',
			phone: '+14155550100',
			externalId: 'crm-42',
			verified: { email: 'verified', phone: 'unverified' },
		});
		const duplicate = await h.call('POST', '/v1/customers', { key: h.sk, body: { email: 'import@example.com' } });
		expect(duplicate.status).toBe(409);
		// a repeated Idempotency-Key is refused; a request without one runs normally
		const once = await h.call('POST', '/v1/customers', {
			key: h.sk,
			idempotencyKey: 'idk-once',
			body: { email: 'once@example.com' },
		});
		expect(once.status).toBe(201);
		const again = await h.call('POST', '/v1/customers', {
			key: h.sk,
			idempotencyKey: 'idk-once',
			body: { email: 'twice@example.com' },
		});
		expect(again.status).toBe(409);
		expect(again.json.type).toMatch(/duplicate_request$/);
		const keyless = await h.call('POST', '/v1/customers', {
			key: h.sk,
			idempotencyKey: null,
			body: { email: 'keyless@example.com' },
		});
		expect(keyless.status).toBe(201);
		const invalid = await h.call('POST', '/v1/customers', { key: h.sk, body: { email: 'nope', profile: { unknown: 1 } } });
		expect(invalid.json.errors.map((/** @type {any} */ e) => e.path)).toEqual(['/email', '/profile/unknown']);
		expect(
			(await h.call('GET', '/v1/customers?email=IMPORT@example.com', { key: h.sk })).json.items.map(
				(/** @type {any} */ c) => c.id,
			),
		).toEqual([id]);
		expect((await h.call('GET', '/v1/customers?phone=%2B14155550100', { key: h.sk })).json.items).toHaveLength(1);
		expect((await h.call('GET', '/v1/customers?email=bad', { key: h.sk })).json.items).toEqual([]);
		expect((await h.call('GET', `/v1/customers/${id}`, { key: h.sk })).json.id).toBe(id);
		expect((await h.call('GET', '/v1/customers/cus_none', { key: h.sk })).status).toBe(404);
		const patched = await h.call('PATCH', `/v1/customers/${id}`, {
			key: h.sk,
			body: {
				profile: { family_name: 'Lovelace' },
				custom: { tier: 'vip' },
				addresses: [{ line1: '1 Way', city: 'Oslo', country: 'NO' }],
			},
		});
		expect(patched.json).toMatchObject({ profile: { given_name: 'Ida', family_name: 'Lovelace' }, custom: { tier: 'vip' } });
		expect(patched.json.addresses[0]).toMatchObject({ line1: '1 Way', country: 'NO', is_default: true });
		expect(h.published('customer.updated@1').at(-1)?.data.changed).toEqual(['profile.family_name', 'addresses', 'custom']);
		expect((await h.call('PATCH', `/v1/customers/${id}`, { key: h.sk, body: { status: 'gone' } })).status).toBe(422);
		const blocked = await h.call('PATCH', `/v1/customers/${id}`, { key: h.sk, body: { status: 'blocked' } });
		expect(blocked.json.status).toBe('blocked');
		// a blocked customer gets the uniform answer, then account_blocked only after proving control
		const before = h.gateway.messages.length;
		const decoy = await h.call('POST', '/v1/otp', { body: { channel: 'email', to: 'import@example.com' } });
		expect(decoy.status).toBe(202);
		expect(h.gateway.messages.length).toBe(before); // decoy: nothing is sent
		const guess = await h.call('POST', `/v1/otp/${decoy.json.challengeId}/verify`, { body: { code: '123456' } });
		expect(guess.json.type).toMatch(/code_invalid$/);
		const removed = await h.call('DELETE', `/v1/customers/${id}`, { key: h.sk });
		expect(removed.json).toEqual({ id, deleted: true });
		const after = await h.collection('customers').findOne({ websiteId: WEBSITE, id });
		expect(after).toMatchObject({ email: null, phone: null, status: 'deleted', profile: {} });
		expect((await h.call('DELETE', `/v1/customers/${id}`, { key: h.sk })).status).toBe(404);
		expect((await h.call('PATCH', `/v1/customers/${id}`, { key: h.sk, body: {} })).status).toBe(404);
		// pagination
		for (const n of [1, 2, 3]) await h.call('POST', '/v1/customers', { key: h.sk, body: { profile: { given_name: `P${n}` } } });
		const first = await h.call('GET', '/v1/customers?limit=2', { key: h.sk });
		expect(first.json.hasMore).toBe(true);
		const second = await h.call('GET', `/v1/customers?limit=2&cursor=${encodeURIComponent(first.json.nextCursor)}`, {
			key: h.sk,
		});
		expect(second.json.items.length).toBeGreaterThan(0);
		expect(
			second.json.items.some((/** @type {any} */ c) => first.json.items.some((/** @type {any} */ f) => f.id === c.id)),
		).toBe(false);
	});
});

describe('profile and identifiers', () => {
	it('lets the signed-in customer edit the profile against the field schema and link a verified phone', async () => {
		await h.entitle({
			config: {
				otp: { channels: ['email', 'sms'] },
				profile: {
					fields: [
						{ key: 'given_name', type: 'text', required: true },
						{ key: 'birthday', type: 'date' },
						{ key: 'newsletter', type: 'boolean' },
					],
				},
				account_pages: { pages: ['profile', 'addresses', 'sessions', 'orders', 'consents', 'data'] },
			},
		});
		const signedIn = await h.signIn('profile@example.com');
		const token = signedIn.json.tokens.accessToken;
		expect(signedIn.json.customer.missingFields).toEqual(['given_name']);
		const bad = await h.call('PATCH', '/v1/profile', {
			token,
			body: { profile: { birthday: '31/12/1990', newsletter: 'yes' } },
		});
		expect(bad.json.errors.map((/** @type {any} */ e) => [e.path, e.code])).toEqual([
			['/profile/birthday', 'format'],
			['/profile/newsletter', 'type'],
		]);
		const good = await h.call('PATCH', '/v1/profile', {
			token,
			body: { profile: { given_name: 'Pia', birthday: '1990-12-31' } },
		});
		expect(good.json).toMatchObject({ profile: { given_name: 'Pia', birthday: '1990-12-31' }, missingFields: [] });
		const unchanged = await h.call('PATCH', '/v1/profile', { token, body: {} });
		expect(unchanged.status).toBe(200);
		// link a phone: the code goes to the phone, verification attaches it to the signed-in customer
		const sent = await h.call('POST', '/v1/otp', { token, body: { channel: 'sms', to: '+4915112345678', purpose: 'link' } });
		expect(sent.status).toBe(202);
		const linked = await h.call('POST', `/v1/otp/${sent.json.challengeId}/verify`, {
			body: { code: h.gateway.code('+4915112345678') },
		});
		expect(linked.json.customer).toMatchObject({ phone: '+4915112345678', verified: { phone: 'verified', email: 'verified' } });
		expect((await h.call('POST', '/v1/otp', { body: { channel: 'sms', to: '+4915112345679', purpose: 'link' } })).status).toBe(
			401,
		);
		// a phone owned by another customer cannot be linked
		const other = await h.signIn('+4915199999999', { channel: 'sms' });
		h.clock.advance(61_000);
		const steal = await h.call('POST', '/v1/otp', {
			token: other.json.tokens.accessToken,
			body: { channel: 'sms', to: '+4915112345678', purpose: 'link' },
		});
		const refused = await h.call('POST', `/v1/otp/${steal.json.challengeId}/verify`, {
			body: { code: h.gateway.code('+4915112345678') },
		});
		expect(refused.status).toBe(409);
		expect(refused.json.type).toMatch(/identifier_in_use$/);
		const viaServer = await h.call('GET', `/v1/profile?customerId=${signedIn.json.customer.id}`, { key: h.sk });
		expect(viaServer.json.profile.given_name).toBe('Pia');
		await h.entitle();
	});
});

describe('magic links', () => {
	it('e-mails a single-use link back to the website and signs in from its fragment token', async () => {
		const sent = await h.call('POST', '/v1/magic-links', {
			body: { email: 'link@example.com', redirect: 'https://shop.example.com/account?x=1' },
		});
		expect(sent.status).toBe(202);
		expect(sent.json.challengeId).toMatch(/^mlk_/);
		const message = h.gateway.last('link@example.com');
		expect(message).toMatchObject({ channel: 'email', purpose: 'magic_link' });
		expect(message?.variables.link).toMatch(/^https:\/\/shop\.example\.com\/account\?x=1#ss_magic=ml1\./);
		const token = h.gateway.linkToken('link@example.com');
		const used = await h.call('POST', '/v1/magic-links:consume', { body: { token } });
		expect(used.status).toBe(200);
		expect(used.json).toMatchObject({
			created: true,
			customer: { email: 'link@example.com', verified: { email: 'verified' } },
		});
		expect((await h.call('POST', '/v1/magic-links:consume', { body: { token } })).json.type).toMatch(/link_invalid$/);
		await h.signups.product.usage.flush();
		expect(h.portal.usage.has(`magic_link_send:${sent.json.challengeId}`)).toBe(true);
	});

	it('refuses redirects off the website, wrong tokens, expired links and other devices when bound', async () => {
		for (const redirect of [
			'https://evil.example.net/',
			'http://shop.example.com/',
			'https://user@shop.example.com/',
			'https://shop.example.com:8443/',
			'javascript:alert(1)',
		])
			expect((await h.call('POST', '/v1/magic-links', { body: { email: 'r@example.com', redirect } })).json.type).toMatch(
				/redirect_not_allowed$/,
			);
		await h.entitle({ config: { magic_link: { allowed_paths: ['/account'], bind_device: true } } });
		expect(
			(
				await h.call('POST', '/v1/magic-links', {
					body: { email: 'r@example.com', redirect: 'https://shop.example.com/cart' },
				})
			).status,
		).toBe(422);
		await h.call('POST', '/v1/magic-links', {
			body: { email: 'bound@example.com', redirect: 'https://shop.example.com/account', deviceId: 'device-bound-01' },
		});
		const token = h.gateway.linkToken('bound@example.com');
		expect(
			(await h.call('POST', '/v1/magic-links:consume', { body: { token, deviceId: 'device-other-02' } })).json.type,
		).toMatch(/link_invalid$/);
		expect(
			(
				await h.call('POST', '/v1/magic-links:consume', {
					body: { token: `${token.slice(0, -4)}AAAA`, deviceId: 'device-bound-01' },
				})
			).status,
		).toBe(422);
		expect((await h.call('POST', '/v1/magic-links:consume', { body: { token, deviceId: 'device-bound-01' } })).status).toBe(
			200,
		);
		await h.entitle();
		await h.call('POST', '/v1/magic-links', { body: { email: 'late@example.com' } });
		expect(h.gateway.last('late@example.com')?.variables.link).toMatch(/^https:\/\/shop\.example\.com\/#ss_magic=/);
		h.clock.advance(16 * 60_000);
		expect(
			(await h.call('POST', '/v1/magic-links:consume', { body: { token: h.gateway.linkToken('late@example.com') } })).json
				.type,
		).toMatch(/link_expired$/);
		expect((await h.call('POST', '/v1/magic-links:consume', { body: { token: 'garbage' } })).json.type).toMatch(
			/link_invalid$/,
		);
		expect((await h.call('POST', '/v1/magic-links', { body: { email: 'bad' } })).json.type).toMatch(/identifier_invalid$/);
	});
});

describe('account pages, orders, consent and data rights', () => {
	it('serves the account view with orders from the Event Hub', async () => {
		const signedIn = await h.signIn('account@example.com');
		const customerId = signedIn.json.customer.id;
		expect(
			(
				await h.deliver('order.placed@1', {
					orderId: 'ord_a1',
					number: '1001',
					customerId,
					currency: 'EUR',
					lines: [{ itemId: 'i', quantity: 1, unitAmount: 500 }],
					amounts: { subtotal: 500, total: 500 },
				})
			).status,
		).toBe(200);
		await h.deliver('order.completed@1', { orderId: 'ord_a1' });
		await h.deliver('order.placed@1', {
			orderId: 'ord_a2',
			customer: { subject: customerId },
			currency: 'EUR',
			lines: [{ itemId: 'i', quantity: 1, unitAmount: 100 }],
			amounts: { subtotal: 100, total: 100 },
		});
		await h.deliver('order.refunded@1', { orderId: 'ord_a2', amount: { amount: 100, currency: 'EUR' } });
		const view = await h.call('GET', '/v1/account', { token: signedIn.json.tokens.accessToken });
		expect(view.status).toBe(200);
		expect(view.json.pages).toEqual(['profile', 'addresses', 'sessions', 'orders', 'consents', 'data']);
		expect(view.json.orders.map((/** @type {any} */ o) => [o.orderId, o.status])).toEqual(
			expect.arrayContaining([
				['ord_a1', 'completed'],
				['ord_a2', 'refunded'],
			]),
		);
		expect(view.json.orders.find((/** @type {any} */ o) => o.orderId === 'ord_a1')).toMatchObject({
			number: '1001',
			totalAmount: 500,
			currency: 'EUR',
		});
		expect(view.json.sessions[0].current).toBe(true);
		expect(view.json.data).toEqual({ export: true, delete: true, pendingDeletion: null });
		expect((await h.call('GET', '/v1/account', { key: h.sk, headers: {} })).status).toBe(422);
		expect((await h.call('GET', `/v1/account?customerId=${customerId}`, { key: h.sk })).status).toBe(401);
	});

	it('records consents from the account and lists them', async () => {
		await h.entitle({
			config: { consent: { documents: [{ key: 'privacy', version: '3', title: 'Privacy', required: false }] } },
		});
		const signedIn = await h.signIn('consent@example.com');
		const token = signedIn.json.tokens.accessToken;
		const before = await h.call('GET', '/v1/consents', { token });
		expect(before.json.documents[0]).toMatchObject({ key: 'privacy', accepted: null });
		expect((await h.call('POST', '/v1/consents', { token, body: { consents: [{ key: 'nope', version: '1' }] } })).status).toBe(
			422,
		);
		expect((await h.call('POST', '/v1/consents', { token, body: {} })).status).toBe(422);
		const accepted = await h.call('POST', '/v1/consents', { token, body: { consents: [{ key: 'privacy', version: '3' }] } });
		expect(accepted.json.documents[0].accepted).toMatchObject({ version: '3', current: true });
		expect(accepted.json.history[0]).toMatchObject({ key: 'privacy', method: 'account' });
		await h.entitle();
	});

	it('exports at once and deletes after the cooling-off period (cancellable), via the daily job', async () => {
		const signedIn = await h.signIn('rights@example.com');
		const token = signedIn.json.tokens.accessToken;
		const exported = await h.call('POST', '/v1/data-requests', { token, body: { type: 'export' } });
		expect(exported.status).toBe(201);
		expect(exported.json).toMatchObject({
			type: 'export',
			status: 'completed',
			download: `/v1/data-requests/${exported.json.id}/export`,
		});
		expect(JSON.stringify(exported.json)).not.toContain('rights@example.com');
		const download = await h.call('GET', exported.json.download, { token });
		expect(download.json.customer.email).toBe('rights@example.com');
		expect(JSON.stringify(download.json)).not.toContain('refreshHash');
		const stranger = await h.signIn('stranger-rights@example.com', { headers: { 'x-forwarded-for': '203.0.113.99' } });
		expect((await h.call('GET', exported.json.download, { token: stranger.json.tokens.accessToken })).status).toBe(404);
		const deletion = await h.call('POST', '/v1/data-requests', { token, body: { type: 'delete' } });
		expect(deletion.json).toMatchObject({ type: 'delete', status: 'pending' });
		expect((await h.call('POST', '/v1/data-requests', { token, body: { type: 'delete' } })).json.type).toMatch(
			/data_request_pending$/,
		);
		const cancelled = await h.call('DELETE', `/v1/data-requests/${deletion.json.id}`, { token });
		expect(cancelled.json.status).toBe('cancelled');
		expect((await h.call('DELETE', `/v1/data-requests/${deletion.json.id}`, { token })).status).toBe(409);
		expect((await h.call('DELETE', '/v1/data-requests/dsr_none', { token })).status).toBe(404);
		const again = await h.call('POST', '/v1/data-requests', { token, body: { type: 'delete' } });
		expect((await h.call('GET', '/v1/data-requests', { token })).json.items).toHaveLength(3);
		h.clock.advance(61 * 60_000);
		expect(
			(await h.call('GET', exported.json.download, { token: (await h.signIn('rights@example.com')).json.tokens.accessToken }))
				.status,
		).toBe(410);
		h.clock.advance(15 * DAY);
		await h.entitle();
		// listing the customer is a read: the due deletion runs first
		const listed = await h.call('GET', '/v1/customers?email=rights@example.com', { key: h.sk });
		expect(listed.json.items).toEqual([expect.objectContaining({ id: signedIn.json.customer.id, status: 'deleted' })]);
		const customer = await h.collection('customers').findOne({ websiteId: WEBSITE, id: signedIn.json.customer.id });
		expect(customer).toMatchObject({ status: 'deleted', email: null });
		expect((await h.collection('data_requests').findOne({ websiteId: WEBSITE, id: again.json.id }))?.status).toBe('completed');
		expect((await h.call('GET', '/v1/profile', { token })).status).toBe(401);
		// the same e-mail can sign up again as a new customer
		const fresh = await h.signIn('rights@example.com');
		expect(fresh.json.created).toBe(true);
	});

	it('deletes a customer whose cooling-off ended when accessed, and from the dashboard button', async () => {
		/** @param {string} email @param {string} ip */
		const requestDeletion = async (email, ip) => {
			const signedIn = await h.signIn(email, { headers: { 'x-forwarded-for': ip } });
			const token = signedIn.json.tokens.accessToken;
			const deletion = await h.call('POST', '/v1/data-requests', { token, body: { type: 'delete' } });
			expect(deletion.json.status).toBe('pending');
			return { id: signedIn.json.customer.id, request: deletion.json.id, token };
		};
		const read = await requestDeletion('due-read@example.com', '203.0.113.31');
		const again = await requestDeletion('due-signin@example.com', '203.0.113.32');
		const cancel = await requestDeletion('due-cancel@example.com', '203.0.113.33');
		const background = await requestDeletion('due-background@example.com', '203.0.113.34');
		h.clock.advance(15 * DAY);
		await h.entitle();
		/** @param {string} id */
		const stored = (id) => h.collection('customers').findOne({ websiteId: WEBSITE, id });

		// the merchant's server reads the customer: the due deletion runs first
		expect((await h.call('GET', `/v1/customers/${read.id}`, { key: h.sk })).json).toMatchObject({ status: 'deleted' });
		expect(await stored(read.id)).toMatchObject({ status: 'deleted', email: null });
		expect((await h.collection('data_requests').findOne({ websiteId: WEBSITE, id: read.request }))?.status).toBe('completed');
		// signing in again: the old account is deleted and a new customer is created
		const fresh = await h.signIn('due-signin@example.com', { headers: { 'x-forwarded-for': '203.0.113.35' } });
		expect(fresh.json.created, JSON.stringify(fresh.json)).toBe(true);
		expect(fresh.json.customer.id).not.toBe(again.id);
		expect(await stored(again.id)).toMatchObject({ status: 'deleted' });
		// a due deletion can no longer be cancelled
		expect((await h.call('DELETE', `/v1/data-requests/${cancel.request}?customerId=${cancel.id}`, { key: h.sk })).status).toBe(
			404,
		);
		expect(await stored(cancel.id)).toMatchObject({ status: 'deleted' });

		// nothing runs by itself: the dashboard's "Run due deletions" button deletes the rest
		expect((await stored(background.id))?.status).toBe('active');
		const press = async (/** @type {any} */ kind, /** @type {Record<string, unknown>} */ scope) => {
			const { token } = await h.portal.issueLaunch({
				kind,
				subject: 'usr_1',
				user: { id: 'usr_1' },
				scope,
				subscriptions: [],
			});
			const sso = await h.handle(new Request(`https://signups.example.com/sso?launch=${token}`));
			const session = /ss_session=(ses_[^;]+)/.exec(sso.headers.get('set-cookie') ?? '')?.[1];
			return h.call('POST', '/v1/dashboard/deletions:run', { key: null, headers: { authorization: `Bearer ${session}` } });
		};
		const merchant = { merchantId: 'mer_0123456789abcdefghjkmnpq', websiteId: WEBSITE };
		expect((await press('merchant', merchant)).json).toEqual({ deleted: 1 });
		expect(await stored(background.id)).toMatchObject({ status: 'deleted', email: null });
		expect((await press('merchant', merchant)).json).toEqual({ deleted: 0 });
		expect((await press('merchant', { merchantId: 'mer_0123456789abcdefghjkmnpq' })).status).toBe(400);
	});

	it('honours disabled data rights and immediate deletion', async () => {
		await h.entitle({ config: { data_rights: { allow_export: false, allow_delete: true, cooling_off_days: 0 } } });
		const signedIn = await h.signIn('now@example.com');
		const token = signedIn.json.tokens.accessToken;
		expect((await h.call('POST', '/v1/data-requests', { token, body: { type: 'export' } })).json.type).toMatch(/not_allowed$/);
		expect((await h.call('POST', '/v1/data-requests', { token, body: { type: 'nope' } })).status).toBe(422);
		const deleted = await h.call('POST', '/v1/data-requests', { token, body: { type: 'delete' } });
		expect(deleted.json.status).toBe('completed');
		await h.entitle({ config: { data_rights: { allow_delete: false } } });
		const other = await h.signIn('keep@example.com');
		expect(
			(await h.call('POST', '/v1/data-requests', { token: other.json.tokens.accessToken, body: { type: 'delete' } })).json
				.type,
		).toMatch(/not_allowed$/);
		await h.entitle();
	});
});

describe('dashboard API', () => {
	it('answers the overview for merchant and staff admin launches', async () => {
		const { token: launch } = await h.portal.issueLaunch({
			kind: 'merchant',
			subject: 'usr_1',
			user: { id: 'usr_1' },
			scope: { merchantId: 'mer_0123456789abcdefghjkmnpq', websiteId: WEBSITE },
			subscriptions: [],
		});
		const sso = await h.handle(new Request(`https://signups.example.com/sso?launch=${launch}`));
		const session = /ss_session=(ses_[^;]+)/.exec(sso.headers.get('set-cookie') ?? '')?.[1];
		const overview = await h.call('GET', '/v1/dashboard/overview', {
			key: null,
			headers: { authorization: `Bearer ${session}` },
		});
		expect(overview.status).toBe(200);
		expect(overview.json.overview.customers).toBeGreaterThan(0);
		expect(overview.json.issuer.issuer).toBe(`https://signups.example.com/i/${WEBSITE}`);
		const { token: adminLaunch } = await h.portal.issueLaunch({
			kind: 'admin',
			subject: 'stf_1',
			user: { id: 'stf_1' },
			scope: { merchantId: 'mer_0123456789abcdefghjkmnpq', websiteId: WEBSITE },
			subscriptions: [],
		});
		const adminSso = await h.handle(new Request(`https://signups.example.com/sso?launch=${adminLaunch}`));
		const adminSession = /ss_session=(ses_[^;]+)/.exec(adminSso.headers.get('set-cookie') ?? '')?.[1];
		const admin = await h.call('GET', '/v1/dashboard/overview', {
			key: null,
			headers: { authorization: `Bearer ${adminSession}` },
		});
		expect(admin.json.overview.customers).toBe(overview.json.overview.customers);
		const view = await h.call('GET', '/v1/session', { key: null, headers: { authorization: `Bearer ${adminSession}` } });
		expect(view.json).toMatchObject({ kind: 'admin', role: 'platform_admin', user: 'stf_1' });
	});

	it('lists customers for a live dashboard (due deletions of the listed customers run first)', async () => {
		const { resolveDashboard } = await import('../api/dashboard.js');
		const signedIn = await h.signIn('listed-due@example.com', { headers: { 'x-forwarded-for': '203.0.113.77' } });
		await h.call('POST', '/v1/data-requests', { token: signedIn.json.tokens.accessToken, body: { type: 'delete' } });
		h.clock.advance(31 * 24 * 3_600_000);
		await h.entitle();
		const { token } = await h.portal.issueLaunch({
			kind: 'merchant',
			subject: 'usr_1',
			user: { id: 'usr_1' },
			scope: { merchantId: 'mer_0123456789abcdefghjkmnpq', websiteId: WEBSITE },
			subscriptions: [],
		});
		const sso = await h.handle(new Request(`https://signups.example.com/sso?launch=${token}`));
		const session = /ss_session=(ses_[^;]+)/.exec(sso.headers.get('set-cookie') ?? '')?.[1];
		const live = await resolveDashboard({ signups: h.signups, sessionId: session, website: WEBSITE });
		if (live.state !== 'ready') throw new Error(live.state);
		const listed = await live.data.customers({ email: 'listed-due@example.com' });
		expect(listed).toEqual([expect.objectContaining({ id: signedIn.json.customer.id, status: 'deleted' })]);
		expect(await live.data.customers({ email: 'nobody@example.com' })).toEqual([]);
	});
});
