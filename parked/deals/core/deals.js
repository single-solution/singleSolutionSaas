/**
 * Deals (pure): kinds, input validation, normalisation and merge-patch. A deal is merchant data stored in the
 * merchant's own database (`ss_deals_deals`), created through `POST /v1/deals` or the dashboard; every bound it is
 * checked against comes from the element feature schemas (the website's signed configuration).
 *
 * Kinds and the element that switches them:
 *
 * | kind     | element       | what                                                                 |
 * | -------- | ------------- | -------------------------------------------------------------------- |
 * | `item`   | `item_deals`  | automatic discount on matching lines (percent, amount off, price, BXGY) |
 * | `cart`   | `cart_deals`  | thresholds, payment/delivery conditions, free shipping, tiers          |
 * | `flash`  | `flash_sales` | item deal with an end (countdown) and an optional unit stock           |
 * | `bundle` | `bundles`     | buy-together components or mix-and-match "any N for …"                |
 * @module
 */
import { compileCondition } from './rules.js';
import { isAmount } from './money.js';
import { validateSchedule } from './schedule.js';
import { ATTRIBUTE_PATTERN, checkFields, idCheck, intCheck, isObject, keyCheck, listCheck, push, textCheck } from './validate.js';

/** @typedef {import('./validate.js').FieldProblem} FieldProblem */

/** Deal kinds and the element that switches each. */
export const KIND_ELEMENT = Object.freeze({ item: 'item_deals', cart: 'cart_deals', flash: 'flash_sales', bundle: 'bundles' });
/** @typedef {keyof typeof KIND_ELEMENT} Kind */
export const KINDS = /** @type {Kind[]} */ (Object.keys(KIND_ELEMENT));
/** Lifecycle: `archived` is the soft delete (`DELETE /v1/deals/{id}`). */
export const STATUSES = Object.freeze(/** @type {const} */ (['active', 'paused', 'archived']));
/** Badge tones the renderers map to design tokens. */
export const TONES = Object.freeze(/** @type {const} */ (['accent', 'urgent', 'neutral', 'success']));

/** Actions allowed per kind. */
export const ACTIONS = Object.freeze({
	item: ['percent', 'amount_off', 'fixed_price', 'buy_x_get_y'],
	flash: ['percent', 'amount_off', 'fixed_price', 'buy_x_get_y'],
	cart: ['percent', 'amount_off', 'free_shipping', 'tiered'],
	bundle: ['percent', 'amount_off', 'fixed_price'],
});

/**
 * @typedef {object} KindRules per-kind bounds from the website's configuration
 * @property {boolean} enabled
 * @property {number} maxPercent
 * @property {boolean} allowStorewide
 * @property {number} maxWindows
 * @property {string} defaultClass
 * @property {number} defaultPriority
 * @property {boolean} [requireEnd] flash: an end instant is required
 * @property {number} [maxDurationHours] flash: maximum start→end duration (0 = none)
 * @property {number} [maxComponents] bundle: maximum buy-together components
 * @property {number} [maxTiers] cart: maximum tiers
 */
/** @typedef {{ kinds: Record<Kind, KindRules>, classes: string[], maxConditionLength: number }} DealRules */

/**
 * @typedef {object} Deal stored / evaluated deal
 * @property {string} id
 * @property {Kind} kind
 * @property {string} name
 * @property {string | null} description
 * @property {'active' | 'paused' | 'archived'} status
 * @property {number} priority higher first
 * @property {string} class stacking class
 * @property {{ label: string | null, tone: string }} badge
 * @property {import('./schedule.js').Schedule} schedule
 * @property {import('./scope.js').Scope | null} scope
 * @property {Record<string, any>} conditions
 * @property {Record<string, any>} action
 * @property {Record<string, any> | null} bundle
 * @property {{ perCustomer: number | null, totalUses: number | null, stockUnits: number | null, maxUnitsPerOrder: number | null }} limits
 * @property {boolean} combinesWithCoupons
 * @property {boolean} combinesWithLoyalty
 * @property {Record<string, unknown>} custom
 * @property {number} version optimistic concurrency
 * @property {string} [createdAt]
 * @property {string} [updatedAt]
 */

const DEAL_FIELDS = {
	kind: 1,
	name: 1,
	description: 1,
	status: 1,
	priority: 1,
	class: 1,
	badge: 1,
	schedule: 1,
	scope: 1,
	conditions: 1,
	action: 1,
	bundle: 1,
	limits: 1,
	combinesWithCoupons: 1,
	combinesWithLoyalty: 1,
	custom: 1,
};
const SCOPE_FIELDS = {
	items: 1,
	variants: 1,
	collections: 1,
	brands: 1,
	attributes: 1,
	minUnitAmount: 1,
	maxUnitAmount: 1,
	exclude: 1,
	when: 1,
};
const CONDITION_FIELDS = {
	minSubtotal: 1,
	minQuantity: 1,
	paymentMethods: 1,
	deliveryMethods: 1,
	customerSegments: 1,
	newCustomersOnly: 1,
	when: 1,
};
const LIMIT_FIELDS = { perCustomer: 1, totalUses: 1, stockUnits: 1, maxUnitsPerOrder: 1 };
const MAX_LIST = 1000;
const MAX_UNITS = 1_000_000_000;

/**
 * @param {unknown} source
 * @param {string} path
 * @param {number} maxLength
 * @param {FieldProblem[]} problems
 */
const checkWhen = (source, path, maxLength, problems) => {
	if (source === undefined || source === null || source === '') return;
	if (typeof source !== 'string' || source.length > maxLength) {
		problems.push({ path, code: 'condition_invalid' });
		return;
	}
	if (!compileCondition(source).ok) problems.push({ path, code: 'condition_invalid' });
};

/**
 * @param {unknown} scope
 * @param {string} at
 * @param {DealRules} rules
 * @returns {FieldProblem[]}
 */
export const validateScope = (scope, at, rules) => {
	const problems = checkFields(scope, SCOPE_FIELDS, [], at);
	if (!isObject(scope)) return problems;
	for (const key of ['items', 'variants', 'collections', 'brands'])
		if (scope[key] !== undefined) push(problems, `${at}/${key}`, listCheck(scope[key], MAX_LIST, idCheck));
	if (scope.attributes !== undefined) {
		if (!Array.isArray(scope.attributes) || scope.attributes.length > 20)
			problems.push({ path: `${at}/attributes`, code: 'list_invalid' });
		else
			scope.attributes.forEach((filter, index) => {
				const a = `${at}/attributes/${index}`;
				problems.push(...checkFields(filter, { name: 1, values: 1 }, ['name', 'values'], a));
				if (!isObject(filter)) return;
				if (filter.name !== undefined && !(typeof filter.name === 'string' && ATTRIBUTE_PATTERN.test(filter.name)))
					problems.push({ path: `${a}/name`, code: 'attribute_invalid' });
				if (filter.values !== undefined)
					push(
						problems,
						`${a}/values`,
						listCheck(filter.values, 100, (v) => textCheck(v, 200)) ?? (filter.values.length === 0 ? 'list_invalid' : null),
					);
			});
	}
	for (const key of ['minUnitAmount', 'maxUnitAmount'])
		if (scope[key] !== undefined && !isAmount(scope[key])) problems.push({ path: `${at}/${key}`, code: 'amount_invalid' });
	if (scope.exclude !== undefined) {
		problems.push(...checkFields(scope.exclude, { items: 1, variants: 1, collections: 1, brands: 1 }, [], `${at}/exclude`));
		if (isObject(scope.exclude))
			for (const key of ['items', 'variants', 'collections', 'brands'])
				if (scope.exclude[key] !== undefined)
					push(problems, `${at}/exclude/${key}`, listCheck(scope.exclude[key], MAX_LIST, idCheck));
	}
	checkWhen(scope.when, `${at}/when`, rules.maxConditionLength, problems);
	return problems;
};

/**
 * @param {unknown} action
 * @param {Kind} kind
 * @param {KindRules} bounds
 * @returns {FieldProblem[]}
 */
const validateAction = (action, kind, bounds) => {
	if (!isObject(action)) return [{ path: '/action', code: 'object_invalid' }];
	/** @type {FieldProblem[]} */
	const problems = [];
	if (!ACTIONS[kind].includes(action.type)) return [{ path: '/action/type', code: 'action_invalid' }];
	const percent = (/** @type {unknown} */ value, /** @type {string} */ path) => {
		if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > Math.min(100, bounds.maxPercent))
			problems.push({ path, code: 'percent_invalid' });
		else if (Math.round(value * 100) !== value * 100) problems.push({ path, code: 'percent_precision' });
	};
	const amount = (/** @type {unknown} */ value, /** @type {string} */ path) => {
		if (!isAmount(value) || value === 0) problems.push({ path, code: 'amount_invalid' });
	};
	switch (action.type) {
		case 'percent':
			problems.push(...checkFields(action, { type: 1, percent: 1, maxDiscount: 1 }, ['percent'], '/action'));
			percent(action.percent, '/action/percent');
			if (action.maxDiscount !== undefined) amount(action.maxDiscount, '/action/maxDiscount');
			break;
		case 'amount_off':
			problems.push(...checkFields(action, { type: 1, amount: 1 }, ['amount'], '/action'));
			amount(action.amount, '/action/amount');
			break;
		case 'fixed_price':
			problems.push(...checkFields(action, { type: 1, amount: 1 }, ['amount'], '/action'));
			if (!isAmount(action.amount)) problems.push({ path: '/action/amount', code: 'amount_invalid' });
			break;
		case 'buy_x_get_y':
			problems.push(...checkFields(action, { type: 1, buy: 1, get: 1, percent: 1 }, ['buy', 'get'], '/action'));
			push(problems, '/action/buy', intCheck(action.buy, 1, 1000));
			push(problems, '/action/get', intCheck(action.get, 1, 1000));
			if (action.percent !== undefined) percent(action.percent, '/action/percent');
			break;
		case 'free_shipping':
			problems.push(...checkFields(action, { type: 1 }, [], '/action'));
			break;
		default: {
			// tiered
			problems.push(...checkFields(action, { type: 1, basis: 1, tiers: 1 }, ['basis', 'tiers'], '/action'));
			if (action.basis !== undefined && !['subtotal', 'quantity'].includes(action.basis))
				problems.push({ path: '/action/basis', code: 'basis_invalid' });
			if (!Array.isArray(action.tiers) || action.tiers.length === 0 || action.tiers.length > (bounds.maxTiers ?? 10))
				problems.push({ path: '/action/tiers', code: 'tiers_invalid' });
			else {
				action.tiers.forEach((tier, index) => {
					const t = `/action/tiers/${index}`;
					problems.push(...checkFields(tier, { min: 1, percent: 1, amount: 1, freeShipping: 1 }, ['min'], t));
					if (!isObject(tier)) return;
					if (!isAmount(tier.min) || tier.min === 0) problems.push({ path: `${t}/min`, code: 'amount_invalid' });
					const rewards = ['percent', 'amount'].filter((key) => tier[key] !== undefined);
					if (rewards.length > 1) problems.push({ path: t, code: 'tier_reward_invalid' });
					if (rewards.length === 0 && tier.freeShipping !== true) problems.push({ path: t, code: 'tier_reward_required' });
					if (tier.percent !== undefined) percent(tier.percent, `${t}/percent`);
					if (tier.amount !== undefined) amount(tier.amount, `${t}/amount`);
					if (tier.freeShipping !== undefined && typeof tier.freeShipping !== 'boolean')
						problems.push({ path: `${t}/freeShipping`, code: 'boolean_invalid' });
				});
				const mins = action.tiers.map((tier) => (isObject(tier) ? tier.min : 0));
				if (mins.some((m, i) => i > 0 && !(m > mins[i - 1])))
					problems.push({ path: '/action/tiers', code: 'tiers_not_ascending' });
			}
		}
	}
	return problems;
};

/**
 * @param {unknown} bundle
 * @param {KindRules} bounds
 * @param {DealRules} rules
 * @returns {FieldProblem[]}
 */
const validateBundle = (bundle, bounds, rules) => {
	if (!isObject(bundle)) return [{ path: '/bundle', code: 'object_invalid' }];
	if (bundle.type === 'buy_together') {
		const problems = checkFields(bundle, { type: 1, components: 1, maxPerOrder: 1 }, ['components'], '/bundle');
		if (
			!Array.isArray(bundle.components) ||
			bundle.components.length < 2 ||
			bundle.components.length > (bounds.maxComponents ?? 5)
		)
			problems.push({ path: '/bundle/components', code: 'components_invalid' });
		else
			bundle.components.forEach((component, index) => {
				const c = `/bundle/components/${index}`;
				problems.push(...checkFields(component, { scope: 1, quantity: 1 }, ['scope', 'quantity'], c));
				if (!isObject(component)) return;
				if (component.scope !== undefined) problems.push(...validateScope(component.scope, `${c}/scope`, rules));
				if (component.quantity !== undefined) push(problems, `${c}/quantity`, intCheck(component.quantity, 1, 100));
			});
		if (bundle.maxPerOrder !== undefined) push(problems, '/bundle/maxPerOrder', intCheck(bundle.maxPerOrder, 1, 1000));
		return problems;
	}
	if (bundle.type === 'mix_and_match') {
		const problems = checkFields(bundle, { type: 1, scope: 1, quantity: 1, maxPerOrder: 1 }, ['scope', 'quantity'], '/bundle');
		if (bundle.scope !== undefined) problems.push(...validateScope(bundle.scope, '/bundle/scope', rules));
		if (bundle.quantity !== undefined) push(problems, '/bundle/quantity', intCheck(bundle.quantity, 2, 100));
		if (bundle.maxPerOrder !== undefined) push(problems, '/bundle/maxPerOrder', intCheck(bundle.maxPerOrder, 1, 1000));
		return problems;
	}
	return [{ path: '/bundle/type', code: 'bundle_type_invalid' }];
};

/**
 * Validate a complete deal (create, or the result of a merge patch).
 * @param {unknown} input
 * @param {DealRules} rules
 * @returns {FieldProblem[]}
 */
export const validateDeal = (input, rules) => {
	const problems = checkFields(input, DEAL_FIELDS, ['kind', 'name', 'action']);
	if (!isObject(input)) return problems;
	const kind = /** @type {Kind} */ (input.kind);
	if (!KINDS.includes(kind)) {
		problems.push({ path: '/kind', code: 'kind_invalid' });
		return problems;
	}
	const bounds = rules.kinds[kind];
	if (input.name !== undefined) push(problems, '/name', textCheck(input.name, 120));
	if (input.description !== undefined && input.description !== null)
		push(problems, '/description', textCheck(input.description, 2000));
	if (input.status !== undefined && !STATUSES.includes(input.status)) problems.push({ path: '/status', code: 'status_invalid' });
	if (input.priority !== undefined) push(problems, '/priority', intCheck(input.priority, -1000, 1000));
	if (input.class !== undefined) {
		push(problems, '/class', keyCheck(input.class));
		if (!rules.classes.includes(input.class)) problems.push({ path: '/class', code: 'class_unknown' });
	}
	if (input.badge !== undefined && input.badge !== null) {
		problems.push(...checkFields(input.badge, { label: 1, tone: 1 }, [], '/badge'));
		if (isObject(input.badge)) {
			if (input.badge.label !== undefined && input.badge.label !== null)
				push(problems, '/badge/label', textCheck(input.badge.label, 40));
			if (input.badge.tone !== undefined && !TONES.includes(input.badge.tone))
				problems.push({ path: '/badge/tone', code: 'tone_invalid' });
		}
	}
	problems.push(
		...validateSchedule(input.schedule, {
			maxWindows: bounds.maxWindows,
			maxDurationDays: kind === 'flash' && bounds.maxDurationHours ? bounds.maxDurationHours / 24 : 0,
		}).map((p) => ({ ...p, path: `/schedule${p.path}` })),
	);
	if (kind === 'flash' && bounds.requireEnd && !(isObject(input.schedule) && typeof input.schedule.endsAt === 'string'))
		problems.push({ path: '/schedule/endsAt', code: 'required' });
	if (input.scope !== undefined && input.scope !== null) problems.push(...validateScope(input.scope, '/scope', rules));
	const needsScope = kind === 'item' || kind === 'flash';
	if (needsScope && !bounds.allowStorewide && isStorewideInput(input.scope))
		problems.push({ path: '/scope', code: 'storewide_not_allowed' });
	if (kind === 'bundle') {
		if (input.bundle === undefined) problems.push({ path: '/bundle', code: 'required' });
		else problems.push(...validateBundle(input.bundle, bounds, rules));
		if (input.scope !== undefined && input.scope !== null) problems.push({ path: '/scope', code: 'not_allowed' });
	} else if (input.bundle !== undefined && input.bundle !== null) problems.push({ path: '/bundle', code: 'not_allowed' });
	if (input.conditions !== undefined && input.conditions !== null) {
		const c = input.conditions;
		problems.push(...checkFields(c, CONDITION_FIELDS, [], '/conditions'));
		if (isObject(c)) {
			if (c.minSubtotal !== undefined && !isAmount(c.minSubtotal))
				problems.push({ path: '/conditions/minSubtotal', code: 'amount_invalid' });
			if (c.minQuantity !== undefined) push(problems, '/conditions/minQuantity', intCheck(c.minQuantity, 1, MAX_UNITS));
			for (const key of ['paymentMethods', 'deliveryMethods', 'customerSegments'])
				if (c[key] !== undefined) push(problems, `/conditions/${key}`, listCheck(c[key], 50, keyCheck));
			if (c.newCustomersOnly !== undefined && typeof c.newCustomersOnly !== 'boolean')
				problems.push({ path: '/conditions/newCustomersOnly', code: 'boolean_invalid' });
			checkWhen(c.when, '/conditions/when', rules.maxConditionLength, problems);
		}
	}
	if (input.action !== undefined) problems.push(...validateAction(input.action, kind, bounds));
	if (input.limits !== undefined && input.limits !== null) {
		problems.push(...checkFields(input.limits, LIMIT_FIELDS, [], '/limits'));
		if (isObject(input.limits))
			for (const key of Object.keys(LIMIT_FIELDS))
				if (input.limits[key] !== undefined && input.limits[key] !== null)
					push(problems, `/limits/${key}`, intCheck(input.limits[key], 1, MAX_UNITS));
	}
	for (const key of ['combinesWithCoupons', 'combinesWithLoyalty'])
		if (input[key] !== undefined && typeof input[key] !== 'boolean')
			problems.push({ path: `/${key}`, code: 'boolean_invalid' });
	if (input.custom !== undefined && !(isObject(input.custom) && JSON.stringify(input.custom).length <= 8192))
		problems.push({ path: '/custom', code: 'custom_invalid' });
	return problems;
};

/**
 * @param {unknown} scope
 * @returns {boolean}
 */
const isStorewideInput = (scope) => {
	if (!isObject(scope)) return true;
	const lists = ['items', 'variants', 'collections', 'brands', 'attributes'];
	return (
		lists.every((key) => !Array.isArray(scope[key]) || scope[key].length === 0) &&
		scope.minUnitAmount === undefined &&
		scope.maxUnitAmount === undefined &&
		!(typeof scope.when === 'string' && scope.when.trim())
	);
};

/**
 * A deal with every default filled in (from validated input or a stored document).
 * @param {Record<string, any>} input
 * @param {{ id: string, rules: DealRules, defaults: { combinesWithCoupons: boolean, combinesWithLoyalty: boolean }, version?: number }} options
 * @returns {Deal}
 */
export const normaliseDeal = (input, { id, rules, defaults, version = 1 }) => {
	const kind = /** @type {Kind} */ (input.kind);
	const bounds = rules.kinds[kind];
	const limits = isObject(input.limits) ? input.limits : {};
	const nullable = (/** @type {unknown} */ v) => (Number.isSafeInteger(v) ? /** @type {number} */ (v) : null);
	return {
		id,
		kind,
		name: String(input.name ?? '').trim(),
		description: typeof input.description === 'string' ? input.description : null,
		status: STATUSES.includes(input.status) ? input.status : 'active',
		priority: Number.isSafeInteger(input.priority) ? input.priority : (bounds?.defaultPriority ?? 0),
		class: typeof input.class === 'string' ? input.class : (bounds?.defaultClass ?? kind),
		badge: {
			label: isObject(input.badge) && typeof input.badge.label === 'string' ? input.badge.label : null,
			tone:
				isObject(input.badge) && TONES.includes(input.badge.tone) ? input.badge.tone : kind === 'flash' ? 'urgent' : 'accent',
		},
		schedule: isObject(input.schedule) ? input.schedule : {},
		scope: kind === 'bundle' ? null : isObject(input.scope) ? input.scope : {},
		conditions: isObject(input.conditions) ? input.conditions : {},
		action: isObject(input.action) ? input.action : { type: 'percent', percent: 0 },
		bundle: kind === 'bundle' && isObject(input.bundle) ? input.bundle : null,
		limits: {
			perCustomer: nullable(limits.perCustomer),
			totalUses: nullable(limits.totalUses),
			stockUnits: nullable(limits.stockUnits),
			maxUnitsPerOrder: nullable(limits.maxUnitsPerOrder),
		},
		combinesWithCoupons:
			typeof input.combinesWithCoupons === 'boolean' ? input.combinesWithCoupons : defaults.combinesWithCoupons,
		combinesWithLoyalty:
			typeof input.combinesWithLoyalty === 'boolean' ? input.combinesWithLoyalty : defaults.combinesWithLoyalty,
		custom: isObject(input.custom) ? input.custom : {},
		version,
		...(typeof input.createdAt === 'string' ? { createdAt: input.createdAt } : {}),
		...(typeof input.updatedAt === 'string' ? { updatedAt: input.updatedAt } : {}),
	};
};

/**
 * JSON Merge Patch (RFC 7386) of a deal's editable fields; `kind` cannot change.
 * @param {Record<string, any>} target
 * @param {unknown} patch
 * @returns {Record<string, any>}
 */
export const mergePatch = (target, patch) => {
	if (!isObject(patch)) return /** @type {any} */ (patch);
	/** @type {Record<string, any>} */
	const out = isObject(target) ? { ...target } : {};
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) delete out[key];
		else out[key] = isObject(value) ? mergePatch(out[key], value) : value;
	}
	return out;
};

/**
 * The editable input of a stored deal (what a merge patch applies to).
 * @param {Deal} deal
 */
export const dealInput = (deal) => {
	/** @type {Record<string, any>} */
	const out = {
		kind: deal.kind,
		name: deal.name,
		status: deal.status,
		priority: deal.priority,
		class: deal.class,
		schedule: deal.schedule,
		conditions: deal.conditions,
		action: deal.action,
		combinesWithCoupons: deal.combinesWithCoupons,
		combinesWithLoyalty: deal.combinesWithLoyalty,
	};
	if (deal.description !== null) out.description = deal.description;
	if (deal.badge.label !== null) out.badge = { label: deal.badge.label, tone: deal.badge.tone };
	else out.badge = { tone: deal.badge.tone };
	if (deal.scope) out.scope = deal.scope;
	if (deal.bundle) out.bundle = deal.bundle;
	const limits = Object.fromEntries(Object.entries(deal.limits).filter(([, v]) => v !== null));
	if (Object.keys(limits).length > 0) out.limits = limits;
	if (Object.keys(deal.custom).length > 0) out.custom = deal.custom;
	return out;
};
