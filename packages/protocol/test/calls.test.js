import { beforeAll, describe, expect, it } from 'vitest';
import { signNotice, signPortalCall, verifyPortalCall } from '../src/index.js';
import { createMemoryReplayStore } from '../src/testing.js';
import { createClock, expectCode, makeKey, seededRandom, staticResolver } from './helpers.js';

/** @type {Awaited<ReturnType<typeof makeKey>>} */
let portal;
/** @type {Awaited<ReturnType<typeof makeKey>>} */
let next;
/** @type {Awaited<ReturnType<typeof makeKey>>} */
let attacker;
beforeAll(async () => {
	portal = await makeKey('portal-1');
	next = await makeKey('portal-2');
	attacker = await makeKey('portal-1');
});

const TARGET = '/v1/blueprint?websiteId=web_1';

/** @param {ReturnType<typeof createClock>} clock */
const ts = (clock) => Math.floor(clock.now() / 1000);

/**
 * @param {ReturnType<typeof createClock>} clock
 * @param {Record<string, any>} [overrides]
 */
const sign = (clock, overrides = {}) =>
	signPortalCall({ signer: portal.signer, audience: 'shop', method: 'GET', target: TARGET, timestamp: ts(clock), ...overrides });

/**
 * @param {ReturnType<typeof createClock>} clock
 * @param {Record<string, any>} headers
 * @param {Record<string, any>} [overrides]
 */
const verify = (clock, headers, overrides = {}) =>
	verifyPortalCall({
		headers,
		audience: 'shop',
		method: 'GET',
		target: TARGET,
		keyResolver: staticResolver([portal.publicJwk, next.publicJwk]),
		replayStore: createMemoryReplayStore({ now: clock.now }),
		now: clock.now,
		...overrides,
	});

describe('Portal calls', () => {
	it('signs and verifies a call (plain object, lower-case and Headers inputs)', async () => {
		const clock = createClock();
		const headers = await sign(clock);
		expect(headers['SS-Key-Id']).toBe('portal-1');
		expect(headers['SS-Nonce']).toMatch(/^[A-Za-z0-9_-]{22}$/);
		expect(headers['SS-Signature']).toMatch(/^v1;kid=portal-1;sig=[A-Za-z0-9_-]{86}$/);
		expect(await verify(clock, headers)).toEqual({ kid: 'portal-1', timestamp: ts(clock) });
		const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
		await verify(clock, lower);
		await verify(clock, /** @type {any} */ (new Headers(headers)));
	});

	it('binds the body, as text or bytes', async () => {
		const clock = createClock();
		const body = JSON.stringify({ a: 1 });
		const headers = await sign(clock, { method: 'POST', body });
		await verify(clock, headers, { method: 'POST', rawBody: new TextEncoder().encode(body) });
		await expectCode(verify(clock, headers, { method: 'POST', rawBody: '{"a":2}' }), 'signature');
		await expectCode(verify(clock, headers, { method: 'POST' }), 'signature');
	});

	it('gives every call its own nonce, so two calls in one second both pass one replay store', async () => {
		const clock = createClock();
		const replayStore = createMemoryReplayStore({ now: clock.now });
		const random = seededRandom(7);
		const first = await sign(clock, { randomBytes: random });
		const second = await sign(clock, { randomBytes: random });
		expect(first['SS-Nonce']).not.toBe(second['SS-Nonce']);
		await verify(clock, first, { replayStore });
		await verify(clock, second, { replayStore });
		await expectCode(verify(clock, first, { replayStore }), 'replay');
	});

	it('refuses the call for another product, method, target or time, a changed nonce, and forged keys', async () => {
		const clock = createClock();
		const headers = await sign(clock);
		await expectCode(verify(clock, headers, { audience: 'other' }), 'signature');
		await expectCode(verify(clock, headers, { method: 'DELETE' }), 'signature');
		await expectCode(verify(clock, headers, { target: '/v1/blueprint?websiteId=web_2' }), 'signature');
		await expectCode(verify(clock, headers, { target: '/v1/blueprint' }), 'signature');
		await expectCode(verify(clock, { ...headers, 'SS-Timestamp': String(ts(clock) - 1) }), 'signature');
		await expectCode(verify(clock, { ...headers, 'SS-Nonce': 'A'.repeat(22) }), 'signature');
		const forged = await signPortalCall({
			signer: attacker.signer,
			audience: 'shop',
			method: 'GET',
			target: TARGET,
			timestamp: ts(clock),
		});
		await expectCode(verify(clock, forged), 'signature');
		// SS-Key-Id is only a hint
		await verify(clock, { ...headers, 'SS-Key-Id': 'portal-2' });
	});

	it('is never taken for a notice, nor a notice for a call', async () => {
		const clock = createClock();
		const body = JSON.stringify({ type: 'status.changed', websiteId: 'web_1' });
		const notice = await signNotice({ signer: portal.signer, body, timestamp: ts(clock) });
		await expectCode(verify(clock, { ...notice, 'SS-Nonce': 'A'.repeat(22) }, { method: 'POST', rawBody: body }), 'signature');
	});

	it('refuses old and future timestamps', async () => {
		const clock = createClock();
		await expectCode(verify(clock, await sign(clock, { timestamp: ts(clock) - 301 })), 'expired');
		await expectCode(verify(clock, await sign(clock, { timestamp: ts(clock) + 301 })), 'not_yet_valid');
		await verify(clock, await sign(clock, { timestamp: ts(clock) - 300 }));
	});

	it('refuses unknown kids, and verifies a dual-signed call with either key', async () => {
		const clock = createClock();
		const headers = await sign(clock);
		await expectCode(verify(clock, headers, { keyResolver: staticResolver([next.publicJwk]) }), 'unknown_kid');
		const dual = await sign(clock, { signer: undefined, signers: [portal.signer, next.signer] });
		await verify(clock, dual, { keyResolver: staticResolver([next.publicJwk]) });
	});

	it.each([
		['a missing nonce', { 'SS-Nonce': undefined }],
		['a short nonce', { 'SS-Nonce': 'abc' }],
		['a missing timestamp', { 'SS-Timestamp': undefined }],
		['a missing signature', { 'SS-Signature': undefined }],
	])('refuses %s as malformed', async (_name, patch) => {
		const clock = createClock();
		await expectCode(verify(clock, { ...(await sign(clock)), ...patch }), 'malformed');
	});

	it.each([
		['no signer', { signer: undefined }],
		['a fractional timestamp', { timestamp: 1.5 }],
		['a bad audience', { audience: 'Not A Product' }],
		['a lower-case method', { method: 'get' }],
		['a target without a leading slash', { target: 'v1/blueprint' }],
		['a target with a space', { target: '/v1/a b' }],
		['a target with a fragment', { target: '/v1/a#b' }],
		['a target that is too long', { target: `/${'a'.repeat(4096)}` }],
		['a body that is not text or bytes', { body: {} }],
	])('validates arguments: %s', async (_name, patch) => {
		await expectCode(sign(createClock(), patch), 'invalid_argument');
	});

	it('needs a replay store and a body of text or bytes to verify', async () => {
		const clock = createClock();
		const headers = await sign(clock);
		await expectCode(verify(clock, headers, { replayStore: undefined }), 'invalid_argument');
		await expectCode(verify(clock, headers, { rawBody: {} }), 'invalid_argument');
	});
});
