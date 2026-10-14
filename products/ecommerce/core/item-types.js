/**
 * Item types (PLAN 0.8.10 dynamic model §1, phase 4): what an item is (its kind: physical, digital or a service) and
 * which parts ("elements") it has — options and variants, a condition grade, numbered units (with the unit fields their
 * numbers take, when the numbers are captured and the stage they are needed before), a measurement table, a package
 * (weight and size), per-item return and warranty days, downloads, license keys and booked time slots. Merchants keep
 * their types as the `item_types` list (feature `catalog`, at most 50); a type may also name the product and variant
 * fields its items take (at most 40; none named: every field their categories take) and names its units' fields (at
 * most 3, one of them with two values).
 *
 * A product's type is its own (`typeKey`), else its first category's (a category without one takes its parent's), else
 * the **built-in type** of its kind. A type of another kind never applies: the product keeps its kind. Built-in types
 * have every element the switched-on features allow (today's behavior, so a shop without types sees no change), except
 * numbered units: units are always a merchant's choice, made with a type that names their fields. An element works only
 * while its feature is on ({@link elementsOf}). No I/O.
 * @module
 */
import { FIELD_LIMITS } from './fields.js';

/** Item kinds (fixed in code): physical goods (delivery or pickup), digital goods (paid before given), services. */
export const ITEM_KINDS = Object.freeze(/** @type {const} */ (['physical', 'digital', 'service']));
/** The elements a type switches on. */
export const ELEMENTS = Object.freeze(
	/** @type {const} */ (['variants', 'grades', 'units', 'chart', 'parcel', 'warranty', 'downloads', 'licenceKeys', 'slots']),
);
/** The feature each element needs (an element works only while its feature is on). */
const ELEMENT_FEATURES = Object.freeze({
	variants: 'variants',
	grades: 'grades_serials',
	units: 'grades_serials',
	chart: 'size_charts',
	parcel: 'delivery_zones',
	warranty: 'returns',
	downloads: 'digital_goods',
	licenceKeys: 'digital_goods',
	slots: 'bookings',
});
/** The kinds an element is for (the others are for every kind). */
const ELEMENT_KINDS = Object.freeze(
	/** @type {Partial<Record<Element, ReadonlyArray<ItemKind>>>} */ ({
		units: ['physical'],
		parcel: ['physical'],
		downloads: ['digital'],
		licenceKeys: ['digital'],
		slots: ['service'],
	}),
);
/** When units get their numbers: picked from units added to stock, or typed when the order is packed (or later). */
export const UNIT_CAPTURES = Object.freeze(/** @type {const} */ (['stock', 'packing']));
/** The stage units must have their numbers before: entering packed, or entering shipped (and delivered). */
const UNIT_STAGES = Object.freeze(/** @type {const} */ (['packed', 'shipped']));
/** At most this many types, characters in a name, and fields a type names. */
export const TYPE_LIMITS = Object.freeze({ types: 50, name: 60, fields: 40 });

/** Type keys: lowercase letters, digits, `_` and `-`, starting with a letter. */
const KEY = /^[a-z][a-z0-9_-]{0,39}$/;
/** A field id as types name it. */
const FIELD_ID = /^[A-Za-z0-9_-]{1,64}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F]/;

/** @typedef {(typeof ITEM_KINDS)[number]} ItemKind */
/** @typedef {(typeof ELEMENTS)[number]} Element */
/** @typedef {(typeof UNIT_CAPTURES)[number]} UnitCapture */
/** @typedef {(typeof UNIT_STAGES)[number]} UnitStage */
/**
 * Numbered units: the unit fields their numbers take (none: a plain serial number), when they get their numbers, and
 * the stage they are needed before (null: never needed; units picked from stock are always needed before packed).
 * @typedef {{ fieldIds: string[], capture: UnitCapture, requiredBefore: UnitStage | null }} UnitsElement
 */
/**
 * The elements of a type: each on or off; `units` null when its items have no numbered units.
 * @typedef {{ variants: boolean, grades: boolean, units: UnitsElement | null, chart: boolean, parcel: boolean,
 *   warranty: boolean, downloads: boolean, licenceKeys: boolean, slots: boolean }} Elements
 */
/**
 * An item type: a merchant's (`item_types` list) or a built-in one (`builtIn`, its key is its kind). `fieldIds`: the
 * product and variant fields its items take (null: every field their categories take, as a built-in type's); `active`
 * false: kept on the products and categories that name it, not offered for new ones.
 * @typedef {{ key: string, name: string, kind: ItemKind, active: boolean, elements: Elements,
 *   fieldIds: string[] | null, builtIn?: boolean }} ItemType
 */
/** @typedef {{ path: string, message: string }} TypeProblem */
/**
 * The units of one product's items as orders capture them: when they get their numbers, the stage they are needed
 * before (null: never needed) and the unit fields their numbers take (none: plain serial numbers).
 * @typedef {{ capture: UnitCapture, requiredBefore: UnitStage | null,
 *   fields: Array<import('./model.js').AttributeRecord> }} UnitRules
 */

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Whether an element is for items of a kind.
 * @param {Element} element @param {ItemKind} kind
 */
export const elementFor = (element, kind) => ELEMENT_KINDS[element]?.includes(kind) ?? true;

/**
 * The built-in type of a kind: every element its kind takes, but no numbered units.
 * @param {ItemKind} kind
 * @returns {ItemType}
 */
const builtIn = (kind) =>
	Object.freeze({
		key: kind,
		name: '',
		kind,
		active: true,
		builtIn: true,
		fieldIds: null,
		elements: Object.freeze({
			variants: true,
			grades: true,
			units: null,
			chart: true,
			parcel: elementFor('parcel', kind),
			warranty: true,
			downloads: elementFor('downloads', kind),
			licenceKeys: elementFor('licenceKeys', kind),
			slots: elementFor('slots', kind),
		}),
	});

/** The built-in types by key (their kind). */
export const BUILT_IN_TYPES = Object.freeze(
	/** @type {Readonly<Record<ItemKind, ItemType>>} */ ({
		physical: builtIn('physical'),
		digital: builtIn('digital'),
		service: builtIn('service'),
	}),
);

/**
 * Whether a key names a built-in type.
 * @param {unknown} key
 * @returns {key is ItemKind}
 */
export const isBuiltInKey = (key) => typeof key === 'string' && ITEM_KINDS.includes(/** @type {any} */ (key));

/**
 * Field ids as a type names them: each once, at most `max`.
 * @param {unknown} value @param {number} max
 * @returns {string[] | null} null when not such a list
 */
const fieldIdsOf = (value, max) => {
	if (!Array.isArray(value) || value.length > max) return null;
	if (!value.every((id) => typeof id === 'string' && FIELD_ID.test(id))) return null;
	return new Set(value).size === value.length ? /** @type {string[]} */ ([...value]) : null;
};

/**
 * Check the units element of a type.
 * @param {unknown} raw @param {string} path @param {string} name @param {TypeProblem[]} errors
 * @returns {UnitsElement | null}
 */
const unitsOf = (raw, path, name, errors) => {
	if (raw === null || raw === undefined || raw === false) return null;
	if (!isObject(raw)) {
		errors.push({ path, message: `${name}: units are null (none) or { fieldIds, capture, requiredBefore }.` });
		return null;
	}
	const fieldIds = raw.fieldIds === undefined ? [] : fieldIdsOf(raw.fieldIds, FIELD_LIMITS.unitFields);
	if (!fieldIds)
		errors.push({
			path: `${path}/fieldIds`,
			message: `${name}: units take at most ${FIELD_LIMITS.unitFields} different unit fields.`,
		});
	const capture = raw.capture ?? 'stock';
	if (!UNIT_CAPTURES.includes(capture))
		errors.push({ path: `${path}/capture`, message: `${name}: units get their numbers from stock or at packing.` });
	const requiredBefore = raw.requiredBefore === undefined ? (capture === 'packing' ? 'shipped' : 'packed') : raw.requiredBefore;
	if (requiredBefore !== null && !UNIT_STAGES.includes(requiredBefore))
		errors.push({ path: `${path}/requiredBefore`, message: `${name}: units are needed before packed or shipped, or never.` });
	else if (capture === 'stock' && requiredBefore !== 'packed')
		errors.push({
			path: `${path}/requiredBefore`,
			message: `${name}: units picked from stock are picked when the order is packed.`,
		});
	return { fieldIds: fieldIds ?? [], capture, requiredBefore };
};

/**
 * Check the `item_types` list the merchant saves: each type's key (not a built-in one, each once), name, kind, whether
 * it is offered, its elements (only those of its kind) and the fields it names (none named: every field). Elements left
 * out are off.
 * @param {unknown} value
 * @returns {{ ok: true, value: ItemType[] } | { ok: false, errors: TypeProblem[] }}
 */
export const checkItemTypes = (value) => {
	if (!Array.isArray(value)) return { ok: false, errors: [{ path: '/value', message: 'A list is expected.' }] };
	if (value.length > TYPE_LIMITS.types)
		return { ok: false, errors: [{ path: '/value', message: `At most ${TYPE_LIMITS.types} item types.` }] };
	/** @type {TypeProblem[]} */
	const errors = [];
	/** @type {ItemType[]} */
	const out = [];
	value.forEach((entry, index) => {
		const path = `/value/${index}`;
		if (!isObject(entry)) return void errors.push({ path, message: `Item type ${index + 1}: an object is expected.` });
		const rawName = typeof entry.name === 'string' ? entry.name.trim() : '';
		const name = rawName || `Item type ${index + 1}`;
		if (!rawName || rawName.length > TYPE_LIMITS.name || CONTROL.test(rawName))
			errors.push({ path: `${path}/name`, message: `${name}: give a name of 1 to ${TYPE_LIMITS.name} characters.` });
		const key = typeof entry.key === 'string' ? entry.key.trim() : '';
		if (!KEY.test(key))
			errors.push({
				path: `${path}/key`,
				message: `${name}: the key is lowercase letters, digits, _ and - (starting with a letter).`,
			});
		else if (isBuiltInKey(key)) errors.push({ path: `${path}/key`, message: `${name}: ${key} is the key of a built-in type.` });
		else if (out.some((type) => type.key === key))
			errors.push({ path: `${path}/key`, message: `${name}: the key ${key} is used twice.` });
		const kind = entry.kind ?? 'physical';
		if (!ITEM_KINDS.includes(kind))
			errors.push({ path: `${path}/kind`, message: `${name}: the kind is ${ITEM_KINDS.join(', ')}.` });
		const active = entry.active ?? true;
		if (typeof active !== 'boolean') errors.push({ path: `${path}/active`, message: `${name}: active is true or false.` });
		const given = entry.elements ?? {};
		if (!isObject(given)) errors.push({ path: `${path}/elements`, message: `${name}: the elements are an object.` });
		const raw = isObject(given) ? given : {};
		for (const element of Object.keys(raw))
			if (!ELEMENTS.includes(/** @type {any} */ (element)))
				errors.push({ path: `${path}/elements/${element}`, message: `${name}: there is no element ${element}.` });
		/** @type {Record<string, unknown>} */
		const elements = {};
		for (const element of ELEMENTS) {
			const at = `${path}/elements/${element}`;
			const on =
				element === 'units' ? unitsOf(raw.units, at, name, errors) : raw[element] === undefined ? false : raw[element];
			if (element !== 'units' && typeof on !== 'boolean')
				errors.push({ path: at, message: `${name}: ${element} is true or false.` });
			const kindOk = ITEM_KINDS.includes(kind) ? elementFor(element, kind) : true;
			if (on && !kindOk)
				errors.push({
					path: at,
					message: `${name}: ${element} is for ${ELEMENT_KINDS[element]?.join(' and ')} items only.`,
				});
			elements[element] = element === 'units' ? on : on === true;
		}
		const givenFields = entry.fieldIds ?? null;
		const fieldIds = givenFields === null ? null : fieldIdsOf(givenFields, TYPE_LIMITS.fields);
		if (givenFields !== null && fieldIds === null)
			errors.push({
				path: `${path}/fieldIds`,
				message: `${name}: a type names at most ${TYPE_LIMITS.fields} different fields, or none (every field).`,
			});
		out.push({
			key,
			name: rawName,
			kind,
			active: active !== false,
			elements: /** @type {Elements} */ (elements),
			fieldIds: fieldIds ?? null,
		});
	});
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value: out };
};

/**
 * The type a key names: a built-in type, else one of the merchant's; null when there is none.
 * @param {string | null | undefined} key
 * @param {ReadonlyArray<ItemType>} types the merchant's
 * @returns {ItemType | null}
 */
export const typeByKey = (key, types) => {
	if (!key) return null;
	if (isBuiltInKey(key)) return BUILT_IN_TYPES[key];
	return types.find((type) => type.key === key) ?? null;
};

/**
 * Categories as item types read them: each one's path and own type key, by id.
 * @param {ReadonlyArray<{ id: string, path?: string[], typeKey?: string | null }>} categories
 * @returns {Map<string, { path: string[], typeKey: string | null }>}
 */
export const typeTree = (categories) =>
	new Map(categories.map((category) => [category.id, { path: category.path ?? [], typeKey: category.typeKey ?? null }]));

/**
 * The type key a category gives its products: its own, else the nearest one above it that names one (a key no type has
 * any more is passed over); '' when none does.
 * @param {string} categoryId
 * @param {ReadonlyArray<ItemType>} types
 * @param {ReadonlyMap<string, { path: string[], typeKey?: string | null }>} categories
 */
export const categoryTypeKey = (categoryId, types, categories) => {
	const category = categories.get(categoryId);
	if (!category) return '';
	for (const step of [categoryId, ...[...category.path].reverse()]) {
		const key = categories.get(step)?.typeKey;
		if (key && typeByKey(key, types)) return key;
	}
	return '';
};

/**
 * The type of a product: its own (`typeKey`), else its first category's (or the nearest one above it), else the built-in
 * type of its kind. A type of another kind never applies.
 * @param {{ kind: string, typeKey?: string | null, categoryIds: ReadonlyArray<string> }} product
 * @param {ReadonlyArray<ItemType>} types the merchant's
 * @param {ReadonlyMap<string, { path: string[], typeKey?: string | null }>} categories
 * @returns {ItemType}
 */
export const typeOf = (product, types, categories) => {
	const kind = /** @type {ItemKind} */ (ITEM_KINDS.includes(/** @type {any} */ (product.kind)) ? product.kind : 'physical');
	const first = product.categoryIds[0];
	const key = product.typeKey || (first ? categoryTypeKey(first, types, categories) : '');
	const found = typeByKey(key, types);
	return found && found.kind === kind ? found : BUILT_IN_TYPES[kind];
};

/**
 * The elements of a type that work: those it has, while their features are on.
 * @param {ItemType} type
 * @param {(feature: string) => boolean} has
 * @returns {Elements}
 */
export const elementsOf = (type, has) => {
	/** @type {Record<string, unknown>} */
	const out = {};
	for (const element of ELEMENTS) {
		const on = has(ELEMENT_FEATURES[element]) && elementFor(element, type.kind);
		out[element] = element === 'units' ? (on ? type.elements.units : null) : on && type.elements[element] === true;
	}
	return /** @type {Elements} */ (out);
};

/**
 * Whether a field applies to a type's items (a built-in type: every field; a merchant's: the fields it names).
 * @param {ItemType} type @param {string} fieldId
 */
export const typeTakes = (type, fieldId) => type.fieldIds === null || type.fieldIds.includes(fieldId);

/**
 * What saving a merchant's types would break (the guard of the `item_types` list): a field id that is not a product or
 * variant field (`fieldIds`) or not a unit field (`units.fieldIds`), two unit fields of one type with two values, a type
 * products or categories name being removed or given another kind, and the units of a type whose items have units in
 * stock being switched off or given other fields.
 * @param {ReadonlyArray<ItemType>} saved the list before
 * @param {ReadonlyArray<ItemType>} next the list checked by {@link checkItemTypes}
 * @param {{ fields: ReadonlyMap<string, { on: string, multiple: boolean }>, named: ReadonlySet<string>,
 *   stocked: ReadonlySet<string> }} data the shop's fields by id, the type keys products and categories name, and the
 *   keys of types whose items have units in stock
 * @returns {TypeProblem[]}
 */
export const typeChangeProblems = (saved, next, { fields, named, stocked }) => {
	/** @type {TypeProblem[]} */
	const problems = [];
	next.forEach((type, index) => {
		const path = `/value/${index}`;
		(type.fieldIds ?? []).forEach((id, at) => {
			const on = fields.get(id)?.on;
			if (on !== 'product' && on !== 'variant')
				problems.push({ path: `${path}/fieldIds/${at}`, message: `${type.name}: ${id} is not a product or variant field.` });
		});
		const units = type.elements.units;
		(units?.fieldIds ?? []).forEach((id, at) => {
			if (fields.get(id)?.on !== 'unit')
				problems.push({ path: `${path}/elements/units/fieldIds/${at}`, message: `${type.name}: ${id} is not a unit field.` });
		});
		if ((units?.fieldIds ?? []).filter((id) => fields.get(id)?.multiple === true).length > 1)
			problems.push({
				path: `${path}/elements/units/fieldIds`,
				message: `${type.name}: at most one unit field takes two values.`,
			});
		const before = saved.find((entry) => entry.key === type.key);
		if (!before) return;
		if (before.kind !== type.kind && named.has(type.key))
			problems.push({
				path: `${path}/kind`,
				message: `${type.name}: products or categories use this type, so its kind cannot change.`,
			});
		const beforeUnits = before.elements.units;
		const sameUnits =
			(beforeUnits === null && units === null) ||
			(beforeUnits !== null && units !== null && JSON.stringify(beforeUnits.fieldIds) === JSON.stringify(units.fieldIds));
		if (!sameUnits && beforeUnits !== null && stocked.has(type.key))
			problems.push({
				path: `${path}/elements/units`,
				message: `${type.name}: units of its items are in stock, so its units and their fields cannot change.`,
			});
	});
	for (const type of saved)
		if (!next.some((entry) => entry.key === type.key) && named.has(type.key))
			problems.push({
				path: '/value',
				message: `${type.name}: products or categories use this type; give them another type first.`,
			});
	return problems;
};
