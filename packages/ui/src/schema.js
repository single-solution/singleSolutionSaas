/**
 * Pure helpers behind {@link SchemaForm}: read a feature's settings schema (an object schema whose top-level
 * properties are the settings, one `type` per node, no `$ref`/combinators) with its `x-ui` hints, turn it into ordered,
 * grouped field descriptors, and validate values in the browser the way the product will (bounds such as the hard
 * maximums of limits, lengths, enums, formats). The product remains the authority: its field errors are shown on top.
 *
 * `x-ui`: `widget` (switch|checkbox|number|text|textarea|select|radio|checkboxes|tags|color|url|email|password|json),
 * `group`, `order`, `help`, `placeholder`, `hidden`, `advanced`, `wide` (span the whole row of the field grid; long
 * text — a `textarea` widget or a long-text `format` (textarea, multiline, markdown, html) —, JSON, lists and
 * fieldsets are wide anyway).
 * @module
 */

/**
 * @typedef {object} SettingNode
 * @property {'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object'} [type]
 * @property {string} [title]
 * @property {string} [description]
 * @property {unknown} [default]
 * @property {unknown[]} [enum]
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
 * @property {SettingNode} [items]
 * @property {number} [minItems]
 * @property {number} [maxItems]
 * @property {boolean} [uniqueItems]
 * @property {Record<string, SettingNode>} [properties]
 * @property {string[]} [required]
 * @property {{ widget?: string, group?: string, order?: number, help?: string, placeholder?: string, hidden?: boolean, advanced?: boolean, wide?: boolean }} [x-ui]
 */

/**
 * @typedef {{ type?: 'object', properties: Record<string, SettingNode>, required?: string[] }} SettingsSchema
 */

/**
 * @typedef {object} Bounds
 * @property {number | undefined} min inclusive
 * @property {number | undefined} max inclusive
 * @property {number | undefined} maxLength
 * @property {number | undefined} maxItems
 */

/**
 * @typedef {object} FieldDescriptor
 * @property {string} name
 * @property {SettingNode} node
 * @property {string} title
 * @property {string} widget
 * @property {string} group
 * @property {number} order
 * @property {string | null} help
 * @property {string | null} placeholder
 * @property {boolean} advanced
 * @property {boolean} wide spans the whole row of the field grid
 * @property {unknown} defaultValue
 * @property {Bounds} bounds
 */

const DEFAULT_GROUP = 'General';

/** String formats that hold long text (shown as a text area, full width). */
export const LONG_TEXT_FORMATS = Object.freeze(['textarea', 'multiline', 'markdown', 'html']);

/** Widgets that take the whole row of the field grid. */
const WIDE_WIDGETS = Object.freeze(['textarea', 'json', 'tags', 'checkboxes', 'fieldset']);

/**
 * Widget for a node: `x-ui.widget` when it fits the type, else a sensible default.
 * @param {SettingNode} node
 * @returns {string}
 */
export const widgetOf = (node) => {
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
	if (node.format && LONG_TEXT_FORMATS.includes(node.format)) return 'textarea';
	return 'text';
};

/**
 * Whether a field spans the whole row of the field grid: `x-ui.wide` when given, else long text, JSON, lists and
 * fieldsets.
 * @param {SettingNode} node
 * @param {string} widget
 * @returns {boolean}
 */
export const isWide = (node, widget) => {
	const asked = node['x-ui']?.wide;
	if (typeof asked === 'boolean') return asked;
	return WIDE_WIDGETS.includes(widget);
};

/**
 * Bounds of a node.
 * @param {SettingNode} node
 * @returns {Bounds}
 */
export const boundsOf = (node) => ({
	min:
		node.minimum ??
		(node.exclusiveMinimum === undefined ? undefined : node.exclusiveMinimum + (node.type === 'integer' ? 1 : Number.EPSILON)),
	max:
		node.maximum ??
		(node.exclusiveMaximum === undefined ? undefined : node.exclusiveMaximum - (node.type === 'integer' ? 1 : Number.EPSILON)),
	maxLength: node.maxLength,
	maxItems: node.maxItems,
});

/**
 * Ordered field descriptors of a schema's top-level properties (hidden ones dropped).
 * @param {SettingsSchema | null | undefined} schema
 * @returns {FieldDescriptor[]}
 */
export const fieldsOf = (schema) => {
	const properties = schema?.properties ?? {};
	return Object.entries(properties)
		.filter(([, node]) => node && node['x-ui']?.hidden !== true)
		.map(([name, node], index) => ({
			name,
			node,
			title: node.title ?? humanName(name),
			widget: widgetOf(node),
			wide: isWide(node, widgetOf(node)),
			group: node['x-ui']?.group ?? DEFAULT_GROUP,
			order: node['x-ui']?.order ?? 1000 + index,
			help: node['x-ui']?.help ?? node.description ?? null,
			placeholder: node['x-ui']?.placeholder ?? null,
			advanced: node['x-ui']?.advanced === true,
			defaultValue: node.default,
			bounds: boundsOf(node),
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
 * Validate one value against a node. Returns a message or null.
 * @param {SettingNode} node
 * @param {unknown} value
 * @param {{ required?: boolean }} [options]
 * @returns {string | null}
 */
export const validateValue = (node, value, { required = true } = {}) => {
	const bounds = boundsOf(node);
	if (value === undefined || value === '') return required && node.type !== 'boolean' ? 'This field is required.' : null;
	if (value === null) return 'A value is required.';
	switch (node.type) {
		case 'boolean':
			return typeof value === 'boolean' ? null : 'Choose on or off.';
		case 'integer':
		case 'number': {
			if (typeof value !== 'number' || !Number.isFinite(value)) return 'Enter a number.';
			if (node.type === 'integer' && !Number.isInteger(value)) return 'Enter a whole number.';
			if (bounds.min !== undefined && value < bounds.min) return `Must be at least ${fmt(bounds.min)}.`;
			if (bounds.max !== undefined && value > bounds.max) return `Must be at most ${fmt(bounds.max)}.`;
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
			if (bounds.maxItems !== undefined && value.length > bounds.maxItems) return `At most ${fmt(bounds.maxItems)} items.`;
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
 * @param {SettingsSchema | null | undefined} schema
 * @param {Record<string, unknown>} values
 * @returns {Record<string, string>}
 */
export const validateValues = (schema, values) => {
	/** @type {Record<string, string>} */
	const errors = {};
	for (const field of fieldsOf(schema)) {
		const problem = validateValue(field.node, values[field.name]);
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
