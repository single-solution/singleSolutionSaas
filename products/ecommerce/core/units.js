/**
 * Units of measure (PLAN 0.8.10 dynamic model §4, §6): lengths, weights and volumes, each with its exact size in the
 * base unit of its dimension (millimeters, grams, milliliters: 1 in = 25.4 mm, 1 ft = 304.8 mm, 1 yd = 914.4 mm,
 * 1 lb = 453.59237 g, 1 oz = 28.349523125 g, by definition). A value converts only between units of one dimension.
 * No I/O.
 * @module
 */

/** @typedef {'length' | 'weight' | 'volume'} Dimension */
/** @typedef {{ dimension: Dimension, size: number }} UnitInfo */

/** Every unit by its key: its dimension and its size in that dimension's base unit. */
export const UNITS = Object.freeze(
	/** @type {Record<string, UnitInfo>} */ ({
		mm: { dimension: 'length', size: 1 },
		cm: { dimension: 'length', size: 10 },
		m: { dimension: 'length', size: 1000 },
		in: { dimension: 'length', size: 25.4 },
		ft: { dimension: 'length', size: 304.8 },
		yd: { dimension: 'length', size: 914.4 },
		g: { dimension: 'weight', size: 1 },
		kg: { dimension: 'weight', size: 1000 },
		lb: { dimension: 'weight', size: 453.59237 },
		oz: { dimension: 'weight', size: 28.349523125 },
		ml: { dimension: 'volume', size: 1 },
		l: { dimension: 'volume', size: 1000 },
	}),
);

/** The unit keys, in their listed order. */
export const UNIT_KEYS = Object.freeze(Object.keys(UNITS));

/**
 * A known unit, or null for anything else (an own label such as `EU` or none).
 * @param {unknown} key
 * @returns {UnitInfo | null}
 */
export const unitOf = (key) => (typeof key === 'string' && Object.hasOwn(UNITS, key) ? (UNITS[key] ?? null) : null);

/**
 * Whether two units are known units of one dimension (a value of one can be written in the other).
 * @param {unknown} from
 * @param {unknown} to
 */
export const sameDimension = (from, to) => {
	const a = unitOf(from);
	const b = unitOf(to);
	return a !== null && b !== null && a.dimension === b.dimension;
};

/** Decimal places kept while converting, so the exact factors give exact results (1 in = 2.54 cm, not 2.5400000000000005). */
const PRECISION = 1e9;

/**
 * A value written in another unit of its dimension, with the exact factors; null between dimensions or for an unknown
 * unit.
 * @param {number} value
 * @param {string} from
 * @param {string} to
 * @returns {number | null}
 */
export const convertAmount = (value, from, to) => {
	const a = unitOf(from);
	const b = unitOf(to);
	if (!a || !b || a.dimension !== b.dimension || !Number.isFinite(value)) return null;
	if (from === to) return value;
	return Math.round(((value * a.size) / b.size) * PRECISION) / PRECISION;
};
