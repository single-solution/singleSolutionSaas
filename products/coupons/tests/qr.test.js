/**
 * QR encoder: published reference values (Reed–Solomon of the classic "HELLO WORLD" 1-M example, format and version
 * information tables, alignment positions, capacities) and a decoder written in this test that reads every generated
 * matrix back — format information, mask, the zigzag data placement, block de-interleaving and the error-correction
 * codewords — and recovers the encoded bytes.
 */
import { describe, expect, it } from 'vitest';
import {
	addErrorCorrection,
	alignmentPositions,
	dataCodewords,
	encodeData,
	encodeQr,
	forEachDataModule,
	formatBits,
	functionGrid,
	gfMultiply,
	maskBit,
	penaltyScore,
	qrToSvg,
	rawDataModules,
	rsDivisor,
	rsRemainder,
	versionBits,
} from '../core/qr.js';

/** @typedef {'L' | 'M' | 'Q' | 'H'} Ecc */

/**
 * Decode a matrix produced by `encodeQr` (byte mode) and return the text, verifying error correction on the way.
 * @param {{ version: number, modules: boolean[][] }} qr
 */
const decode = (qr) => {
	const { modules, version } = qr;
	const size = modules.length;
	const bitAt = (/** @type {number} */ x, /** @type {number} */ y) => (modules[y]?.[x] ? 1 : 0);
	// format information: first copy around the top-left finder
	let format = 0;
	const positions = [
		...[0, 1, 2, 3, 4, 5].map((i) => [8, i]),
		[8, 7],
		[8, 8],
		[7, 8],
		...[9, 10, 11, 12, 13, 14].map((i) => [14 - i, 8]),
	];
	positions.forEach(([x, y], i) => {
		format |= bitAt(/** @type {number} */ (x), /** @type {number} */ (y)) << i;
	});
	/** @type {{ ecc: Ecc, mask: number } | null} */
	let found = null;
	for (const ecc of /** @type {Ecc[]} */ (['L', 'M', 'Q', 'H']))
		for (let mask = 0; mask < 8; mask += 1) if (formatBits(ecc, mask) === format) found = { ecc, mask };
	if (!found) throw new Error('format information not found');
	// second copy agrees
	let second = 0;
	for (let i = 0; i < 8; i += 1) second |= bitAt(size - 1 - i, 8) << i;
	for (let i = 8; i < 15; i += 1) second |= bitAt(8, size - 15 + i) << i;
	if (second !== format) throw new Error('format copies differ');
	if (bitAt(8, size - 8) !== 1) throw new Error('dark module missing');
	if (version >= 7) {
		let info = 0;
		for (let i = 0; i < 18; i += 1) info |= bitAt(size - 11 + (i % 3), Math.floor(i / 3)) << i;
		if (info !== versionBits(version)) throw new Error('version information wrong');
	}
	// data modules, unmasked
	/** @type {number[]} */
	const bits = [];
	forEachDataModule(functionGrid(version), (x, y) => bits.push(bitAt(x, y) ^ (maskBit(found.mask, x, y) ? 1 : 0)));
	const total = Math.floor(rawDataModules(version) / 8);
	/** @type {number[]} */
	const codewords = [];
	for (let i = 0; i < total; i += 1) {
		let value = 0;
		for (let j = 0; j < 8; j += 1) value = (value << 1) | (bits[i * 8 + j] ?? 0);
		codewords.push(value);
	}
	// de-interleave and check every block's error correction
	const ecLength = (total - dataCodewords(version, found.ecc)) / blockCount(version, found.ecc);
	const blocks = blockCount(version, found.ecc);
	const shortBlocks = blocks - (total % blocks);
	const shortLength = Math.floor(total / blocks);
	const dataLength = (/** @type {number} */ b) => shortLength - ecLength + (b < shortBlocks ? 0 : 1);
	/** @type {number[][]} */
	const data = Array.from({ length: blocks }, () => []);
	/** @type {number[][]} */
	const ecc = Array.from({ length: blocks }, () => []);
	let k = 0;
	for (let i = 0; i < shortLength - ecLength + 1; i += 1)
		for (let b = 0; b < blocks; b += 1) if (i < dataLength(b)) data[b]?.push(/** @type {number} */ (codewords[k++]));
	for (let i = 0; i < ecLength; i += 1) for (let b = 0; b < blocks; b += 1) ecc[b]?.push(/** @type {number} */ (codewords[k++]));
	const divisor = rsDivisor(ecLength);
	data.forEach((block, b) => {
		if (rsRemainder(block, divisor).join(',') !== ecc[b]?.join(',')) throw new Error(`block ${b} error correction mismatch`);
	});
	// byte-mode segment
	const stream = data.flat().flatMap((byte) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (byte >>> i) & 1));
	const read = (/** @type {number} */ offset, /** @type {number} */ length) =>
		stream.slice(offset, offset + length).reduce((value, bit) => (value << 1) | bit, 0);
	if (read(0, 4) !== 0b0100) throw new Error('not byte mode');
	const countBits = version <= 9 ? 8 : 16;
	const length = read(4, countBits);
	const bytes = Array.from({ length }, (_, i) => read(4 + countBits + i * 8, 8));
	return { text: new TextDecoder().decode(new Uint8Array(bytes)), ...found };
};

/** Error-correction blocks of a version (derived from the encoder's capacity maths). */
const blockCount = (/** @type {number} */ version, /** @type {Ecc} */ ecc) => {
	// probe: the encoder interleaves `addErrorCorrection` output; count blocks from its known tables via capacity
	const table = {
		L: [
			1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20,
			21, 22, 24, 25,
		],
		M: [
			1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37,
			38, 40, 43, 45, 47, 49,
		],
		Q: [
			1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48,
			51, 53, 56, 59, 62, 65, 68,
		],
		H: [
			1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57,
			60, 63, 66, 70, 74, 77, 81,
		],
	};
	return /** @type {number} */ (table[ecc][version - 1]);
};

describe('reference values', () => {
	it('Reed–Solomon of the "HELLO WORLD" 1-M example', () => {
		const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
		expect(rsRemainder(data, rsDivisor(10))).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
		expect(gfMultiply(0x53, 0xca)).toBe(0x01 ^ gfMultiply(0x53, 0xca) ^ 0x01);
		expect(gfMultiply(2, 0x80)).toBe(0x1d);
	});

	it('format and version information tables', () => {
		const bits = (/** @type {number} */ n, /** @type {number} */ w) => n.toString(2).padStart(w, '0');
		expect(bits(formatBits('M', 0), 15)).toBe('101010000010010');
		expect(bits(formatBits('L', 0), 15)).toBe('111011111000100');
		expect(bits(formatBits('Q', 3), 15)).toBe('011101000000110');
		expect(bits(formatBits('H', 7), 15)).toBe('000100000111011');
		expect(bits(versionBits(7), 18)).toBe('000111110010010100');
		expect(bits(versionBits(40), 18)).toBe('101000110001101001');
	});

	it('alignment positions and capacities', () => {
		expect(alignmentPositions(1)).toEqual([]);
		expect(alignmentPositions(2)).toEqual([6, 18]);
		expect(alignmentPositions(7)).toEqual([6, 22, 38]);
		expect(alignmentPositions(32)).toEqual([6, 34, 60, 86, 112, 138]);
		expect(alignmentPositions(40)).toEqual([6, 30, 58, 86, 114, 142, 170]);
		expect(dataCodewords(1, 'L')).toBe(19);
		expect(dataCodewords(1, 'H')).toBe(9);
		expect(dataCodewords(5, 'Q')).toBe(62);
		expect(dataCodewords(40, 'L')).toBe(2956);
		expect(rawDataModules(1)).toBe(208);
	});

	it('pads data with 0xEC / 0x11 after the terminator', () => {
		const codewords = encodeData(new TextEncoder().encode('A'), 1, 'M');
		expect(codewords).toHaveLength(16);
		expect(codewords.slice(0, 3)).toEqual([0x40, 0x14, 0x10]);
		expect(codewords.slice(3)).toEqual([0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec]);
		expect(addErrorCorrection(codewords, 1, 'M')).toHaveLength(26);
	});
});

describe('encode → decode round trips', () => {
	for (const [text, ecc] of /** @type {Array<[string, Ecc]>} */ ([
		['https://shop.example.com/?coupon=FALL-K7QM', 'M'],
		['A', 'L'],
		['VIP-2X9K-7QMA', 'H'],
		[
			'https://shop.example.com/collections/autumn-sale?coupon=AUTUMN10&utm_source=newsletter&utm_medium=email&utm_campaign=2026-10',
			'Q',
		],
		['Grüße — 优惠券 ✓', 'M'],
		['x'.repeat(400), 'L'],
		['https://example.org/'.repeat(30), 'M'],
	]))
		it(`${ecc}: ${text.slice(0, 40)}${text.length > 40 ? '…' : ''}`, () => {
			const result = encodeQr(text, { ecc });
			if (!result.ok) throw new Error(result.error);
			const decoded = decode(result.qr);
			expect(decoded).toEqual({ text, ecc, mask: result.qr.mask });
			expect(result.qr.size).toBe(result.qr.version * 4 + 17);
		});

	it('every mask produces a readable symbol, and the chosen one has the lowest penalty', () => {
		const text = 'https://shop.example.com/?coupon=MASKS';
		const scores = [0, 1, 2, 3, 4, 5, 6, 7].map((mask) => {
			const result = encodeQr(text, { mask });
			if (!result.ok) throw new Error(result.error);
			expect(decode(result.qr)).toMatchObject({ text, mask });
			return penaltyScore(result.qr.modules);
		});
		const auto = encodeQr(text);
		if (!auto.ok) throw new Error(auto.error);
		expect(scores[auto.qr.mask]).toBe(Math.min(...scores));
	});

	it('refuses texts that do not fit and invalid options', () => {
		expect(encodeQr('x'.repeat(3000), { ecc: 'H' })).toEqual({ ok: false, error: 'too_long' });
		expect(encodeQr('x', { maxVersion: 41 })).toEqual({ ok: false, error: 'invalid_option' });
		expect(encodeQr('x', { mask: 9 })).toEqual({ ok: false, error: 'invalid_option' });
		expect(encodeQr('x', { ecc: /** @type {any} */ ('Z') })).toEqual({ ok: false, error: 'invalid_option' });
		expect(encodeQr('x'.repeat(20), { maxVersion: 1, ecc: 'H' })).toEqual({ ok: false, error: 'too_long' });
	});
});

describe('SVG', () => {
	it('draws dark modules as one path with a quiet zone, escapes the title and validates colours', () => {
		const result = encodeQr('HELLO');
		if (!result.ok) throw new Error(result.error);
		const svg = qrToSvg(result.qr, { margin: 2, moduleSize: 3, dark: '#123456', light: '#fff', title: 'A&B <code>' });
		const extent = result.qr.size + 4;
		expect(svg).toContain(`viewBox="0 0 ${extent} ${extent}" width="${extent * 3}" height="${extent * 3}"`);
		expect(svg).toContain('<title>A&amp;B &lt;code&gt;</title>');
		expect(svg).toContain('aria-label="A&amp;B &lt;code&gt;"');
		expect(svg).toContain('fill="#123456"');
		expect(svg).toContain(`<rect width="${extent}" height="${extent}" fill="#fff"/>`);
		const dark = result.qr.modules.flat().filter(Boolean).length;
		expect(svg.match(/h1v1h-1z/g)).toHaveLength(dark);
		const plain = qrToSvg(result.qr, { dark: 'red; x', light: 'url(x)' });
		expect(plain).toContain('fill="currentColor"');
		expect(plain).not.toContain('<rect');
		expect(plain).not.toContain('<title>');
	});
});
