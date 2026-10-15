/**
 * Selling in any unit (PLAN 0.8.10 dynamic model §4, phase 7; feature `measured_sales`): items sold in decimal
 * quantities of the merchant's own unit — per meter, per kilogram, per square foot, per hour, per dozen, per tola or
 * per carat; the unit is a label the merchant writes in any language, never a pick from a list. An item type's
 * `measure` element names that label, the decimals a shopper may give (0–3) and the step, least and most a shopper
 * buys. Every quantity of such an item — its variants' stock, a cart or order line's quantity, returned and claimed
 * quantities, stock holds and restocks — is a whole number of **thousandths of the unit** (2.5 = 2500, a step of 0.5 =
 * 500), so every amount stays exact. A price stays per one unit; what a line comes to is {@link lineGross}, the one
 * place that multiplies a unit price by a quantity. For everything counted in pieces (the most of one item, deal
 * minimums, per-unit deal rounding, item counts, analytics items) a measured line is one piece ({@link piecesOf}).
 *
 * Only for shopping feeds (`unit_pricing_measure`) and structured data (`UnitPriceSpecification`) may the merchant tie
 * the unit to a standard measure: an amount of a UN/CEFACT unit ({@link STANDARD_UNITS}). Without it, unit pricing is
 * left out; it is never guessed, and the standard list never limits what a merchant sells in. No I/O.
 * @module
 */
import { MAX_AMOUNT } from './money.js';

/** Thousandths of the unit in one unit (the integer base of measured quantities). */
export const MILLI = 1000;
/** The most of one measured line, and of a step, a least and a most quantity, in thousandths (a million units). */
export const MAX_MEASURED = 1_000_000_000;
/** The longest unit label. */
export const MAX_UNIT_LABEL = 20;
/** The most decimals a shopper may give of a unit. */
export const MAX_DECIMALS = 3;
/** The most pieces of one cart line (the system ceiling: the `checkout` setting `maxQuantity` and an item type's
 * quantity rule lower it, E4). */
export const MAX_QUANTITY = 100_000;
/** The most lines of one cart (the system ceiling: the `checkout` setting `maxLines` lowers it, E4). */
export const MAX_LINES = 500;

/**
 * The standard units a merchant may tie a unit to, for shopping feeds and structured data only: the UN/CEFACT common
 * code (structured data's `unitCode`) → the unit Google's `unit_pricing_measure` takes and how many of it one is (a
 * millimeter is sent as 0.1 cm).
 * @type {Readonly<Record<string, { feed: string, factor: number }>>}
 */
export const STANDARD_UNITS = Object.freeze({
	MMT: { feed: 'cm', factor: 0.1 },
	CMT: { feed: 'cm', factor: 1 },
	MTR: { feed: 'm', factor: 1 },
	INH: { feed: 'in', factor: 1 },
	FOT: { feed: 'ft', factor: 1 },
	YRD: { feed: 'yd', factor: 1 },
	MTK: { feed: 'sqm', factor: 1 },
	FTK: { feed: 'sqft', factor: 1 },
	MGM: { feed: 'mg', factor: 1 },
	GRM: { feed: 'g', factor: 1 },
	KGM: { feed: 'kg', factor: 1 },
	ONZ: { feed: 'oz', factor: 1 },
	LBR: { feed: 'lb', factor: 1 },
	MLT: { feed: 'ml', factor: 1 },
	CLT: { feed: 'cl', factor: 1 },
	LTR: { feed: 'l', factor: 1 },
	MTQ: { feed: 'cbm', factor: 1 },
	OZA: { feed: 'floz', factor: 1 },
	GLL: { feed: 'gal', factor: 1 },
	C62: { feed: 'ct', factor: 1 },
});

/**
 * What one unit is in a standard unit, for feeds and structured data only: `amount` of the UN/CEFACT unit `code`
 * (a tola as 11.664 GRM, a dozen as 12 C62).
 * @typedef {{ code: string, amount: number }} StandardMeasure
 */
/**
 * The `measure` element of an item type: the merchant's unit label (prices are per one unit), the decimals a shopper
 * may give, and in thousandths of the unit the step a quantity is a multiple of, the least quantity and the most
 * (null: no most); `standard`: what one unit is in a standard unit, for feeds and structured data (null: none).
 * @typedef {{ unit: string, decimals: number, step: number, min: number, max: number | null,
 *   standard: StandardMeasure | null }} Measure
 */
/**
 * What an order line keeps of its item's measure at placement (none: counted in pieces).
 * @typedef {{ unit: string, decimals: number, step: number }} LineMeasure
 */

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** @param {unknown} value @param {number} min @param {number} max */
const whole = (value, min, max) => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F]/;

/**
 * Check the `measure` element an item type gives: null (counted in pieces) or `{ unit, decimals, step, min, max,
 * standard }`: a unit label of 1 to {@link MAX_UNIT_LABEL} characters in any language, 0 to 3 decimals (default 1), a
 * step from 0.001 to 1,000 units that the decimals can write (default the smallest they write: 0.1 with one decimal), the
 * least quantity a multiple of the step (default one step), the most one too and at least the least (default none),
 * and optionally a standard measure: an amount (above 0, at most 1,000,000, six decimals) of a code of
 * {@link STANDARD_UNITS}.
 * @param {unknown} raw
 * @returns {{ ok: true, value: Measure | null } | { ok: false, errors: Array<{ path: string, message: string }> }}
 */
export const checkMeasure = (raw) => {
	if (raw === null || raw === undefined || raw === false) return { ok: true, value: null };
	if (!isObject(raw))
		return {
			ok: false,
			errors: [{ path: '', message: 'measure is null or { unit, decimals, step, min, max, standard }.' }],
		};
	/** @type {Array<{ path: string, message: string }>} */
	const errors = [];
	// one line of text: spaces inside are kept as one, a line break or other control character refused
	const unit = typeof raw.unit === 'string' && !CONTROL.test(raw.unit) ? raw.unit.trim().replace(/ {2,}/g, ' ') : '';
	if (!unit || unit.length > MAX_UNIT_LABEL)
		errors.push({
			path: '/unit',
			message: `Name the unit in 1 to ${MAX_UNIT_LABEL} characters (such as m, kg, sq ft, hour or dozen).`,
		});
	const decimals = raw.decimals ?? 1;
	if (!whole(decimals, 0, MAX_DECIMALS)) errors.push({ path: '/decimals', message: `decimals is 0 to ${MAX_DECIMALS}.` });
	const grain = whole(decimals, 0, MAX_DECIMALS) ? 10 ** (MAX_DECIMALS - Number(decimals)) : 1;
	const step = raw.step ?? grain;
	if (!whole(step, 1, 1_000_000) || Number(step) % grain !== 0)
		errors.push({
			path: '/step',
			message: 'The step is a whole number of thousandths of the unit, from 1 to 1,000,000, that the decimals can write.',
		});
	const okStep = whole(step, 1, 1_000_000) ? Number(step) : 1;
	const min = raw.min ?? okStep;
	if (!whole(min, okStep, MAX_MEASURED) || Number(min) % okStep !== 0)
		errors.push({ path: '/min', message: 'The least quantity is a multiple of the step, in thousandths of the unit.' });
	const max = raw.max ?? null;
	if (max !== null && (!whole(max, Number(min) || okStep, MAX_MEASURED) || Number(max) % okStep !== 0))
		errors.push({
			path: '/max',
			message: `The most quantity is null or a multiple of the step from the least quantity to ${MAX_MEASURED}.`,
		});
	const standard = raw.standard ?? null;
	if (standard !== null) {
		const amount = isObject(standard) ? standard.amount : undefined;
		if (!isObject(standard) || !Object.hasOwn(STANDARD_UNITS, standard.code))
			errors.push({ path: '/standard/code', message: `A standard unit is one of ${Object.keys(STANDARD_UNITS).join(', ')}.` });
		if (
			typeof amount !== 'number' ||
			!Number.isFinite(amount) ||
			amount <= 0 ||
			amount > 1_000_000 ||
			Math.abs(amount * 1e6 - Math.round(amount * 1e6)) > 1e-6
		)
			errors.push({
				path: '/standard/amount',
				message: 'The amount is a number above 0, at most 1,000,000, with at most six decimals.',
			});
	}
	for (const key of Object.keys(raw))
		if (!['unit', 'decimals', 'step', 'min', 'max', 'standard'].includes(key))
			errors.push({ path: `/${key}`, message: `measure has no ${key}.` });
	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		value: {
			unit,
			decimals: Number(decimals),
			step: Number(step),
			min: Number(min),
			max: max === null ? null : Number(max),
			standard: standard === null ? null : { code: String(standard.code), amount: Number(standard.amount) },
		},
	};
};

/**
 * Whether two measures give quantities the same meaning (the same unit label; decimals, steps, limits and the standard
 * measure may differ): stock kept in thousandths of one unit cannot be read in another.
 * @param {Pick<Measure, 'unit'> | null | undefined} a @param {Pick<Measure, 'unit'> | null | undefined} b
 */
export const sameMeaning = (a, b) => ((a ?? null) === null ? (b ?? null) === null : (b ?? null) !== null && a?.unit === b?.unit);

/**
 * What a line comes to: its unit price times its quantity — exact for pieces; for a measured line (`quantity` in
 * thousandths) the price of `quantity / 1000` units rounded half up, to whole `unit`s with Format's `wholeUnits`
 * (E25). Worked in BigInt, so a price up to {@link MAX_AMOUNT} times the most of a line is exact.
 * @param {number} unitPrice minor units, per piece or per selling unit
 * @param {number} quantity pieces, or thousandths of the selling unit
 * @param {boolean} measured
 * @param {number} [unit] whole units (E25)
 * @returns {number} minor units
 * @throws {RangeError} when it is more than {@link MAX_AMOUNT} (callers refuse such lines first, {@link grossFits})
 */
export const lineGross = (unitPrice, quantity, measured, unit = 1) => {
	const product = BigInt(unitPrice) * BigInt(quantity);
	const divisor = measured ? BigInt(MILLI) * BigInt(Math.max(1, unit)) : 1n;
	const gross = measured ? ((product * 2n + divisor) / (2n * divisor)) * BigInt(Math.max(1, unit)) : product;
	if (gross > BigInt(MAX_AMOUNT)) throw new RangeError(`A line comes to more than ${MAX_AMOUNT} minor units.`);
	return Number(gross);
};

/**
 * Whether a line's amount stays within {@link MAX_AMOUNT} (a larger line is refused, never rounded).
 * @param {number} unitPrice @param {number} quantity @param {boolean} measured @param {number} [unit]
 */
export const grossFits = (unitPrice, quantity, measured, unit = 1) => {
	try {
		lineGross(unitPrice, quantity, measured, unit);
		return true;
	} catch {
		return false;
	}
};

/**
 * A per-unit amount (a deal's saving, a package's weight) for a measured quantity, rounded down: `amount × quantity /
 * 1000`, exact in BigInt.
 * @param {number} amount per selling unit
 * @param {number} quantity thousandths of the selling unit
 */
export const perMeasure = (amount, quantity) =>
	Number((BigInt(Math.max(0, Math.floor(amount))) * BigInt(quantity)) / BigInt(MILLI));

/**
 * The pieces a line counts as: its quantity, or 1 for a measured line (the most of one item, deal minimums, per-unit
 * deal rounding, item counts and analytics items).
 * @param {{ quantity: number, measure?: unknown }} line
 */
export const piecesOf = (line) => (line.measure ? 1 : line.quantity);

/**
 * A quantity as text: pieces as they are, thousandths as a decimal number of units (`2500` → `2.5`).
 * @param {number} quantity
 * @param {unknown} [measure] the line's or item's measure (none: pieces)
 */
export const quantityText = (quantity, measure) => {
	if (!measure) return String(quantity);
	const sign = quantity < 0 ? '-' : '';
	const abs = Math.abs(quantity);
	const units = Math.floor(abs / MILLI);
	const rest = String(abs % MILLI)
		.padStart(3, '0')
		.replace(/0+$/, '');
	return `${sign}${units}${rest ? `.${rest}` : ''}`;
};

/**
 * A decimal text (or number) of units as thousandths, exactly: `2.5` → 2500, `0.75` → 750, `3` → 3000; null when it
 * is not a plain positive number with at most three decimals (more decimals only as trailing zeros).
 * @param {unknown} value
 * @returns {number | null}
 */
export const toThousandths = (value) => {
	const text =
		typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : typeof value === 'string' ? value.trim() : '';
	const match = /^(\d{1,7})(?:\.(\d{1,12}))?$/.exec(text);
	if (!match) return null;
	const fraction = match[2] ?? '';
	if (fraction.length > 3 && !/^0*$/.test(fraction.slice(3))) return null;
	const out = Number(match[1]) * MILLI + Number(fraction.slice(0, 3).padEnd(3, '0'));
	return out > 0 && out <= MAX_MEASURED ? out : null;
};

/**
 * The quantity rule of an item counted in pieces (its item type's `quantity` element, E4): the step a quantity is a
 * multiple of (6 for a case of six), the least and the most (null: up to the shop's most of one item).
 * @typedef {{ step: number, min: number, max: number | null }} QuantityRule
 */
/**
 * The quantities a shopper may buy of an item: a multiple of `step` from `min` to `max` — in thousandths of the unit
 * of a measured item, else in pieces.
 * @typedef {{ step: number, min: number, max: number }} QuantityLimits
 */

/**
 * Check the `quantity` element an item type gives: null (any number of pieces from 1) or `{ step, min, max }` in whole
 * pieces: a step from 1 to {@link MAX_QUANTITY} (default 1), the least a multiple of the step (default one step), the
 * most null (the shop's most of one item) or a multiple of the step from the least to {@link MAX_QUANTITY}.
 * @param {unknown} raw
 * @returns {{ ok: true, value: QuantityRule | null } | { ok: false, errors: Array<{ path: string, message: string }> }}
 */
export const checkQuantityRule = (raw) => {
	if (raw === null || raw === undefined || raw === false) return { ok: true, value: null };
	if (!isObject(raw)) return { ok: false, errors: [{ path: '', message: 'quantity is null or { step, min, max }.' }] };
	/** @type {Array<{ path: string, message: string }>} */
	const errors = [];
	const step = raw.step ?? 1;
	if (!whole(step, 1, MAX_QUANTITY))
		errors.push({ path: '/step', message: `The step is a whole number of pieces from 1 to ${MAX_QUANTITY}.` });
	const okStep = whole(step, 1, MAX_QUANTITY) ? Number(step) : 1;
	const min = raw.min ?? okStep;
	if (!whole(min, okStep, MAX_QUANTITY) || Number(min) % okStep !== 0)
		errors.push({ path: '/min', message: 'The least quantity is a multiple of the step.' });
	const max = raw.max ?? null;
	if (max !== null && (!whole(max, Number(min) || okStep, MAX_QUANTITY) || Number(max) % okStep !== 0))
		errors.push({
			path: '/max',
			message: `The most quantity is null or a multiple of the step from the least quantity to ${MAX_QUANTITY}.`,
		});
	for (const key of Object.keys(raw))
		if (!['step', 'min', 'max'].includes(key)) errors.push({ path: `/${key}`, message: `quantity has no ${key}.` });
	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, value: { step: Number(step), min: Number(min), max: max === null ? null : Number(max) } };
};

/**
 * The quantities a shopper may buy of an item: a measured item's step, least and most (in thousandths of its unit;
 * no most: {@link MAX_MEASURED}); else in pieces its type's quantity rule (none: from 1 in steps of 1), its most at
 * most `cap` (the shop's most of one item).
 * @param {Pick<Measure, 'step' | 'min' | 'max'> | null | undefined} measure
 * @param {QuantityRule | null | undefined} rule
 * @param {number} cap
 * @returns {QuantityLimits}
 */
export const limitsOf = (measure, rule, cap) =>
	measure
		? { step: measure.step, min: measure.min, max: measure.max ?? MAX_MEASURED }
		: { step: rule?.step ?? 1, min: rule?.min ?? 1, max: Math.min(cap, rule?.max ?? cap) };

/**
 * Why a quantity cannot be bought: `quantity_step` (not a multiple of the step), `quantity_min` (below the least) or
 * `quantity_max` (above the most); null when it can.
 * @param {number} quantity pieces, or thousandths of a measured item's unit
 * @param {{ step: number, min: number, max: number | null }} limits
 * @returns {'quantity_step' | 'quantity_min' | 'quantity_max' | null}
 */
export const quantityProblem = (quantity, limits) => {
	if (quantity < limits.min) return 'quantity_min';
	if (limits.max !== null && quantity > limits.max) return 'quantity_max';
	if (quantity % limits.step !== 0) return 'quantity_step';
	return null;
};

/**
 * What a line keeps of its item's measure (null: counted in pieces).
 * @param {Measure | null | undefined} measure
 * @returns {LineMeasure | null}
 */
export const lineMeasureOf = (measure) =>
	measure ? { unit: measure.unit, decimals: measure.decimals, step: measure.step } : null;

/**
 * A measure as answers show it with a quantity: the merchant's unit label and the quantity as decimal text.
 * @param {number} quantity @param {Pick<Measure, 'unit'> | null | undefined} measure
 * @returns {{ unit: string, quantityText: string } | null}
 */
export const measureView = (quantity, measure) =>
	measure ? { unit: measure.unit, quantityText: quantityText(quantity, measure) } : null;

/**
 * The unit price measure of shopping feeds (`unit_pricing_measure` and `unit_pricing_base_measure`): what one unit is
 * in a standard unit (`1 m`, `11.664 g`, `12 ct`), or null without a standard measure (never guessed).
 * @param {Pick<Measure, 'standard'>} measure
 * @returns {string | null}
 */
export const feedMeasureOf = (measure) => {
	const standard = measure.standard;
	const unit = standard ? STANDARD_UNITS[standard.code] : undefined;
	if (!standard || !unit) return null;
	return `${Number((standard.amount * unit.factor).toFixed(6))} ${unit.feed}`;
};

/**
 * A stock level in thousandths compared in selling units: the `catalog` setting `lowStock` is in units (pieces, or
 * selling units of a measured item).
 * @param {number} level units
 * @param {unknown} measure the item's measure (none: pieces)
 */
export const levelOf = (level, measure) => (measure ? level * MILLI : level);

/**
 * What a placed order line came to before discounts: unit price × pieces, or for a measured line what it was priced at
 * (its total + discount, less tax added on top), so a later change of Format's `wholeUnits` never changes it.
 * @param {{ unitPrice: number, quantity: number, total: number, discount: number, tax: number, measure?: unknown }} line
 * @param {boolean} taxIncluded the order's `totals.taxIncluded`
 */
export const placedGross = (line, taxIncluded) =>
	line.measure ? line.total + line.discount - (taxIncluded ? 0 : line.tax) : line.unitPrice * line.quantity;

/**
 * A quantity as documents print it: pieces, or the measured quantity and its unit symbol (`2.5 m`).
 * @param {number} quantity @param {{ unit: string } | null | undefined} measure
 */
export const quantityLabel = (quantity, measure) =>
	measure ? `${quantityText(quantity, measure)} ${measure.unit}` : String(quantity);
