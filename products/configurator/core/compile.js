/**
 * Compile a normalised schema (core/schema.js) for the resolver and the pricer (pure): rules@1 programs, the groups
 * each check reads (so the search can prune as soon as they are assigned), option and combination indexes. A compiled
 * configurator is immutable and can be reused for any number of resolutions.
 * @module
 */
import { compileCondition } from './rules.js';

/** @typedef {import('./schema.js').Schema} Schema */
/** @typedef {import('./rules.js').Condition} Condition */

/**
 * @typedef {object} CompiledOption
 * @property {string} key
 * @property {number} index position in the group
 * @property {string} label
 * @property {boolean} hidden
 * @property {Condition | null} when
 * @property {number} priceDelta
 * @property {number | null} stock
 * @property {number} popularity
 */
/**
 * @typedef {object} CompiledGroup
 * @property {string} key
 * @property {number} index
 * @property {'single' | 'multi' | 'range' | 'text'} type
 * @property {string} label
 * @property {boolean} required
 * @property {import('./schema.js').Value | null} default
 * @property {Condition | null} when
 * @property {CompiledOption[]} options
 * @property {Map<string, CompiledOption>} optionByKey
 * @property {number[] | null} deps groups its validity check reads (itself included); null = every group
 * @property {number | null} min
 * @property {number | null} max
 * @property {number | null} step
 * @property {number | null} unitPrice
 * @property {number | null} minSelect
 * @property {number | null} maxSelect
 * @property {number | null} maxLength
 */
/** @typedef {{ id: string, when: Condition, deps: number[] | null, message: string | null }} CompiledRule */
/**
 * @typedef {object} CompiledCombination
 * @property {string} id
 * @property {string | null} sku
 * @property {Array<Set<string> | null>} values per group index: the option keys it matches (null = any / not a dimension)
 * @property {number | null} stock
 * @property {number | null} price
 */
/**
 * @typedef {object} CompiledPricing
 * @property {number | null} base
 * @property {string | null} currency
 * @property {Array<{ id: string, when: Condition | null, amount: number, percent: number }>} rules
 * @property {import('./schema.js').Rounding | null} rounding
 */
/**
 * @typedef {object} Compiled
 * @property {Schema} schema
 * @property {CompiledGroup[]} groups
 * @property {Map<string, number>} groupIndex
 * @property {CompiledRule[]} rules
 * @property {CompiledCombination[] | null} combinations available combinations (null = no variant matrix)
 * @property {number[]} dims group indexes the combinations constrain
 * @property {Set<number>} referenced groups some condition reads
 * @property {CompiledPricing | null} pricing
 */

/**
 * @param {Schema} schema a schema from `parseSchema` (or `linkSchema`)
 * @returns {{ ok: true, compiled: Compiled } | { ok: false, problems: Array<{ path: string, code: string, message?: string }> }}
 */
export const compileSchema = (schema) => {
	/** @type {Array<{ path: string, code: string, message?: string }>} */
	const problems = [];
	const groupIndex = new Map(schema.groups.map((group, index) => [group.key, index]));
	/** @type {Set<number>} */
	const referenced = new Set();
	let all = false;
	/**
	 * @param {string | null} source @param {string} path
	 * @returns {Condition | null}
	 */
	const condition = (source, path) => {
		const compiled = compileCondition(source);
		if (!compiled.ok) {
			problems.push({ path, code: 'rule_invalid', message: compiled.error.message });
			return null;
		}
		const { condition: result } = compiled;
		if (result === null) return null;
		if (result.groups === null) all = true;
		else
			for (const key of result.groups) {
				const index = groupIndex.get(key);
				if (index === undefined) problems.push({ path, code: 'unknown_group', message: key });
				else referenced.add(index);
			}
		return result;
	};
	/** @param {Array<Condition | null>} conditions @returns {number[] | null} */
	const depsOf = (conditions) => {
		/** @type {Set<number>} */
		const deps = new Set();
		for (const item of conditions) {
			if (item === null) continue;
			if (item.groups === null) return null;
			for (const key of item.groups) {
				const index = groupIndex.get(key);
				if (index !== undefined) deps.add(index);
			}
		}
		return [...deps].sort((a, b) => a - b);
	};

	const groups = schema.groups.map((group, gi) => {
		const when = condition(group.when, `/groups/${gi}/when`);
		const options = group.options.map((option, oi) => ({
			key: option.key,
			index: oi,
			label: option.label,
			hidden: option.hidden,
			when: condition(option.when, `/groups/${gi}/options/${oi}/when`),
			priceDelta: option.priceDelta,
			stock: option.stock,
			popularity: option.popularity,
		}));
		const read = depsOf([when, ...options.map((option) => option.when)]);
		return {
			key: group.key,
			index: gi,
			type: group.type,
			label: group.label,
			required: group.required,
			default: group.default,
			when,
			options,
			optionByKey: new Map(options.map((option) => [option.key, option])),
			deps: read === null ? null : [...new Set([...read, gi])].sort((a, b) => a - b),
			min: group.min,
			max: group.max,
			step: group.step,
			unitPrice: group.unitPrice,
			minSelect: group.minSelect,
			maxSelect: group.maxSelect,
			maxLength: group.maxLength,
		};
	});

	/** @type {CompiledRule[]} */
	const rules = [];
	for (const [ri, rule] of schema.rules.entries()) {
		const when = condition(rule.when, `/rules/${ri}/when`);
		if (when) rules.push({ id: rule.id, when, deps: depsOf([when]), message: rule.message });
	}

	/** @type {Set<number>} */
	const dimSet = new Set();
	for (const combination of schema.combinations)
		for (const key of Object.keys(combination.options)) {
			const index = groupIndex.get(key);
			if (index !== undefined) dimSet.add(index);
		}
	const dims = [...dimSet].sort((a, b) => a - b);
	const combinations =
		schema.combinations.length === 0
			? null
			: schema.combinations
					.filter((combination) => combination.available)
					.map((combination) => ({
						id: combination.id,
						sku: combination.sku,
						values: groups.map((group) => {
							const value = combination.options[group.key];
							if (value === undefined) return null;
							return new Set(Array.isArray(value) ? value : [value]);
						}),
						stock: combination.stock,
						price: combination.price,
					}));

	const pricing = schema.pricing
		? {
				base: schema.pricing.base,
				currency: schema.pricing.currency,
				rules: schema.pricing.rules.map((rule, pi) => ({
					id: rule.id,
					when: condition(rule.when, `/pricing/rules/${pi}/when`),
					amount: rule.amount,
					percent: rule.percent,
				})),
				rounding: schema.pricing.rounding,
			}
		: null;

	if (problems.length > 0) return { ok: false, problems };
	return {
		ok: true,
		compiled: {
			schema,
			groups,
			groupIndex,
			rules,
			combinations,
			dims,
			referenced: all ? new Set(groups.map((group) => group.index)) : referenced,
			pricing,
		},
	};
};
