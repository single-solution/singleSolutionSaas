/**
 * Helpers the shopper widgets share (PLAN 0.8.8 Shopper widgets): widget texts with `{placeholders}` (every word is a
 * text the merchant can edit), the settings with defaults, money, dates, elements (text is always set as text, never
 * as HTML), problem codes of answers, the sign-in hint, product cards, the mount with the shop's CSS and the
 * dispatch of Growth's browser events (`../core/growth-events.js`).
 * @module
 */
import { formatText, mountWidget } from '@ss/app-kit/widget';
import { formatMoney, isCurrency } from '../core/money.js';
import { element } from './dom.js';
import { SHOP_CSS } from './shop-styles.js';
import { WIDGET_CSS } from './styles.js';

/** @typedef {import('./widget.js').WidgetConfig} WidgetConfig */
/** @typedef {import('./widget.js').Shop} Shop */
/** @typedef {import('./widget.js').Answer} Answer */
/** @typedef {(key: string, values?: Record<string, string | number>) => string} Texts */
/** @typedef {string | Node | null | undefined | false} Child */

/**
 * The texts of a config: the website's own, else the key itself (a missing text shows its key, never nothing).
 * @param {WidgetConfig} config
 * @returns {Texts}
 */
export const textsOf =
	(config) =>
	(key, values = {}) =>
		formatText(config.texts[key] ?? key, values);

/**
 * The settings the shopper widgets read (each part's `widgetSettings`), with defaults while a part is off.
 * @param {WidgetConfig} config
 */
export const settingsOf = (config) => {
	const raw = /** @type {Record<string, any>} */ (config.settings ?? {});
	const checkout = raw.checkout ?? {};
	return {
		currency: isCurrency(raw.currency) ? raw.currency : '',
		catalog: { pageSize: Number(raw.catalog?.pageSize) || 24 },
		checkout: {
			paymentMethods: /** @type {string[]} */ (Array.isArray(checkout.paymentMethods) ? checkout.paymentMethods : []),
			pickupLocations: /** @type {Array<{ id: string, name: string }>} */ (
				Array.isArray(checkout.pickupLocations) ? checkout.pickupLocations : []
			),
			cities: /** @type {string[]} */ (Array.isArray(checkout.delivery?.cities) ? checkout.delivery.cities : []),
			policies: /** @type {Record<string, string>} */ (checkout.policies ?? {}),
			coupons: checkout.coupons === true,
			loyalty: checkout.loyalty === true,
			address: {
				required: /** @type {string[]} */ (checkout.address?.required ?? ['name', 'phone', 'line1', 'city']),
				optional: /** @type {string[]} */ (checkout.address?.optional ?? ['line2', 'area', 'postalCode', 'country', 'notes']),
			},
		},
		returns: {
			maxPhotos: Number(raw.returns?.maxPhotos ?? 0),
			photoMaxMb: Number(raw.returns?.photoMaxMb ?? 5),
		},
		compare: { max: Number(raw.compare?.max) || 4 },
	};
};

/** @typedef {ReturnType<typeof settingsOf>} ShopSettings */

/**
 * The first currency code among the candidates, else the shop's.
 * @param {ShopSettings} settings
 * @param {...unknown} candidates
 */
export const currencyOf = (settings, ...candidates) => {
	const found = candidates.find((value) => isCurrency(value));
	return typeof found === 'string' ? found : settings.currency;
};

/**
 * Dispatch a Growth browser event on the page's window (PLAN 0.8.9), not cancelable.
 * @param {Window & typeof globalThis} win
 * @param {string} name one of `GROWTH_EVENTS`
 * @param {object} detail
 */
export const announce = (win, name, detail) => void win.dispatchEvent(new win.CustomEvent(name, { detail }));

/** @param {number} amount @param {string} currency */
export const money = (amount, currency) => formatMoney(Math.round(Number(amount) || 0), currency);

/**
 * A date and time in the shopper's own language and time zone (or the one given).
 * @param {string | null | undefined} iso
 * @param {{ timeZone?: string, time?: boolean }} [options]
 */
export const dateText = (iso, { timeZone, time = true } = {}) => {
	const at = iso ? new Date(iso) : null;
	if (!at || Number.isNaN(at.getTime())) return '';
	try {
		return new Intl.DateTimeFormat(undefined, {
			dateStyle: 'medium',
			...(time ? { timeStyle: 'short' } : {}),
			...(timeZone ? { timeZone } : {}),
		}).format(at);
	} catch {
		return at.toISOString();
	}
};

/**
 * An element with attributes and children (strings become text nodes).
 * @param {Document} doc
 * @param {string} tag
 * @param {Record<string, string>} [attributes]
 * @param {...Child} children
 * @returns {HTMLElement}
 */
export const h = (doc, tag, attributes = {}, ...children) => {
	const node = element(doc, tag, attributes);
	for (const child of children) if (child !== null && child !== undefined && child !== false && child !== '') node.append(child);
	return node;
};

/**
 * Replace a node's children (empty values are left out).
 * @param {Element} node
 * @param {...Child} children
 */
export const fill = (node, ...children) => {
	node.replaceChildren(
		.../** @type {Array<string | Node>} */ (
			children.filter((child) => child !== null && child !== undefined && child !== false && child !== '')
		),
	);
};

/**
 * A button (type button) that runs `onClick`.
 * @param {Document} doc
 * @param {string} text
 * @param {(event: Event) => void} onClick
 * @param {Record<string, string>} [attributes]
 * @returns {HTMLButtonElement}
 */
export const button = (doc, text, onClick, attributes = {}) => {
	const node = /** @type {HTMLButtonElement} */ (element(doc, 'button', { type: 'button', ...attributes }, text));
	node.addEventListener('click', onClick);
	return node;
};

/**
 * A labelled field: the label, then the control (ids are made unique per widget by the caller's prefix).
 * @param {Document} doc
 * @param {string} id
 * @param {string} label
 * @param {HTMLElement} control
 */
export const field = (doc, id, label, control) => {
	control.setAttribute('id', id);
	return h(doc, 'div', { class: 'field' }, h(doc, 'label', { for: id }, label), control);
};

/**
 * A `<select>` with options `[value, text]`.
 * @param {Document} doc
 * @param {Array<[string, string]>} options
 * @param {string} value
 * @param {Record<string, string>} [attributes]
 * @returns {HTMLSelectElement}
 */
export const select = (doc, options, value, attributes = {}) => {
	const node = /** @type {HTMLSelectElement} */ (element(doc, 'select', attributes));
	for (const [key, text] of options) node.append(element(doc, 'option', { value: key }, text));
	node.value = value;
	return node;
};

/**
 * The problem code of a refused answer (`type` ends with it), `offline` when unreachable, else ''.
 * @param {Answer} answer
 */
export const codeOf = (answer) => {
	if (answer.status === 0) return 'offline';
	const type = answer.data?.type;
	return typeof type === 'string' ? (type.split('/').pop() ?? '') : '';
};

/**
 * The text for a problem code: `<prefix><code>` when the website has such a text, else the fallback text.
 * @param {WidgetConfig} config
 * @param {string} prefix
 * @param {string} code
 * @param {string} fallback key
 */
export const problemText = (config, prefix, code, fallback) => {
	const t = textsOf(config);
	return code && Object.hasOwn(config.texts, `${prefix}${code}`) ? t(`${prefix}${code}`) : t(fallback);
};

/**
 * Mount a shopper widget into its host: Shadow DOM, the theme, the widget CSS and the merchant's custom CSS.
 * @param {{ host: HTMLElement, config: WidgetConfig, name: string, render: (root: HTMLElement) => void | (() => void) }} input
 */
export const mountShop = ({ host, config, name, render }) => {
	host.setAttribute('data-ss-mounted', name);
	return mountWidget({ host, theme: config.theme, customCss: config.customCss, css: WIDGET_CSS + SHOP_CSS, render });
};

/**
 * Keep the keyboard focus across a re-render: the focused control's `data-focus` is focused again afterwards.
 * @param {HTMLElement} root
 * @param {() => void} renderFn
 */
export const keepFocus = (root, renderFn) => {
	const shadow = /** @type {ShadowRoot | null} */ (root.getRootNode());
	const active = /** @type {HTMLElement | null} */ (shadow?.activeElement ?? null);
	const key = active?.dataset?.focus;
	renderFn();
	if (key && /^[\w.:|-]+$/.test(key)) /** @type {HTMLElement | null} */ (root.querySelector(`[data-focus="${key}"]`))?.focus();
};

/**
 * A price with the "was" price beside it when it is higher.
 * @param {Document} doc
 * @param {Texts} t
 * @param {{ price: number, was?: number | null, currency: string, big?: boolean }} input
 */
export const priceNode = (doc, t, { price, was = null, currency, big = false }) =>
	h(
		doc,
		'p',
		{ class: big ? 'price big' : 'price' },
		money(price, currency),
		was !== null && was > price
			? h(doc, 'span', { class: 'was' }, h(doc, 'span', { class: 'sr-only' }, t('shop.wasLabel')), money(was, currency))
			: null,
	);

/**
 * The rating text of a product, or '' without ratings.
 * @param {Texts} t
 * @param {{ average: number, count: number } | null | undefined} rating
 */
export const ratingText = (t, rating) =>
	rating && rating.count > 0 ? t('shop.rating', { average: Number(rating.average).toFixed(1), count: rating.count }) : '';

/**
 * A product card (grid, wishlist): image, name linking to the product page, brand, price, rating, grades, stock.
 * @param {Document} doc
 * @param {Texts} t
 * @param {{ id: string, name: string, url: string, image: string | null, price: number, compareAtPrice?: number | null,
 *   currency: string, inStock: boolean, rating?: { average: number, count: number }, brand?: { name: string } | string | null,
 *   grades?: string[] }} card
 * @param {Child[]} [actions]
 */
export const productCard = (doc, t, card, actions = []) => {
	const brand = typeof card.brand === 'string' ? card.brand : (card.brand?.name ?? '');
	const rating = ratingText(t, card.rating);
	return h(
		doc,
		'li',
		{ class: 'card', 'data-product': card.id },
		card.image ? h(doc, 'img', { src: card.image, alt: card.name, loading: 'lazy' }) : null,
		h(doc, 'a', { class: 'name', href: card.url }, card.name),
		brand ? h(doc, 'span', { class: 'meta' }, brand) : null,
		priceNode(doc, t, { price: card.price, was: card.compareAtPrice ?? null, currency: card.currency }),
		rating ? h(doc, 'span', { class: 'meta' }, rating) : null,
		card.grades && card.grades.length > 0 ? h(doc, 'span', { class: 'meta' }, card.grades.join(' · ')) : null,
		card.inStock ? null : h(doc, 'span', { class: 'badge danger' }, t('shop.outOfStock')),
		actions.some(Boolean) ? h(doc, 'div', { class: 'actions' }, ...actions) : null,
	);
};
