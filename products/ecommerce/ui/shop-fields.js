/**
 * The order fields a checkout asks the shopper (PLAN 0.8.10 dynamic model §2): the quote's `fields`, the shop's order
 * fields shown to shoppers. One control per field — text (several separated by commas where it takes several),
 * number (in its range and decimals), a choice (checkboxes where it takes several), yes or no, or a date — checked as
 * the server checks it (`core/fields.js` `checkValue`: formats, ranges, days) before the order is placed, every
 * required one given. Typed values stay while the cart is priced again.
 * @module
 */
import { FORMAT_REFUSALS, checkValue } from '../core/fields.js';
import { field, h } from './shop-common.js';

/** @typedef {import('./shop-common.js').Texts} Texts */
/** @typedef {import('../core/fields.js').ValueRules & { id: string, required: boolean, unit: string }} CheckoutField */

/**
 * The control of one field and how to read it (null: nothing given).
 * @param {Document} doc @param {Texts} t @param {CheckoutField} entry @param {string} id
 * @returns {{ node: HTMLElement, read: () => unknown }}
 */
const control = (doc, t, entry, id) => {
	const label = [entry.unit ? `${entry.name} (${entry.unit})` : entry.name, entry.required ? '' : t('checkout.optional')]
		.filter(Boolean)
		.join(' ');
	if (entry.type === 'choice' && entry.multiple) {
		const boxes = entry.choices.map((choice) => {
			const box = /** @type {HTMLInputElement} */ (h(doc, 'input', { type: 'checkbox', value: choice.value }));
			return { box, node: h(doc, 'label', { class: 'check' }, box, choice.label) };
		});
		return {
			node: h(doc, 'fieldset', { id }, h(doc, 'legend', {}, label), ...boxes.map((entry) => entry.node)),
			read: () => {
				const picked = boxes.filter((entry) => entry.box.checked).map((entry) => entry.box.value);
				return picked.length > 0 ? picked : null;
			},
		};
	}
	if (entry.type === 'choice' || entry.type === 'yes_no') {
		const choices =
			entry.type === 'yes_no'
				? [
						{ value: 'true', label: t('shop.yes') },
						{ value: 'false', label: t('shop.no') },
					]
				: entry.choices;
		const select = /** @type {HTMLSelectElement} */ (
			h(
				doc,
				'select',
				{},
				h(doc, 'option', { value: '' }, t('checkout.pick')),
				...choices.map((choice) => h(doc, 'option', { value: choice.value }, choice.label)),
			)
		);
		return {
			node: field(doc, id, label, select),
			read: () => (select.value === '' ? null : entry.type === 'yes_no' ? select.value === 'true' : select.value),
		};
	}
	const input = /** @type {HTMLInputElement} */ (
		h(doc, 'input', {
			...(entry.type === 'number'
				? {
						type: 'number',
						step: entry.decimals === 0 ? '1' : String(10 ** -entry.decimals),
						...(entry.min === null ? {} : { min: String(entry.min) }),
						...(entry.max === null ? {} : { max: String(entry.max) }),
					}
				: entry.type === 'date'
					? { type: 'date' }
					: { maxlength: '200', ...(entry.format?.chars === 'digits' ? { inputmode: 'numeric' } : {}) }),
		})
	);
	return {
		node: field(doc, id, label, input),
		read: () => {
			const typed = input.value.trim();
			if (!typed) return null;
			if (entry.type === 'number') return Number(typed);
			if (entry.type === 'text' && entry.multiple)
				return typed
					.split(',')
					.map((part) => part.trim())
					.filter(Boolean);
			return typed;
		},
	};
};

/**
 * The fields form. `render(fields)` draws the quote's fields (the same fields keep their controls and what was typed);
 * `values()` checks them for placing.
 * @param {{ doc: Document, t: Texts }} options
 */
export const checkoutFieldsForm = ({ doc, t }) => {
	const box = h(doc, 'div', { class: 'stack' });
	/** @type {Array<{ entry: CheckoutField, read: () => unknown, node: HTMLElement }>} */
	let controls = [];
	let drawn = '';
	return {
		node: box,
		/** @param {CheckoutField[] | undefined} fields */
		render: (fields) => {
			const list = Array.isArray(fields) ? fields : [];
			const key = JSON.stringify(list.map((entry) => [entry.id, entry.required, entry.type]));
			if (key === drawn) return;
			drawn = key;
			const kept = new Map(controls.map((item) => [item.entry.id, item]));
			controls = list.map((entry, index) => {
				const known = kept.get(entry.id);
				return known ? { ...known, entry } : { entry, ...control(doc, t, entry, `ss-cart-field-${index}`) };
			});
			box.replaceChildren(...controls.map((item) => item.node));
		},
		/**
		 * The values to send, or the first one to fix and why.
		 * @returns {{ ok: true, value: Record<string, unknown> } | { ok: false, message: string, node: HTMLElement }}
		 */
		values: () => {
			/** @type {Record<string, unknown>} */
			const value = {};
			for (const { entry, read, node } of controls) {
				const given = read();
				if (given === null) {
					if (entry.required) return { ok: false, message: t('checkout.fieldNeeded', { field: entry.name }), node };
					continue;
				}
				const checked = checkValue(entry, given);
				if (!checked.ok)
					return {
						ok: false,
						node,
						message:
							checked.value !== undefined && FORMAT_REFUSALS.includes(/** @type {any} */ (checked.code))
								? `${t('fields.notFormat', { value: checked.value, field: entry.name })} ${t(`fields.problem.${checked.code}`)}`
								: t('checkout.fieldWrong', { field: entry.name }),
					};
				value[entry.id] = checked.value;
			}
			return { ok: true, value };
		},
	};
};
