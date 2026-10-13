import { createCipheriv, hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SEAL_FORMAT, createSealer, legacyV1, sealKeyId } from '../src/index.js';
import { expectThrowCode } from './helpers.js';

const A = 'key-a-0123456789-0123456789-abcdef';
const B = 'key-b-0123456789-0123456789-abcdef';
const C = 'key-c-0123456789-0123456789-abcdef';

/**
 * A value in the first products' format (`v1.<iv>.<tag>.<data>`), as they sealed it.
 * @param {string} encryptionKey
 * @param {string} info
 * @param {string} plaintext
 * @param {string} aad
 */
const sealV1 = (encryptionKey, info, plaintext, aad) => {
	const key = Buffer.from(hkdfSync('sha256', Buffer.from(encryptionKey, 'utf8'), Buffer.alloc(0), info, 32));
	const iv = Buffer.alloc(12, 7);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	cipher.setAAD(Buffer.from(aad, 'utf8'));
	const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
};

describe('sealing', () => {
	it('seals with a key id derived from the key (never the key) and opens with the same aad only', () => {
		const sealer = createSealer({ key: A, label: 'test' });
		const sealed = sealer.seal('secret', 'here');
		const [format, keyId, ...rest] = sealed.split('.');
		expect(format).toBe(SEAL_FORMAT);
		expect(keyId).toBe(sealKeyId(A));
		expect(keyId).toHaveLength(8);
		expect(sealed).not.toContain(A);
		expect(rest).toHaveLength(3);
		expect(sealer.keyId).toBe(keyId);
		expect(sealer.previousKeyId).toBeNull();
		expect(sealer.open(sealed, 'here')).toBe('secret');
		expect(sealer.open(sealed, 'elsewhere')).toBeNull();
		expect(sealer.seal('secret', 'here')).not.toBe(sealed); // fresh IV
		expect(sealer.isCurrent(sealed)).toBe(true);
	});

	it('another key or another label does not open; malformed values give null', () => {
		const sealed = createSealer({ key: A, label: 'test' }).seal('secret', 'here');
		expect(createSealer({ key: B, label: 'test' }).open(sealed, 'here')).toBeNull();
		expect(createSealer({ key: A, label: 'other' }).open(sealed, 'here')).toBeNull();
		const sealer = createSealer({ key: A, label: 'test' });
		expect(sealer.open(`${sealed}.x`, 'here')).toBeNull();
		expect(sealer.open(sealed.split('.').slice(0, 4).join('.'), 'here')).toBeNull();
		expect(sealer.open(`${sealed.slice(0, -2)}AA`, 'here')).toBeNull();
		expect(sealer.open(42, 'here')).toBeNull();
		expect(sealer.open('v9.x.y.z', 'here')).toBeNull();
		expect(sealer.isCurrent(42)).toBe(false);
	});

	it('key change: A sealed, B current with A previous opens everything, re-seal moves it to B, then A can go', () => {
		const old = createSealer({ key: A, label: 'test' });
		const sealedA = old.seal('database-uri', 'website-1');
		const changing = createSealer({ key: B, previousKey: A, label: 'test' });
		expect(changing.keyId).toBe(sealKeyId(B));
		expect(changing.previousKeyId).toBe(sealKeyId(A));
		expect(changing.open(sealedA, 'website-1')).toBe('database-uri');
		expect(changing.isCurrent(sealedA)).toBe(false);
		const sealedB = /** @type {string} */ (changing.reseal(sealedA, 'website-1'));
		expect(sealedB.split('.')[1]).toBe(sealKeyId(B));
		expect(changing.reseal(sealedB, 'website-1')).toBe(sealedB); // already current: unchanged
		expect(changing.reseal(sealedA, 'elsewhere')).toBeNull(); // cannot be opened
		const after = createSealer({ key: B, label: 'test' });
		expect(after.open(sealedB, 'website-1')).toBe('database-uri');
		expect(after.open(sealedA, 'website-1')).toBeNull();
		// a third key that sealed nothing here opens nothing
		expect(createSealer({ key: C, previousKey: B, label: 'test' }).open(sealedA, 'website-1')).toBeNull();
	});

	it('reads values sealed before this format with either key, and re-seals them', () => {
		const legacy = legacyV1('ss-test.seal.v1');
		const oldA = sealV1(A, 'ss-test.seal.v1', 'token', 'aad');
		expect(createSealer({ key: A, label: 'test', legacy }).open(oldA, 'aad')).toBe('token');
		expect(createSealer({ key: A, label: 'test', legacy }).open(oldA, 'other')).toBeNull();
		expect(createSealer({ key: A, label: 'test' }).open(oldA, 'aad')).toBeNull(); // no legacy reader
		const changing = createSealer({ key: B, previousKey: A, label: 'test', legacy });
		expect(changing.open(oldA, 'aad')).toBe('token');
		const moved = /** @type {string} */ (changing.reseal(oldA, 'aad'));
		expect(changing.isCurrent(moved)).toBe(true);
		expect(createSealer({ key: B, label: 'test' }).open(moved, 'aad')).toBe('token');
		expect(changing.open('v1.only.three', 'aad')).toBeNull();
		expect(changing.open(`${oldA}.extra`, 'aad')).toBeNull();
	});

	it('the same key twice counts once; bad keys and labels are refused', () => {
		expect(createSealer({ key: A, previousKey: A, label: 'test' }).previousKeyId).toBeNull();
		expect(createSealer({ key: A, previousKey: '', label: 'test' }).previousKeyId).toBeNull();
		expectThrowCode(() => createSealer({ key: 'short', label: 'test' }), 'invalid_argument');
		expectThrowCode(() => createSealer({ key: A, previousKey: 'short', label: 'test' }), 'invalid_argument');
		expectThrowCode(() => createSealer({ key: A, label: 'Not A Label' }), 'invalid_argument');
		expectThrowCode(() => createSealer(/** @type {any} */ ({ key: A })), 'invalid_argument');
	});

	it('uses the given randomness for the IV', () => {
		const sealer = createSealer({ key: A, label: 'test', randomBytes: (n) => new Uint8Array(n).fill(1) });
		expect(sealer.seal('x', 'a')).toBe(sealer.seal('x', 'a'));
	});
});
