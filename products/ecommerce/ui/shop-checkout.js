/**
 * Parts of the cart widget's checkout (PLAN 0.8.8: cart + checkout + success page): the delivery address form (the
 * fields the merchant requires, from the `checkout` settings), the success page of a placed order (its number,
 * status, totals and, while it waits for a payment, the way to pay) and paying an order again.
 * @module
 */
import { ADDRESS_FIELDS, ADDRESS_LIMITS, regionsFor } from '../core/address.js';
import { button, codeOf, currencyOf, field, formatsOf, h, problemText, select } from './shop-common.js';
import { transferParts } from './shop-payment.js';

/** @typedef {import('../core/address.js').AddressField} AddressField */

/** @typedef {import('./shop-common.js').Texts} Texts */
/** @typedef {import('./shop-common.js').ShopSettings} ShopSettings */
/** @typedef {import('./widget.js').Shop} Shop */
/** @typedef {import('./widget.js').WidgetConfig} WidgetConfig */

/** The browser's autofill name of each address field. */
const AUTOFILL = Object.freeze({
	name: 'name',
	phone: 'tel',
	line1: 'address-line1',
	line2: 'address-line2',
	city: 'address-level2',
	area: 'address-level3',
	region: 'address-level1',
	postalCode: 'postal-code',
	country: 'country-name',
	notes: 'off',
});

/**
 * The delivery address form: the fields the merchant asks for (the `checkout` settings), each at most its length in
 * the one address table (`core/address.js`); the region is a list to pick from in a country `address_regions` names
 * (the business.json country while the country is left empty). `onPlace` runs when a field the delivery fee and taxes
 * depend on changes.
 * @param {{ doc: Document, t: Texts, settings: ShopSettings, onPlace: () => void }} input
 */
export const addressForm = ({ doc, t, settings, onPlace }) => {
	const { required, optional, regions, country: homeCountry } = settings.checkout.address;
	/** @type {Map<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>} */
	const inputs = new Map();
	/** @param {string} name */
	const value = (name) => inputs.get(name)?.value.trim() ?? '';
	/** The region names offered where the address is, or null. */
	const regionNames = () => regionsFor(regions, value('country') || homeCountry);
	/** @param {AddressField} name @param {boolean} needed */
	const control = (name, needed) => {
		const names = name === 'region' ? regionNames() : null;
		const node = names
			? select(
					doc,
					[['', t('checkout.region.choose')], ...names.map((entry) => /** @type {[string, string]} */ ([entry, entry]))],
					'',
					{
						autocomplete: AUTOFILL.region,
					},
				)
			: /** @type {HTMLInputElement | HTMLTextAreaElement} */ (
					h(doc, name === 'notes' ? 'textarea' : 'input', {
						maxlength: String(ADDRESS_LIMITS[name]),
						autocomplete: AUTOFILL[name],
						...(name === 'phone' ? { type: 'tel', inputmode: 'tel' } : {}),
						...(name === 'city' && settings.checkout.cities.length > 0 ? { list: 'ss-cart-cities' } : {}),
					})
				);
		if (needed) {
			node.setAttribute('required', '');
			node.setAttribute('aria-required', 'true');
		}
		if (['city', 'area', 'region', 'postalCode', 'country'].includes(name)) node.addEventListener('change', onPlace);
		inputs.set(name, node);
		return node;
	};
	const fields = ADDRESS_FIELDS.filter((name) => required.includes(name) || optional.includes(name)).map((name) => {
		const needed = required.includes(name);
		return field(
			doc,
			`ss-cart-${name}`,
			t(needed ? `checkout.field.${name}` : 'checkout.optional', { field: t(`checkout.field.${name}`) }),
			control(name, needed),
		);
	});
	// a new country may offer its own regions: the region field follows (a typed region is kept where it can be)
	inputs.get('country')?.addEventListener('change', () => {
		const old = inputs.get('region');
		if (!old) return;
		const kept = old.value;
		const next = control('region', required.includes('region'));
		next.setAttribute('id', 'ss-cart-region');
		old.replaceWith(next);
		const options = next.tagName === 'SELECT' ? [.../** @type {HTMLSelectElement} */ (next).options] : null;
		if (!options || options.some((option) => option.value === kept)) next.value = kept;
	});
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

	return {
		node,
		value,
		/** The address as the order takes it. */
		values: () => Object.fromEntries(ADDRESS_FIELDS.map((name) => [name, value(name)])),
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
 * or the button that starts the payment again; for a bank transfer, the bank details, the shop's note and the transfer
 * proof (E24).
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
	parts.push(
		...transferParts({
			doc,
			t,
			shop,
			config,
			win: /** @type {Window & typeof globalThis} */ (doc.defaultView),
			order,
			onOrder: (next) => renderSuccess({ box, t, shop, config, settings, order: next }),
		}),
	);
	box.replaceChildren(h(doc, 'div', { class: 'box' }, ...parts, status));
};
