import { describe, expect, it } from 'vitest';
import {
	BUNDLE_SIGNING_PREFIX,
	bundleSigningInput,
	createSigner,
	generateSigningKey,
	signBundle,
	verifyBundle,
} from '../src/index.js';
import { expectCode, staticResolver } from './helpers.js';

/**
 * Copy of `value` without `key`.
 * @param {Record<string, any>} value
 * @param {string} key
 * @returns {Record<string, any>}
 */
const omitKey = (value, key) => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));

// Fixed test key and the signature the Portal catalog's former implementation produced for DESCRIPTOR (byte compatibility).
const VECTOR_KEY = /** @type {import('../src/index.js').PrivateJwk} */ ({
	kty: 'OKP',
	crv: 'Ed25519',
	x: '7SOV3bLoryL0VfDuBAMwTEKpWAQxNqSRBkSSjnCckTQ',
	kid: 'dev-vector-1',
	alg: 'EdDSA',
	use: 'sig',
	d: 'Ceb07R5JbCs6-XdBzfRPW1lMaf-V1UXRa_uOB1PI_xM',
});
const DESCRIPTOR = {
	format: 'ss-pack-bundle@1',
	manifest: { ssps: '1', product: { slug: 'notice-bar', version: '1.0.0' } },
	assets: [{ path: 'ui/bar.js', sha256: 'a'.repeat(64), size: 2048, contentType: 'text/javascript' }],
	createdAt: '2026-10-01T00:00:00Z',
};
const VECTOR_SIGNATURE = {
	kid: 'dev-vector-1',
	alg: 'EdDSA',
	sig: '9RCpOx-YEIfbmOdodg11jmMBxClRnMRIxqoL0PRzwObWclNVQIO2oQNFP62RMna6Lx0HqRegZ3cp0Inm2sKbAQ',
};

describe('bundle signatures', () => {
	it('is byte-compatible with the catalog implementation', async () => {
		expect(bundleSigningInput(DESCRIPTOR)).toBe(
			'ss-pack-bundle.v1.1246228d0d761c5b975368765b937d7d78a514d248f67a7bd46636425d36211b',
		);
		// key order does not matter (canonical JSON)
		const reordered = {
			createdAt: DESCRIPTOR.createdAt,
			assets: DESCRIPTOR.assets,
			manifest: DESCRIPTOR.manifest,
			format: DESCRIPTOR.format,
		};
		expect(bundleSigningInput(reordered)).toBe(bundleSigningInput(DESCRIPTOR));
		expect(await signBundle({ signer: createSigner(VECTOR_KEY), descriptor: DESCRIPTOR })).toEqual(VECTOR_SIGNATURE);
		const publicJwk = omitKey(VECTOR_KEY, 'd');
		expect(await verifyBundle({ descriptor: reordered, signature: VECTOR_SIGNATURE, publicJwk })).toBe(true);
	});

	it('signs and verifies (copied catalog cases)', async () => {
		const { privateJwk, publicJwk } = await generateSigningKey({ kid: 'dev-1' });
		const { publicJwk: other } = await generateSigningKey({ kid: 'dev-2' });
		const d = /** @type {any} */ ({ ...DESCRIPTOR });
		const sig = await signBundle({ signer: createSigner(privateJwk), descriptor: d });
		expect(bundleSigningInput(d)).toMatch(/^ss-pack-bundle\.v1\.[0-9a-f]{64}$/);
		expect(BUNDLE_SIGNING_PREFIX).toBe('ss-pack-bundle.v1.');
		expect(await verifyBundle({ descriptor: d, signature: sig, keys: [other, publicJwk] })).toBe(true);
		expect(await verifyBundle({ descriptor: { ...d, assets: [] }, signature: sig, keys: [publicJwk] })).toBe(false);
		expect(await verifyBundle({ descriptor: d, signature: sig, keys: [other] })).toBe(false);
		expect(await verifyBundle({ descriptor: d, signature: { ...sig, sig: 'AAAA' }, keys: [publicJwk] })).toBe(false);
		expect(await verifyBundle({ descriptor: d, signature: sig, keys: ['garbage'] })).toBe(false);
		expect(await verifyBundle({ descriptor: d, signature: { ...sig, kid: 'dev-2' }, keys: [{ ...other }] })).toBe(false);
	});

	it('verifies with a pinned key or a key resolver', async () => {
		const { privateJwk, publicJwk } = await generateSigningKey({ kid: 'dev-1' });
		const { publicJwk: other } = await generateSigningKey({ kid: 'dev-2' });
		const sig = await signBundle({ signer: createSigner(privateJwk), descriptor: DESCRIPTOR });
		expect(await verifyBundle({ descriptor: DESCRIPTOR, signature: sig, publicJwk })).toBe(true);
		expect(await verifyBundle({ descriptor: DESCRIPTOR, signature: sig, publicJwk: other })).toBe(false);
		expect(await verifyBundle({ descriptor: DESCRIPTOR, signature: sig, publicJwk: { ...other, kid: 'dev-1' } })).toBe(false);
		expect(await verifyBundle({ descriptor: DESCRIPTOR, signature: sig, keyResolver: staticResolver([publicJwk]) })).toBe(true);
		expect(await verifyBundle({ descriptor: DESCRIPTOR, signature: sig, keyResolver: staticResolver([other]) })).toBe(false);
		expect(await verifyBundle({ descriptor: DESCRIPTOR, signature: sig })).toBe(false);
		for (const bad of [null, 'x', { kid: 'dev-1' }, { ...sig, alg: 'RS256' }, { ...sig, sig: '***' }]) {
			expect(await verifyBundle({ descriptor: DESCRIPTOR, signature: bad, publicJwk })).toBe(false);
		}
		expect(await verifyBundle({ descriptor: { n: Infinity }, signature: sig, publicJwk })).toBe(false);
		await expectCode(signBundle({ signer: /** @type {any} */ ({}), descriptor: DESCRIPTOR }), 'invalid_argument');
	});
});
