import { beforeAll, describe, expect, it } from 'vitest';
import { checkTimeClaims, peekPayload, requireString, signCompact, verifyCompact } from '../src/jws.js';
import { b64url } from '../src/encoding.js';
import { expectCode, expectThrowCode, makeKey, staticResolver, tamperSegment } from './helpers.js';

/** @type {Awaited<ReturnType<typeof makeKey>>} */
let key;
beforeAll(async () => {
	key = await makeKey('k');
});

describe('compact JWS', () => {
	it('round-trips', async () => {
		const token = await signCompact({ signer: key.signer, typ: 't', payload: { a: 1 } });
		expect(await verifyCompact({ token, keyResolver: staticResolver([key.publicJwk]), typ: 't' })).toEqual({
			payload: { a: 1 },
			kid: 'k',
		});
		expect(peekPayload(token)).toEqual({ a: 1 });
	});

	it.each([
		['non-string', 42],
		['empty', ''],
		['two segments', 'a.b'],
		['empty segment', 'a..c'],
		['not base64url', '!!!.e30.sig'],
		['not JSON', `${b64url('nope')}.e30.sig`],
		['JSON array header', `${b64url('[1]')}.e30.sig`],
		['too long', 'a'.repeat(20_000)],
	])('rejects %s tokens as malformed', async (_name, token) => {
		await expectCode(verifyCompact({ token, keyResolver: staticResolver([key.publicJwk]), typ: 't' }), 'malformed');
	});

	it.each(['jwk', 'jku', 'x5u', 'x5c', 'crit', 'b64'])('rejects a %s header', async (member) => {
		const token = await signCompact({ signer: key.signer, typ: 't', payload: {} });
		const forged = tamperSegment(token, 0, (h) => ({ ...h, [member]: 'x' }));
		await expectCode(verifyCompact({ token: forged, keyResolver: staticResolver([key.publicJwk]), typ: 't' }), 'malformed');
	});

	it('rejects missing kid, bad payload JSON and missing resolver/signer', async () => {
		const token = await signCompact({ signer: key.signer, typ: 't', payload: {} });
		const noKid = tamperSegment(token, 0, (h) => ({ alg: h.alg, typ: h.typ }));
		await expectCode(verifyCompact({ token: noKid, keyResolver: staticResolver([key.publicJwk]), typ: 't' }), 'unknown_kid');
		await expectCode(verifyCompact({ token, keyResolver: /** @type {any} */ (null), typ: 't' }), 'invalid_argument');
		await expectCode(signCompact({ signer: /** @type {any} */ ({}), typ: 't', payload: {} }), 'invalid_argument');
		// correctly signed but payload is an array
		const parts = token.split('.');
		const input = `${parts[0]}.${b64url('[1]')}`;
		const sig = await key.signer.sign(new TextEncoder().encode(input));
		await expectCode(
			verifyCompact({ token: `${input}.${b64url(sig)}`, keyResolver: staticResolver([key.publicJwk]), typ: 't' }),
			'malformed',
		);
	});

	it('propagates unexpected resolver errors as signature failures only when they are not protocol errors', async () => {
		const token = await signCompact({ signer: key.signer, typ: 't', payload: {} });
		const wrongKeyType = { resolve: async () => /** @type {any} */ ({}) };
		await expectCode(verifyCompact({ token, keyResolver: wrongKeyType, typ: 't' }), 'signature');
	});

	it('checkTimeClaims without iat and helpers', () => {
		expect(checkTimeClaims({ claims: { exp: 100 }, nowMs: 50_000, skewSeconds: 0, requireIat: false })).toEqual({
			iat: undefined,
			exp: 100,
		});
		expectThrowCode(() => requireString('', 'x'), 'invalid_argument');
	});
});
