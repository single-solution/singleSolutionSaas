import { beforeAll, describe, expect, it } from 'vitest';
import { TICKET_TTL_SECONDS, issueTicket, verifyTicket } from '../src/index.js';
import { signCompact } from '../src/jws.js';
import {
	T0,
	createClock,
	decodeSegment,
	expectCode,
	makeKey,
	seededRandom,
	staticResolver,
	tamperSegment,
	tamperSignature,
} from './helpers.js';

const ORIGIN = 'https://admin.shop.com';
const user = { id: 'u_1', name: 'Sara', email: 'sara@shop.com' };

/** @type {Awaited<ReturnType<typeof makeKey>>} */
let ticketKey;
/** @type {Awaited<ReturnType<typeof makeKey>>} */
let other;

beforeAll(async () => {
	ticketKey = await makeKey('chat-ticket-1');
	other = await makeKey('chat-ticket-1');
});

/**
 * @param {ReturnType<typeof createClock>} clock
 * @param {Record<string, any>} [overrides]
 */
const issue = (clock, overrides = {}) =>
	issueTicket({
		signer: ticketKey.signer,
		productId: 'chat',
		websiteId: 'web_1',
		user,
		origin: 'HTTPS://Admin.Shop.com:443',
		permissions: ['inbox.read', 'inbox.reply'],
		tokenId: 'tok_server_1',
		now: clock.now,
		randomBytes: seededRandom(),
		...overrides,
	});

/**
 * @param {ReturnType<typeof createClock>} clock
 * @param {unknown} ticket
 * @param {Record<string, any>} [overrides]
 */
const verify = (clock, ticket, overrides = {}) =>
	verifyTicket({
		ticket,
		keyResolver: staticResolver([ticketKey.publicJwk]),
		productId: 'chat',
		origin: ORIGIN,
		now: clock.now,
		...overrides,
	});

/** @param {Record<string, unknown>} payload */
const signRaw = (payload) => signCompact({ signer: ticketKey.signer, typ: 'ss-ticket+jws', payload });

describe('tickets', () => {
	it('issues a 15-minute ticket bound to product, website, user, origin and server token', async () => {
		const clock = createClock();
		const { ticket, expiresAt, claims } = await issue(clock);
		expect(expiresAt).toBe(new Date(T0 + TICKET_TTL_SECONDS * 1000).toISOString());
		expect(claims).toMatchObject({
			iss: 'chat',
			aud: 'chat',
			sub: 'u_1',
			websiteId: 'web_1',
			user,
			origin: ORIGIN,
			permissions: ['inbox.read', 'inbox.reply'],
			tid: 'tok_server_1',
		});
		expect(claims.exp - claims.iat).toBe(900);
		expect(claims.nbf).toBe(claims.iat);
		expect(decodeSegment(ticket, 0)).toEqual({ alg: 'EdDSA', kid: 'chat-ticket-1', typ: 'ss-ticket+jws' });
		expect(await verify(clock, ticket)).toEqual(claims);
		expect(await verify(clock, ticket, { origin: 'https://ADMIN.shop.com', isRevoked: async () => false })).toEqual(claims);
		const local = await issue(clock, { origin: 'http://localhost:3000', permissions: [] });
		expect((await verify(clock, local.ticket, { origin: 'http://localhost:3000' })).permissions).toEqual([]);
	});

	it('refuses every bad ticket with the same invalid_token error', async () => {
		const clock = createClock();
		const { ticket, claims } = await issue(clock);
		const late = createClock(T0 + 906_000);
		const cases = [
			() => verify(late, ticket),
			() => verify(clock, ticket, { origin: 'https://other.shop.com' }),
			() => verify(clock, ticket, { origin: undefined }),
			() => verify(clock, ticket, { origin: 'https://admin.shop.com/' }),
			() => verify(clock, ticket, { productId: 'growth' }),
			() => verify(clock, ticket, { isRevoked: (/** @type {string} */ tid) => tid === 'tok_server_1' }),
			() => verify(clock, ticket, { keyResolver: staticResolver([other.publicJwk]) }),
			() => verify(clock, tamperSignature(ticket)),
			() =>
				verify(
					clock,
					tamperSegment(ticket, 0, (h) => ({ ...h, typ: 'ss-token+jws' })),
				),
			() => verify(clock, 'x.y.z'),
			async () => verify(clock, await signRaw({ ...claims, exp: claims.iat + 901 })),
			async () => verify(clock, await signRaw({ ...claims, aud: 'growth' })),
			async () => verify(clock, await signRaw({ ...claims, user: { id: 'u_1', name: 'Sara' } })),
			async () => verify(clock, await signRaw({ ...claims, sub: 'u_2' })),
			async () => verify(clock, await signRaw({ ...claims, websiteId: '' })),
			async () => verify(clock, await signRaw({ ...claims, tid: undefined })),
			async () => verify(clock, await signRaw({ ...claims, permissions: ['inbox.read', 'inbox.read'] })),
			async () => verify(clock, await signRaw({ ...claims, permissions: 'inbox.read' })),
		];
		for (const run of cases)
			await expect(run()).rejects.toMatchObject({
				name: 'ProtocolError',
				code: 'invalid_token',
				message: 'token is not valid',
			});
	});

	it('passes errors of the revocation lookup through', async () => {
		const clock = createClock();
		const { ticket } = await issue(clock);
		const failure = new Error('database down');
		await expect(
			verify(clock, ticket, {
				isRevoked: () => {
					throw failure;
				},
			}),
		).rejects.toBe(failure);
		const typeFailure = new TypeError('boom');
		await expect(
			verify(clock, ticket, {
				keyResolver: {
					resolve: () => {
						throw typeFailure;
					},
				},
			}),
		).rejects.toBe(typeFailure);
	});

	it.each([
		['a bad product id', { productId: 'Chat' }],
		['a missing website', { websiteId: '' }],
		['a missing token id', { tokenId: undefined }],
		['a missing user', { user: undefined }],
		['a user without id', { user: { ...user, id: '' } }],
		['a user without name', { user: { ...user, name: '' } }],
		['a user without email', { user: { ...user, email: 7 } }],
		['an http origin', { origin: 'http://admin.shop.com' }],
		['an origin with a path', { origin: 'https://admin.shop.com/inbox' }],
		['permissions that are not a list', { permissions: 'inbox.read' }],
		['a bad permission key', { permissions: ['Inbox'] }],
		['duplicate permissions', { permissions: ['inbox.read', 'inbox.read'] }],
	])('refuses to issue with %s', async (_name, extra) => {
		await expectCode(issue(createClock(), extra), 'invalid_argument');
	});

	it('validates verify arguments', async () => {
		const clock = createClock();
		const { ticket } = await issue(clock);
		await expectCode(verify(clock, ticket, { productId: '' }), 'invalid_argument');
		await expectCode(verify(clock, ticket, { keyResolver: undefined }), 'invalid_argument');
	});
});
