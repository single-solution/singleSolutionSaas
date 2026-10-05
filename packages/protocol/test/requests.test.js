import { beforeAll, describe, expect, it } from 'vitest';
import {
	canonicalRequestPath,
	createJwks,
	createKeyResolver,
	createMemoryReplayStore,
	signEvent,
	signRequest,
	verifyEvent,
	verifyRequest,
} from '../src/index.js';
import { createClock, expectCode, expectThrowCode, makeKey, staticResolver } from './helpers.js';

const AUD = 'app_coupons';
const body = JSON.stringify({ websiteId: 'web_1', reason: 'merchant request' });

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

/** @param {ReturnType<typeof createClock>} clock */
const ts = (clock) => Math.floor(clock.now() / 1000);

/**
 * @param {ReturnType<typeof createClock>} clock
 * @param {Record<string, any>} [overrides]
 */
const sign = (clock, overrides = {}) =>
	signRequest({
		signer: portal.signer,
		method: 'POST',
		path: '/v1/data:export?b=2&a=1',
		audience: AUD,
		body,
		timestamp: ts(clock),
		...overrides,
	});

/**
 * @param {ReturnType<typeof createClock>} clock
 * @param {Record<string, any>} headers
 * @param {Record<string, any>} [overrides]
 */
const verify = (clock, headers, overrides = {}) =>
	verifyRequest({
		method: 'POST',
		path: '/v1/data:export?b=2&a=1',
		audience: AUD,
		headers,
		rawBody: body,
		keyResolver: staticResolver([portal.publicJwk, next.publicJwk]),
		replayStore: createMemoryReplayStore({ now: clock.now }),
		now: clock.now,
		...overrides,
	});

describe('signed requests', () => {
	it('signs and verifies method + path + query + body', async () => {
		const clock = createClock();
		const headers = await sign(clock);
		expect(headers['SS-Signature']).toMatch(/^v1;kid=portal-1;sig=[A-Za-z0-9_-]{86}$/);
		expect(await verify(clock, headers)).toMatchObject({
			timestamp: ts(clock),
			kid: 'portal-1',
			method: 'POST',
			path: '/v1/data:export?a=1&b=2',
		});
		await verify(clock, headers, { method: 'post', rawBody: new TextEncoder().encode(body) });
	});

	it('accepts query reordering and equivalent encodings', async () => {
		const clock = createClock();
		const headers = await sign(clock);
		await verify(clock, headers, { path: '/v1/data:export?a=1&b=2' });
		await verify(clock, headers, { path: '/v1/data:export?a=%31&b=2' });
		await verify(clock, headers, { path: '/v1/./x/../data:export?b=2&a=1' });
		const multi = await sign(clock, { path: '/v1/items?tag=b&tag=a&q=hello%20world' });
		await verify(clock, multi, { path: '/v1/items?q=hello%20world&tag=a&tag=b' });
		await verify(clock, multi, { path: '/v1/items?tag=a&q=hello+world&tag=b' });
	});

	it('rejects cross-endpoint replay (same body and timestamp, other path)', async () => {
		const clock = createClock();
		const headers = await sign(clock);
		await expectCode(verify(clock, headers, { path: '/v1/data:anonymize?b=2&a=1' }), 'signature');
		await expectCode(verify(clock, headers, { path: '/v1/data:export' }), 'signature');
		await expectCode(verify(clock, headers, { path: '/v1/data:export/?a=1&b=2' }), 'signature');
	});

	it('rejects query tampering', async () => {
		const clock = createClock();
		const headers = await sign(clock);
		await expectCode(verify(clock, headers, { path: '/v1/data:export?b=2&a=2' }), 'signature');
		await expectCode(verify(clock, headers, { path: '/v1/data:export?b=2&a=1&c=3' }), 'signature');
		await expectCode(verify(clock, headers, { path: '/v1/data:export?b=2&a=1&a=1' }), 'signature');
		await expectCode(verify(clock, headers, { path: '/v1/data:export?b=2' }), 'signature');
	});

	it('rejects a method swap', async () => {
		const clock = createClock();
		const headers = await sign(clock);
		await expectCode(verify(clock, headers, { method: 'DELETE' }), 'signature');
		await expectCode(verify(clock, headers, { method: 'PUT' }), 'signature');
	});

	it('rejects replay to another product (audience binding)', async () => {
		const clock = createClock();
		const headers = await sign(clock);
		await expectCode(verify(clock, headers, { audience: 'app_loyalty' }), 'signature');
	});

	it('rejects body tampering, forged keys and bad signatures', async () => {
		const clock = createClock();
		const headers = await sign(clock);
		await expectCode(verify(clock, headers, { rawBody: body.replace('web_1', 'web_2') }), 'signature');
		await expectCode(verify(clock, await sign(clock, { signer: attacker.signer })), 'signature');
		await expectCode(verify(clock, headers, { keyResolver: staticResolver([]) }), 'unknown_kid');
		const revoked = createKeyResolver({ jwks: createJwks([portal.publicJwk]), revokedKids: ['portal-1'] });
		await expectCode(verify(clock, headers, { keyResolver: revoked }), 'revoked_key');
		await expectCode(verify(clock, { ...headers, 'SS-Signature': 'garbage' }), 'malformed');
		await expectCode(verify(clock, { ...headers, 'SS-Signature': undefined }), 'malformed');
	});

	it('rejects replays within the window, but the same body to another path is a different request', async () => {
		const clock = createClock();
		const replayStore = createMemoryReplayStore({ now: clock.now });
		const headers = await sign(clock);
		await verify(clock, headers, { replayStore });
		await expectCode(verify(clock, headers, { replayStore }), 'replay');
		await expectCode(verify(clock, headers, { replayStore, path: '/v1/data:export?a=1&b=2' }), 'replay');
		const other = await sign(clock, { path: '/v1/other' });
		await verify(clock, other, { replayStore, path: '/v1/other' });
	});

	it('rejects stale and future timestamps', async () => {
		const clock = createClock();
		await expectCode(verify(clock, await sign(clock, { timestamp: ts(clock) - 301 })), 'expired');
		await expectCode(verify(clock, await sign(clock, { timestamp: ts(clock) + 301 })), 'not_yet_valid');
		await expectCode(verify(clock, { ...(await sign(clock)), 'SS-Timestamp': 'x' }), 'malformed');
	});

	it('signs an empty body by default and supports dual signing', async () => {
		const clock = createClock();
		const headers = await signRequest({
			signers: [portal.signer, next.signer],
			method: 'GET',
			path: '/v1/entitlement',
			audience: AUD,
			timestamp: ts(clock),
		});
		const result = await verify(clock, headers, {
			method: 'GET',
			path: '/v1/entitlement',
			rawBody: undefined,
			keyResolver: staticResolver([next.publicJwk]),
		});
		expect(result.kid).toBe('portal-2');
	});

	it('event and request signatures never verify as each other (prefix separation)', async () => {
		const clock = createClock();
		const eventHeaders = await signEvent({ signer: portal.signer, body, timestamp: ts(clock) });
		await expectCode(verify(clock, eventHeaders), 'signature');
		const requestHeaders = await sign(clock);
		await expectCode(
			verifyEvent({
				headers: requestHeaders,
				rawBody: body,
				keyResolver: staticResolver([portal.publicJwk]),
				replayStore: createMemoryReplayStore({ now: clock.now }),
				now: clock.now,
			}),
			'signature',
		);
	});

	it('validates arguments', async () => {
		const clock = createClock();
		await expectCode(sign(clock, { signer: undefined }), 'invalid_argument');
		await expectCode(sign(clock, { timestamp: 0 }), 'invalid_argument');
		await expectCode(sign(clock, { body: {} }), 'invalid_argument');
		await expectCode(sign(clock, { method: 'GET /' }), 'invalid_argument');
		await expectCode(sign(clock, { method: 7 }), 'invalid_argument');
		await expectCode(sign(clock, { audience: 'https://coupons.test/x' }), 'invalid_argument');
		const headers = await sign(clock);
		await expectCode(verify(clock, headers, { replayStore: undefined }), 'invalid_argument');
		await expectCode(verify(clock, headers, { rawBody: 5 }), 'invalid_argument');
		await expectCode(verify(clock, headers, { path: 'https://evil.test/v1/data:export' }), 'invalid_argument');
	});
});

describe('canonicalRequestPath', () => {
	it.each([
		['/v1/items', '/v1/items'],
		['/v1/items?', '/v1/items'],
		['/v1/items?b=2&a=1', '/v1/items?a=1&b=2'],
		['/v1/items?a=2&a=1', '/v1/items?a=1&a=2'],
		['/v1/items?flag', '/v1/items?flag='],
		['/v1/a/./b/../c', '/v1/a/c'],
		['/v1/%7euser/%2f', '/v1/~user/%2F'],
		['/v1/items?q=a+b', '/v1/items?q=a%20b'],
		["/v1/items?q=it's(1)*!", '/v1/items?q=it%27s%281%29%2A%21'],
		['/v1/ünï', '/v1/%C3%BCn%C3%AF'],
	])('%s → %s', (input, expected) => {
		expect(canonicalRequestPath(input)).toBe(expected);
	});

	it.each([
		['relative', 'v1/items'],
		['protocol-relative', '//evil.test/v1'],
		['absolute URL', 'https://evil.test/v1'],
		['fragment', '/v1/items#x'],
		['whitespace', '/v1/it ems'],
		['backslash', '/v1\\items'],
		['control char', '/v1/\u0001'],
		['non-string', 42],
		['too long', `/${'a'.repeat(9000)}`],
	])('rejects %s', (_name, input) => {
		expectThrowCode(() => canonicalRequestPath(input), 'invalid_argument');
	});
});
