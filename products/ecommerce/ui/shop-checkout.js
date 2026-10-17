/**
 * Parts of the cart widget's checkout (PLAN 0.8.8: cart + checkout + success page): the delivery address form (the
 * fields the merchant requires, from the `checkout` settings), a guest's details (E21: their name and the contact the
 * shop checks guests out by), the success page of a placed order (its number,
 * status, totals and, while it waits for a payment, the way to pay) and paying an order again.
 * @module
 */
import {
	ADDRESS_FIELDS,
	ADDRESS_LIMITS,
	LABEL_KINDS,
	PLACE_PARTS,
	addressFields,
	addressProblem,
	countryChoices,
	countryCodeOf,
	regionsFor,
} from '../core/address.js';
import { button, currencyOf, field, formatsOf, h, problemText, quantityShown, select } from './shop-common.js';
import { codeOf } from './problem-code.js';
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
 * A field's label: for the area, city, region and postal code the country's label kind as a widget text
 * (`address.<part>.<kind>`, for example `address.region.state`, which a website renames), else the field's own text.
 * @param {Texts} t @param {string} name @param {string} [kind] the country's (`addressFormat(country).labels`)
 */
const addressLabel = (t, name, kind) =>
	name in LABEL_KINDS
		? t(`address.${name}.${kind ?? LABEL_KINDS[/** @type {keyof typeof LABEL_KINDS} */ (name)][0]}`)
		: t(`checkout.field.${name}`);

/**
 * The delivery address form: the name and phone, the country (a picker of every country, the business country
 * chosen first), the place parts the country's format uses (`@ss/contracts/address`: its order, its labels such as
 * State, Province or ZIP code, the region and postal code it requires) plus those the website requires, then the
 * delivery directions. Picking another country lays the place parts out again, keeping what was typed. Each field takes
 * at most its length in the one address table (`core/address.js`); the region is a list to pick from in a country
 * `address_regions` names. `onPlace` runs when a field the delivery fee and taxes depend on changes.
 * @param {{ doc: Document, t: Texts, settings: ShopSettings, onPlace: () => void }} input
 */
export const addressForm = ({ doc, t, settings, onPlace }) => {
	const { required, regions, country: homeCountry } = settings.checkout.address;
	/** @type {Map<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>} */
	const inputs = new Map();
	/** @type {Map<string, string>} the label of each field shown */
	const labels = new Map();
	/** @param {string} name */
	const value = (name) => inputs.get(name)?.value.trim() ?? '';
	/** @param {string} name */
	const isRequired = (name) => inputs.get(name)?.hasAttribute('required') === true;
	/**
	 * @param {AddressField} name @param {boolean} needed @param {string} label
	 * @param {HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement} node
	 */
	const fieldOf = (name, needed, label, node) => {
		if (needed) {
			node.setAttribute('required', '');
			node.setAttribute('aria-required', 'true');
		}
		if (['city', 'area', 'region', 'postalCode', 'country'].includes(name)) node.addEventListener('change', onPlace);
		inputs.set(name, node);
		labels.set(name, label);
		return field(doc, `ss-cart-${name}`, needed ? label : t('checkout.optional', { field: label }), node);
	};
	/** @param {AddressField} name */
	const input = (name) =>
		/** @type {HTMLInputElement | HTMLTextAreaElement} */ (
			h(doc, name === 'notes' ? 'textarea' : 'input', {
				maxlength: String(ADDRESS_LIMITS[name]),
				autocomplete: AUTOFILL[name],
				...(name === 'phone' ? { type: 'tel', inputmode: 'tel' } : {}),
				...(name === 'city' && settings.checkout.cities.length > 0 ? { list: 'ss-cart-cities' } : {}),
			})
		);
	const country = select(
		doc,
		[
			...(homeCountry ? [] : /** @type {Array<[string, string]>} */ ([['', t('checkout.region.choose')]])),
			...countryChoices().map(({ value: code, label }) => /** @type {[string, string]} */ ([code, label])),
		],
		countryCodeOf(homeCountry) ?? '',
		{ autocomplete: AUTOFILL.country },
	);
	const where = () => value('country') || homeCountry;
	const places = h(doc, 'div', { class: 'address-parts' });
	/** Lay out the place parts of the country picked, keeping what was typed. */
	const layOut = () => {
		const typed = new Map(PLACE_PARTS.map((name) => [name, inputs.get(name)?.value ?? '']));
		for (const name of PLACE_PARTS) {
			inputs.delete(name);
			labels.delete(name);
		}
		const names = regionsFor(regions, where());
		const parts = addressFields(where(), { required, ask: names ? ['region'] : [] }).map(
			({ part, label, required: needed }) => {
				const node =
					part === 'region' && names
						? select(
								doc,
								[
									['', t('checkout.region.choose')],
									...names.map((entry) => /** @type {[string, string]} */ ([entry, entry])),
								],
								'',
								{ autocomplete: AUTOFILL.region },
							)
						: input(part);
				const kept = typed.get(part) ?? '';
				const options = node.tagName === 'SELECT' ? [.../** @type {HTMLSelectElement} */ (node).options] : null;
				if (!options || options.some((option) => option.value === kept)) node.value = kept;
				return fieldOf(part, needed, addressLabel(t, part, label), node);
			},
		);
		places.replaceChildren(...parts);
	};
	country.addEventListener('change', layOut);
	layOut();
	/** @param {'name' | 'phone' | 'notes'} name */
	const own = (name) => fieldOf(name, required.includes(name), t(`checkout.field.${name}`), input(name));
	const cities =
		settings.checkout.cities.length > 0
			? h(
					doc,
					'datalist',
					{ id: 'ss-cart-cities' },
					...settings.checkout.cities.map((city) => h(doc, 'option', { value: city })),
				)
			: null;
	const node = h(
		doc,
		'fieldset',
		{ class: 'box' },
		h(doc, 'legend', {}, t('checkout.address')),
		own('name'),
		own('phone'),
		fieldOf('country', required.includes('country'), t('checkout.field.country'), country),
		places,
		own('notes'),
		cities,
	);

	return {
		node,
		value,
		/** The address as the order takes it. */
		values: () => Object.fromEntries(ADDRESS_FIELDS.map((name) => [name, value(name)])),
		/**
		 * The first field to fix, with what to say: a required one left empty, or a postal code not in the country's
		 * shape; null when none.
		 * @returns {{ name: string, text: string } | null}
		 */
		problem: () => {
			// in the order the form shows them
			const shown = [...node.querySelectorAll('input, select, textarea')].map((control) => control.id.slice(8));
			const empty = shown.find((name) => isRequired(name) && value(name) === '');
			if (empty) return { name: empty, text: t('checkout.missing', { field: labels.get(empty) ?? empty }) };
			const refused = addressProblem({
				...Object.fromEntries(PLACE_PARTS.map((name) => [name, value(name)])),
				country: where(),
			});
			return refused?.problem === 'postcode'
				? { name: 'postalCode', text: t('checkout.fieldWrong', { field: labels.get('postalCode') ?? '' }) }
				: null;
		},
		/** @param {string} name */
		focus: (name) => inputs.get(name)?.focus(),
	};
};

/** A guest's details: their longest text, the input type and the browser's autofill name. */
const GUEST_FIELDS = Object.freeze({
	name: /** @type {const} */ ([ADDRESS_LIMITS.name, 'text', 'name']),
	phone: /** @type {const} */ ([ADDRESS_LIMITS.phone, 'tel', 'tel']),
	email: /** @type {const} */ ([254, 'email', 'email']),
});

/**
 * A guest's details (E21): the name, and the contact the shop checks guests out by (`guestIdentity`, phase 5) first —
 * the phone (needed while `phoneRequired` is on too), the email address, or either one of them; a contact not needed
 * is optional.
 * @param {{ doc: Document, t: Texts, rules: { identity: import('../core/guests.js').GuestIdentity, phoneRequired: boolean } }} input
 */
export const guestForm = ({ doc, t, rules }) => {
	/** @type {Record<keyof typeof GUEST_FIELDS, boolean>} */
	const needed = { name: true, phone: rules.identity === 'phone' || rules.phoneRequired, email: rules.identity === 'email' };
	// under either, with no phone needed, one of the two is enough
	const eitherOne = !needed.phone && !needed.email;
	const order = /** @type {Array<keyof typeof GUEST_FIELDS>} */ (
		rules.identity === 'email' ? ['name', 'email', 'phone'] : ['name', 'phone', 'email']
	);
	/** @type {Map<string, HTMLInputElement>} */
	const inputs = new Map();
	const fields = order.map((name) => {
		const [max, type, autocomplete] = GUEST_FIELDS[name];
		const control = /** @type {HTMLInputElement} */ (
			h(doc, 'input', {
				type,
				maxlength: String(max),
				autocomplete,
				...(type === 'tel' ? { inputmode: 'tel' } : {}),
				...(needed[name] ? { required: '', 'aria-required': 'true' } : {}),
			})
		);
		inputs.set(name, control);
		const label = t(`checkout.guest.${name}`);
		return field(
			doc,
			`ss-cart-guest-${name}`,
			needed[name] || eitherOne ? label : t('checkout.optional', { field: label }),
			control,
		);
	});
	const node = h(
		doc,
		'fieldset',
		{ class: 'box' },
		h(doc, 'legend', {}, t('checkout.guest.title')),
		h(doc, 'p', { class: 'hint' }, t('checkout.guest.signIn')),
		eitherOne ? h(doc, 'p', { class: 'hint' }, t('checkout.guest.either')) : null,
		...fields,
	);
	/** @param {string} name */
	const value = (name) => inputs.get(name)?.value.trim() ?? '';
	return {
		node,
		/** The guest as the order takes it (`customer`). */
		values: () => ({ name: value('name'), phone: value('phone'), email: value('email') }),
		/** The first needed detail left empty (`contact`: neither the phone nor the email address under either), or null. */
		missing: () =>
			order.find((name) => needed[name] && value(name) === '') ??
			(eitherOne && !value('phone') && !value('email') ? 'contact' : null),
		/** @param {string} name */
		focus: (name) => inputs.get(name === 'contact' ? 'phone' : name)?.focus(),
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
						quantity: quantityShown(t, line),
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
