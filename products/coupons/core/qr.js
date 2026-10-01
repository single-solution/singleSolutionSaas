/**
 * QR Code generator (ISO/IEC 18004, model 2) producing SVG — pure, dependency-free. Byte mode (UTF-8), versions 1–40,
 * error-correction levels L/M/Q/H, Reed–Solomon over GF(2⁸) with the 0x11D polynomial, the eight standard masks with
 * the standard penalty rules for choosing one. Used by `distribution` for share links (`GET /v1/share-links/{code}/qr`)
 * so no third-party service ever sees a merchant's codes.
 *
 * The algorithm follows the public specification (and the well-known reference structure by Project Nayuki); written
 * here from scratch in this product's functional style.
 * @module
 */

/** Error-correction levels and their format bits. */
export const ECC_LEVELS = Object.freeze({ L: 1, M: 0, Q: 3, H: 2 });
/** @typedef {keyof typeof ECC_LEVELS} EccLevel */

const ECC_ORDER = /** @type {const} */ (['L', 'M', 'Q', 'H']);

/** ECC codewords per block, by level then version (index 0 unused). */
const ECC_PER_BLOCK = Object.freeze({
	L: [
		-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30,
		30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
	],
	M: [
		-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28,
		28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
	],
	Q: [
		-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30,
		30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
	],
	H: [
		-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30,
		30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
	],
});

/** Number of error-correction blocks, by level then version (index 0 unused). */
const BLOCKS = Object.freeze({
	L: [
		-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20,
		21, 22, 24, 25,
	],
	M: [
		-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35,
		37, 38, 40, 43, 45, 47, 49,
	],
	Q: [
		-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48,
		51, 53, 56, 59, 62, 65, 68,
	],
	H: [
		-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54,
		57, 60, 63, 66, 70, 74, 77, 81,
	],
});

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

/** @param {number} value @param {number} index */
const bit = (value, index) => ((value >>> index) & 1) !== 0;

/**
 * Raw data modules of a version (everything except function patterns).
 * @param {number} version
 */
export const rawDataModules = (version) => {
	let result = (16 * version + 128) * version + 64;
	if (version >= 2) {
		const align = Math.floor(version / 7) + 2;
		result -= (25 * align - 10) * align - 55;
		if (version >= 7) result -= 36;
	}
	return result;
};

/**
 * Data codewords available for a version and level.
 * @param {number} version
 * @param {EccLevel} ecc
 */
export const dataCodewords = (version, ecc) =>
	Math.floor(rawDataModules(version) / 8) -
	/** @type {number} */ (ECC_PER_BLOCK[ecc][version]) * /** @type {number} */ (BLOCKS[ecc][version]);

/**
 * Centre coordinates of the alignment patterns of a version.
 * @param {number} version
 * @returns {number[]}
 */
export const alignmentPositions = (version) => {
	if (version === 1) return [];
	const count = Math.floor(version / 7) + 2;
	const step = Math.floor((version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
	const size = version * 4 + 17;
	/** @type {number[]} */
	const result = [6];
	for (let pos = size - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
	return result;
};

// ── Reed–Solomon over GF(2^8) ───────────────────────────────────────────────────────────────────────────────

/**
 * Product in GF(2^8) modulo x^8 + x^4 + x^3 + x^2 + 1.
 * @param {number} x
 * @param {number} y
 */
export const gfMultiply = (x, y) => {
	let z = 0;
	for (let i = 7; i >= 0; i -= 1) {
		z = (z << 1) ^ ((z >>> 7) * 0x11d);
		z ^= ((y >>> i) & 1) * x;
	}
	return z & 0xff;
};

/**
 * Generator polynomial coefficients (highest power first, leading 1 omitted) of a degree.
 * @param {number} degree
 * @returns {number[]}
 */
export const rsDivisor = (degree) => {
	const result = new Array(degree).fill(0);
	result[degree - 1] = 1;
	let root = 1;
	for (let i = 0; i < degree; i += 1) {
		for (let j = 0; j < result.length; j += 1) {
			result[j] = gfMultiply(result[j], root);
			if (j + 1 < result.length) result[j] ^= result[j + 1];
		}
		root = gfMultiply(root, 0x02);
	}
	return result;
};

/**
 * Error-correction codewords of a data block.
 * @param {readonly number[]} data
 * @param {readonly number[]} divisor
 * @returns {number[]}
 */
export const rsRemainder = (data, divisor) => {
	const result = new Array(divisor.length).fill(0);
	for (const byte of data) {
		const factor = byte ^ /** @type {number} */ (result.shift());
		result.push(0);
		divisor.forEach((coefficient, index) => {
			result[index] ^= gfMultiply(coefficient, factor);
		});
	}
	return result;
};

// ── data encoding ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * Bits needed by the byte-mode segment of `length` bytes at a version.
 * @param {number} length
 * @param {number} version
 */
const segmentBits = (length, version) => 4 + (version <= 9 ? 8 : 16) + length * 8;

/**
 * Data codewords (before interleaving) of the message at a version and level: mode, count, bytes, terminator, padding.
 * @param {Uint8Array} bytes
 * @param {number} version
 * @param {EccLevel} ecc
 * @returns {number[]}
 */
export const encodeData = (bytes, version, ecc) => {
	/** @type {number[]} */
	const bits = [];
	const push = (/** @type {number} */ value, /** @type {number} */ length) => {
		for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
	};
	push(0b0100, 4);
	push(bytes.length, version <= 9 ? 8 : 16);
	for (const byte of bytes) push(byte, 8);
	const capacity = dataCodewords(version, ecc) * 8;
	push(0, Math.min(4, capacity - bits.length));
	push(0, (8 - (bits.length % 8)) % 8);
	for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
	/** @type {number[]} */
	const codewords = [];
	for (let i = 0; i < bits.length; i += 8) {
		let value = 0;
		for (let j = 0; j < 8; j += 1) value = (value << 1) | (bits[i + j] ?? 0);
		codewords.push(value);
	}
	return codewords;
};

/**
 * Split data codewords into blocks, add error correction and interleave (the final codeword sequence).
 * @param {readonly number[]} data
 * @param {number} version
 * @param {EccLevel} ecc
 * @returns {number[]}
 */
export const addErrorCorrection = (data, version, ecc) => {
	const blockCount = /** @type {number} */ (BLOCKS[ecc][version]);
	const eccLength = /** @type {number} */ (ECC_PER_BLOCK[ecc][version]);
	const rawCodewords = Math.floor(rawDataModules(version) / 8);
	const shortBlocks = blockCount - (rawCodewords % blockCount);
	const shortLength = Math.floor(rawCodewords / blockCount);
	const divisor = rsDivisor(eccLength);
	/** @type {number[][]} */
	const blocks = [];
	for (let i = 0, k = 0; i < blockCount; i += 1) {
		const block = data.slice(k, k + shortLength - eccLength + (i < shortBlocks ? 0 : 1));
		k += block.length;
		const correction = rsRemainder(block, divisor);
		if (i < shortBlocks) block.push(0);
		blocks.push([...block, ...correction]);
	}
	/** @type {number[]} */
	const result = [];
	for (let i = 0; i < (blocks[0]?.length ?? 0); i += 1)
		blocks.forEach((block, j) => {
			if (i !== shortLength - eccLength || j >= shortBlocks) result.push(/** @type {number} */ (block[i]));
		});
	return result;
};

// ── matrix ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} Grid
 * @property {number} size
 * @property {boolean[][]} modules dark = true, `[y][x]`
 * @property {boolean[][]} reserved function modules
 */

/** @param {number} size @returns {Grid} */
const emptyGrid = (size) => ({
	size,
	modules: Array.from({ length: size }, () => new Array(size).fill(false)),
	reserved: Array.from({ length: size }, () => new Array(size).fill(false)),
});

/** @param {Grid} grid @param {number} x @param {number} y @param {boolean} dark */
const setFunction = (grid, x, y, dark) => {
	const modules = /** @type {boolean[]} */ (grid.modules[y]);
	const reserved = /** @type {boolean[]} */ (grid.reserved[y]);
	modules[x] = dark;
	reserved[x] = true;
};

/**
 * Format bits (level + mask, BCH-protected and masked with 0x5412).
 * @param {EccLevel} ecc
 * @param {number} mask
 */
export const formatBits = (ecc, mask) => {
	const data = (ECC_LEVELS[ecc] << 3) | mask;
	let rem = data;
	for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
	return ((data << 10) | rem) ^ 0x5412;
};

/**
 * Version bits (versions ≥ 7, BCH-protected).
 * @param {number} version
 */
export const versionBits = (version) => {
	let rem = version;
	for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
	return (version << 12) | rem;
};

/** @param {Grid} grid @param {EccLevel} ecc @param {number} mask */
const drawFormat = (grid, ecc, mask) => {
	const bits = formatBits(ecc, mask);
	const { size } = grid;
	for (let i = 0; i <= 5; i += 1) setFunction(grid, 8, i, bit(bits, i));
	setFunction(grid, 8, 7, bit(bits, 6));
	setFunction(grid, 8, 8, bit(bits, 7));
	setFunction(grid, 7, 8, bit(bits, 8));
	for (let i = 9; i < 15; i += 1) setFunction(grid, 14 - i, 8, bit(bits, i));
	for (let i = 0; i < 8; i += 1) setFunction(grid, size - 1 - i, 8, bit(bits, i));
	for (let i = 8; i < 15; i += 1) setFunction(grid, 8, size - 15 + i, bit(bits, i));
	setFunction(grid, 8, size - 8, true); // the dark module
};

/**
 * Function patterns of a version: timing, finders, alignment, (dummy) format and version information.
 * @param {number} version
 * @returns {Grid}
 */
export const functionGrid = (version) => {
	const size = version * 4 + 17;
	const grid = emptyGrid(size);
	for (let i = 0; i < size; i += 1) {
		setFunction(grid, 6, i, i % 2 === 0);
		setFunction(grid, i, 6, i % 2 === 0);
	}
	for (const [cx, cy] of [
		[3, 3],
		[size - 4, 3],
		[3, size - 4],
	]) {
		for (let dy = -4; dy <= 4; dy += 1)
			for (let dx = -4; dx <= 4; dx += 1) {
				const distance = Math.max(Math.abs(dx), Math.abs(dy));
				const x = /** @type {number} */ (cx) + dx;
				const y = /** @type {number} */ (cy) + dy;
				if (x >= 0 && x < size && y >= 0 && y < size) setFunction(grid, x, y, distance !== 2 && distance !== 4);
			}
	}
	const positions = alignmentPositions(version);
	const last = positions.length - 1;
	positions.forEach((px, i) =>
		positions.forEach((py, j) => {
			if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
			for (let dy = -2; dy <= 2; dy += 1)
				for (let dx = -2; dx <= 2; dx += 1) setFunction(grid, px + dx, py + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
		}),
	);
	drawFormat(grid, 'L', 0); // reserved now, overwritten once the mask is chosen
	if (version >= 7) {
		const bits = versionBits(version);
		for (let i = 0; i < 18; i += 1) {
			const a = size - 11 + (i % 3);
			const b = Math.floor(i / 3);
			setFunction(grid, a, b, bit(bits, i));
			setFunction(grid, b, a, bit(bits, i));
		}
	}
	return grid;
};

/**
 * Visit the data module positions in placement order (two-column zigzag from the bottom right, skipping column 6).
 * @param {Grid} grid
 * @param {(x: number, y: number) => void} visit
 */
export const forEachDataModule = (grid, visit) => {
	const { size } = grid;
	for (let right = size - 1; right >= 1; right -= 2) {
		if (right === 6) right = 5;
		for (let vert = 0; vert < size; vert += 1)
			for (let j = 0; j < 2; j += 1) {
				const x = right - j;
				const upward = ((right + 1) & 2) === 0;
				const y = upward ? size - 1 - vert : vert;
				if (!(/** @type {boolean[]} */ (grid.reserved[y])[x])) visit(x, y);
			}
	}
};

/**
 * Is the module at (x, y) inverted by a mask?
 * @param {number} mask 0…7
 * @param {number} x
 * @param {number} y
 */
export const maskBit = (mask, x, y) => {
	switch (mask) {
		case 0:
			return (x + y) % 2 === 0;
		case 1:
			return y % 2 === 0;
		case 2:
			return x % 3 === 0;
		case 3:
			return (x + y) % 3 === 0;
		case 4:
			return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
		case 5:
			return ((x * y) % 2) + ((x * y) % 3) === 0;
		case 6:
			return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
		default:
			return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
	}
};

/** @param {Grid} grid @param {number} mask */
const applyMask = (grid, mask) => {
	for (let y = 0; y < grid.size; y += 1)
		for (let x = 0; x < grid.size; x += 1)
			if (!(/** @type {boolean[]} */ (grid.reserved[y])[x]) && maskBit(mask, x, y)) {
				const row = /** @type {boolean[]} */ (grid.modules[y]);
				row[x] = !row[x];
			}
};

/**
 * Penalty score of a finished matrix (rules N1–N4 of the specification).
 * @param {boolean[][]} modules
 */
export const penaltyScore = (modules) => {
	const size = modules.length;
	let result = 0;
	/** @param {number} run @param {number[]} history */
	const addHistory = (run, history) => {
		history.pop();
		history.unshift(history[0] === 0 ? run + size : run);
	};
	/** @param {number[]} h */
	const countPatterns = (h) => {
		const n = /** @type {number} */ (h[1]);
		const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
		return (
			(core && /** @type {number} */ (h[0]) >= n * 4 && /** @type {number} */ (h[6]) >= n ? 1 : 0) +
			(core && /** @type {number} */ (h[6]) >= n * 4 && /** @type {number} */ (h[0]) >= n ? 1 : 0)
		);
	};
	/** @param {boolean} color @param {number} run @param {number[]} history */
	const terminate = (color, run, history) => {
		let length = run;
		if (color) {
			addHistory(length, history);
			length = 0;
		}
		addHistory(length + size, history);
		return countPatterns(history);
	};
	/** @param {(i: number, j: number) => boolean} at */
	const lines = (at) => {
		for (let i = 0; i < size; i += 1) {
			let color = false;
			let run = 0;
			const history = [0, 0, 0, 0, 0, 0, 0];
			for (let j = 0; j < size; j += 1) {
				if (at(i, j) === color) {
					run += 1;
					if (run === 5) result += PENALTY_N1;
					else if (run > 5) result += 1;
				} else {
					addHistory(run, history);
					if (!color) result += countPatterns(history) * PENALTY_N3;
					color = at(i, j);
					run = 1;
				}
			}
			result += terminate(color, run, history) * PENALTY_N3;
		}
	};
	const cell = (/** @type {number} */ y, /** @type {number} */ x) => /** @type {boolean} */ (modules[y]?.[x]);
	lines((i, j) => cell(i, j));
	lines((i, j) => cell(j, i));
	for (let y = 0; y < size - 1; y += 1)
		for (let x = 0; x < size - 1; x += 1) {
			const c = cell(y, x);
			if (c === cell(y, x + 1) && c === cell(y + 1, x) && c === cell(y + 1, x + 1)) result += PENALTY_N2;
		}
	const dark = modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
	const total = size * size;
	const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
	return result + k * PENALTY_N4;
};

/**
 * @typedef {object} QrCode
 * @property {number} version
 * @property {EccLevel} ecc
 * @property {number} mask
 * @property {number} size
 * @property {boolean[][]} modules dark = true, `[y][x]`
 * @property {number[]} codewords the interleaved codeword sequence placed in the matrix
 */

/**
 * Encode text (UTF-8, byte mode) at the smallest version that fits the level.
 * @param {string} text
 * @param {{ ecc?: EccLevel, minVersion?: number, maxVersion?: number, mask?: number }} [options] `mask` forces a mask
 * @returns {{ ok: true, qr: QrCode } | { ok: false, error: 'too_long' | 'invalid_option' }}
 */
export const encodeQr = (text, { ecc = 'M', minVersion = 1, maxVersion = 40, mask } = {}) => {
	if (!ECC_ORDER.includes(ecc) || minVersion < 1 || maxVersion > 40 || minVersion > maxVersion)
		return { ok: false, error: 'invalid_option' };
	if (mask !== undefined && !(Number.isInteger(mask) && mask >= 0 && mask <= 7)) return { ok: false, error: 'invalid_option' };
	const bytes = new TextEncoder().encode(String(text));
	let version = minVersion;
	while (version <= maxVersion && segmentBits(bytes.length, version) > dataCodewords(version, ecc) * 8) version += 1;
	if (version > maxVersion || bytes.length > 0xffff) return { ok: false, error: 'too_long' };
	const codewords = addErrorCorrection(encodeData(bytes, version, ecc), version, ecc);
	const grid = functionGrid(version);
	let index = 0;
	forEachDataModule(grid, (x, y) => {
		const byte = codewords[index >>> 3] ?? 0;
		/** @type {boolean[]} */ (grid.modules[y])[x] = index < codewords.length * 8 && bit(byte, 7 - (index & 7));
		index += 1;
	});
	let chosen = mask ?? 0;
	if (mask === undefined) {
		let best = Number.POSITIVE_INFINITY;
		for (let candidate = 0; candidate < 8; candidate += 1) {
			applyMask(grid, candidate);
			drawFormat(grid, ecc, candidate);
			const score = penaltyScore(grid.modules);
			if (score < best) {
				best = score;
				chosen = candidate;
			}
			applyMask(grid, candidate);
		}
	}
	applyMask(grid, chosen);
	drawFormat(grid, ecc, chosen);
	return { ok: true, qr: { version, ecc, mask: chosen, size: grid.size, modules: grid.modules, codewords } };
};

/** @param {string} text */
const xml = (text) =>
	text.replace(/[<>&"']/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char] ?? char);

/**
 * SVG document of a QR code: one path of unit squares on a `viewBox` grid with a quiet zone.
 * @param {QrCode} qr
 * @param {{ margin?: number, moduleSize?: number, dark?: string, light?: string, title?: string }} [options]
 *   colours are passed through only when they are `#rgb` / `#rrggbb` (anything else falls back to currentColor / none)
 * @returns {string}
 */
export const qrToSvg = (qr, { margin = 4, moduleSize = 4, dark = 'currentColor', light = 'none', title = '' } = {}) => {
	const colour = (/** @type {string} */ value, /** @type {string} */ fallback) =>
		/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value) ? value : fallback;
	const quiet = Math.max(0, Math.min(16, Math.floor(margin)));
	const extent = qr.size + quiet * 2;
	const pixels = extent * Math.max(1, Math.min(64, Math.floor(moduleSize)));
	/** @type {string[]} */
	const parts = [];
	qr.modules.forEach((row, y) =>
		row.forEach((on, x) => {
			if (on) parts.push(`M${x + quiet},${y + quiet}h1v1h-1z`);
		}),
	);
	const background = colour(light, 'none');
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${extent} ${extent}" width="${pixels}" height="${pixels}" shape-rendering="crispEdges" role="img"${title ? ` aria-label="${xml(title)}"` : ''}>`,
		title ? `<title>${xml(title)}</title>` : '',
		background === 'none' ? '' : `<rect width="${extent}" height="${extent}" fill="${background}"/>`,
		`<path d="${parts.join('')}" fill="${colour(dark, 'currentColor')}"/>`,
		'</svg>',
	].join('');
};
