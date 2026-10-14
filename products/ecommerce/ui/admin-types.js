/**
 * Item types in the catalog admin widget (PLAN 0.8.10 dynamic model §1): the merchant's types from the widget settings
 * (`settings.catalog.types`) with the built-in ones, a picker of the types of a kind (with "As its category says" or "As
 * its parent says"), the type a product or category draft has, the parts it has while their features are on, and the
 * unit fields its units take. The rules are the server's (`core/item-types.js`).
 * @module
 */
import { BUILT_IN_TYPES, ITEM_KINDS, elementsOf, typeByKey, typeOf, typeTree } from '../core/item-types.js';

/** @typedef {import('./admin-kit.js').Kit} Kit */
/** @typedef {import('../core/item-types.js').ItemType} ItemType */

/**
 * The merchant's item types (from the widget settings).
 * @param {Kit} kit
 * @returns {ItemType[]}
 */
export const typesOf = (kit) => {
	const list = kit.settings.catalog?.types;
	return Array.isArray(list) ? list : [];
};

/**
 * A type's name for people: the merchant's name, a built-in type's by its kind.
 * @param {Kit} kit @param {ItemType} type
 */
export const typeName = (kit, type) => (type.builtIn ? kit.t(`catalogAdmin.kind.${type.kind}`) : type.name);

/**
 * The name of the type a key names, or `inherited` without one (a key no type has any more shows itself).
 * @param {Kit} kit @param {string | null | undefined} key @param {string} inherited
 */
export const typeLabel = (kit, key, inherited) => {
	if (!key) return inherited;
	const type = typeByKey(key, typesOf(kit));
	return type ? typeName(kit, type) : key;
};

/**
 * Whether the editors show item type pickers: the merchant has types, or the record names one.
 * @param {Kit} kit @param {string | null | undefined} key
 */
export const showsTypes = (kit, key) => typesOf(kit).length > 0 || Boolean(key);

/**
 * The choices of a type picker: the inherited choice first, then the built-in type and the merchant's offered types of
 * a kind (null: of every kind), and the type it has even when no longer offered.
 * @param {Kit} kit @param {string | null} kind @param {string | null} current @param {string} inherited the first
 *   choice's words
 */
export const typeChoices = (kit, kind, current, inherited) => {
	const kinds = kind === null ? ITEM_KINDS : ITEM_KINDS.filter((entry) => entry === kind);
	return [
		{ value: '', label: inherited },
		...kinds.map((entry) => ({ value: entry, label: typeName(kit, BUILT_IN_TYPES[entry]) })),
		...typesOf(kit)
			.filter((type) => (kind === null || type.kind === kind) && (type.active || type.key === current))
			.map((type) => ({ value: type.key, label: type.name })),
	];
};

/**
 * The type a product has (its own, its first category's, else the built-in one of its kind).
 * @param {Kit} kit
 * @param {{ kind: string, typeKey?: string | null, categoryIds: string[] }} product
 * @param {ReadonlyArray<{ id: string, path?: string[], typeKey?: string | null }>} categories
 * @returns {ItemType}
 */
export const productTypeOf = (kit, product, categories) => typeOf(product, typesOf(kit), typeTree(categories));

/**
 * The type a key names (a built-in one, else the merchant's), else the built-in type of the kind.
 * @param {Kit} kit @param {string | null | undefined} key @param {string} kind
 * @returns {ItemType}
 */
export const typeNamed = (kit, key, kind) =>
	typeByKey(key, typesOf(kit)) ?? BUILT_IN_TYPES[/** @type {keyof typeof BUILT_IN_TYPES} */ (kind)] ?? BUILT_IN_TYPES.physical;

/**
 * The parts a type has while their features are on.
 * @param {Kit} kit @param {ItemType} type
 */
export const partsOf = (kit, type) => elementsOf(type, (feature) => kit.has(feature));

/**
 * The unit fields the units of a type take, in its order (active fields of the shop's).
 * @param {Kit} kit @param {ItemType} type @param {ReadonlyArray<any>} fields the shop's fields
 * @returns {any[]}
 */
export const unitFieldsOfType = (kit, type, fields) =>
	(partsOf(kit, type).units?.fieldIds ?? []).flatMap((id) =>
		fields.filter((field) => field.id === id && field.on === 'unit' && field.active !== false),
	);
