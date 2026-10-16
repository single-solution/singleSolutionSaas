/**
 * Addresses in the admin widgets (staff order edits, customers' saved addresses): one editor and one written form, both
 * by the address's country (`@ss/contracts/address`: its order and its labels such as State, Province or ZIP code).
 * @module
 */
import {
	ADDRESS_LIMITS,
	LABEL_KINDS,
	PLACE_PARTS,
	addressFields,
	addressLines,
	countryChoices,
	countryName,
} from '../core/address.js';

/** @typedef {import('./admin-kit.js').Kit} Kit */

/**
 * A field's label: the country's label kind for the area, city, region and postal code (`address.<part>.<kind>`,
 * texts a website renames), else the field's own text.
 * @param {Kit} kit @param {string} name @param {string} label the label kind from `addressFields`
 */
const labelOf = (kit, name, label) =>
	name in LABEL_KINDS ? kit.t(`address.${name}.${label}`) : kit.t(`ordersAdmin.address.${name}`);

/**
 * An address as one line: the name and phone, the place in its country's order, then the country's name.
 * @param {Record<string, any>} address
 */
export const addressText = (address) =>
	[address.name, address.phone, ...addressLines(address), countryName(address.country)].filter(Boolean).join(', ');

/**
 * The address editor: the name, the phone, the country (a picker of every country) and the place parts of the
 * country picked, in its order with its labels (any part already filled stays shown), then the delivery notes; another
 * country lays the parts out again, keeping what was typed. Each field takes at most its length in the one address
 * table (`core/address.js`).
 * @param {Kit} kit @param {Record<string, any>} address the address to change (or the name and phone of a new one)
 * @returns {{ node: HTMLElement, values: () => Record<string, string> }}
 */
export const addressEditor = (kit, address) => {
	/** @type {Map<string, HTMLInputElement | HTMLSelectElement>} */
	const inputs = new Map();
	/** @param {string} name */
	const input = (name) => {
		const node = kit.input(address[name] ?? '', {
			maxlength: String(ADDRESS_LIMITS[/** @type {keyof typeof ADDRESS_LIMITS} */ (name)]),
			...(name === 'phone' ? { type: 'tel' } : {}),
		});
		inputs.set(name, node);
		return node;
	};
	const own = (/** @type {string} */ name) => kit.field(kit.t(`ordersAdmin.address.${name}`), input(name));
	const country = kit.select([{ value: '', label: '—' }, ...countryChoices()], address.country ?? '');
	inputs.set('country', country);
	const node = kit.h('div', { class: 'fields' });
	const before = [own('name'), own('phone'), kit.field(kit.t('ordersAdmin.address.country'), country)];
	const notes = own('notes');
	const layOut = () => {
		const typed = new Map(PLACE_PARTS.map((name) => [name, inputs.get(name)?.value ?? address[name] ?? '']));
		for (const name of PLACE_PARTS) inputs.delete(name);
		const ask = PLACE_PARTS.filter((name) => typed.get(name));
		const places = addressFields(country.value, { ask }).map(({ part, label }) => {
			const control = input(part);
			control.value = typed.get(part) ?? '';
			return kit.field(labelOf(kit, part, label), control);
		});
		node.replaceChildren(...before, ...places, notes);
	};
	country.addEventListener('change', layOut);
	layOut();
	return {
		node,
		/** The address as the API takes it (a part the country does not use and nobody filled is empty). */
		values: () => Object.fromEntries(Object.keys(ADDRESS_LIMITS).map((name) => [name, inputs.get(name)?.value.trim() ?? ''])),
	};
};
