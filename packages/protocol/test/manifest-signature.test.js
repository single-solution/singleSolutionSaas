import { describe, expect, it } from 'vitest';
import { MANIFEST_SIGNATURE_HEADER, MANIFEST_TYP, signManifest, verifyManifest } from '../src/index.js';
import { signCompact } from '../src/jws.js';
import { T0, createClock, decodeSegment, expectCode, makeKey, staticResolver, tamperSignature } from './helpers.js';

/**
 * @param {import('../src/index.js').Signer} signer
 * @param {string} typ
 * @param {Record<string, unknown>} payload
 */
const signCompactForTests = (signer, typ, payload) => signCompact({ signer, typ, payload });

const manifest = { ssps: '1', product: { slug: 'coupon-box', version: '1.4.0' }, elements: [{ key: 'codes' }] };

describe('signed manifests', () => {
	it('signs { appId, manifestHash, iat } as ss-manifest+jws and verifies it', async () => {
		const { signer, publicJwk } = await makeKey('prod-1');
		const clock = createClock();
		const jws = await signManifest({ signer, manifest, appId: 'app_1', now: clock.now });
		expect(decodeSegment(jws, 0)).toEqual({ alg: 'EdDSA', kid: 'prod-1', typ: MANIFEST_TYP });
		expect(decodeSegment(jws, 1)).toEqual({
			appId: 'app_1',
			manifestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
			iat: T0 / 1000,
		});
		expect(MANIFEST_SIGNATURE_HEADER).toBe('SS-Manifest-Signature');
		const reordered = { elements: manifest.elements, product: manifest.product, ssps: '1' };
		const claims = await verifyManifest({
			manifest: reordered,
			jws,
			keyResolver: staticResolver([publicJwk]),
			expectedAppId: 'app_1',
			now: clock.now,
		});
		expect(claims).toEqual({ appId: 'app_1', manifestHash: decodeSegment(jws, 1).manifestHash, iat: T0 / 1000, kid: 'prod-1' });
		const explicit = await signManifest({ signer, manifest, appId: 'app_1', iat: 1_000 });
		expect(decodeSegment(explicit, 1).iat).toBe(1_000);
	});

	it('rejects tampering, wrong apps, wrong keys and stale signatures', async () => {
		const { signer, publicJwk } = await makeKey('prod-1');
		const other = await makeKey('prod-2');
		const clock = createClock();
		const keyResolver = staticResolver([publicJwk]);
		const jws = await signManifest({ signer, manifest, appId: 'app_1', now: clock.now });
		const base = { manifest, jws, keyResolver, expectedAppId: 'app_1', now: clock.now };
		await expectCode(verifyManifest({ ...base, manifest: { ...manifest, ssps: '2' } }), 'signature');
		await expectCode(verifyManifest({ ...base, manifest: [manifest] }), 'signature');
		await expectCode(verifyManifest({ ...base, manifest: { n: Infinity } }), 'malformed');
		await expectCode(verifyManifest({ ...base, expectedAppId: 'app_2' }), 'issuer');
		await expectCode(verifyManifest({ ...base, jws: tamperSignature(jws) }), 'signature');
		await expectCode(verifyManifest({ ...base, keyResolver: staticResolver([other.publicJwk]) }), 'unknown_kid');
		const foreign = await signManifest({ signer: other.signer, manifest, appId: 'app_1', now: clock.now });
		await expectCode(verifyManifest({ ...base, jws: foreign }), 'unknown_kid');
		await expectCode(verifyManifest({ ...base, now: () => T0 + 86_401_000 }), 'expired');
		await expectCode(verifyManifest({ ...base, now: () => T0 + 61_000, maxAgeSec: 60 }), 'expired');
		await expectCode(verifyManifest({ ...base, now: () => T0 - 301_000 }), 'not_yet_valid');
		await expectCode(verifyManifest({ ...base, maxAgeSec: 0 }), 'invalid_argument');
		await expectCode(verifyManifest({ ...base, expectedAppId: '' }), 'invalid_argument');
		await expectCode(verifyManifest({ ...base, jws: 'x'.repeat(5000) }), 'malformed');
		// another signed object type cannot pass as a manifest signature
		const launchLike = await signCompactForTests(signer, 'ss-launch+jwt', { appId: 'app_1' });
		await expectCode(verifyManifest({ ...base, jws: launchLike }), 'wrong_type');
		const incomplete = await signCompactForTests(signer, MANIFEST_TYP, { appId: 'app_1', iat: T0 / 1000 });
		await expectCode(verifyManifest({ ...base, jws: incomplete }), 'malformed');
	});

	it('validates signing arguments', async () => {
		const { signer } = await makeKey('prod-1');
		await expectCode(signManifest({ signer, manifest, appId: '' }), 'invalid_argument');
		await expectCode(signManifest({ signer, manifest, appId: 'a', iat: -1 }), 'invalid_argument');
		await expectCode(signManifest({ signer, manifest, appId: 'a', iat: 1.5 }), 'invalid_argument');
		await expectCode(signManifest({ signer, manifest: { n: NaN }, appId: 'a' }), 'invalid_argument');
	});
});
