/**
 * Attribute definitions and values (pure), ported from the store's per-category attributes and made generic: any
 * website defines its own attributes (text, number, boolean, select, multi-select) with options and a unit, decides
 * which are filters and which are variant dimensions, where they show on cards, which collections they apply to, and
 * when they show (always, for some brands, or when another attribute has some values).
 *
 * Option values are compact slugs derived from the label and the unit ("256" + "gb" → "256gb") unless given.
 * @module
 */
import { cleanText, isId, isKey, isObject, issue, slugify } from './text.js';

export const ATTRIBUTE_TYPES = Object.freeze(/** @type {const} */ (['text', 'number', 'boolean', 'select', 'multi_select']));
export const VISIBILITY_TYPES = Object.freeze(/** @type {const} */ (['always', 'brand', 'attribute']));
/** Option value: lowercase letters of any script, digits, `_` and `-`. */
export const OPTION_VALUE = /^[\p{Ll}\p{Lo}\p{N}][\p{Ll}\p{Lo}\p{N}_-]{0,59}$/u;
const LIMITS = Object.freeze({ label: 80, unit: 20, optionLabel: 80, text: 500, collections: 100, values: 50 });

/**
 * @typedef {object} AttributeOption
 * @property {string} value
 * @property {string} label
 */
/**
 * @typedef {object} Attribute
 * @property {string} id
 * @property {string} key
 * @property {string} label
 * @property {typeof ATTRIBUTE_TYPES[number]} type
 * @property {string | null} unit
 * @property {AttributeOption[]} options
 * @property {boolean} filterable
 * @property {boolean} variantOption
 * @property {string} cardPosition
 * @property {string[]} collectionIds empty = every collection
 * @property {{ type: typeof VISIBILITY_TYPES[number], brandIds?: string[], attributeKey?: string, values?: string[] }} visibility
 * @property {number} position
 * @property {boolean} required
 */

/**
 * Compact option value from a label and the attribute unit.
 * @param {string} label
 * @param {string | null} [unit]
 */
export const optionValueOf = (label, unit = null) => slugify(`${label}${unit ?? ''}`, 60).replace(/-/g, '');

/**
 * Display label of a value ("256" + "gb" → "256 gb"); unknown values show as written.
 * @param {Pick<Attribute, 'options' | 'unit'>} attribute
 * @param {unknown} value
 */
export const optionLabel = (attribute, value) => {
	const option = attribute.options.find((o) => o.value === value);
	const label = option ? option.label : String(value);
	return attribute.unit && option ? `${label} ${attribute.unit}` : label;
};

/** @param {unknown} value @param {number} max */
const idList = (value, max) =>
	Array.isArray(value) && value.length <= max && value.every(isId) ? [...new Set(/** @type {string[]} */ (value))] : null;

/**
 * Validate an attribute definition (create or patch over `current`).
 * @param {unknown} input
 * @param {{ current?: Attribute | null, cardPositions: readonly string[], maxOptions: number }} context
 * @returns {{ problems: Array<{ path: string, code: string }>, value: Omit<Attribute, 'id'> | null }}
 */
export const validateAttribute = (input, { current = null, cardPositions, maxOptions }) => {
	if (!isObject(input)) return { problems: [issue('', 'object_required')], value: null };
	const body = /** @type {Record<string, any>} */ (input);
	/** @type {Array<{ path: string, code: string }>} */
	const problems = [];
	const has = (/** @type {string} */ key) => Object.hasOwn(body, key);
	const key = current ? current.key : body.key;
	if (!current && !isKey(key)) problems.push(issue('/key', 'key_invalid'));
	if (current && has('key') && body.key !== current.key) problems.push(issue('/key', 'immutable'));
	const label = has('label') ? cleanText(body.label, LIMITS.label) : (current?.label ?? null);
	if (label === null) problems.push(issue('/label', 'required'));
	const type = has('type') ? body.type : (current?.type ?? 'select');
	if (!ATTRIBUTE_TYPES.includes(type)) problems.push(issue('/type', 'type_invalid'));
	if (current && has('type') && type !== current.type) problems.push(issue('/type', 'immutable'));
	const unit = has('unit') ? (body.unit === null ? null : cleanText(body.unit, LIMITS.unit)) : (current?.unit ?? null);
	if (has('unit') && body.unit !== null && unit === null) problems.push(issue('/unit', 'text_invalid'));
	/** @type {AttributeOption[]} */
	let options = current?.options ?? [];
	if (has('options')) {
		if (!Array.isArray(body.options) || body.options.length > maxOptions) problems.push(issue('/options', 'options_invalid'));
		else {
			options = [];
			body.options.forEach((/** @type {any} */ raw, /** @type {number} */ index) => {
				const optionLabelText = cleanText(isObject(raw) ? raw.label : raw, LIMITS.optionLabel);
				const value = isObject(raw) && typeof raw.value === 'string' ? raw.value : optionValueOf(optionLabelText ?? '', unit);
				if (optionLabelText === null || !OPTION_VALUE.test(value))
					problems.push(issue(`/options/${index}`, 'option_invalid'));
				else if (options.some((o) => o.value === value)) problems.push(issue(`/options/${index}`, 'option_duplicate'));
				else options.push({ value, label: optionLabelText });
			});
		}
	}
	const choice = type === 'select' || type === 'multi_select';
	if (choice && options.length === 0) problems.push(issue('/options', 'options_required'));
	if (!choice && options.length > 0) problems.push(issue('/options', 'options_not_allowed'));
	const variantOption = has('variantOption') ? body.variantOption === true : (current?.variantOption ?? false);
	if (variantOption && type !== 'select') problems.push(issue('/variantOption', 'select_required'));
	const filterable = has('filterable') ? body.filterable === true : (current?.filterable ?? choice);
	const cardPosition = has('cardPosition') ? body.cardPosition : (current?.cardPosition ?? cardPositions.at(-1) ?? 'hidden');
	if (!cardPositions.includes(cardPosition)) problems.push(issue('/cardPosition', 'position_invalid'));
	const collectionIds = has('collectionIds') ? idList(body.collectionIds, LIMITS.collections) : (current?.collectionIds ?? []);
	if (collectionIds === null) problems.push(issue('/collectionIds', 'ids_invalid'));
	const visibility = has('visibility') ? visibilityOf(body.visibility) : (current?.visibility ?? { type: 'always' });
	if (visibility === null) problems.push(issue('/visibility', 'visibility_invalid'));
	else if (visibility.type === 'attribute' && visibility.attributeKey === key)
		problems.push(issue('/visibility', 'self_reference'));
	const position = has('position') ? body.position : (current?.position ?? 0);
	if (!Number.isSafeInteger(position) || position < 0 || position > 100_000)
		problems.push(issue('/position', 'position_invalid'));
	const required = has('required') ? body.required === true : (current?.required ?? false);
	for (const name of ['variantOption', 'filterable', 'required'])
		if (has(name) && typeof body[name] !== 'boolean') problems.push(issue(`/${name}`, 'boolean_invalid'));
	if (problems.length > 0) return { problems, value: null };
	return {
		problems,
		value: {
			key,
			label: /** @type {string} */ (label),
			type,
			unit,
			options,
			filterable,
			variantOption,
			cardPosition,
			collectionIds: /** @type {string[]} */ (collectionIds),
			visibility: /** @type {Attribute['visibility']} */ (visibility),
			position,
			required,
		},
	};
};

/**
 * @param {unknown} input
 * @returns {Attribute['visibility'] | null}
 */
const visibilityOf = (input) => {
	if (!isObject(input)) return null;
	const rule = /** @type {Record<string, any>} */ (input);
	if (rule.type === 'always') return { type: 'always' };
	if (rule.type === 'brand') {
		const brandIds = idList(rule.brandIds, LIMITS.collections);
		return brandIds && brandIds.length > 0 ? { type: 'brand', brandIds } : null;
	}
	if (rule.type === 'attribute' && isKey(rule.attributeKey)) {
		const values = Array.isArray(rule.values) && rule.values.length <= LIMITS.values ? rule.values : null;
		return values && values.length > 0 && values.every((v) => typeof v === 'string' && OPTION_VALUE.test(v))
			? { type: 'attribute', attributeKey: rule.attributeKey, values: [...new Set(/** @type {string[]} */ (values))] }
			: null;
	}
	return null;
};

/**
 * Whether an attribute applies (ported visibility rules): always, for some brands, or when another attribute has one
 * of some values; and only in its collections when scoped.
 * @param {Pick<Attribute, 'visibility' | 'collectionIds'>} attribute
 * @param {{ brandId?: string | null, values?: Record<string, unknown>, collectionIds?: readonly string[] | null }} context
 *   `collectionIds` null = no collection context (every attribute is in scope)
 */
export const attributeApplies = (attribute, { brandId = null, values = {}, collectionIds = null }) => {
	if (collectionIds !== null && attribute.collectionIds.length > 0)
		if (!attribute.collectionIds.some((id) => collectionIds.includes(id))) return false;
	const rule = attribute.visibility;
	if (rule.type === 'brand') return brandId !== null && (rule.brandIds ?? []).includes(brandId);
	if (rule.type === 'attribute') {
		const value = values[rule.attributeKey ?? ''];
		const list = Array.isArray(value) ? value : [value];
		return list.some((v) => (rule.values ?? []).includes(/** @type {string} */ (v)));
	}
	return true;
};

/**
 * One attribute value: the stored value or an error code.
 * @param {Attribute} attribute
 * @param {unknown} value
 * @returns {{ value: string | number | boolean | string[] } | { code: string }}
 */
export const attributeValue = (attribute, value) => {
	switch (attribute.type) {
		case 'text': {
			const text = cleanText(value, LIMITS.text);
			return text === null ? { code: 'text_invalid' } : { value: text };
		}
		case 'number':
			return typeof value === 'number' && Number.isFinite(value) ? { value } : { code: 'number_invalid' };
		case 'boolean':
			return typeof value === 'boolean' ? { value } : { code: 'boolean_invalid' };
		case 'select':
			return attribute.options.some((o) => o.value === value)
				? { value: /** @type {string} */ (value) }
				: { code: 'option_invalid' };
		default: {
			const list = Array.isArray(value) ? value : null;
			return list && list.length <= 20 && list.every((v) => attribute.options.some((o) => o.value === v))
				? { value: [...new Set(/** @type {string[]} */ (list))] }
				: { code: 'option_invalid' };
		}
	}
};

/**
 * Validate an item's `attributes` map against the definitions (unknown keys, wrong values, required ones missing).
 * @param {readonly Attribute[]} attributes
 * @param {unknown} input
 * @param {{ brandId: string | null, collectionIds: readonly string[], current?: Record<string, unknown>, partial?: boolean }} context
 * @returns {{ problems: Array<{ path: string, code: string }>, value: Record<string, unknown> }}
 */
export const validateItemAttributes = (attributes, input, { brandId, collectionIds, current = {}, partial = false }) => {
	if (input !== undefined && !isObject(input)) return { problems: [issue('/attributes', 'object_required')], value: current };
	const byKey = new Map(attributes.map((a) => [a.key, a]));
	/** @type {Array<{ path: string, code: string }>} */
	const problems = [];
	/** @type {Record<string, unknown>} */
	const value = partial ? { ...current } : {};
	for (const [key, raw] of Object.entries(/** @type {Record<string, unknown>} */ (input ?? {}))) {
		const attribute = byKey.get(key);
		if (!attribute) problems.push(issue(`/attributes/${key}`, 'attribute_unknown'));
		else if (raw === null) delete value[key];
		else {
			const result = attributeValue(attribute, raw);
			if ('code' in result) problems.push(issue(`/attributes/${key}`, result.code));
			else value[key] = result.value;
		}
	}
	for (const attribute of attributes)
		if (
			attribute.required &&
			!attribute.variantOption &&
			value[attribute.key] === undefined &&
			attributeApplies(attribute, { brandId, values: value, collectionIds: collectionIds.length > 0 ? collectionIds : null })
		)
			problems.push(issue(`/attributes/${attribute.key}`, 'required'));
	return { problems, value };
};

/**
 * Facet tokens of an item (`<key>:<value>`) for indexed filtering: item attribute values and the option values of its
 * active variants, for filterable choice attributes only.
 * @param {readonly Attribute[]} attributes
 * @param {{ attributes?: Record<string, unknown>, variants?: ReadonlyArray<{ options?: Record<string, string>, status?: string }> }} item
 * @returns {string[]}
 */
export const facetsOf = (attributes, item) => {
	const filterable = new Set(attributes.filter((a) => a.filterable).map((a) => a.key));
	const out = new Set();
	for (const [key, value] of Object.entries(item.attributes ?? {}))
		if (filterable.has(key)) for (const v of Array.isArray(value) ? value : [value]) out.add(`${key}:${String(v)}`);
	for (const variant of item.variants ?? [])
		if (variant.status !== 'inactive')
			for (const [key, value] of Object.entries(variant.options ?? {})) if (filterable.has(key)) out.add(`${key}:${value}`);
	return [...out].sort();
};
