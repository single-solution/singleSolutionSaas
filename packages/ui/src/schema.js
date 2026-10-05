/**
 * Pure helpers behind {@link SchemaForm}: read a feature JSON Schema (the `@ss/contracts` subset — object root, one
 * `type` per node, no `$ref`/combinators) with its `x-*` keywords and turn it into ordered, grouped field
 * descriptors with plan bounds, then validate values client-side the way the Portal will (absolute bounds and plan
 * maxima). The Portal remains the authority: server field errors are shown on top of these.
 *
 * `x-ui`: `widget` (switch|checkbox|number|text|textarea|select|radio|checkboxes|tags|color|url|email|json),
 * `group`, `order`, `help`, `placeholder`, `hidden`, `advanced`. `x-plan[plan]`: `{ default?, max? }` where max means
 * value (numbers), item count (arrays), length (strings) or allowed (`false` = flag cannot be enabled).
 *
 * `placement` features (`x-kind: 'placement'`, F.18) hold a placement v1 object and render with the `placement`
 * widget; `x-placement.members` and `x-plan[plan].members` limit the members shown and allowed.
 * @module
 */

/** Members of a placement v1 object, in form order. */
export const PLACEMENT_MEMBERS = Object.freeze([
	'paths',
	'selectors',
	'pageTypes',
	'devices',
	'referrers',
	'schedule',
	'consent',
	'triggers',
	'frequency',
	'audience',
]);

/**
 * @typedef {object} FeatureNode
 * @property {'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object'} [type]
 * @property {string} [title]
 * @property {string} [description]
 * @property {unknown} [default]
 * @property {unknown[]} [enum]
 * @property {unknown} [const]
 * @property {boolean} [readOnly]
 * @property {number} [minimum]
 * @property {number} [maximum]
 * @property {number} [exclusiveMinimum]
 * @property {number} [exclusiveMaximum]
 * @property {number} [multipleOf]
 * @property {number} [minLength]
 * @property {number} [maxLength]
 * @property {string} [pattern]
 * @property {string} [format]
 * @property {FeatureNode} [items]
 * @property {number} [minItems]
 * @property {number} [maxItems]
 * @property {boolean} [uniqueItems]
 * @property {Record<string, FeatureNode>} [properties]
 * @property {string[]} [required]
 * @property {'flag' | 'quota' | 'limit' | 'rate' | 'config' | 'placement'} [x-kind]
 * @property {Record<string, { default?: unknown, max?: number | boolean, members?: string[] }>} [x-plan]
 * @property {{ members?: string[] }} [x-placement]
 * @property {boolean} [x-lock]
 * @property {boolean} [x-experiment]
 * @property {string} [x-period]
 * @property {string} [x-per]
 * @property {string} [x-unit]
 * @property {boolean} [x-hardStop]
 * @property {{ widget?: string, group?: string, order?: number, help?: string, placeholder?: string, hidden?: boolean, advanced?: boolean }} [x-ui]
 */

/**
 * @typedef {{ type?: 'object', properties: Record<string, FeatureNode>, required?: string[] }} FeatureSchema
 */

/**
 * @typedef {object} Bounds
 * @property {number | undefined} min inclusive
 * @property {number | undefined} max inclusive (absolute maximum and plan max combined)
 * @property {number | undefined} absoluteMax schema maximum
 * @property {number | boolean | undefined} planMax plan maximum (`x-plan[plan].max`)
 * @property {number | undefined} maxLength
 * @property {number | undefined} maxItems
 * @property {boolean} flagAllowed false when the plan forbids enabling a flag
 */

/**
 * @typedef {object} FieldDescriptor
 * @property {string} name
 * @property {FeatureNode} node
 * @property {string} title
 * @property {string} kind
 * @property {string} widget
 * @property {string} group
 * @property {number} order
 * @property {string | null} help
 * @property {string | null} placeholder
 * @property {boolean} advanced
 * @property {boolean} lockable
 * @property {boolean} unlimitedAllowed null (unlimited) is a valid value
 * @property {unknown} defaultValue product default overlaid by the plan default
 * @property {Bounds} bounds
 * @property {string | null} unitLabel `per month · redemptions`
 */

const UNLIMITED_KINDS = new Set(['quota', 'limit', 'rate']);
export const DEFAULT_GROUP = 'General';

/**
 * Kind of a feature (`x-kind`, inferred as flag for booleans and config otherwise).
 * @param {FeatureNode} node
 */
export const kindOf = (node) => node['x-kind'] ?? (node.type === 'boolean' ? 'flag' : 'config');

/**
 * Widget for a node: `x-ui.widget` when it fits the type, else a sensible default.
 * @param {FeatureNode} node
 * @returns {string}
 */
export const widgetOf = (node) => {
	if (node['x-kind'] === 'placement') return 'placement';
	const asked = node['x-ui']?.widget;
	const fits = {
		boolean: ['switch', 'checkbox'],
		integer: ['number', 'slider'],
		number: ['number', 'slider'],
		string: ['text', 'textarea', 'select', 'radio', 'color', 'url', 'email', 'password'],
		array: ['checkboxes', 'tags'],
		object: ['fieldset', 'json'],
	};
	const type = node.type ?? 'string';
	if (asked && /** @type {Record<string, string[]>} */ (fits)[type]?.includes(asked))
		return asked === 'slider' ? 'number' : asked;
	if (type === 'boolean') return 'switch';
	if (type === 'integer' || type === 'number') return 'number';
	if (type === 'array') return node.items?.enum ? 'checkboxes' : 'tags';
	if (type === 'object') return 'fieldset';
	if (node.enum) return node.enum.length <= 4 ? 'radio' : 'select';
	if (node.format === 'email') return 'email';
	if (node.format === 'uri') return 'url';
	return 'text';
};

/**
 * Plan entry of a node.
 * @param {FeatureNode} node
 * @param {string | null | undefined} plan
 */
const planEntry = (node, plan) => (plan ? node['x-plan']?.[plan] : undefined);

/**
 * Bounds of a node under a plan.
 * @param {FeatureNode} node
 * @param {string | null | undefined} [plan]
 * @returns {Bounds}
 */
export const boundsOf = (node, plan) => {
	const planMax = planEntry(node, plan)?.max;
	const numericPlanMax = typeof planMax === 'number' ? planMax : undefined;
	const min =
		node.minimum ??
		(node.exclusiveMinimum === undefined ? undefined : node.exclusiveMinimum + (node.type === 'integer' ? 1 : Number.EPSILON));
	const absoluteMax =
		node.maximum ??
		(node.exclusiveMaximum === undefined ? undefined : node.exclusiveMaximum - (node.type === 'integer' ? 1 : Number.EPSILON));
	const numeric = node.type === 'integer' || node.type === 'number';
	/** @param {number | undefined} a @param {number | undefined} b */
	const lower = (a, b) => (a === undefined ? b : b === undefined ? a : Math.min(a, b));
	return {
		min,
		max: numeric ? lower(absoluteMax, numericPlanMax) : absoluteMax,
		absoluteMax,
		planMax,
		maxLength: node.type === 'string' ? lower(node.maxLength, numericPlanMax) : node.maxLength,
		maxItems: node.type === 'array' ? lower(node.maxItems, numericPlanMax) : node.maxItems,
		flagAllowed: !(node.type === 'boolean' && planMax === false),
	};
};

/**
 * Default value of a node under a plan (`x-plan[plan].default` › `default`).
 * @param {FeatureNode} node
 * @param {string | null | undefined} [plan]
 */
export const defaultOf = (node, plan) => {
	const entry = planEntry(node, plan);
	return entry && Object.hasOwn(entry, 'default') ? entry.default : node.default;
};

/**
 * `per month · redemption` style hint for quotas, rates and unit-bearing limits.
 * @param {FeatureNode} node
 */
const unitLabelOf = (node) => {
	const parts = [];
	if (node['x-period']) parts.push(`per ${node['x-period']}`);
	if (node['x-per']) parts.push(`per ${node['x-per']}`);
	if (node['x-unit']) parts.push(String(node['x-unit']).replace(/_/g, ' '));
	return parts.length > 0 ? parts.join(' · ') : null;
};

/**
 * Ordered field descriptors of a schema's top-level properties (hidden ones dropped).
 * @param {FeatureSchema | null | undefined} schema
 * @param {{ plan?: string | null }} [options]
 * @returns {FieldDescriptor[]}
 */
export const fieldsOf = (schema, { plan = null } = {}) => {
	const properties = schema?.properties ?? {};
	return Object.entries(properties)
		.filter(([, node]) => node && node['x-ui']?.hidden !== true)
		.map(([name, node], index) => ({
			name,
			node,
			title: node.title ?? humanName(name),
			kind: kindOf(node),
			widget: widgetOf(node),
			group: node['x-ui']?.group ?? DEFAULT_GROUP,
			order: node['x-ui']?.order ?? 1000 + index,
			help: node['x-ui']?.help ?? node.description ?? null,
			placeholder: node['x-ui']?.placeholder ?? null,
			advanced: node['x-ui']?.advanced === true,
			lockable: node['x-lock'] !== false,
			unlimitedAllowed: UNLIMITED_KINDS.has(kindOf(node)) && boundsOf(node, plan).planMax === undefined,
			defaultValue: defaultOf(node, plan),
			bounds: boundsOf(node, plan),
			unitLabel: unitLabelOf(node),
		}))
		.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
};

/**
 * Fields grouped by `x-ui.group` (first appearance order), with `advanced` fields in their own list.
 * @param {FieldDescriptor[]} fields
 * @returns {{ groups: Array<{ name: string, fields: FieldDescriptor[] }>, advanced: FieldDescriptor[] }}
 */
export const groupFields = (fields) => {
	/** @type {Map<string, FieldDescriptor[]>} */
	const groups = new Map();
	/** @type {FieldDescriptor[]} */
	const advanced = [];
	for (const field of fields) {
		if (field.advanced) {
			advanced.push(field);
			continue;
		}
		const list = groups.get(field.group) ?? [];
		list.push(field);
		groups.set(field.group, list);
	}
	return { groups: [...groups].map(([name, list]) => ({ name, fields: list })), advanced };
};

/** @param {string} name */
const humanName = (name) => {
	const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
	return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
};

/** @param {number} n */
const fmt = (n) => new Intl.NumberFormat('en-US').format(n);

/**
 * Placement members a feature may set under a plan: `x-placement.members` (default all) narrowed by
 * `x-plan[plan].members`.
 * @param {FeatureNode} node
 * @param {string | null | undefined} [plan]
 * @returns {string[]}
 */
export const placementMembersOf = (node, plan) => {
	const own = node['x-placement']?.members ?? [...PLACEMENT_MEMBERS];
	const planned = planEntry(node, plan)?.members;
	return own.filter((name) => !planned || planned.includes(name));
};

const DURATION = /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/;
const TRIGGER_TYPES = ['load', 'idle', 'scroll', 'exit', 'selector-click', 'event'];

/**
 * Client-side checks of a placement value (the Portal validates it fully against the placement v1 schema).
 * @param {FeatureNode} node
 * @param {Record<string, unknown>} value
 * @param {string | null} plan
 * @returns {string | null}
 */
const placementProblem = (node, value, plan) => {
	const allowed = placementMembersOf(node, plan);
	for (const name of Object.keys(value)) {
		if (!PLACEMENT_MEMBERS.includes(name)) return `Unknown placement setting ${name}.`;
		if (!allowed.includes(name))
			return (node['x-placement']?.members ?? PLACEMENT_MEMBERS).includes(name)
				? `Your plan does not include ${humanName(name).toLowerCase()} targeting.`
				: `This element has no ${humanName(name).toLowerCase()} setting.`;
	}
	const frequency = /** @type {Record<string, unknown> | undefined} */ (value.frequency);
	if (frequency !== undefined) {
		if (typeof frequency !== 'object' || frequency === null) return 'Frequency is invalid.';
		for (const key of ['maxPerSession', 'maxPerDay', 'maxPerVisitor'])
			if (frequency[key] !== undefined && (!Number.isInteger(frequency[key]) || /** @type {number} */ (frequency[key]) < 1))
				return `${humanName(key)}: enter a whole number of at least 1.`;
		for (const key of ['cooldown', 'dismissMemory'])
			if (frequency[key] !== undefined && !(typeof frequency[key] === 'string' && DURATION.test(frequency[key])))
				return `${humanName(key)}: enter an ISO-8601 duration such as P1D or PT30M.`;
	}
	const triggers = value.triggers;
	if (triggers !== undefined) {
		if (!Array.isArray(triggers)) return 'Triggers are invalid.';
		for (const trigger of triggers) {
			const type = /** @type {Record<string, unknown>} */ (trigger)?.type;
			if (!TRIGGER_TYPES.includes(String(type))) return 'A trigger has an unknown type.';
		}
	}
	const schedule = /** @type {Record<string, unknown> | undefined} */ (value.schedule);
	if (
		schedule !== undefined &&
		(typeof schedule !== 'object' || schedule === null || typeof schedule.timezone !== 'string' || schedule.timezone === '')
	)
		return 'A schedule needs a time zone.';
	if (value.audience !== undefined && (typeof value.audience !== 'string' || value.audience.trim() === ''))
		return 'Enter an audience rule or remove it.';
	return null;
};

/**
 * Validate one value against a node (absolute bounds + plan bounds). `null` passes for unlimited kinds without a
 * plan max. Returns a message or null.
 * @param {FeatureNode} node
 * @param {unknown} value
 * @param {{ plan?: string | null, required?: boolean }} [options]
 * @returns {string | null}
 */
export const validateValue = (node, value, { plan = null, required = true } = {}) => {
	const bounds = boundsOf(node, plan);
	if (value === undefined || value === '') return required && node.type !== 'boolean' ? 'This field is required.' : null;
	if (value === null) return UNLIMITED_KINDS.has(kindOf(node)) && bounds.planMax === undefined ? null : 'A value is required.';
	if (node['x-kind'] === 'placement')
		return typeof value === 'object' && !Array.isArray(value)
			? placementProblem(node, /** @type {Record<string, unknown>} */ (value), plan)
			: 'Invalid placement.';
	switch (node.type) {
		case 'boolean':
			if (typeof value !== 'boolean') return 'Choose on or off.';
			if (value === true && !bounds.flagAllowed) return 'Your plan does not include this option.';
			return null;
		case 'integer':
		case 'number': {
			if (typeof value !== 'number' || !Number.isFinite(value)) return 'Enter a number.';
			if (node.type === 'integer' && !Number.isInteger(value)) return 'Enter a whole number.';
			if (bounds.min !== undefined && value < bounds.min) return `Must be at least ${fmt(bounds.min)}.`;
			if (bounds.absoluteMax !== undefined && value > bounds.absoluteMax) return `Must be at most ${fmt(bounds.absoluteMax)}.`;
			if (typeof bounds.planMax === 'number' && value > bounds.planMax)
				return `Your plan allows at most ${fmt(bounds.planMax)}.`;
			if (node.multipleOf && Math.abs(value / node.multipleOf - Math.round(value / node.multipleOf)) > 1e-9)
				return `Must be a multiple of ${fmt(node.multipleOf)}.`;
			return null;
		}
		case 'string': {
			if (typeof value !== 'string') return 'Enter text.';
			if (node.enum && !node.enum.includes(value)) return 'Choose one of the options.';
			if (node.minLength !== undefined && value.length < node.minLength)
				return `Must be at least ${fmt(node.minLength)} characters.`;
			if (bounds.maxLength !== undefined && value.length > bounds.maxLength)
				return `Must be at most ${fmt(bounds.maxLength)} characters.`;
			if (node.pattern && !safeTest(node.pattern, value)) return 'Has an invalid format.';
			if (node.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'Enter an e-mail address.';
			if (node.format === 'uri' && !/^https?:\/\/[^\s]+$/.test(value)) return 'Enter a URL starting with https://.';
			return null;
		}
		case 'array': {
			if (!Array.isArray(value)) return 'Invalid list.';
			if (node.minItems !== undefined && value.length < node.minItems) return `Choose at least ${fmt(node.minItems)}.`;
			if (bounds.maxItems !== undefined && value.length > bounds.maxItems)
				return typeof bounds.planMax === 'number' && bounds.maxItems === bounds.planMax
					? `Your plan allows at most ${fmt(bounds.maxItems)} items.`
					: `At most ${fmt(bounds.maxItems)} items.`;
			if (node.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length)
				return 'Items must not repeat.';
			const item = node.items;
			if (item) {
				for (const entry of value) {
					const problem = validateValue(item, entry, { required: true });
					if (problem) return `An item is invalid: ${problem.charAt(0).toLowerCase()}${problem.slice(1)}`;
				}
			}
			return null;
		}
		case 'object': {
			if (typeof value !== 'object' || Array.isArray(value)) return 'Invalid value.';
			const record = /** @type {Record<string, unknown>} */ (value);
			for (const key of node.required ?? []) if (record[key] === undefined) return `${humanName(key)} is required.`;
			for (const [key, child] of Object.entries(node.properties ?? {})) {
				if (record[key] === undefined) continue;
				const problem = validateValue(child, record[key], { required: false });
				if (problem) return `${child.title ?? humanName(key)}: ${problem}`;
			}
			return null;
		}
		default:
			return null;
	}
};

/**
 * @param {string} pattern
 * @param {string} value
 */
const safeTest = (pattern, value) => {
	try {
		return new RegExp(pattern, 'u').test(value);
	} catch {
		return true; // an unparseable pattern is the server's to judge
	}
};

/**
 * Errors of every visible field, keyed by name.
 * @param {FeatureSchema | null | undefined} schema
 * @param {Record<string, unknown>} values
 * @param {{ plan?: string | null, skip?: ReadonlySet<string> | string[] }} [options] `skip` = locked fields
 * @returns {Record<string, string>}
 */
export const validateValues = (schema, values, { plan = null, skip = [] } = {}) => {
	const skipped = new Set(skip);
	/** @type {Record<string, string>} */
	const errors = {};
	for (const field of fieldsOf(schema, { plan })) {
		if (skipped.has(field.name)) continue;
		const problem = validateValue(field.node, values[field.name], { plan });
		if (problem) errors[field.name] = problem;
	}
	return errors;
};

/**
 * Structural equality for JSON values.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export const sameValue = (a, b) => {
	if (a === b) return true;
	if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (Array.isArray(a)) {
		const other = /** @type {unknown[]} */ (b);
		return a.length === other.length && a.every((v, i) => sameValue(v, other[i]));
	}
	const ra = /** @type {Record<string, unknown>} */ (a);
	const rb = /** @type {Record<string, unknown>} */ (b);
	const keys = Object.keys(ra);
	return keys.length === Object.keys(rb).length && keys.every((k) => Object.hasOwn(rb, k) && sameValue(ra[k], rb[k]));
};

/**
 * Names whose value differs between two value maps.
 * @param {Record<string, unknown>} before
 * @param {Record<string, unknown>} after
 * @returns {string[]}
 */
export const changedNames = (before, after) =>
	[...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !sameValue(before[k], after[k])).sort();

/** Who set a locked value, from an entitlement-document feature `source`. */
const LOCK_LABELS = Object.freeze({
	admin_override: 'Set by admin',
	platform_policy: 'Set by platform',
	merchant_default: 'Set by your organisation',
	plan_default: 'Set by your plan',
	product_default: 'Set by the product',
});

/**
 * @param {string | null | undefined} source
 * @returns {string}
 */
export const lockLabel = (source) =>
	(source && /** @type {Record<string, string>} */ (LOCK_LABELS)[source]) || 'Set by platform/admin';
