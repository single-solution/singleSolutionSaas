/**
 * The resolver (pure, deterministic, bounded): a partial — possibly invalid — selection in, the closest valid
 * combination out, or a clear problem when none exists. Ported from the proven PDP variant selector (exact match wins;
 * the option the shopper just clicked is honoured first; then as many of their other picks as possible; then stock),
 * generalised to any option groups, rules@1 dependencies and exclusions, and optional combinations.
 *
 * Closeness is a cost compared lexicographically:
 *   1. the group just changed (`changed`) keeps its pick,
 *   2. the number of the other picks kept,
 *   3. in stock (only with `inStock: 'prefer'`; `require` never returns an out-of-stock result),
 *   4. the sum of each value's rank in its group's preference order (pick, default, then stock and the tie-break:
 *      schema order, price low / high or popularity).
 * The search is a depth-first branch and bound over the groups (the changed group first, then schema order); every
 * condition is checked as soon as the groups it reads are assigned, and combinations are narrowed per dimension. Ties
 * resolve to the first candidate in that fixed order, so the same input always gives the same output. A step budget
 * bounds the work: the best valid result found within it is returned (`optimal: false` when cut short).
 * @module
 */
import { LIMITS } from './limits.js';
import { holds } from './rules.js';

/** @typedef {import('./compile.js').Compiled} Compiled */
/** @typedef {import('./compile.js').CompiledGroup} CompiledGroup */
/** @typedef {import('./compile.js').CompiledCombination} CompiledCombination */
/** @typedef {string | string[] | number | null} Value internal value: single → key | null, multi → keys (schema order), range → number | null, text → string | null */

/**
 * @typedef {object} ResolveOptions
 * @property {'prefer' | 'require' | 'ignore'} [inStock]
 * @property {'schema' | 'price_low' | 'price_high' | 'popularity'} [tieBreak]
 * @property {'fill' | 'keep'} [partial]
 * @property {'closest' | 'defaults' | 'reject'} [fallback]
 * @property {number} [maxSteps]
 * @property {boolean} [states] include per-option states (default true)
 * @property {number} [now] epoch ms for conditions (default 0 — pass the clock for time-based rules)
 * @property {string} [timeZone]
 */
/**
 * @typedef {object} ResolveInput
 * @property {Record<string, unknown>} [selection] group key → option key | option keys | number | text (null = none)
 * @property {string | null} [changed] the group the shopper just changed (its pick wins)
 * @property {number} [quantity]
 */
/** @typedef {{ group: string, from: unknown, to: unknown, reason: string }} Adjustment */
/** @typedef {{ key: string, state: 'selected' | 'available' | 'out_of_stock' | 'conflict' }} OptionState */
/**
 * @typedef {object} Resolution
 * @property {true} ok
 * @property {Record<string, string | string[] | number>} selection non-empty values only
 * @property {boolean} exact the input was valid as given (nothing adjusted)
 * @property {boolean} complete every applicable required group has a value
 * @property {string[]} missing applicable required groups without a value
 * @property {Adjustment[]} adjusted picks that were changed, and why
 * @property {Array<{ group: string, value: unknown, source: 'default' | 'auto' }>} filled groups completed by the resolver
 * @property {string[]} ignored unknown group keys in the input
 * @property {string[]} applicable groups that apply to the result
 * @property {{ id: string, sku: string | null, inStock: boolean } | null} combination
 * @property {boolean} inStock
 * @property {number} quantity
 * @property {boolean} optimal false when the step budget cut the search short
 * @property {number} steps
 * @property {Array<{ key: string, applicable: boolean, options: OptionState[] }>} states
 */
/**
 * @typedef {{ ok: false, problem: { code: 'no_valid_combination' | 'selection_invalid', detail: string,
 *   exhaustive: boolean, suggestion?: Record<string, unknown>, adjusted?: Adjustment[] } }} ResolveFailure
 */

export const RESOLVER_DEFAULTS = Object.freeze({
	inStock: /** @type {const} */ ('prefer'),
	tieBreak: /** @type {const} */ ('schema'),
	partial: /** @type {const} */ ('fill'),
	fallback: /** @type {const} */ ('closest'),
	maxSteps: 20_000,
	states: true,
});

/** @param {Value} value */
const isEmpty = (value) => value === null || (Array.isArray(value) && value.length === 0);

/** @param {Value | undefined} a @param {Value | undefined} b */
export const sameValue = (a, b) => {
	if (Array.isArray(a) || Array.isArray(b)) {
		const x = Array.isArray(a) ? a : a === null || a === undefined ? [] : null;
		const y = Array.isArray(b) ? b : b === null || b === undefined ? [] : null;
		return x !== null && y !== null && x.length === y.length && x.every((v, i) => v === y[i]);
	}
	return a === b;
};

/** The empty value of a group type. @param {CompiledGroup} group @returns {Value} */
const emptyOf = (group) => (group.type === 'multi' ? [] : null);

/**
 * Snap a number to a range group's steps, inside its bounds.
 * @param {CompiledGroup} group
 * @param {number} value
 */
const snap = (group, value) => {
	const min = /** @type {number} */ (group.min);
	const max = /** @type {number} */ (group.max);
	const step = /** @type {number} */ (group.step);
	const clamped = Math.min(max, Math.max(min, value));
	const snapped = min + Math.round((clamped - min) / step) * step;
	return snapped > max ? snapped - step : snapped;
};

/** @param {unknown} value */
const preview = (value) =>
	typeof value === 'string' ? value.slice(0, 100) : Array.isArray(value) ? value.slice(0, 20) : (value ?? null);

/**
 * Sanitise the raw input against the schema.
 * @param {Compiled} compiled
 * @param {Record<string, unknown>} raw
 * @returns {{ picks: Array<Value | undefined>, notes: Adjustment[], ignored: string[] }}
 */
const sanitize = (compiled, raw) => {
	/** @type {Array<Value | undefined>} */
	const picks = compiled.groups.map(() => undefined);
	/** @type {Adjustment[]} */
	const notes = [];
	/** @type {string[]} */
	const ignored = [];
	const given = new Map(Object.entries(raw).slice(0, LIMITS.groups * 4));
	for (const key of [...given.keys()].sort())
		if (!compiled.groupIndex.has(key) && ignored.length < 20) ignored.push(key.slice(0, 64));
	// schema order, so the result never depends on the key order of the input
	for (const group of compiled.groups) {
		const { key, index } = group;
		const value = given.get(key);
		if (value === undefined) continue;
		if (value === null || value === '') {
			// clearing an optional group is a pick; a required group cannot be cleared
			if (!group.required) picks[index] = emptyOf(group);
			continue;
		}
		const offered = (/** @type {unknown} */ k) =>
			typeof k === 'string' && group.optionByKey.has(k) && !group.optionByKey.get(k)?.hidden;
		switch (group.type) {
			case 'single':
				if (offered(value)) picks[index] = /** @type {string} */ (value);
				else notes.push({ group: key, from: preview(value), to: null, reason: 'unknown_option' });
				break;
			case 'multi': {
				const list = Array.isArray(value) ? value : [value];
				const kept = [...new Set(list.filter(offered))].sort(
					(a, b) =>
						/** @type {number} */ (group.optionByKey.get(a)?.index) -
						/** @type {number} */ (group.optionByKey.get(b)?.index),
				);
				const capped = kept.slice(0, /** @type {number} */ (group.maxSelect));
				if (kept.length !== list.length)
					notes.push({ group: key, from: preview(list), to: capped, reason: 'unknown_option' });
				else if (capped.length !== kept.length)
					notes.push({ group: key, from: preview(list), to: capped, reason: 'too_many' });
				picks[index] = capped;
				break;
			}
			case 'range': {
				if (typeof value !== 'number' || !Number.isFinite(value)) {
					notes.push({ group: key, from: preview(value), to: null, reason: 'invalid_number' });
					break;
				}
				const snapped = snap(group, value);
				if (snapped !== value) notes.push({ group: key, from: value, to: snapped, reason: 'clamped' });
				picks[index] = snapped;
				break;
			}
			default: {
				if (typeof value !== 'string') {
					notes.push({ group: key, from: preview(value), to: null, reason: 'invalid_text' });
					break;
				}
				const clean = value
					// eslint-disable-next-line no-control-regex
					.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
					.slice(0, /** @type {number} */ (group.maxLength));
				if (clean !== value) notes.push({ group: key, from: preview(value), to: clean, reason: 'truncated' });
				picks[index] = clean === '' ? null : clean;
			}
		}
	}
	return { picks, notes, ignored };
};

/**
 * @param {import('./compile.js').CompiledOption} option
 * @param {Required<ResolveOptions>} options
 */
const optionInStock = (option, options) => options.inStock === 'ignore' || option.stock === null || option.stock > 0;

/**
 * Options of a group in preference order: in stock first (unless stock is ignored), then the tie-break, then schema order.
 * @param {CompiledGroup} group
 * @param {Required<ResolveOptions>} options
 */
const preferenceOrder = (group, options) => {
	const visible = group.options.filter(
		(option) => !option.hidden && (options.inStock !== 'require' || option.stock === null || option.stock > 0),
	);
	/** @param {import('./compile.js').CompiledOption} option */
	const score = (option) => {
		switch (options.tieBreak) {
			case 'price_low':
				return option.priceDelta;
			case 'price_high':
				return -option.priceDelta;
			case 'popularity':
				return -option.popularity;
			default:
				return 0;
		}
	};
	return [...visible].sort(
		(a, b) =>
			Number(!optionInStock(a, options)) - Number(!optionInStock(b, options)) || score(a) - score(b) || a.index - b.index,
	);
};

/**
 * Candidate subsets of a multi-choice group: every subset when small, else a few around the preferred one.
 * @param {CompiledGroup} group
 * @param {string[]} keys visible option keys in preference order
 * @param {string[]} preferred
 * @returns {{ values: string[][], complete: boolean }}
 */
const subsets = (group, keys, preferred) => {
	const indexOf = (/** @type {string} */ key) => /** @type {number} */ (group.optionByKey.get(key)?.index);
	const ordered = (/** @type {string[]} */ list) => [...list].sort((a, b) => indexOf(a) - indexOf(b));
	const minSelect = /** @type {number} */ (group.minSelect);
	const maxSelect = /** @type {number} */ (group.maxSelect);
	const fits = (/** @type {string[]} */ list) => list.length === 0 || (list.length >= minSelect && list.length <= maxSelect);
	if (keys.length <= LIMITS.multiEnumeration) {
		const want = new Set(preferred);
		/** @type {Array<{ value: string[], distance: number, rank: number, mask: number }>} */
		const all = [];
		for (let mask = 0; mask < 1 << keys.length; mask += 1) {
			const value = keys.filter((_, i) => (mask & (1 << i)) !== 0);
			if (!fits(value)) continue;
			const distance = value.filter((key) => !want.has(key)).length + preferred.filter((key) => !value.includes(key)).length;
			const rank = value.reduce((sum, key) => sum + keys.indexOf(key), 0);
			all.push({ value: ordered(value), distance, rank, mask });
		}
		all.sort((a, b) => a.distance - b.distance || a.rank - b.rank || a.mask - b.mask);
		return { values: all.map((entry) => entry.value), complete: true };
	}
	const base = ordered(preferred.filter((key) => keys.includes(key)));
	const candidates = [
		base,
		...base.map((key) => base.filter((other) => other !== key)),
		ordered(keys.slice(0, Math.max(1, minSelect))),
		...keys.slice(0, 20).map((key) => ordered([...new Set([...base, key])])),
		[],
	];
	return { values: candidates.filter(fits), complete: false };
};

/**
 * The ordered candidate values of a group with their cost contributions.
 * @param {CompiledGroup} group
 * @param {Value | undefined} pick
 * @param {Required<ResolveOptions>} options
 * @returns {{ entries: Array<{ value: Value, changed: number, rank: number }>, complete: boolean }}
 */
const domainOf = (group, pick, options) => {
	const hasPick = pick !== undefined;
	const empty = emptyOf(group);
	const def = /** @type {Value} */ (group.default);
	/** @type {Value[]} */
	let values = [];
	let complete = true;
	/** @type {Value[]} */
	const head = [];
	if (hasPick) head.push(pick);
	if (!hasPick && options.partial === 'keep') head.push(empty);
	switch (group.type) {
		case 'single': {
			const ordered = preferenceOrder(group, options).map((option) => option.key);
			if (def !== null && ordered.includes(/** @type {string} */ (def))) head.push(def);
			if (!group.required && !hasPick) head.push(empty);
			values = [...head, ...ordered, empty];
			break;
		}
		case 'multi': {
			const keys = preferenceOrder(group, options).map((option) => option.key);
			const preferred = /** @type {string[]} */ (hasPick ? pick : Array.isArray(def) ? def : []);
			const found = subsets(group, keys, preferred);
			complete = found.complete;
			// the subsets are ordered by distance from the pick (or the default), the empty set included
			values = [...head, ...found.values, empty];
			break;
		}
		case 'range': {
			const min = /** @type {number} */ (group.min);
			const max = /** @type {number} */ (group.max);
			const step = /** @type {number} */ (group.step);
			const preferred = typeof pick === 'number' ? pick : typeof def === 'number' ? def : min;
			const count = Math.floor((max - min) / step) + 1;
			/** @type {number[]} */
			let numbers;
			if (count <= LIMITS.rangeEnumeration) numbers = Array.from({ length: count }, (_, i) => min + i * step);
			else {
				complete = false;
				numbers = [
					preferred,
					min,
					max,
					...Array.from({ length: 9 }, (_, i) => snap(group, min + ((max - min) * (i + 1)) / 10)),
				];
			}
			numbers.sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred) || a - b);
			if (!hasPick && !group.required) head.push(typeof def === 'number' ? def : empty);
			values = [...head, ...numbers, empty];
			break;
		}
		default:
			complete = false;
			values = [...head, hasPick ? pick : def, empty];
	}
	/** @type {Array<{ value: Value, changed: number, rank: number }>} */
	const entries = [];
	for (const value of values) {
		if (value === undefined || entries.some((entry) => sameValue(entry.value, value))) continue;
		entries.push({ value, changed: hasPick && !sameValue(value, pick) ? 1 : 0, rank: entries.length });
	}
	return { entries, complete };
};

/**
 * @typedef {object} Checker evaluates the validity checks of a configurator for given values
 * @property {(group: CompiledGroup, values: Value[]) => boolean} applies
 * @property {(group: CompiledGroup, values: Value[]) => boolean} groupValid
 * @property {(rule: import('./compile.js').CompiledRule, values: Value[]) => boolean} ruleValid
 */

/**
 * @param {Compiled} compiled
 * @param {Required<ResolveOptions>} options
 * @param {number} quantity
 * @returns {Checker}
 */
const createChecker = (compiled, options, quantity) => {
	const evalOptions = { now: options.now, timeZone: options.timeZone };
	/** @param {Value[]} values */
	const context = (values) => {
		/** @type {Record<string, Value>} */
		const selection = {};
		for (const group of compiled.groups) {
			const value = values[group.index];
			if (value !== undefined) selection[group.key] = value;
		}
		return { selection, quantity };
	};
	/** @type {Checker['applies']} */
	const applies = (group, values) => group.when === null || holds(group.when, context(values), evalOptions);
	return {
		applies,
		groupValid: (group, values) => {
			const value = /** @type {Value} */ (values[group.index]);
			if (!applies(group, values)) return isEmpty(value);
			if (isEmpty(value)) return !(group.required && options.partial === 'fill' && group.type !== 'text');
			if (group.type === 'multi') {
				const count = /** @type {string[]} */ (value).length;
				if (count < /** @type {number} */ (group.minSelect) || count > /** @type {number} */ (group.maxSelect)) return false;
			}
			if (group.type === 'single' || group.type === 'multi') {
				const ctx = context(values);
				for (const key of Array.isArray(value) ? value : [value]) {
					const option = group.optionByKey.get(/** @type {string} */ (key));
					if (!option || option.hidden) return false;
					if (option.when && !holds(option.when, ctx, evalOptions)) return false;
				}
			}
			return true;
		},
		ruleValid: (rule, values) => !holds(rule.when, context(values), evalOptions),
	};
};

/**
 * Stock of an assignment: the matching combination (when every dimension has a value) and whether it is in stock.
 * @param {Compiled} compiled
 * @param {Value[]} values
 * @param {CompiledCombination[] | null} candidates combinations still matching (null = no variant matrix)
 * @returns {{ combination: CompiledCombination | null, outOfStock: boolean }}
 */
const stockOf = (compiled, values, candidates) => {
	const complete = compiled.dims.every((dim) => !isEmpty(/** @type {Value} */ (values[dim])));
	const combination =
		candidates && complete && candidates.length > 0
			? (candidates.find((candidate) => candidate.stock === null || candidate.stock > 0) ??
				/** @type {CompiledCombination} */ (candidates[0]))
			: null;
	let outOfStock = combination !== null && combination.stock !== null && combination.stock <= 0;
	for (const group of compiled.groups) {
		if (outOfStock) break;
		if (group.type !== 'single' && group.type !== 'multi') continue;
		const value = values[group.index];
		for (const key of Array.isArray(value) ? value : value === null || value === undefined ? [] : [value]) {
			const option = group.optionByKey.get(/** @type {string} */ (key));
			if (option && option.stock !== null && option.stock <= 0) outOfStock = true;
		}
	}
	return { combination, outOfStock };
};

/**
 * Combinations matching a value of a dimension.
 * @param {CompiledCombination[]} list
 * @param {number} dim
 * @param {Value} value
 */
const narrow = (list, dim, value) =>
	isEmpty(value) ? list : list.filter((combination) => combination.values[dim]?.has(/** @type {string} */ (value)) ?? true);

/**
 * Full validity check of complete values (no search): every group, rule and the combination.
 * @param {Compiled} compiled
 * @param {Value[]} values
 * @param {Checker} checker
 * @returns {{ valid: boolean, outOfStock: boolean, combination: CompiledCombination | null, violations: Array<{ group?: string, rule?: string, message?: string | null, reason: string }> }}
 */
const fullCheck = (compiled, values, checker) => {
	/** @type {Array<{ group?: string, rule?: string, message?: string | null, reason: string }>} */
	const violations = [];
	for (const group of compiled.groups)
		if (!checker.groupValid(group, values)) violations.push({ group: group.key, reason: 'group_invalid' });
	for (const rule of compiled.rules)
		if (!checker.ruleValid(rule, values)) violations.push({ rule: rule.id, message: rule.message, reason: 'excluded' });
	let candidates = compiled.combinations;
	if (candidates) for (const dim of compiled.dims) candidates = narrow(candidates, dim, /** @type {Value} */ (values[dim]));
	if (candidates && candidates.length === 0) violations.push({ reason: 'no_combination' });
	const { combination, outOfStock } = stockOf(compiled, values, candidates);
	return { valid: violations.length === 0, outOfStock, combination, violations };
};

/** @param {number[]} a @param {number[]} b */
const less = (a, b) => {
	for (let i = 0; i < a.length; i += 1) {
		const x = /** @type {number} */ (a[i]);
		const y = /** @type {number} */ (b[i]);
		if (x !== y) return x < y;
	}
	return false;
};

/**
 * Branch-and-bound search for the cheapest valid values.
 * @param {Compiled} compiled
 * @param {Array<Value | undefined>} picks
 * @param {number} pinned group index whose pick wins (-1 = none)
 * @param {Required<ResolveOptions>} options
 * @param {Checker} checker
 */
const search = (compiled, picks, pinned, options, checker) => {
	const n = compiled.groups.length;
	const order =
		pinned >= 0
			? [pinned, ...compiled.groups.map((g) => g.index).filter((i) => i !== pinned)]
			: compiled.groups.map((g) => g.index);
	/** @type {number[]} */
	const position = [];
	order.forEach((gi, p) => {
		position[gi] = p;
	});
	const depthOf = (/** @type {number[] | null} */ deps) =>
		deps === null ? n - 1 : deps.reduce((max, gi) => Math.max(max, /** @type {number} */ (position[gi])), 0);
	/** @type {Array<{ groups: CompiledGroup[], rules: import('./compile.js').CompiledRule[] }>} */
	const checksAt = order.map(() => ({ groups: [], rules: [] }));
	for (const group of compiled.groups) checksAt[depthOf(group.deps)]?.groups.push(group);
	for (const rule of compiled.rules) checksAt[depthOf(rule.deps)]?.rules.push(rule);
	const isDim = compiled.groups.map((group) => compiled.dims.includes(group.index));
	const domains = order.map((gi) => domainOf(/** @type {CompiledGroup} */ (compiled.groups[gi]), picks[gi], options));
	const exhaustiveDomains = order.every(
		(gi, p) => /** @type {{ complete: boolean }} */ (domains[p]).complete || !compiled.referenced.has(gi),
	);

	/** @type {Value[]} */
	const values = compiled.groups.map(() => /** @type {Value} */ (null));
	/** @typedef {{ values: Value[], cost: number[], combination: CompiledCombination | null, outOfStock: boolean }} Candidate */
	/** @type {{ best: Candidate | null }} the best candidate so far (a holder, so the type survives the closure) */
	const found = { best: null };
	let steps = 0;
	let aborted = false;
	/** Unassigned groups are absent from the rule context. */
	/** @type {Array<Value | undefined>} */
	const assigned = compiled.groups.map(() => undefined);

	/**
	 * @param {number} depth
	 * @param {number[]} cost [pinned changed, picks changed, 0, rank sum]
	 * @param {CompiledCombination[] | null} candidates
	 */
	const visit = (depth, cost, candidates) => {
		if (aborted) return;
		if (depth === n) {
			const stock = stockOf(compiled, values, candidates);
			if (stock.outOfStock && options.inStock === 'require') return;
			const total = [
				/** @type {number} */ (cost[0]),
				/** @type {number} */ (cost[1]),
				options.inStock === 'prefer' && stock.outOfStock ? 1 : 0,
				/** @type {number} */ (cost[3]),
			];
			if (found.best === null || less(total, found.best.cost)) found.best = { values: [...values], cost: total, ...stock };
			return;
		}
		const gi = /** @type {number} */ (order[depth]);
		const domain = /** @type {{ entries: Array<{ value: Value, changed: number, rank: number }> }} */ (domains[depth]);
		const checks = /** @type {{ groups: CompiledGroup[], rules: import('./compile.js').CompiledRule[] }} */ (checksAt[depth]);
		for (const entry of domain.entries) {
			steps += 1;
			if (steps > options.maxSteps) {
				aborted = true;
				return;
			}
			const next = [
				/** @type {number} */ (cost[0]) + (gi === pinned ? entry.changed : 0),
				/** @type {number} */ (cost[1]) + (gi === pinned ? 0 : entry.changed),
				0,
				/** @type {number} */ (cost[3]) + entry.rank,
			];
			// entries are ordered by (changed, rank), so every later entry costs at least as much: stop here
			if (found.best !== null && !less(next, found.best.cost)) break;
			values[gi] = entry.value;
			assigned[gi] = entry.value;
			const narrowed = candidates && isDim[gi] ? narrow(candidates, gi, entry.value) : candidates;
			if (narrowed && narrowed.length === 0 && !isEmpty(entry.value)) continue;
			const view = /** @type {Value[]} */ (assigned);
			if (
				checks.groups.every((group) => checker.groupValid(group, view)) &&
				checks.rules.every((rule) => checker.ruleValid(rule, view))
			)
				visit(depth + 1, next, narrowed);
			if (aborted) return;
		}
		values[gi] = null;
		assigned[gi] = undefined;
	};
	visit(0, [0, 0, 0, 0], compiled.combinations);
	return { best: found.best, steps, aborted, exhaustive: !aborted && exhaustiveDomains };
};

/** @param {Value | undefined} value @returns {unknown} */
const publicValue = (value) => (value === undefined ? null : Array.isArray(value) ? [...value] : value);

/**
 * Resolve a partial selection to a valid combination.
 * @param {Compiled} compiled
 * @param {ResolveInput} [input]
 * @param {ResolveOptions} [overrides]
 * @returns {Resolution | ResolveFailure}
 */
export const resolve = (compiled, input = {}, overrides = {}) => {
	/** @type {Required<ResolveOptions>} */
	const options = {
		...RESOLVER_DEFAULTS,
		now: 0,
		timeZone: 'UTC',
		...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)),
	};
	options.maxSteps = Number.isFinite(options.maxSteps)
		? Math.min(LIMITS.steps, Math.max(1, Math.floor(options.maxSteps)))
		: RESOLVER_DEFAULTS.maxSteps;
	const quantity = Number.isSafeInteger(input.quantity)
		? Math.min(LIMITS.quantity, Math.max(1, /** @type {number} */ (input.quantity)))
		: 1;
	const raw =
		input.selection !== null && typeof input.selection === 'object' && !Array.isArray(input.selection) ? input.selection : {};
	const { picks, notes, ignored } = sanitize(compiled, raw);
	const changedIndex = typeof input.changed === 'string' ? (compiled.groupIndex.get(input.changed) ?? -1) : -1;
	const pinned = changedIndex >= 0 && picks[changedIndex] !== undefined ? changedIndex : -1;
	const checker = createChecker(compiled, options, quantity);

	let found = search(compiled, picks, pinned, options, checker);
	let steps = found.steps;
	const kept = (/** @type {NonNullable<typeof found.best>} */ best) => best.cost[0] === 0 && best.cost[1] === 0;
	if (found.best && (!kept(found.best) || notes.length > 0) && options.fallback === 'reject') {
		const suggestion = found.best.values;
		return {
			ok: false,
			problem: {
				code: 'selection_invalid',
				detail: 'The selection is not a valid combination.',
				exhaustive: found.exhaustive,
				suggestion: Object.fromEntries(
					compiled.groups
						.filter((g) => !isEmpty(/** @type {Value} */ (suggestion[g.index])))
						.map((g) => [g.key, publicValue(suggestion[g.index])]),
				),
				adjusted: [...notes, ...changesOf(compiled, picks, suggestion, checker, options)],
			},
		};
	}
	if (found.best && !kept(found.best) && options.fallback === 'defaults') {
		const reset = picks.map((pick, gi) => (gi === pinned ? pick : undefined));
		const again = search(compiled, reset, pinned, options, checker);
		steps += again.steps;
		if (again.best) found = { ...again, steps };
	}
	const { best } = found;
	if (!best)
		return {
			ok: false,
			problem: {
				code: 'no_valid_combination',
				detail: found.exhaustive
					? 'No combination of the options satisfies the rules.'
					: 'No valid combination was found within the search budget.',
				exhaustive: found.exhaustive,
			},
		};

	const finalValues = best.values;
	const applicable = compiled.groups.filter((group) => checker.applies(group, finalValues));
	const applicableKeys = new Set(applicable.map((group) => group.key));
	/** @type {Resolution['filled']} */
	const filled = [];
	for (const group of compiled.groups) {
		const value = /** @type {Value} */ (finalValues[group.index]);
		if (picks[group.index] === undefined && !isEmpty(value))
			filled.push({
				group: group.key,
				value: publicValue(value),
				source: sameValue(value, /** @type {Value} */ (group.default)) ? 'default' : 'auto',
			});
	}
	const adjusted = [...notes, ...changesOf(compiled, picks, finalValues, checker, options)];
	return {
		ok: true,
		selection: /** @type {Record<string, string | string[] | number>} */ (
			Object.fromEntries(
				compiled.groups
					.filter((g) => !isEmpty(/** @type {Value} */ (finalValues[g.index])))
					.map((g) => [g.key, publicValue(finalValues[g.index])]),
			)
		),
		exact: adjusted.length === 0,
		complete: applicable.every((group) => !group.required || !isEmpty(/** @type {Value} */ (finalValues[group.index]))),
		missing: applicable
			.filter((group) => group.required && isEmpty(/** @type {Value} */ (finalValues[group.index])))
			.map((group) => group.key),
		adjusted,
		filled,
		ignored,
		applicable: [...applicableKeys],
		combination: best.combination ? { id: best.combination.id, sku: best.combination.sku, inStock: !best.outOfStock } : null,
		inStock: !best.outOfStock,
		quantity,
		optimal: !found.aborted,
		steps,
		states: options.states ? statesOf(compiled, finalValues, checker, applicableKeys) : [],
	};
};

/**
 * Picks the result changed, with the reason.
 * @param {Compiled} compiled
 * @param {Array<Value | undefined>} picks
 * @param {Value[]} values
 * @param {Checker} checker
 * @param {Required<ResolveOptions>} options
 * @returns {Adjustment[]}
 */
const changesOf = (compiled, picks, values, checker, options) =>
	compiled.groups.flatMap((group) => {
		const pick = picks[group.index];
		const value = /** @type {Value} */ (values[group.index]);
		if (pick === undefined || sameValue(pick, value)) return [];
		/** @type {string} */
		let reason = 'conflict';
		if (!checker.applies(group, values)) reason = 'not_applicable';
		else if (options.inStock === 'require') {
			const probe = [...values];
			probe[group.index] = pick;
			const check = fullCheck(compiled, probe, checker);
			if (check.valid && check.outOfStock) reason = 'out_of_stock';
		}
		return [{ group: group.key, from: publicValue(pick), to: isEmpty(value) ? null : publicValue(value), reason }];
	});

/**
 * State of every visible option for the resolved values: selected, available (picking it keeps a valid
 * combination), out_of_stock (valid but without stock) or conflict (picking it makes the resolver change other picks).
 * @param {Compiled} compiled
 * @param {Value[]} values
 * @param {Checker} checker
 * @param {Set<string>} applicable
 */
const statesOf = (compiled, values, checker, applicable) =>
	compiled.groups.map((group) => {
		if (group.type !== 'single' && group.type !== 'multi')
			return { key: group.key, applicable: applicable.has(group.key), options: [] };
		const current = /** @type {Value} */ (values[group.index]);
		/** @type {OptionState[]} */
		const options = group.options
			.filter((option) => !option.hidden)
			.map((option) => {
				const chosen = Array.isArray(current) ? current.includes(option.key) : current === option.key;
				if (chosen) return { key: option.key, state: /** @type {const} */ ('selected') };
				const probe = [...values];
				probe[group.index] =
					group.type === 'multi'
						? [.../** @type {string[]} */ (current), option.key].sort(
								(a, b) =>
									/** @type {number} */ (group.optionByKey.get(a)?.index) -
									/** @type {number} */ (group.optionByKey.get(b)?.index),
							)
						: option.key;
				const check = fullCheck(compiled, probe, checker);
				return {
					key: option.key,
					state: check.valid
						? check.outOfStock
							? /** @type {const} */ ('out_of_stock')
							: /** @type {const} */ ('available')
						: /** @type {const} */ ('conflict'),
				};
			});
		return { key: group.key, applicable: applicable.has(group.key), options };
	});

/**
 * Strict check of a selection as given (no resolution): what a quote or an order needs.
 * @param {Compiled} compiled
 * @param {{ selection?: Record<string, unknown>, quantity?: number }} input
 * @param {ResolveOptions} [overrides]
 * @returns {{ valid: boolean, complete: boolean, missing: string[], inStock: boolean, violations: Array<Record<string, unknown>>,
 *   combination: { id: string, sku: string | null, inStock: boolean } | null, selection: Record<string, unknown>, quantity: number }}
 */
export const checkSelection = (compiled, input, overrides = {}) => {
	/** @type {Required<ResolveOptions>} */
	const options = {
		...RESOLVER_DEFAULTS,
		now: 0,
		timeZone: 'UTC',
		...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)),
		partial: 'keep',
	};
	const quantity = Number.isSafeInteger(input.quantity)
		? Math.min(LIMITS.quantity, Math.max(1, /** @type {number} */ (input.quantity)))
		: 1;
	const raw =
		input.selection !== null && typeof input.selection === 'object' && !Array.isArray(input.selection) ? input.selection : {};
	const { picks, notes, ignored } = sanitize(compiled, raw);
	const values = compiled.groups.map((group, gi) => /** @type {Value} */ (picks[gi] === undefined ? emptyOf(group) : picks[gi]));
	const checker = createChecker(compiled, options, quantity);
	const check = fullCheck(compiled, values, checker);
	const missing = compiled.groups
		.filter((group) => group.required && checker.applies(group, values) && isEmpty(/** @type {Value} */ (values[group.index])))
		.map((group) => group.key);
	const violations = [
		...notes.map((note) => ({ group: note.group, reason: note.reason })),
		...ignored.map((key) => ({ group: key, reason: 'unknown_group' })),
		...check.violations,
	];
	return {
		valid: violations.length === 0 && (options.inStock !== 'require' || !check.outOfStock),
		complete: missing.length === 0,
		missing,
		inStock: !check.outOfStock,
		violations,
		combination: check.combination
			? { id: check.combination.id, sku: check.combination.sku, inStock: !check.outOfStock }
			: null,
		selection: Object.fromEntries(
			compiled.groups
				.filter((g) => !isEmpty(/** @type {Value} */ (values[g.index])))
				.map((g) => [g.key, publicValue(values[g.index])]),
		),
		quantity,
	};
};

/**
 * The combination record (with its price) of a resolution, for the pricer.
 * @param {Compiled} compiled
 * @param {{ id: string } | null} combination
 * @returns {CompiledCombination | null}
 */
export const combinationById = (compiled, combination) =>
	combination ? (compiled.combinations?.find((candidate) => candidate.id === combination.id) ?? null) : null;
