/**
 * The parts of the orders admin widget's move dialog that depend on the status's role (PLAN 0.8.8 Orders): the serial
 * numbers of the lines that take them, one per unit with each line's warranty (packing, and typed later with typed
 * serials, E11; an `imei` check needs 15 digits ending in their Luhn check digit, the server checks too), and the
 * shipment (a courier of the website's list, or a typed courier key, and a tracking number; or a booking through the
 * courier API).
 * @module
 */
import { isImei } from '../core/orders.js';

/** @typedef {import('./admin-kit.js').Kit} Kit */
/** @typedef {{ ok: true, value: Record<string, string[]> } | { ok: false, error: string }} SerialValues */

/**
 * Whether serial numbers are typed at packing or later (E11).
 * @param {Kit} kit
 */
export const typedSerials = (kit) => kit.has('grades_serials') && kit.settings.catalog?.serialMode === 'typed';

/**
 * The lines that take serial numbers: physical lines, unless the answer says a line is not serialized.
 * @param {any} order
 * @returns {any[]}
 */
export const serialLines = (order) =>
	order.lines.filter((/** @type {any} */ line) => line.kind === 'physical' && line.serialized !== false);

/**
 * A line's warranty for people.
 * @param {Kit} kit @param {any} line
 */
export const warrantyOf = (kit, line) =>
	typeof line.warrantyDays !== 'number'
		? ''
		: line.warrantyDays > 0
			? kit.t('ordersAdmin.warrantyDays', { days: line.warrantyDays })
			: kit.t('ordersAdmin.noWarranty');

/**
 * Couriers of the website, when the widget settings carry them (`settings.orders.couriers: [{ key, name }]`).
 * @param {Kit} kit
 * @returns {Array<{ key: string, name: string }>}
 */
const couriersOf = (kit) => {
	const list = kit.settings.orders?.couriers;
	return Array.isArray(list) ? list : [];
};

/**
 * Serial number inputs, one per unit of each line that takes them (none: null). `values()` gives the complete lines
 * (all of a line's inputs empty leaves it out; some empty is a mistake); with `changedOnly`, only lines whose numbers
 * changed.
 * @param {Kit} kit @param {any} order @param {boolean} changedOnly
 * @returns {{ node: HTMLElement, values: () => SerialValues } | null}
 */
export const serialForm = (kit, order, changedOnly) => {
	const { t, h } = kit;
	const lines = serialLines(order);
	if (lines.length === 0) return null;
	const imei = kit.settings.catalog?.serialCheck === 'imei';
	/** @type {Array<{ line: any, inputs: HTMLInputElement[] }>} */
	const rows = lines.map((line) => ({
		line,
		inputs: Array.from({ length: line.quantity }, (_, index) =>
			kit.input(line.serials[index] ?? '', {
				maxlength: '64',
				autocomplete: 'off',
				...(imei ? { inputmode: 'numeric' } : {}),
				placeholder: t('ordersAdmin.unit', { unit: index + 1 }),
				'aria-label': t('ordersAdmin.serialOf', { item: line.name, unit: index + 1 }),
			}),
		),
	}));
	return {
		node: kit.group(t('ordersAdmin.serialsTitle'), [
			kit.text('p', { class: 'muted' }, t(typedSerials(kit) ? 'ordersAdmin.serialsTypedHint' : 'ordersAdmin.serialsHint')),
			...rows.map(({ line, inputs }) =>
				h('div', {}, [
					kit.text('strong', {}, [line.name, line.variantName].filter(Boolean).join(' · ')),
					warrantyOf(kit, line)
						? kit.text('span', { class: 'meta' }, `${t('ordersAdmin.warranty')}: ${warrantyOf(kit, line)}`)
						: null,
					h('div', { class: 'row' }, inputs),
				]),
			),
		]),
		values: () => {
			/** @type {Record<string, string[]>} */
			const value = {};
			for (const { line, inputs } of rows) {
				const typed = inputs.map((input) => input.value.trim());
				if (typed.every((serial) => serial === '')) continue;
				if (typed.some((serial) => serial === ''))
					return { ok: false, error: t('ordersAdmin.serialsPartial', { item: line.name }) };
				const wrong = imei ? typed.find((serial) => !isImei(serial)) : undefined;
				if (wrong !== undefined) return { ok: false, error: t('ordersAdmin.notImei', { serial: wrong }) };
				if (changedOnly && typed.join('\n') === line.serials.join('\n')) continue;
				value[line.id] = typed;
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
	const book = kit.check(t('ordersAdmin.bookCourier'));
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
