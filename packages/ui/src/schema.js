/**
 * Pure helpers behind {@link SchemaForm}: read a feature's settings schema (the `@ss/contracts` settings subset: an object
 * schema whose top-level properties are the settings, each a string, integer, number, boolean or list) with its `x-ui`
 * hints, and turn it into grouped field descriptors in the schema's order. The product checks every value when it is
 * saved; its field errors are passed to the form.
 *
 * `x-ui`: `widget` (switch|number|text|textarea|select|radio|url|email|checkboxes|tags; one that does not fit the type
 * is ignored), `group`, `placeholder`, `labels` (`country`, or each choice's own words: labels are data, fixed-choices
 * audit K3), `suggestions` (values a text or a list of texts offers while the merchant may type their own), `wide`
 * (span the whole row of the field grid; a `textarea` widget and lists are wide anyway). A setting's `description` is
 * its help text.
 * @module
 */
import { humanize } from './format.js';

/**
 * One item of a list setting.
 * @typedef {object} SettingItem
 * @property {'string' | 'integer' | 'number' | 'boolean'} type
 * @property {number} [minimum]
 * @property {number} [maximum]
 * @property {number} [maxLength]
 * @property {unknown[]} [enum]
 * @property {string} [format]
 */

/**
 * One setting.
 * @typedef {object} SettingNode
 * @property {'string' | 'integer' | 'number' | 'boolean' | 'array'} type
 * @property {string} title
 * @property {unknown} default
 * @property {string} [description]
 * @property {number} [minimum]
 * @property {number} [maximum]
 * @property {number} [maxLength]
 * @property {unknown[]} [enum]
 * @property {string} [format]
 * @property {SettingItem} [items] every list setting has them
 * @property {{ widget?: string, group?: string, placeholder?: string, wide?: boolean,
 *   labels?: 'country' | Record<string, string>, suggestions?: string[] }} [x-ui]
 */

/**
 * @typedef {{ type: 'object', properties: Record<string, SettingNode>, additionalProperties?: false }} SettingsSchema
 */

/**
 * @typedef {object} FieldDescriptor
 * @property {string} name
 * @property {SettingNode} node
 * @property {string} title
 * @property {string} widget
 * @property {string} group
 * @property {string | null} help the setting's description
 * @property {string | null} placeholder
 * @property {boolean} wide spans the whole row of the field grid
 */

const DEFAULT_GROUP = 'General';

/** English country names from the runtime's own data (no list to keep up to date). */
const REGION_NAMES = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(['en'], { type: 'region' }) : null;

/**
 * The English name of an ISO 3166-1 alpha-2 country code (`GB` → "United Kingdom"); the code itself when unknown.
 * @param {string} code
 * @returns {string}
 */
export const countryName = (code) => {
	try {
		const name = REGION_NAMES?.of(code);
		return name && name !== code ? name : code;
	} catch {
		return code;
	}
};

/**
 * The readable label of a choice, by the field's `x-ui.labels` hint: `country` names ISO country codes, a map gives
 * each choice its own words (labels are data); a choice it does not name goes through {@link humanize}.
 * @param {unknown} value
 * @param {'country' | Record<string, string> | undefined} labels
 * @returns {string}
 */
export const optionLabel = (value, labels) => {
	if (labels === 'country') return countryName(String(value));
	if (labels && typeof labels === 'object' && Object.hasOwn(labels, String(value))) return labels[String(value)] ?? '';
	return humanize(value);
};

/** A list of choices longer than this is a searchable picker, not a group of checkboxes. */
const PICKER_FROM = 12;

/** Widgets that take the whole row of the field grid. */
const WIDE_WIDGETS = Object.freeze(['textarea', 'tags', 'checkboxes']);

/**
 * Widget for a node: `x-ui.widget` when it fits the type, else a sensible default.
 * @param {SettingNode} node
 * @returns {string}
 */
export const widgetOf = (node) => {
	const asked = node['x-ui']?.widget;
	const fits = {
		boolean: ['switch'],
		integer: ['number'],
		number: ['number'],
		string: ['text', 'textarea', 'select', 'radio', 'url', 'email'],
		array: ['checkboxes', 'tags'],
	};
	const type = node.type;
	if (asked && fits[type].includes(asked)) return asked;
	if (type === 'boolean') return 'switch';
	if (type === 'integer' || type === 'number') return 'number';
	if (type === 'array') {
		if (!node.items?.enum && node['x-ui']?.suggestions) return 'tags';
		return node.items?.enum && node.items.enum.length <= PICKER_FROM ? 'checkboxes' : 'tags';
	}
	if (node.enum) return node.enum.length <= 4 ? 'radio' : 'select';
	if (node['x-ui']?.suggestions) return 'suggest';
	if (node.format === 'email') return 'email';
	if (node.format === 'uri') return 'url';
	return 'text';
};

/**
 * Whether a field spans the whole row of the field grid: `x-ui.wide` when given, else long text and lists.
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
 * Field descriptors of a schema's top-level properties, in the schema's order.
 * @param {SettingsSchema | null | undefined} schema
 * @returns {FieldDescriptor[]}
 */
export const fieldsOf = (schema) =>
	Object.entries(schema?.properties ?? {}).map(([name, node]) => {
		const widget = widgetOf(node);
		return {
			name,
			node,
			title: node.title,
			widget,
			wide: isWide(node, widget),
			group: node['x-ui']?.group ?? DEFAULT_GROUP,
			help: node.description ?? null,
			placeholder: node['x-ui']?.placeholder ?? null,
		};
	});

/**
 * Fields grouped by `x-ui.group`, the groups in the order they first appear.
 * @param {FieldDescriptor[]} fields
 * @returns {Array<{ name: string, fields: FieldDescriptor[] }>}
 */
export const groupFields = (fields) => {
	/** @type {Map<string, FieldDescriptor[]>} */
	const groups = new Map();
	for (const field of fields) {
		const list = groups.get(field.group) ?? [];
		list.push(field);
		groups.set(field.group, list);
	}
	return [...groups].map(([name, list]) => ({ name, fields: list }));
};
