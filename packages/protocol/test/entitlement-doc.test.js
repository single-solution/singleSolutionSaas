import { beforeAll, describe, expect, it } from 'vitest';
import { signEntitlementDocument, verifyEntitlementDocument } from '../src/index.js';
import { signCompact } from '../src/jws.js';
import {
	T0,
	createClock,
	decodeSegment,
	expectCode,
	makeKey,
	staticResolver,
	tamperSegment,
	tamperSignature,
} from './helpers.js';

const HOUR = 3_600_000;

/** @type {Awaited<ReturnType<typeof makeKey>>} */
let portal;
/** @type {Awaited<ReturnType<typeof makeKey>>} */
let attacker;
beforeAll(async () => {
	portal = await makeKey('portal-1');
	attacker = await makeKey('portal-1');
});

const payload = {
	v: 1,
	websiteId: 'web_1',
	domain: 'shop.example.com',
	issuedAt: new Date(T0).toISOString(),
	validFrom: new Date(T0).toISOString(),
	validUntil: new Date(T0 + HOUR).toISOString(),
	elements: { codes: { on: true } },
};

/**
 * @param {ReturnType<typeof createClock>} clock
 * @param {string} token
 * @param {Record<string, any>} [overrides]
 */
const verify = (clock, token, overrides = {}) =>
	verifyEntitlementDocument({
		token,
		keyResolver: staticResolver([portal.publicJwk]),
		now: clock.now,
		graceMs: 24 * HOUR,
		...overrides,
	});

describe('entitlement documents', () => {
	it('signs with typ ss-entitlement+jws and verifies fresh', async () => {
		const clock = createClock();
		const token = await signEntitlementDocument({ signer: portal.signer, payload });
		expect(decodeSegment(token, 0).typ).toBe('ss-entitlement+jws');
		const result = await verify(clock, token, { expectedDomain: 'SHOP.example.com' });
		expect(result).toEqual({ payload, stale: false, kid: 'portal-1' });
	});

	it('is stale past validUntil but within grace, and expired beyond grace', async () => {
		const clock = createClock();
		const token = await signEntitlementDocument({ signer: portal.signer, payload });
		clock.advance(HOUR);
		expect((await verify(clock, token)).stale).toBe(false); // exactly at validUntil
		clock.advance(1);
		expect((await verify(clock, token)).stale).toBe(true);
		clock.advance(24 * HOUR - 1);
		expect((await verify(clock, token)).stale).toBe(true);
		clock.advance(1);
		await expectCode(verify(clock, token), 'expired');
		await expectCode(verify(createClock(T0 + HOUR + 1), token, { graceMs: 0 }), 'expired');
	});

	it('rejects not-yet-valid, domain mismatch, tampering, forged and wrong-type documents', async () => {
		const clock = createClock();
		const token = await signEntitlementDocument({ signer: portal.signer, payload });
		await expectCode(verify(createClock(T0 - HOUR), token), 'not_yet_valid');
		const futureIssued = await signEntitlementDocument({
			signer: portal.signer,
			payload: { ...payload, validFrom: undefined, issuedAt: new Date(T0 + HOUR).toISOString() },
		});
		await expectCode(verify(clock, futureIssued), 'not_yet_valid');
		await expectCode(verify(clock, token, { expectedDomain: 'example.com' }), 'domain_mismatch');
		await expectCode(verify(clock, token, { expectedDomain: 'shop.example.com.evil.com' }), 'domain_mismatch');
		const unbound = await signEntitlementDocument({ signer: portal.signer, payload: { ...payload, domain: undefined } });
		await expectCode(verify(clock, unbound, { expectedDomain: 'shop.example.com' }), 'domain_mismatch');
		await expectCode(
			verify(
				clock,
				tamperSegment(token, 1, (p) => ({ ...p, validUntil: '2099-01-01T00:00:00Z' })),
			),
			'signature',
		);
		await expectCode(verify(clock, tamperSignature(token)), 'signature');
		await expectCode(verify(clock, await signEntitlementDocument({ signer: attacker.signer, payload })), 'signature');
		await expectCode(verify(clock, token, { keyResolver: staticResolver([]) }), 'unknown_kid');
		const launchTyped = await signCompact({ signer: portal.signer, typ: 'ss-launch+jwt', payload });
		await expectCode(verify(clock, launchTyped), 'wrong_type');
		const noValidity = await signCompact({ signer: portal.signer, typ: 'ss-entitlement+jws', payload: { v: 1 } });
		await expectCode(verify(clock, noValidity), 'malformed');
		await expectCode(verify(clock, token, { graceMs: -1 }), 'invalid_argument');
	});

	it('validates the payload at signing', async () => {
		await expectCode(
			signEntitlementDocument({ signer: portal.signer, payload: /** @type {any} */ (null) }),
			'invalid_argument',
		);
		await expectCode(
			signEntitlementDocument({ signer: portal.signer, payload: { ...payload, validUntil: 'tomorrow' } }),
			'invalid_argument',
		);
		await expectCode(
			signEntitlementDocument({ signer: portal.signer, payload: { ...payload, validFrom: '1700000000' } }),
			'invalid_argument',
		);
	});
});
