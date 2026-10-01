/**
 * Configurator schemas (pure): validation and normalisation of what a merchant defines. A schema is generic — it fits
 * clothing (size × colour), phones (storage × colour), furniture (material, finish, add-ons), service packages or a
 * SaaS plan builder (plan, seats, add-ons) — and nothing in it is store-, country- or currency-specific.
 *
 * - `groups`: option groups in display order. `type` single (one option), multi (several), range (a number between
 *   `min` and `max` in `step`s) or text (free text). `required`, `default`, `display` (pills / dropdown / swatches),
 *   `when` (rules@1: the group applies only when true) and, for catalog-linked configurators, `attribute` (the variant
 *   attribute the group maps to). Options: `key`, `label`, `swatch` (colour), `image`, `hidden`, `when` (available
 *   only when true), `priceDelta`, `stock`, `popularity`.
 * - `rules`: exclusions — a combination is not allowed when a rule's `when` holds.
 * - `combinations`: optional variant matrix — when present, the single-choice groups it names must match one
 *   combination (with its `sku`, `stock`, absolute `price`, `available`).
 * - `pricing`: `base` price, `currency`, delta `rules` (amount or percent in basis points) and `rounding`.
 * - `source`: `{ type: 'standalone' }` or `{ type: 'catalog', itemId }` (options, combinations, prices and stock come
 *   from the catalog item's variants, fed by item.* / inventory.changed events).
 * @module
 */
import { LIMITS } from './limits.js';
import { compileCondition } from './rules.js';

export const GROUP_TYPES = Object.freeze(/** @type {const} */ (['single', 'multi', 'range', 'text']));
export const DISPLAYS = Object.freeze(/** @type {const} */ (['pills', 'dropdown', 'swatches']));
export const ROUNDING_MODES = Object.freeze(/** @type {const} */ (['none', 'nearest', 'up', 'down']));

const CONFIGURATOR_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const GROUP_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const RULE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const ATTRIBUTE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const CURRENCY = /^[A-Z]{3}$/;
const SWATCH = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** @typedef {{ path: string, code: string, message?: string }} FieldProblem */
/** @typedef {string | string[] | number} Value a group value: option key, option keys, number or text */

/**
 * @typedef {object} Option
 * @property {string} key
 * @property {string} label
 * @property {string | null} description
 * @property {string | null} swatch colour (`#rgb`, `#rrggbb`, with alpha)
 * @property {string | null} image https URL
 * @property {boolean} hidden never offered (kept for existing links and combinations)
 * @property {string | null} when rules@1: available only when true
 * @property {number} priceDelta integer minor units (may be negative)
 * @property {number | null} stock null = not tracked
 * @property {number} popularity
 */
/**
 * @typedef {object} Group
 * @property {string} key
 * @property {string} label
 * @property {string | null} description
 * @property {'single' | 'multi' | 'range' | 'text'} type
 * @property {'pills' | 'dropdown' | 'swatches' | null} display null = the widget's layout
 * @property {boolean} required
 * @property {Value | null} default
 * @property {string | null} when rules@1: the group applies only when true
 * @property {string | null} attribute catalog variant attribute (catalog-linked configurators)
 * @property {Option[]} options
 * @property {number | null} min range
 * @property {number | null} max range
 * @property {number | null} step range
 * @property {number | null} unitPrice range: price per unit (integer minor units)
 * @property {number | null} minSelect multi
 * @property {number | null} maxSelect multi
 * @property {number | null} maxLength text
 */
/** @typedef {{ id: string, when: string, message: string | null }} Rule */
/**
 * @typedef {object} Combination
 * @property {string} id
 * @property {string | null} sku
 * @property {Record<string, string | string[]>} options group key → option key (a list = any of them)
 * @property {number | null} stock
 * @property {number | null} price absolute unit price (integer minor units), replaces `pricing.base`
 * @property {boolean} available
 */
/** @typedef {{ id: string, when: string | null, amount: number, percent: number }} PriceRule percent in basis points */
/** @typedef {{ mode: 'none' | 'nearest' | 'up' | 'down', increment: number, ending: number }} Rounding */
/**
 * @typedef {object} Pricing
 * @property {number | null} base
 * @property {string | null} currency ISO 4217 (else the item's or the website's)
 * @property {PriceRule[]} rules
 * @property {Rounding | null} rounding null = the price_deltas element's default
 */
/**
 * @typedef {object} Schema
 * @property {string | null} key stable handle (unique per website)
 * @property {string} name
 * @property {string | null} description
 * @property {{ type: 'standalone' } | { type: 'catalog', itemId: string }} source
 * @property {Group[]} groups
 * @property {Rule[]} rules
 * @property {Combination[]} combinations
 * @property {Pricing | null} pricing
 */
/**
 * @typedef {object} SchemaLimits
 * @property {number} [groups]
 * @property {number} [options]
 * @property {number} [combinations]
 * @property {number} [rules]
 * @property {number} [priceRules]
 */

/** @param {unknown} value @returns {value is Record<string, any>} */
export const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** @param {unknown} value */
const isInt = (value) => Number.isSafeInteger(value);

/** A field is set (null counts as absent, so normalised schemas parse again). @param {unknown} value */
const given = (value) => value !== undefined && value !== null;

/**
 * Validate and normalise a configurator schema.
 * @param {unknown} input
 * @param {SchemaLimits} [limits] narrower bounds from the website's features
 * @returns {{ ok: true, schema: Schema } | { ok: false, problems: FieldProblem[] }}
 */
export const parseSchema = (input, limits = {}) => {
	/** @type {FieldProblem[]} */
	const problems = [];
	/** @param {string} path @param {string} code @param {string} [message] */
	const fail = (path, code, message) => {
		if (problems.length < 100) problems.push({ path, code, ...(message ? { message } : {}) });
	};
	const bound = (/** @type {keyof SchemaLimits} */ name, /** @type {number} */ absolute) => {
		const value = limits[name];
		return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? Math.min(value, absolute) : absolute;
	};
	const max = {
		groups: bound('groups', LIMITS.groups),
		options: bound('options', LIMITS.options),
		combinations: bound('combinations', LIMITS.combinations),
		rules: bound('rules', LIMITS.rules),
		priceRules: bound('priceRules', LIMITS.priceRules),
	};
	if (!isObject(input)) return { ok: false, problems: [{ path: '', code: 'type', message: 'must be an object' }] };

	/**
	 * Optional text field.
	 * @param {unknown} value @param {string} path @param {number} maxLength @param {{ required?: boolean }} [options]
	 * @returns {string | null}
	 */
	const text = (value, path, maxLength, { required = false } = {}) => {
		if (value === undefined || value === null || value === '') {
			if (required) fail(path, 'required');
			return null;
		}
		if (typeof value !== 'string') return (fail(path, 'type', 'must be a string'), null);
		if (value.length > maxLength) return (fail(path, 'too_long', `at most ${maxLength} characters`), null);
		if (CONTROL.test(value)) return (fail(path, 'invalid', 'control characters are not allowed'), null);
		return value;
	};
	/**
	 * Optional integer.
	 * @param {unknown} value @param {string} path @param {number} min @param {number} maxValue
	 * @returns {number | null}
	 */
	const integer = (value, path, min, maxValue) => {
		if (value === undefined || value === null) return null;
		if (!isInt(value)) return (fail(path, 'type', 'must be an integer'), null);
		const n = /** @type {number} */ (value);
		if (n < min || n > maxValue) return (fail(path, 'range', `must be between ${min} and ${maxValue}`), null);
		return n;
	};
	/** @param {unknown} value @param {string} path @returns {boolean | null} */
	const flag = (value, path) => {
		if (value === undefined || value === null) return null;
		if (typeof value !== 'boolean') return (fail(path, 'type', 'must be a boolean'), null);
		return value;
	};
	/** Conditions compiled here only to report errors; the compiler keeps the programs. */
	/** @type {Array<{ path: string, groups: string[] }>} */
	const conditions = [];
	/** @param {unknown} value @param {string} path @returns {string | null} */
	const condition = (value, path) => {
		const source = text(value, path, LIMITS.ruleSourceLength);
		if (source === null || source.trim() === '') return null;
		const compiled = compileCondition(source);
		if (!compiled.ok) {
			const { error } = compiled;
			fail(path, 'rule_invalid', `${error.message}${error.line ? ` (${error.line}:${error.column})` : ''}`);
			return null;
		}
		conditions.push({ path, groups: compiled.condition?.groups ?? [] });
		return source;
	};

	const key = text(input.key, '/key', LIMITS.keyLength);
	if (key !== null && !CONFIGURATOR_KEY.test(key)) fail('/key', 'pattern', 'lower-case letters, digits, - and _');
	const name = text(input.name, '/name', LIMITS.labelLength, { required: true }) ?? '';
	const description = text(input.description, '/description', LIMITS.descriptionLength);

	/** @type {Schema['source']} */
	let source = { type: 'standalone' };
	if (input.source !== undefined && input.source !== null) {
		if (!isObject(input.source)) fail('/source', 'type', 'must be an object');
		else if (input.source.type === 'catalog') {
			const itemId = text(input.source.itemId, '/source/itemId', 128, { required: true });
			if (itemId !== null && !OPAQUE_ID.test(itemId)) fail('/source/itemId', 'pattern');
			source = { type: 'catalog', itemId: itemId ?? '' };
		} else if (input.source.type !== 'standalone') fail('/source/type', 'enum', 'standalone or catalog');
	}
	const linked = source.type === 'catalog';

	// ── groups ────────────────────────────────────────────────────────────────────────────────────────
	/** @type {Group[]} */
	const groups = [];
	if (!Array.isArray(input.groups) || input.groups.length === 0) fail('/groups', 'required', 'at least one group');
	else if (input.groups.length > max.groups) fail('/groups', 'too_many', `at most ${max.groups} groups`);
	else {
		/** @type {Set<string>} */
		const seen = new Set();
		for (const [gi, raw] of input.groups.entries()) {
			const at = `/groups/${gi}`;
			if (!isObject(raw)) {
				fail(at, 'type', 'must be an object');
				continue;
			}
			const groupKey = text(raw.key, `${at}/key`, LIMITS.keyLength, { required: true }) ?? '';
			if (groupKey && !GROUP_KEY.test(groupKey)) fail(`${at}/key`, 'pattern', 'a letter, then letters, digits or _');
			else if (seen.has(groupKey)) fail(`${at}/key`, 'duplicate');
			seen.add(groupKey);
			const type = raw.type ?? 'single';
			if (!GROUP_TYPES.includes(type)) fail(`${at}/type`, 'enum', GROUP_TYPES.join(', '));
			const display = raw.display ?? null;
			if (display !== null && !DISPLAYS.includes(display)) fail(`${at}/display`, 'enum', DISPLAYS.join(', '));
			const attribute = text(raw.attribute, `${at}/attribute`, LIMITS.keyLength);
			if (attribute !== null && !ATTRIBUTE.test(attribute)) fail(`${at}/attribute`, 'pattern');
			const choice = type === 'single' || type === 'multi';
			/** @type {Option[]} */
			const options = [];
			if (choice) {
				const list = raw.options ?? [];
				if (!Array.isArray(list)) fail(`${at}/options`, 'type', 'must be an array');
				else if (list.length > max.options) fail(`${at}/options`, 'too_many', `at most ${max.options} options`);
				else if (list.length === 0 && !linked) fail(`${at}/options`, 'required', 'at least one option');
				else {
					/** @type {Set<string>} */
					const keys = new Set();
					for (const [oi, option] of list.entries()) {
						const ot = `${at}/options/${oi}`;
						if (!isObject(option)) {
							fail(ot, 'type', 'must be an object');
							continue;
						}
						const optionKey = text(option.key, `${ot}/key`, LIMITS.optionKeyLength, { required: true }) ?? '';
						if (optionKey !== optionKey.trim()) fail(`${ot}/key`, 'invalid', 'no leading or trailing spaces');
						else if (keys.has(optionKey)) fail(`${ot}/key`, 'duplicate');
						keys.add(optionKey);
						const swatch = text(option.swatch, `${ot}/swatch`, 9);
						if (swatch !== null && !SWATCH.test(swatch)) fail(`${ot}/swatch`, 'pattern', 'a #rgb or #rrggbb colour');
						const image = text(option.image, `${ot}/image`, LIMITS.urlLength);
						if (image !== null && !/^https:\/\/[^\s"'<>\\]+$/.test(image)) fail(`${ot}/image`, 'pattern', 'an https URL');
						options.push({
							key: optionKey,
							label: text(option.label, `${ot}/label`, LIMITS.labelLength) ?? optionKey,
							description: text(option.description, `${ot}/description`, LIMITS.descriptionLength),
							swatch,
							image,
							hidden: flag(option.hidden, `${ot}/hidden`) ?? false,
							when: condition(option.when, `${ot}/when`),
							priceDelta: integer(option.priceDelta, `${ot}/priceDelta`, -LIMITS.amount, LIMITS.amount) ?? 0,
							stock: integer(option.stock, `${ot}/stock`, -LIMITS.stock, LIMITS.stock),
							popularity: integer(option.popularity, `${ot}/popularity`, 0, LIMITS.popularity) ?? 0,
						});
					}
				}
			} else if (given(raw.options) && !(Array.isArray(raw.options) && raw.options.length === 0))
				fail(`${at}/options`, 'not_allowed', `${type} groups have no options`);
			/** @type {Group} */
			const group = {
				key: groupKey,
				label: text(raw.label, `${at}/label`, LIMITS.labelLength) ?? groupKey,
				description: text(raw.description, `${at}/description`, LIMITS.descriptionLength),
				type,
				display: choice ? display : null,
				required: flag(raw.required, `${at}/required`) ?? type === 'single',
				default: null,
				when: condition(raw.when, `${at}/when`),
				attribute: type === 'single' ? (attribute ?? (linked ? groupKey : null)) : null,
				options,
				min: null,
				max: null,
				step: null,
				unitPrice: null,
				minSelect: null,
				maxSelect: null,
				maxLength: null,
			};
			if (type === 'range') {
				const min = integer(raw.min, `${at}/min`, -LIMITS.rangeAbs, LIMITS.rangeAbs);
				const maxValue = integer(raw.max, `${at}/max`, -LIMITS.rangeAbs, LIMITS.rangeAbs);
				const step = integer(raw.step ?? 1, `${at}/step`, 1, LIMITS.rangeAbs);
				if (min === null) fail(`${at}/min`, 'required');
				if (maxValue === null) fail(`${at}/max`, 'required');
				if (min !== null && maxValue !== null && maxValue < min) fail(`${at}/max`, 'range', 'must be ≥ min');
				group.min = min;
				group.max = maxValue;
				group.step = step;
				group.unitPrice = integer(raw.unitPrice, `${at}/unitPrice`, -LIMITS.amount, LIMITS.amount);
			} else if (given(raw.min) || given(raw.max) || given(raw.step) || given(raw.unitPrice))
				fail(at, 'not_allowed', 'min, max, step and unitPrice are for range groups');
			if (type === 'multi') {
				const minSelect = integer(raw.minSelect ?? 0, `${at}/minSelect`, 0, LIMITS.options) ?? 0;
				const maxSelect = integer(raw.maxSelect ?? LIMITS.options, `${at}/maxSelect`, 1, LIMITS.options) ?? LIMITS.options;
				if (maxSelect < minSelect) fail(`${at}/maxSelect`, 'range', 'must be ≥ minSelect');
				group.minSelect = minSelect;
				group.maxSelect = maxSelect;
			} else if (given(raw.minSelect) || given(raw.maxSelect))
				fail(at, 'not_allowed', 'minSelect and maxSelect are for multi groups');
			if (type === 'text') group.maxLength = integer(raw.maxLength ?? 200, `${at}/maxLength`, 1, LIMITS.textLength) ?? 200;
			else if (given(raw.maxLength)) fail(at, 'not_allowed', 'maxLength is for text groups');
			if (raw.default !== undefined && raw.default !== null)
				group.default = defaultOf(group, raw.default, `${at}/default`, fail);
			groups.push(group);
		}
	}
	const groupKeys = new Set(groups.map((group) => group.key));

	// ── exclusion rules ───────────────────────────────────────────────────────────────────────────────
	/** @type {Rule[]} */
	const rules = [];
	const rawRules = input.rules ?? [];
	if (!Array.isArray(rawRules)) fail('/rules', 'type', 'must be an array');
	else if (rawRules.length > max.rules) fail('/rules', 'too_many', `at most ${max.rules} rules`);
	else {
		/** @type {Set<string>} */
		const ids = new Set();
		for (const [ri, raw] of rawRules.entries()) {
			const at = `/rules/${ri}`;
			if (!isObject(raw)) {
				fail(at, 'type', 'must be an object');
				continue;
			}
			const id = text(raw.id, `${at}/id`, LIMITS.keyLength, { required: true }) ?? '';
			if (id && !RULE_ID.test(id)) fail(`${at}/id`, 'pattern');
			else if (ids.has(id)) fail(`${at}/id`, 'duplicate');
			ids.add(id);
			const when = condition(raw.when, `${at}/when`);
			if (when === null && !problems.some((p) => p.path === `${at}/when`)) fail(`${at}/when`, 'required');
			rules.push({ id, when: when ?? '', message: text(raw.message, `${at}/message`, LIMITS.messageLength) });
		}
	}

	// ── combinations ──────────────────────────────────────────────────────────────────────────────────
	/** @type {Combination[]} */
	const combinations = [];
	const rawCombinations = input.combinations ?? [];
	if (!Array.isArray(rawCombinations)) fail('/combinations', 'type', 'must be an array');
	else if (linked && rawCombinations.length > 0)
		fail('/combinations', 'not_allowed', 'catalog-linked configurators take combinations from the item variants');
	else if (rawCombinations.length > max.combinations)
		fail('/combinations', 'too_many', `at most ${max.combinations} combinations`);
	else {
		/** @type {Set<string>} */
		const ids = new Set();
		for (const [ci, raw] of rawCombinations.entries()) {
			const at = `/combinations/${ci}`;
			if (!isObject(raw) || !isObject(raw.options)) {
				fail(at, 'type', 'must be an object with options');
				continue;
			}
			const id = text(raw.id, `${at}/id`, 128, { required: true }) ?? '';
			if (id && !OPAQUE_ID.test(id)) fail(`${at}/id`, 'pattern');
			else if (ids.has(id)) fail(`${at}/id`, 'duplicate');
			ids.add(id);
			/** @type {Record<string, string | string[]>} */
			const options = {};
			const entries = Object.entries(raw.options);
			if (entries.length === 0) fail(`${at}/options`, 'required');
			for (const [groupKey, value] of entries) {
				const group = groups.find((candidate) => candidate.key === groupKey);
				if (!group) fail(`${at}/options/${groupKey}`, 'unknown_group');
				else if (group.type !== 'single') fail(`${at}/options/${groupKey}`, 'not_allowed', 'only single-choice groups');
				else {
					const values = Array.isArray(value) ? value : [value];
					if (values.length === 0 || values.length > 20) fail(`${at}/options/${groupKey}`, 'invalid');
					else if (!values.every((v) => typeof v === 'string' && group.options.some((option) => option.key === v)))
						fail(`${at}/options/${groupKey}`, 'unknown_option');
					else options[groupKey] = Array.isArray(value) ? [...values] : /** @type {string} */ (value);
				}
			}
			combinations.push({
				id,
				sku: text(raw.sku, `${at}/sku`, 100),
				options,
				stock: integer(raw.stock, `${at}/stock`, -LIMITS.stock, LIMITS.stock),
				price: integer(raw.price, `${at}/price`, 0, LIMITS.amount),
				available: flag(raw.available, `${at}/available`) ?? true,
			});
		}
	}

	// ── pricing ───────────────────────────────────────────────────────────────────────────────────────
	/** @type {Pricing | null} */
	let pricing = null;
	if (input.pricing !== undefined && input.pricing !== null) {
		const raw = input.pricing;
		if (!isObject(raw)) fail('/pricing', 'type', 'must be an object');
		else {
			const currency = text(raw.currency, '/pricing/currency', 3);
			if (currency !== null && !CURRENCY.test(currency)) fail('/pricing/currency', 'pattern', 'an ISO 4217 code');
			/** @type {PriceRule[]} */
			const priceRules = [];
			const list = raw.rules ?? [];
			if (!Array.isArray(list)) fail('/pricing/rules', 'type', 'must be an array');
			else if (list.length > max.priceRules) fail('/pricing/rules', 'too_many', `at most ${max.priceRules} rules`);
			else {
				/** @type {Set<string>} */
				const ids = new Set();
				for (const [pi, rule] of list.entries()) {
					const at = `/pricing/rules/${pi}`;
					if (!isObject(rule)) {
						fail(at, 'type', 'must be an object');
						continue;
					}
					const id = text(rule.id, `${at}/id`, LIMITS.keyLength, { required: true }) ?? '';
					if (id && !RULE_ID.test(id)) fail(`${at}/id`, 'pattern');
					else if (ids.has(id)) fail(`${at}/id`, 'duplicate');
					ids.add(id);
					const amount = integer(rule.amount, `${at}/amount`, -LIMITS.amount, LIMITS.amount) ?? 0;
					const percent = integer(rule.percent, `${at}/percent`, LIMITS.basisPointsMin, LIMITS.basisPointsMax) ?? 0;
					if (rule.amount === undefined && rule.percent === undefined) fail(at, 'required', 'amount or percent');
					priceRules.push({ id, when: condition(rule.when, `${at}/when`), amount, percent });
				}
			}
			/** @type {Rounding | null} */
			let rounding = null;
			if (raw.rounding !== undefined && raw.rounding !== null) {
				if (!isObject(raw.rounding)) fail('/pricing/rounding', 'type', 'must be an object');
				else {
					const mode = raw.rounding.mode ?? 'nearest';
					if (!ROUNDING_MODES.includes(mode)) fail('/pricing/rounding/mode', 'enum', ROUNDING_MODES.join(', '));
					const increment =
						integer(raw.rounding.increment ?? 1, '/pricing/rounding/increment', 1, LIMITS.roundingIncrement) ?? 1;
					const ending = integer(raw.rounding.ending ?? 0, '/pricing/rounding/ending', 0, LIMITS.roundingIncrement) ?? 0;
					if (ending >= increment && ending !== 0) fail('/pricing/rounding/ending', 'range', 'must be below the increment');
					rounding = { mode, increment, ending };
				}
			}
			pricing = {
				base: integer(raw.base, '/pricing/base', 0, LIMITS.amount),
				currency,
				rules: priceRules,
				rounding,
			};
		}
	}

	// every condition reads known groups only
	for (const { path, groups: read } of conditions) {
		for (const groupKey of read)
			if (!groupKeys.has(groupKey)) fail(path, 'unknown_group', `'selection.${groupKey}' is not a group of this configurator`);
	}

	if (problems.length > 0) return { ok: false, problems };
	return {
		ok: true,
		schema: { key, name, description, source, groups, rules, combinations, pricing },
	};
};

/**
 * Validate a group default.
 * @param {Group} group
 * @param {unknown} value
 * @param {string} path
 * @param {(path: string, code: string, message?: string) => void} fail
 * @returns {Value | null}
 */
const defaultOf = (group, value, path, fail) => {
	const known = (/** @type {unknown} */ key) =>
		typeof key === 'string' &&
		(group.options.length === 0
			? key.length > 0 && key.length <= LIMITS.optionKeyLength
			: group.options.some((o) => o.key === key && !o.hidden));
	switch (group.type) {
		case 'single':
			if (!known(value)) return (fail(path, 'unknown_option'), null);
			return /** @type {string} */ (value);
		case 'multi': {
			if (!Array.isArray(value) || !value.every(known) || new Set(value).size !== value.length)
				return (fail(path, 'unknown_option', 'a list of distinct option keys'), null);
			if (value.length > /** @type {number} */ (group.maxSelect)) return (fail(path, 'too_many'), null);
			const position = (/** @type {string} */ key) => group.options.findIndex((option) => option.key === key);
			return [.../** @type {string[]} */ (value)].sort((a, b) => position(a) - position(b));
		}
		case 'range': {
			const { min, max, step } = group;
			if (!Number.isSafeInteger(value) || min === null || max === null || step === null) return (fail(path, 'type'), null);
			const n = /** @type {number} */ (value);
			if (n < min || n > max || (n - min) % step !== 0) return (fail(path, 'range', 'a step between min and max'), null);
			return n;
		}
		default:
			if (typeof value !== 'string' || value.length > /** @type {number} */ (group.maxLength) || CONTROL.test(value))
				return (fail(path, 'invalid'), null);
			return value;
	}
};
