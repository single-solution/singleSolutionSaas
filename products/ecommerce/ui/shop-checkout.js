/**
 * Parts of the cart widget's checkout (PLAN 0.8.8: cart + checkout + success page): the delivery address form (the
 * fields the merchant requires, from the `checkout` settings), the success page of a placed order (its number,
 * status, totals and, while it waits for a payment, the way to pay) and paying an order again.
 * @module
 */
import { button, codeOf, currencyOf, field, formatsOf, h, problemText } from './shop-common.js';

/** @typedef {import('./shop-common.js').Texts} Texts */
/** @typedef {import('./shop-common.js').ShopSettings} ShopSettings */
/** @typedef {import('./widget.js').Shop} Shop */
/** @typedef {import('./widget.js').WidgetConfig} WidgetConfig */

/** The address fields in order, with their longest text and the browser's autofill name. */
const ADDRESS_FIELDS = Object.freeze(
	/** @type {Array<[string, number, string]>} */ ([
		['name', 120, 'name'],
		['phone', 30, 'tel'],
		['line1', 200, 'address-line1'],
		['line2', 200, 'address-line2'],
		['city', 80, 'address-level2'],
		['area', 80, 'address-level3'],
		['postalCode', 20, 'postal-code'],
		['country', 60, 'country-name'],
		['notes', 500, 'off'],
	]),
);

/**
 * The delivery address form. `onPlace` runs when the city, area or country changes (the delivery fee may change).
 * @param {{ doc: Document, t: Texts, settings: ShopSettings, onPlace: () => void }} input
 */
export const addressForm = ({ doc, t, settings, onPlace }) => {
	const { required, optional } = settings.checkout.address;
	/** @type {Map<string, HTMLInputElement | HTMLTextAreaElement>} */
	const inputs = new Map();
	const fields = ADDRESS_FIELDS.filter(([name]) => required.includes(name) || optional.includes(name)).map(
		([name, max, autocomplete]) => {
			const needed = required.includes(name);
			const control = /** @type {HTMLInputElement | HTMLTextAreaElement} */ (
				h(doc, name === 'notes' ? 'textarea' : 'input', {
					maxlength: String(max),
					autocomplete,
					...(name === 'phone' ? { type: 'tel', inputmode: 'tel' } : {}),
					...(name === 'city' && settings.checkout.cities.length > 0 ? { list: 'ss-cart-cities' } : {}),
					...(needed ? { required: '', 'aria-required': 'true' } : {}),
				})
			);
			if (['city', 'area', 'country'].includes(name)) control.addEventListener('change', onPlace);
			inputs.set(name, control);
			return field(
				doc,
				`ss-cart-${name}`,
				t(needed ? `checkout.field.${name}` : 'checkout.optional', { field: t(`checkout.field.${name}`) }),
				control,
			);
		},
	);
	const cities =
		settings.checkout.cities.length > 0
			? h(
					doc,
					'datalist',
					{ id: 'ss-cart-cities' },
					...settings.checkout.cities.map((city) => h(doc, 'option', { value: city })),
				)
			: null;
	const node = h(doc, 'fieldset', { class: 'box' }, h(doc, 'legend', {}, t('checkout.address')), ...fields, cities);

	/** @param {string} name */
	const value = (name) => inputs.get(name)?.value.trim() ?? '';
	return {
		node,
		value,
		/** The address as the order takes it. */
		values: () => Object.fromEntries(ADDRESS_FIELDS.map(([name]) => [name, value(name)])),
		/** The first required field left empty, or null. */
		missing: () => required.find((name) => inputs.has(name) && value(name) === '') ?? null,
		/** @param {string} name */
		focus: (name) => inputs.get(name)?.focus(),
	};
};

/**
 * The return address for Payments: this page without a previous `ss_order`.
 * @param {Shop} shop
 */
export const returnUrlOf = (shop) => {
	const url = shop.location();
	url.searchParams.delete('ss_order');
	url.hash = '';
	return url.toString();
};

/**
 * Show a placed order: its number, status, lines and totals, and, while it waits for a payment, the payment page link
 * or the button that starts the payment again.
 * @param {{ box: HTMLElement, t: Texts, shop: Shop, config: WidgetConfig, settings: ShopSettings, order: any }} input
 */
export const renderSuccess = ({ box, t, shop, config, settings, order }) => {
	const doc = /** @type {Document} */ (box.ownerDocument);
	const { money, dateText } = formatsOf(config, doc.defaultView);
	const currency = currencyOf(settings, order.totals?.currency);
	const status = h(doc, 'p', { class: 'status', role: 'status' });
	const waiting = order.role === 'awaiting_payment' && order.payment?.state === 'pending';
	const parts = [
		h(doc, 'h2', {}, t('success.title')),
		h(doc, 'p', {}, t('success.number', { number: order.number })),
		h(doc, 'p', {}, t('success.status', { status: order.statusLabel })),
		h(
			doc,
			'ul',
			{ 'aria-label': t('success.lines') },
			...order.lines.map((/** @type {any} */ line) =>
				h(
					doc,
					'li',
					{},
					t('success.line', {
						name: line.variantName ? `${line.name} (${line.variantName})` : line.name,
						quantity: line.quantity,
					}),
					h(doc, 'span', { class: 'meta' }, money(line.total, currency)),
				),
			),
		),
		h(doc, 'p', { class: 'amount' }, t('success.total', { total: money(order.totals.total, currency) })),
	];
	if (order.payment?.state === 'paid') parts.push(h(doc, 'p', { class: 'save' }, t('success.paid')));
	if (waiting) {
		if (order.payment.payBy)
			parts.push(h(doc, 'p', { class: 'meta' }, t('success.payBy', { date: dateText(order.payment.payBy) })));
		if (order.payment.payUrl) parts.push(h(doc, 'a', { href: order.payment.payUrl, class: 'button' }, t('success.pay')));
		else
			parts.push(
				button(doc, t('success.retry'), async (event) => {
					const node = /** @type {HTMLButtonElement} */ (event.currentTarget);
					node.setAttribute('disabled', '');
					const answer = await shop.call(`/v1/shop/orders/${encodeURIComponent(order.id)}/pay`, {
						method: 'POST',
						body: { returnUrl: returnUrlOf(shop) },
						idempotencyKey: shop.newKey(),
					});
					node.removeAttribute('disabled');
					if (answer.ok && answer.data.next?.kind === 'pay') return shop.go(answer.data.next.url);
					if (answer.ok) return renderSuccess({ box, t, shop, config, settings, order: answer.data.order });
					status.textContent = problemText(config, 'checkout.problem.', codeOf(answer), 'checkout.problem.failed');
				}),
			);
	} else if (order.role === 'awaiting_confirmation') parts.push(h(doc, 'p', { class: 'meta' }, t('success.confirming')));
	box.replaceChildren(h(doc, 'div', { class: 'box' }, ...parts, status));
};
