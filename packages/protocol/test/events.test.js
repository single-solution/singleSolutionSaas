import { beforeAll, describe, expect, it } from 'vitest';
import { createJwks, createKeyResolver, createMemoryReplayStore, signEvent, verifyEvent } from '../src/index.js';
import { createClock, expectCode, makeKey, staticResolver } from './helpers.js';

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

const body = JSON.stringify({ id: 'evt_1', type: 'order.placed@1', websiteId: 'web_1', data: { total: 1200 } });

/** @param {ReturnType<typeof createClock>} clock */
const ts = (clock) => Math.floor(clock.now() / 1000);

/**
 * @param {ReturnType<typeof createClock>} clock
 * @param {Record<string, any>} headers
 * @param {Record<string, any>} [overrides]
 */
const verify = (clock, headers, overrides = {}) =>
	verifyEvent({
		headers,
		rawBody: body,
		keyResolver: staticResolver([portal.publicJwk, next.publicJwk]),
		replayStore: createMemoryReplayStore({ now: clock.now }),
		now: clock.now,
		...overrides,
	});

describe('signed events', () => {
	it('signs headers and verifies (plain object, lower-case and Headers inputs)', async () => {
		const clock = createClock();
		const headers = await signEvent({ signer: portal.signer, body, timestamp: ts(clock) });
		expect(headers['SS-Key-Id']).toBe('portal-1');
		expect(headers['SS-Signature']).toMatch(/^v1;kid=portal-1;sig=[A-Za-z0-9_-]{86}$/);
		expect(await verify(clock, headers)).toMatchObject({ timestamp: ts(clock), kid: 'portal-1' });
		const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
		await verify(clock, lower);
		await verify(clock, /** @type {any} */ (new Headers(headers)));
		await verify(clock, headers, { rawBody: new TextEncoder().encode(body) });
	});

	it('rejects replays within the window', async () => {
		const clock = createClock();
		const replayStore = createMemoryReplayStore({ now: clock.now });
		const headers = await signEvent({ signer: portal.signer, body, timestamp: ts(clock) });
		await verify(clock, headers, { replayStore });
		await expectCode(verify(clock, headers, { replayStore }), 'replay');
	});

	it('rejects old and future timestamps', async () => {
		const clock = createClock();
		const old = await signEvent({ signer: portal.signer, body, timestamp: ts(clock) - 301 });
		await expectCode(verify(clock, old), 'expired');
		const future = await signEvent({ signer: portal.signer, body, timestamp: ts(clock) + 301 });
		await expectCode(verify(clock, future), 'not_yet_valid');
		const edge = await signEvent({ signer: portal.signer, body, timestamp: ts(clock) - 300 });
		await verify(clock, edge);
	});

	it('rejects tampered body, timestamp, signature and forged keys', async () => {
		const clock = createClock();
		const headers = await signEvent({ signer: portal.signer, body, timestamp: ts(clock) });
		await expectCode(verify(clock, headers, { rawBody: body.replace('1200', '1') }), 'signature');
		await expectCode(verify(clock, { ...headers, 'SS-Timestamp': String(ts(clock) - 1) }), 'signature');
		const sig = headers['SS-Signature'];
		const flipped = sig.replace(/sig=(.)/, (_m, c) => `sig=${c === 'A' ? 'B' : 'A'}`);
		await expectCode(verify(clock, { ...headers, 'SS-Signature': flipped }), 'signature');
		const forged = await signEvent({ signer: attacker.signer, body, timestamp: ts(clock) });
		await expectCode(verify(clock, forged), 'signature');
		// SS-Key-Id is only a hint: pointing it elsewhere changes nothing
		await verify(clock, { ...headers, 'SS-Key-Id': 'portal-2' });
	});

	it('rejects unknown and revoked kids', async () => {
		const clock = createClock();
		const headers = await signEvent({ signer: portal.signer, body, timestamp: ts(clock) });
		await expectCode(verify(clock, headers, { keyResolver: staticResolver([next.publicJwk]) }), 'unknown_kid');
		const revoked = createKeyResolver({ jwks: createJwks([portal.publicJwk]), revokedKids: ['portal-1'] });
		await expectCode(verify(clock, headers, { keyResolver: revoked }), 'revoked_key');
	});

	it('supports dual-signing during rotation', async () => {
		const clock = createClock();
		const headers = await signEvent({ signers: [portal.signer, next.signer], body, timestamp: ts(clock) });
		expect(headers['SS-Signature'].split(', ')).toHaveLength(2);
		// a verifier that only knows the new key accepts it
		expect(await verify(clock, headers, { keyResolver: staticResolver([next.publicJwk]) })).toMatchObject({ kid: 'portal-2' });
		// old key revoked → falls through to the new one
		const resolver = createKeyResolver({ jwks: createJwks([portal.publicJwk, next.publicJwk]), revokedKids: ['portal-1'] });
		expect(await verify(clock, headers, { keyResolver: resolver })).toMatchObject({ kid: 'portal-2' });
		// neither known → signature
		await expectCode(verify(clock, headers, { keyResolver: staticResolver([]) }), 'signature');
	});

	it.each([
		['missing timestamp', { 'SS-Timestamp': undefined }],
		['non-numeric timestamp', { 'SS-Timestamp': '12a' }],
		['missing signature', { 'SS-Signature': undefined }],
		['bad version', { 'SS-Signature': 'v2;kid=portal-1;sig=abc' }],
		['short sig', { 'SS-Signature': 'v1;kid=portal-1;sig=abc' }],
		[
			'too many entries',
			{
				'SS-Signature': Array(5)
					.fill('v1;kid=a;sig=' + 'A'.repeat(86))
					.join(', '),
			},
		],
		['duplicated header array', { 'SS-Signature': ['a', 'b'] }],
	])('rejects %s as malformed', async (_name, patch) => {
		const clock = createClock();
		const headers = await signEvent({ signer: portal.signer, body, timestamp: ts(clock) });
		await expectCode(verify(clock, { ...headers, ...patch }), 'malformed');
	});

	it('validates arguments', async () => {
		const clock = createClock();
		await expectCode(signEvent({ body, timestamp: ts(clock) }), 'invalid_argument');
		await expectCode(signEvent({ signer: portal.signer, body, timestamp: 1.5 }), 'invalid_argument');
		await expectCode(signEvent({ signer: portal.signer, body: /** @type {any} */ ({}), timestamp: 1 }), 'invalid_argument');
		const headers = await signEvent({ signer: portal.signer, body, timestamp: ts(clock) });
		await expectCode(verify(clock, headers, { replayStore: undefined }), 'invalid_argument');
		await expectCode(verify(clock, headers, { rawBody: undefined }), 'invalid_argument');
		await expectCode(verify(clock, /** @type {any} */ (null)), 'malformed');
	});
});
