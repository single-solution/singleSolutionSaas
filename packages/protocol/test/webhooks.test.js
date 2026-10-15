import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WEBHOOK_TOLERANCE_SECONDS, signWebhook, verifyWebhook } from '../src/index.js';
import { T0, createClock } from './helpers.js';

const SECRET = 'whsec_0123456789abcdefghijklmnop';
const BODY = '{"id":"evt_1","type":"payment.paid"}';
const t0 = Math.floor(T0 / 1000);

/** @param {string} secret @param {string | number} t @param {string} body */
const hmac = (secret, t, body) => createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');

describe('signWebhook', () => {
	it('signs "<t>.<body>" with the secret at the current second', () => {
		const clock = createClock(T0 + 999);
		expect(signWebhook({ body: BODY, secret: SECRET, now: clock.now })).toBe(`t=${t0},v1=${hmac(SECRET, t0, BODY)}`);
		expect(signWebhook({ body: BODY, secret: SECRET })).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
	});

	it('refuses an empty secret and a body that is not text', () => {
		expect(() => signWebhook({ body: BODY, secret: '' })).toThrow(TypeError);
		expect(() => signWebhook({ body: /** @type {any} */ ({ id: 1 }), secret: SECRET })).toThrow(TypeError);
	});
});

describe('verifyWebhook', () => {
	const clock = createClock(T0);
	const header = signWebhook({ body: BODY, secret: SECRET, now: clock.now });
	/** @param {Partial<Parameters<typeof verifyWebhook>[0]>} [change] */
	const check = (change = {}) => verifyWebhook({ header, body: BODY, secret: SECRET, now: clock.now, ...change });

	it('accepts what signWebhook made, within the tolerance either way', () => {
		expect(check()).toBe(true);
		expect(check({ now: () => T0 + WEBHOOK_TOLERANCE_SECONDS * 1000 })).toBe(true);
		expect(check({ now: () => T0 - WEBHOOK_TOLERANCE_SECONDS * 1000 })).toBe(true);
		expect(check({ now: () => T0 + 60_000, toleranceSeconds: 60 })).toBe(true);
		expect(verifyWebhook({ header: signWebhook({ body: BODY, secret: SECRET }), body: BODY, secret: SECRET })).toBe(true);
	});

	it('refuses a time outside the tolerance', () => {
		expect(check({ now: () => T0 + (WEBHOOK_TOLERANCE_SECONDS + 1) * 1000 })).toBe(false);
		expect(check({ now: () => T0 - (WEBHOOK_TOLERANCE_SECONDS + 1) * 1000 })).toBe(false);
		expect(check({ now: () => T0 + 61_000, toleranceSeconds: 60 })).toBe(false);
	});

	it('refuses another body, another secret and a changed signature', () => {
		expect(check({ body: `${BODY} ` })).toBe(false);
		expect(check({ secret: `${SECRET}x` })).toBe(false);
		expect(check({ header: header.replace(/.$/, (c) => (c === '0' ? '1' : '0')) })).toBe(false);
	});

	it('accepts any v1 of a Stripe-style header, with spaces and other schemes, and signs the time as sent', () => {
		const v1 = hmac(SECRET, t0, BODY);
		expect(check({ header: `t=${t0}, v1=${'0'.repeat(64)}, v1=${v1}, v0=abc` })).toBe(true);
		expect(check({ header: `v1=${v1},t=${t0}` })).toBe(true);
		// a time written another way is checked as written: the sender signed those exact characters
		expect(check({ header: `t=0${t0},v1=${v1}` })).toBe(false);
		expect(check({ header: `t=0${t0},v1=${hmac(SECRET, `0${t0}`, BODY)}` })).toBe(true);
	});

	it('refuses missing and malformed headers, an empty secret and a body that is not text', () => {
		for (const bad of [
			null,
			undefined,
			'',
			'garbage',
			`v1=${hmac(SECRET, t0, BODY)}`,
			`t=,v1=${hmac(SECRET, t0, BODY)}`,
			`t=1e9,v1=${hmac(SECRET, '1e9', BODY)}`,
			`t=-${t0},v1=${hmac(SECRET, `-${t0}`, BODY)}`,
			`t=${t0}`,
			`t=${t0},v1=`,
		])
			expect(check({ header: bad })).toBe(false);
		expect(check({ secret: '' })).toBe(false);
		expect(check({ body: /** @type {any} */ (Buffer.from(BODY)) })).toBe(false);
	});
});
