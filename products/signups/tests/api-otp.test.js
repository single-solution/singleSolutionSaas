/**
 * One-time codes through the real routes on MongoDB: delivery through the merchant's messaging connector, hashed codes,
 * atomic attempt budgets, cooldowns and caps, uniform anti-enumeration answers, consent capture, events and usage.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, GATEWAY, WEBSITE } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
beforeAll(async () => {
	h = await createHarness();
});
afterAll(async () => h?.close());

describe('POST /v1/otp', () => {
	it('sends a code through the merchant’s messaging connector and stores only its hash', async () => {
		const sent = await h.call('POST', '/v1/otp', { body: { channel: 'email', to: '  Ada@Example.COM ', locale: 'en' } });
		expect(sent.status).toBe(202);
		expect(sent.json).toMatchObject({
			channel: 'email',
			destination: 'a•••@example.com',
			resendAfter: 60,
			codeLength: 6,
			codeAlphabet: 'numeric',
		});
		expect(sent.json.challengeId).toMatch(/^otp_[0-9a-z]{26}$/);
		const message = h.gateway.last('ada@example.com');
		expect(message).toMatchObject({
			channel: 'email',
			purpose: 'otp',
			lang: 'en',
			reference: sent.json.challengeId,
			_auth: 'Bearer gw-key-123',
		});
		expect(message?._url).toBe(`${GATEWAY}/messages`);
		expect(message?.variables.code).toMatch(/^\d{6}$/);
		expect(message?.text).toContain(message?.variables.code);
		expect(message?.subject).toBe('Your shop.example.com sign-in code');
		const stored = await h.collection('challenges').findOne({ websiteId: WEBSITE, id: sent.json.challengeId });
		expect(stored).toMatchObject({ identifier: 'ada@example.com', attempts: 0, maxAttempts: 5, decoy: false });
		expect(JSON.stringify(stored)).not.toContain(message?.variables.code);
		expect(stored?.codeHash).toMatch(/^[0-9a-f]{64}$/);
		expect(stored?.identityKey).toMatch(/^[0-9a-f]{64}$/);
		expect(stored?.ipKey).toMatch(/^[0-9a-f]{64}$/);
	});

	it('enforces the resend cooldown, then the hourly cap per identity', async () => {
		const to = 'cap@example.com';
		expect((await h.call('POST', '/v1/otp', { body: { channel: 'email', to } })).status).toBe(202);
		const soon = await h.call('POST', '/v1/otp', { body: { channel: 'email', to } });
		expect(soon.status).toBe(429);
		expect(soon.json.type).toMatch(/too_soon$/);
		expect(Number(soon.headers.get('retry-after'))).toBeGreaterThan(0);
		for (let i = 0; i < 4; i += 1) {
			h.clock.advance(61_000);
			expect((await h.call('POST', '/v1/otp', { body: { channel: 'email', to } })).status).toBe(202);
		}
		h.clock.advance(61_000);
		const capped = await h.call('POST', '/v1/otp', { body: { channel: 'email', to } });
		expect(capped.status).toBe(429);
		expect(capped.json.type).toMatch(/send_limit$/);
		h.clock.advance(3_600_000);
	});

	it('refuses disabled channels, invalid identifiers, national numbers without a calling code and disposable domains', async () => {
		expect((await h.call('POST', '/v1/otp', { body: { channel: 'whatsapp', to: '+442071838750' } })).json.type).toMatch(
			/channel_disabled$/,
		);
		expect((await h.call('POST', '/v1/otp', { body: { channel: 'email', to: 'not-an-email' } })).json.type).toMatch(
			/identifier_invalid$/,
		);
		expect((await h.call('POST', '/v1/otp', { body: { channel: 'sms', to: '020 7183 8750' } })).json.type).toMatch(
			/identifier_invalid$/,
		);
		const blocked = await h.call('POST', '/v1/otp', { body: { channel: 'email', to: 'x@mailinator.com' } });
		expect(blocked.status).toBe(422);
		expect(blocked.json.type).toMatch(/identifier_blocked$/);
		const events = await h.call('GET', '/v1/risk-events', { key: h.sk });
		expect(events.json.items.map((/** @type {any} */ e) => e.type)).toContain('identifier_blocked');
		const invalid = await h.call('POST', '/v1/otp', { body: { channel: 'email' } });
		expect(invalid.status).toBe(422);
		expect(invalid.json.errors[0]).toMatchObject({ path: '/to', code: 'required' });
	});

	it('normalises national numbers with the website’s calling code (E.164) and delivers by SMS', async () => {
		await h.entitle({
			config: { otp: { channels: ['email', 'sms', 'whatsapp'], default_calling_code: '+44', trunk_prefix: '0' } },
		});
		const sent = await h.call('POST', '/v1/otp', { body: { channel: 'whatsapp', to: '020 7183 8750' } });
		expect(sent.status).toBe(202);
		expect(sent.json.destination).toBe('+44•••••••750');
		expect(h.gateway.last('+442071838750')).toMatchObject({ channel: 'whatsapp', purpose: 'otp' });
		await h.entitle();
	});

	it('fails cleanly when the gateway refuses (non-2xx or a 2xx error body) and frees the cooldown', async () => {
		h.gateway.failNext({ status: 503 });
		const failed = await h.call('POST', '/v1/otp', { body: { channel: 'email', to: 'gw@example.com' } });
		expect(failed.status).toBe(502);
		expect(failed.json.type).toMatch(/delivery_failed$/);
		h.gateway.failNext({ status: 200, body: { sent: 'false', message: 'no balance' } });
		expect((await h.call('POST', '/v1/otp', { body: { channel: 'email', to: 'gw@example.com' } })).status).toBe(502);
		h.gateway.failNext('throw');
		expect((await h.call('POST', '/v1/otp', { body: { channel: 'email', to: 'gw@example.com' } })).status).toBe(502);
		expect((await h.call('POST', '/v1/otp', { body: { channel: 'email', to: 'gw@example.com' } })).status).toBe(202);
	});
});

describe('POST /v1/otp/{id}/verify', () => {
	it('signs a new customer up, issues tokens, publishes events and records usage once', async () => {
		const result = await h.signIn('new@example.com', { deviceId: 'device-aaaa-1111' });
		expect(result.status).toBe(200);
		expect(result.json.created).toBe(true);
		expect(result.json.customer).toMatchObject({
			email: 'new@example.com',
			verified: { email: 'verified', phone: 'none' },
			status: 'active',
		});
		expect(result.json.tokens).toMatchObject({ tokenType: 'Bearer' });
		expect(result.json.tokens.refreshToken).toMatch(/^rt1\.ses_/);
		const customerId = result.json.customer.id;
		expect(h.published('customer.created@1').at(-1)?.data).toEqual({ customerId, source: 'signups.otp' });
		expect(h.published('signups.customer_created@1').at(-1)?.data).toEqual({ customerId, method: 'otp', channel: 'email' });
		expect(h.published('customer.signed_in@1').at(-1)?.data).toEqual({ customerId, method: 'otp' });
		await h.signups.product.usage.flush();
		expect([...h.portal.usage.values()].filter((u) => u.unit === 'otp_send').length).toBeGreaterThan(0);
		expect(h.portal.usage.has(`otp_send:${result.challengeId}`)).toBe(true);
		// the code is single use
		const again = await h.call('POST', `/v1/otp/${result.challengeId}/verify`, { body: { code: '000000' } });
		expect(again.json.type).toMatch(/code_invalid$/);
		// a second sign-in finds the same customer
		const second = await h.signIn('NEW@example.com');
		expect(second.json).toMatchObject({ created: false, customer: { id: customerId } });
	});

	it('spends one attempt per wrong code (reserved atomically, even in parallel) and exhausts the code', async () => {
		const sent = await h.call('POST', '/v1/otp', { body: { channel: 'email', to: 'guess@example.com' } });
		const code = h.gateway.code('guess@example.com');
		const wrong = code === '111111' ? '222222' : '111111';
		const first = await h.call('POST', `/v1/otp/${sent.json.challengeId}/verify`, { body: { code: wrong } });
		expect(first.status).toBe(422);
		expect(first.json.errors[0]).toEqual({ path: '/code', code: 'attempts_remaining', message: '4' });
		const malformed = await h.call('POST', `/v1/otp/${sent.json.challengeId}/verify`, { body: { code: 'abc' } });
		expect(malformed.json.errors[0].message).toBe('4'); // no attempt spent on a malformed code
		const parallel = await Promise.all(
			Array.from({ length: 8 }, () => h.call('POST', `/v1/otp/${sent.json.challengeId}/verify`, { body: { code: wrong } })),
		);
		expect(parallel.every((r) => r.status === 422)).toBe(true);
		const stored = await h.collection('challenges').findOne({ websiteId: WEBSITE, id: sent.json.challengeId });
		expect(stored?.attempts).toBe(5);
		const right = await h.call('POST', `/v1/otp/${sent.json.challengeId}/verify`, { body: { code } });
		expect(right.json.type).toMatch(/attempts_exhausted$/);
	});

	it('accepts separators in typed codes, refuses expired codes and unknown challenges', async () => {
		const sent = await h.call('POST', '/v1/otp', { body: { channel: 'email', to: 'sep@example.com' } });
		const code = h.gateway.code('sep@example.com');
		const ok = await h.call('POST', `/v1/otp/${sent.json.challengeId}/verify`, {
			body: { code: `${code.slice(0, 3)} - ${code.slice(3)}` },
		});
		expect(ok.status).toBe(200);
		h.clock.advance(61_000);
		const late = await h.call('POST', '/v1/otp', { body: { channel: 'email', to: 'sep@example.com' } });
		h.clock.advance(11 * 60_000);
		const expired = await h.call('POST', `/v1/otp/${late.json.challengeId}/verify`, {
			body: { code: h.gateway.code('sep@example.com') },
		});
		expect(expired.json.type).toMatch(/code_expired$/);
		expect(
			(await h.call('POST', '/v1/otp/otp_00000000000000000000000000/verify', { body: { code: '123456' } })).json.type,
		).toMatch(/code_invalid$/);
		expect((await h.call('POST', '/v1/otp/nope/verify', { body: { code: '123456' } })).json.type).toMatch(/code_invalid$/);
	});

	it('answers identically for unknown identities when sign-up is closed, and the decoy never verifies or sends', async () => {
		await h.signIn('member@example.com');
		await h.entitle({ config: { otp: { allow_signup: false } } });
		h.clock.advance(61_000);
		const before = h.gateway.messages.length;
		const known = await h.call('POST', '/v1/otp', { body: { channel: 'email', to: 'member@example.com' } });
		const unknown = await h.call('POST', '/v1/otp', { body: { channel: 'email', to: 'stranger@example.com' } });
		expect(known.status).toBe(unknown.status);
		expect(Object.keys(unknown.json).sort()).toEqual(Object.keys(known.json).sort());
		expect(h.gateway.messages.length).toBe(before + 1); // only the member got a message
		const guess = await h.call('POST', `/v1/otp/${unknown.json.challengeId}/verify`, { body: { code: '123456' } });
		expect(guess.status).toBe(422);
		expect(guess.json.type).toMatch(/code_invalid$/);
		expect(guess.json.errors[0].message).toBe('4');
		await h.entitle();
	});

	it('requires terms acceptance on sign-up: the code stays valid until the consents are sent', async () => {
		const documents = [
			{ key: 'terms', version: '2026-10', title: 'Terms', url: 'https://shop.example.com/terms', required: true },
		];
		await h.entitle({ config: { consent: { documents } } });
		const sent = await h.call('POST', '/v1/otp', { body: { channel: 'email', to: 'terms@example.com' } });
		const code = h.gateway.code('terms@example.com');
		const missing = await h.call('POST', `/v1/otp/${sent.json.challengeId}/verify`, { body: { code } });
		expect(missing.status).toBe(422);
		expect(missing.json.type).toMatch(/consent_required$/);
		expect(missing.json.errors).toEqual([{ path: '/consents/terms', code: 'required', message: '2026-10' }]);
		const outdated = await h.call('POST', `/v1/otp/${sent.json.challengeId}/verify`, {
			body: { code, consents: [{ key: 'terms', version: '2025-01' }] },
		});
		expect(outdated.json.errors[0]).toMatchObject({ code: 'outdated_version' });
		const accepted = await h.call('POST', `/v1/otp/${sent.json.challengeId}/verify`, {
			body: { code, consents: [{ key: 'terms', version: '2026-10' }] },
		});
		expect(accepted.status).toBe(200);
		expect(accepted.json.customer.consents.terms.version).toBe('2026-10');
		const records = await h
			.collection('consents')
			.find({ websiteId: WEBSITE, customerId: accepted.json.customer.id })
			.toArray();
		expect(records.map((r) => [r.key, r.version, r.method])).toEqual([['terms', '2026-10', 'otp']]);
		// a new version asks again at the next sign-in
		await h.entitle({ config: { consent: { documents: [{ ...documents[0], version: '2027-01' }] } } });
		h.clock.advance(61_000);
		const again = await h.signIn('terms@example.com');
		expect(again.json.type).toMatch(/consent_required$/);
		await h.entitle();
	});

	it('blocks an IP after too many failed verifications (risk velocity)', async () => {
		await h.entitle({ config: { risk: { max_failures_per_ip_hour: 2 } } });
		const headers = { 'x-forwarded-for': '198.51.100.9' };
		const sent = await h.call('POST', '/v1/otp', { body: { channel: 'email', to: 'velo@example.com' }, headers });
		const code = h.gateway.code('velo@example.com');
		const wrong = code === '111111' ? '222222' : '111111';
		for (let i = 0; i < 2; i += 1)
			expect(
				(await h.call('POST', `/v1/otp/${sent.json.challengeId}/verify`, { body: { code: wrong }, headers })).status,
			).toBe(422);
		const blocked = await h.call('POST', `/v1/otp/${sent.json.challengeId}/verify`, { body: { code }, headers });
		expect(blocked.status).toBe(429);
		expect(blocked.json.type).toMatch(/velocity_limit$/);
		await h.entitle();
		h.clock.advance(3_600_000);
	});

	it('limits distinct identities per IP (risk velocity)', async () => {
		await h.entitle({ config: { risk: { max_identities_per_ip_hour: 2 } } });
		const headers = { 'x-forwarded-for': '198.51.100.10' };
		expect((await h.call('POST', '/v1/otp', { body: { channel: 'email', to: 'v1@example.com' }, headers })).status).toBe(202);
		expect((await h.call('POST', '/v1/otp', { body: { channel: 'email', to: 'v2@example.com' }, headers })).status).toBe(202);
		const third = await h.call('POST', '/v1/otp', { body: { channel: 'email', to: 'v3@example.com' }, headers });
		expect(third.status).toBe(429);
		expect(third.json.type).toMatch(/velocity_limit$/);
		h.clock.advance(61_000);
		expect((await h.call('POST', '/v1/otp', { body: { channel: 'email', to: 'v1@example.com' }, headers })).status).toBe(202);
		await h.entitle();
	});

	it('caps the whole website per hour (gateway spend) and per IP', async () => {
		await h.entitle({ config: { otp: { global_sends_per_hour: 2, resend_cooldown_seconds: 0 } } });
		h.clock.advance(3_600_000);
		expect((await h.call('POST', '/v1/otp', { body: { channel: 'email', to: 'g1@example.com' } })).status).toBe(202);
		expect((await h.call('POST', '/v1/otp', { body: { channel: 'email', to: 'g2@example.com' } })).status).toBe(202);
		expect((await h.call('POST', '/v1/otp', { body: { channel: 'email', to: 'g3@example.com' } })).json.type).toMatch(
			/send_limit$/,
		);
		await h.entitle({ config: { otp: { max_sends_per_ip_hour: 1, resend_cooldown_seconds: 0 } } });
		h.clock.advance(3_600_000);
		expect((await h.call('POST', '/v1/otp', { body: { channel: 'email', to: 'i1@example.com' } })).status).toBe(202);
		expect((await h.call('POST', '/v1/otp', { body: { channel: 'email', to: 'i2@example.com' } })).json.type).toMatch(
			/send_limit$/,
		);
		// server keys forward the customer's IP (SS-Client-IP) or skip per-IP limits
		expect(
			(
				await h.call('POST', '/v1/otp', {
					key: h.sk,
					body: { channel: 'email', to: 'i3@example.com' },
					headers: { 'ss-client-ip': '192.0.2.44' },
				})
			).status,
		).toBe(202);
		await h.entitle();
	});

	it('is gated by the element and needs the messaging connector', async () => {
		await h.entitle({ elements: { otp: false } });
		expect((await h.call('POST', '/v1/otp', { body: { channel: 'email', to: 'x@example.com' } })).status).toBe(403);
		await h.entitle();
	});
});
