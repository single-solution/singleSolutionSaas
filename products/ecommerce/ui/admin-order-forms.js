/**
 * The parts of the orders admin widget's move dialog that depend on the status's role (PLAN 0.8.8 Orders): the units of
 * the lines whose item type numbers them (dynamic model §1), with each line's warranty (packing, a later move that needs
 * them, and typed later): a serial number per unit picked from stock, or typed — with unit fields (§2) one input per
 * value of each field (two for a field that takes two), each checked live against its field's format as the server
 * checks it; and the
 * shipment (a courier of the website's list, or a typed courier key, and a tracking number; or a booking through the
 * courier API).
 * @module
 */
import { checkFormat } from '../core/fields.js';
import { timeText } from './shop-common.js';

/** @typedef {import('./admin-kit.js').Kit} Kit */
/**
 * The units typed per line: serial numbers, or `{ values }` by unit field.
 * @typedef {{ ok: true, value: Record<string, Array<string | { values: Record<string, string[]> }>> }
 *   | { ok: false, error: string }} SerialValues
 */

/**
 * The lines whose units are numbered: the answer says how (`unitCapture`: picked from `stock`, or typed at `packing` or
 * later, as each line's item type says).
 * @param {any} order
 * @returns {any[]}
 */
export const serialLines = (order) =>
	order.lines.filter((/** @type {any} */ line) => line.unitCapture === 'stock' || line.unitCapture === 'packing');

/**
 * Whether a line's units are typed (at packing or later) rather than picked from stock.
 * @param {any} line
 */
export const typedLine = (line) => line.unitCapture === 'packing';

/**
 * Whether a line still lacks some of its units' numbers.
 * @param {any} line
 */
export const unitsMissing = (line) => (line.serials ?? []).length !== line.quantity;

/**
 * A line's warranty for people.
 * @param {Kit} kit @param {any} line
 */
export const warrantyOf = (kit, line) =>
	!line.warrantyTime ? '' : timeText(kit.t, line.warrantyTime) || kit.t('ordersAdmin.noWarranty');

/**
 * Couriers of the website, when the widget settings carry them (`settings.orders.couriers: [{ key, name }]`).
 * @param {Kit} kit
 * @returns {Array<{ key: string, name: string }>}
 */
const couriersOf = (kit) => {
	const list = kit.settings.orders?.couriers;
	return Array.isArray(list) ? list : [];
};

/** One unit's inputs: each with its unit field (null: the serial number). @typedef {Array<{ field: any, input: HTMLInputElement }>} UnitInputs */

/**
 * One unit's inputs: a serial number, or, typed with unit fields, an input per value of each field (two for a field
 * that takes two), filled with what the unit has.
 * @param {Kit} kit @param {any} line @param {number} index
 * @returns {UnitInputs}
 */
const unitInputs = (kit, line, index) => {
	const { t } = kit;
	const fields = typedLine(line) ? (line.unitFields ?? []) : [];
	const unit = line.units?.[index] ?? { serial: line.serials[index] ?? '', values: {} };
	const label = (/** @type {string} */ name, /** @type {number} */ value) =>
		t('ordersAdmin.unitValueOf', { item: line.name, unit: index + 1, field: name, value: value + 1 });
	if (fields.length === 0)
		return [
			{
				field: null,
				input: kit.input(unit.serial ?? '', {
					maxlength: '64',
					autocomplete: 'off',
					placeholder: t('ordersAdmin.unit', { unit: index + 1 }),
					'aria-label': t('ordersAdmin.serialOf', { item: line.name, unit: index + 1 }),
				}),
			},
		];
	return fields.flatMap((/** @type {any} */ field) =>
		Array.from({ length: field.maxValues > 1 ? field.maxValues : 1 }, (_, value) => ({
			field,
			input: kit.input(unit.values?.[field.id]?.[value] ?? '', {
				maxlength: '200',
				autocomplete: 'off',
				...(field.format?.chars === 'digits' ? { inputmode: 'numeric' } : {}),
				placeholder: value === 0 ? field.name : t('ordersAdmin.secondValue', { field: field.name }),
				'aria-label': label(field.name, value),
			}),
		})),
	);
};

/**
 * What is wrong with one typed value as its field's format sees it ('' = nothing).
 * @param {Kit} kit @param {any} field @param {string} value
 */
const formatProblem = (kit, field, value) => {
	if (!field?.format || !value) return '';
	const checked = checkFormat(value, field.format);
	return checked.ok
		? ''
		: `${kit.t('fields.notFormat', { value, field: field.name })} ${kit.t(`fields.problem.${checked.code}`)}`;
};

/**
 * Unit inputs, one unit per unit of each line given (none: null). `values()` gives the complete lines (all of a line's
 * inputs empty leaves it out; some units empty is a mistake); with `changedOnly`, only lines whose units changed. Typed
 * values are checked as they are typed, and again before sending.
 * @param {Kit} kit @param {any[]} lines the lines whose units are asked @param {boolean} changedOnly
 * @returns {{ node: HTMLElement, values: () => SerialValues } | null}
 */
export const serialForm = (kit, lines, changedOnly) => {
	const { t, h } = kit;
	if (lines.length === 0) return null;
	/** @type {Array<{ line: any, units: UnitInputs[] }>} */
	const rows = lines.map((/** @type {any} */ line) => ({
		line,
		units: Array.from({ length: line.quantity }, (_, index) => unitInputs(kit, line, index)),
	}));
	// a live hint (the dialog keeps its own status line for what saving says)
	const status = kit.text('p', { class: 'error', 'aria-live': 'polite' }, '');
	/** Say the first value whose format is wrong (live). */
	const check = () => {
		for (const { units } of rows)
			for (const unit of units)
				for (const { field, input } of unit) {
					const problem = formatProblem(kit, field, input.value.trim());
					input.toggleAttribute('aria-invalid', problem !== '');
					if (problem) return kit.say(status, problem, true);
				}
		return kit.say(status, '');
	};
	for (const { units } of rows) for (const unit of units) for (const { input } of unit) input.addEventListener('input', check);
	return {
		node: kit.group(t('ordersAdmin.serialsTitle'), [
			kit.text('p', { class: 'muted' }, t('ordersAdmin.serialsHint')),
			...rows.map(({ line, units }) =>
				h('div', {}, [
					kit.text('strong', {}, [line.name, line.variantName].filter(Boolean).join(' · ')),
					warrantyOf(kit, line)
						? kit.text('span', { class: 'meta' }, `${t('ordersAdmin.warranty')}: ${warrantyOf(kit, line)}`)
						: null,
					...units.map((unit) =>
						h(
							'div',
							{ class: 'row' },
							unit.map(({ input }) => input),
						),
					),
				]),
			),
			status,
		]),
		values: () => {
			/** @type {Record<string, Array<string | { values: Record<string, string[]> }>>} */
			const value = {};
			for (const { line, units } of rows) {
				const entered = units.map((unit) => unit.map(({ field, input }) => ({ field, text: input.value.trim() })));
				if (entered.every((unit) => unit.every((entry) => entry.text === ''))) continue;
				if (entered.some((unit) => unit.every((entry) => entry.text === '')))
					return { ok: false, error: t('ordersAdmin.serialsPartial', { item: line.name }) };
				/** @type {Array<string | { values: Record<string, string[]> }>} */
				const sent = [];
				for (const unit of entered) {
					if (unit[0]?.field === null) {
						sent.push(unit[0].text);
						continue;
					}
					/** @type {Record<string, string[]>} */
					const values = {};
					for (const { field, text } of unit) {
						if (!text) continue;
						const problem = formatProblem(kit, field, text);
						if (problem) return { ok: false, error: problem };
						values[field.id] = [...(values[field.id] ?? []), text];
					}
					const missing = (line.unitFields ?? []).find((/** @type {any} */ field) => field.required && !values[field.id]);
					if (missing)
						return { ok: false, error: t('ordersAdmin.unitFieldMissing', { field: missing.name, item: line.name }) };
					sent.push({ values });
				}
				const before = (line.units ?? []).map((/** @type {any} */ unit) =>
					Object.keys(unit.values ?? {}).length > 0 ? { values: unit.values } : unit.serial,
				);
				if (changedOnly && JSON.stringify(sent) === JSON.stringify(before)) continue;
				value[line.id] = sent;
			}
			return { ok: true, value };
		},
	};
};

/**
 * The shipment of a move to a shipped status.
 * @param {Kit} kit
 */
export const shipForm = (kit) => {
	const { t, h, has } = kit;
	const couriers = couriersOf(kit);
	const courier =
		couriers.length > 0
			? kit.select([
					{ value: '', label: t('ordersAdmin.pickCourier') },
					...couriers.map((item) => ({ value: item.key, label: item.name })),
				])
			: kit.input('', { maxlength: '40' });
	const tracking = kit.input('', { maxlength: '80' });
	const book = kit.toggle(t('ordersAdmin.bookCourier'));
	const trackingField = kit.field(t('ordersAdmin.trackingNumber'), tracking);
	book.box.addEventListener('change', () => {
		trackingField.hidden = book.box.checked;
	});
	return {
		node: kit.group(t('ordersAdmin.shipment'), [
			h('div', { class: 'fields' }, [kit.field(t('ordersAdmin.courier'), courier), trackingField]),
			has('courier_apis') ? book.node : null,
		]),
		/** @returns {Record<string, unknown> | null} */
		value: () => {
			if (has('courier_apis') && book.box.checked) return { book: true, ...(courier.value ? { courier: courier.value } : {}) };
			if (courier.value || tracking.value.trim()) return { courier: courier.value, trackingNumber: tracking.value.trim() };
			return null;
		},
	};
};
