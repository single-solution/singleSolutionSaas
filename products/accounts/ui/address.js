/**
 * Addresses in the Accounts widgets (My account, the Users widget): one set of inputs and one written form, both by
 * the address's country (`@ss/contracts/address`, the table Ecommerce uses too: its order and its labels such as State,
 * Province or ZIP code).
 * @module
 */
import { element } from '@ss/app-kit/widget';
import {
	ADDRESS_LIMITS,
	LABEL_KINDS,
	PLACE_PARTS,
	addressFields,
	addressLines,
	countryChoices,
	countryName,
} from '../core/widgets.js';

/** @typedef {import('./common.js').FieldMaker} FieldMaker */
/** @typedef {(key: string, values?: Record<string, unknown>) => string} Texts */

/**
 * An address as one line: the place in its country's order, then the country's name.
 * @param {Record<string, any>} address
 * @param {string} [homeCountry] the country of an address without one
 */
export const addressText = (address, homeCountry = '') =>
	[...addressLines(address, homeCountry), countryName(address.country)].filter(Boolean).join(', ');

/**
 * The inputs of one address, appended to `box`: the label, the name, the country (a picker of every country; the
 * business country for a new address), the place parts of the country picked in its order with its labels (the
 * area, city, region and postal code as widget texts `address.<part>.<kind>`, renamable per website) and the phone.
 * Picking another country lays the place parts out again, keeping what was typed; a part already filled stays shown.
 * `required` (the Profile setting) marks the parts the website requires; the country adds its own.
 * @param {{ doc: Document, make: FieldMaker, t: Texts, box: HTMLElement, address: Record<string, any>,
 *   required?: ReadonlyArray<string>, country?: string }} input
 * @returns {{ values: () => Record<string, string> }}
 */
export const addressInputs = ({ doc, make, t, box, address, required = [], country: home = '' }) => {
	/** @type {Map<string, HTMLInputElement | HTMLSelectElement>} */
	const inputs = new Map();
	/** @param {string} key @param {string} label @param {boolean} needed */
	const input = (key, label, needed) => {
		const made = make.field('input', label, {
			maxlength: String(ADDRESS_LIMITS[/** @type {keyof typeof ADDRESS_LIMITS} */ (key)]),
			...(needed ? { required: '' } : {}),
			...(key === 'phone' ? { type: 'tel' } : {}),
		});
		made.input.value = address[key] ?? '';
		inputs.set(key, made.input);
		return made.wrap;
	};
	const country = make.field('select', t('address.country'), required.includes('country') ? { required: '' } : {});
	const picker = /** @type {HTMLSelectElement} */ (/** @type {unknown} */ (country.input));
	for (const choice of [{ value: '', label: '—' }, ...countryChoices()])
		picker.append(element(doc, 'option', { value: choice.value }, choice.label));
	picker.value = address.id ? (address.country ?? '') : (address.country ?? home);
	inputs.set('country', picker);
	box.append(
		input('label', t('address.label'), required.includes('label')),
		input('name', t('address.name'), required.includes('name')),
		country.wrap,
	);
	const phone = input('phone', t('address.phone'), required.includes('phone'));
	/** @type {HTMLElement[]} */
	let places = [];
	const layOut = () => {
		const typed = new Map(PLACE_PARTS.map((part) => [part, inputs.get(part)?.value ?? address[part] ?? '']));
		for (const node of places) node.remove();
		const ask = PLACE_PARTS.filter((part) => typed.get(part));
		places = addressFields(picker.value || home, { required, ask }).map(({ part, label, required: needed }) => {
			const wrap = input(part, part in LABEL_KINDS ? t(`address.${part}.${label}`) : t(`address.${part}`), needed);
			/** @type {HTMLInputElement} */ (inputs.get(part)).value = typed.get(part) ?? '';
			return wrap;
		});
		for (const part of PLACE_PARTS) if (!places.some((node) => node.contains(inputs.get(part) ?? null))) inputs.delete(part);
		country.wrap.after(...places, phone);
	};
	picker.addEventListener('change', layOut);
	box.append(phone);
	layOut();
	return {
		/** The address's values as the API takes them (a part the country does not use and nobody filled is empty). */
		values: () => Object.fromEntries(Object.keys(ADDRESS_LIMITS).map((key) => [key, inputs.get(key)?.value.trim() ?? ''])),
	};
};
