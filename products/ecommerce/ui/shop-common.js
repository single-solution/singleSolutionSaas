/**
 * Helpers the shopper widgets share (PLAN 0.8.8 Shopper widgets): widget texts with `{placeholders}` (every word is a
 * text the merchant can edit), the settings with defaults, money and dates (by the website's Format and business time
 * zone from the widget config, and the viewer's language and time zone; PLAN 0.8.10 K7), elements (text is always set
 * as text, never as HTML), rich text rebuilt from a parsed copy with only the allowed tags (E3), problem codes of
 * answers, the sign-in hint, product cards (price ranges, Featured, a 2×2 grid of variant photos; E2, E6, E8), warranty
 * texts (E12), the mount with the shop's CSS and the dispatch of Growth's browser events (`../core/growth-events.js`).
 * @module
 */
import { DEFAULT_FORMAT, element, formatDate, formatMoney, formatText, mountWidget, viewerOf } from '@ss/app-kit/widget';
import { CONTACT_LINK, RICH_DROPPED, RICH_SYNONYMS, RICH_TAGS } from '../core/catalog-content.js';
import { GUEST_IDENTITIES } from '../core/guests.js';
import { COMPARE_MAX_PRODUCTS, RETURN_PHOTO_MAX_MB } from '../core/limits.js';
import { MAX_PAGE_SIZE } from '../core/model.js';
import { fromDecimal, isCurrency, toDecimal } from '@ss/app-kit/widget';
import { SHOP_CSS } from './shop-styles.js';
import { WIDGET_CSS } from './styles.js';

/** @typedef {import('./widget.js').WidgetConfig} WidgetConfig */
/** @typedef {import('./widget.js').Shop} Shop */
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
 * The grades the widget config names (`settings.catalog.grades` while grades_serials is on): a list of `{ key, label }`;
 * anything else is left out.
 * @param {unknown} value
 * @returns {Array<{ key: string, label: string }>}
 */
const gradesOf = (value) =>
	(Array.isArray(value) ? value : []).flatMap((entry) => {
		const key = entry?.key;
		const label = entry?.label ?? key;
		return typeof key === 'string' && key && typeof label === 'string' ? [{ key, label: label || key }] : [];
	});

/**
 * How guests order (`settings.checkout.guests`): the contact they check out by and whether a phone is needed; null
 * while shoppers sign in to order.
 * @param {any} value
 * @returns {{ identity: import('../core/guests.js').GuestIdentity, phoneRequired: boolean } | null}
 */
const guestsOf = (value) =>
	value && GUEST_IDENTITIES.includes(value.identity)
		? { identity: value.identity, phoneRequired: value.phoneRequired === true }
		: null;

/**
 * The settings the shopper widgets read (each part's `widgetSettings`), with defaults while a part is off.
 * @param {WidgetConfig} config
 */
export const settingsOf = (config) => {
	const raw = /** @type {Record<string, any>} */ (config.settings ?? {});
	const checkout = raw.checkout ?? {};
	const catalog = raw.catalog ?? {};
	return {
		currency: isCurrency(raw.currency) ? raw.currency : '',
		catalog: {
			pageSize: Math.min(MAX_PAGE_SIZE, Number(catalog.pageSize) || 24),
			/** what shoppers are told of stock (E9): the page says "Only N left" up to this many, else "N in stock" */
			lowStockShown: Number(catalog.lowStockShown) || 5,
			grades: gradesOf(catalog.grades),
		},
		checkout: {
			/** the payment methods a cart may offer: { key, name, kind } */
			paymentMethods: /** @type {Array<{ key: string, name: string, kind: string }>} */ (
				Array.isArray(checkout.paymentMethods) ? checkout.paymentMethods : []
			),
			pickupLocations: /** @type {Array<{ id: string, name: string }>} */ (
				Array.isArray(checkout.pickupLocations) ? checkout.pickupLocations : []
			),
			cities: /** @type {string[]} */ (Array.isArray(checkout.delivery?.cities) ? checkout.delivery.cities : []),
			/** the merchant's policies, filled, in their order (E27) */
			policies: /** @type {Array<{ key: string, title: string, text: string }>} */ (
				Array.isArray(checkout.policies)
					? checkout.policies.filter(
							(/** @type {any} */ policy) =>
								typeof policy?.key === 'string' && typeof policy.title === 'string' && typeof policy.text === 'string',
						)
					: []
			),
			/** how a shopper orders without signing in (E21): the contact guests check out by; null while guests sign in */
			guests: guestsOf(checkout.guests),
			address: {
				/** the fields the website requires (the place parts a country requires come from its format) */
				required: /** @type {string[]} */ (checkout.address?.required ?? ['name', 'phone', 'line1', 'city']),
				/** the region names offered per country (`address_regions`) */
				regions: /** @type {Array<{ country: string, names: string[] }>} */ (
					Array.isArray(checkout.address?.regions) ? checkout.address.regions : []
				),
				/** the country of an address without one (business.json) */
				country: typeof checkout.address?.country === 'string' ? checkout.address.country : '',
			},
		},
		returns: {
			maxPhotos: Number(raw.returns?.maxPhotos ?? 0),
			photoMaxMb: RETURN_PHOTO_MAX_MB,
		},
		compare: { max: COMPARE_MAX_PRODUCTS },
		/** reviews per product (the product page's form) or per item bought (the order page's, E34), and the page size */
		reviews: {
			per: raw.reviews?.per === 'order_line' ? 'order_line' : 'product',
			pageSize: Number(raw.reviews?.pageSize) || 10,
			/** the merchant's review questions (E40) */
			questions:
				/** @type {Array<{ key: string, label: string, type: 'rating' | 'choice', choices: string[], required: boolean }>} */ (
					Array.isArray(raw.reviews?.questions) ? raw.reviews.questions : []
				),
		},
		/** guests set alerts with a phone; a price-drop alert names a price (EN-1) */
		alerts: {
			guests: raw.alerts?.guests === true,
			targetPrice: raw.alerts?.targetPrice === true,
			/** what a guest gives: the contact guests are known by (checkout.guestIdentity, E15) */
			contact: /** @type {'phone' | 'email' | 'either'} */ (
				['email', 'either'].includes(raw.alerts?.contact) ? raw.alerts.contact : 'phone'
			),
		},
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

/**
 * Money and dates as the widgets show them (PLAN 0.8.10 K7).
 * @typedef {object} Formats
 * @property {(amount: unknown, currency: string) => string} money an amount in minor units
 * @property {(iso: string | null | undefined, options?: { time?: boolean, zone?: string }) => string} dateText a date
 *   (and time, unless `time` is false); `zone` shows it in that time zone whatever the Format says (booking slots,
 *   which are the business's own hours)
 * @property {(iso: string | null | undefined, zone?: string) => string} timeText a time of day
 * @property {string} decimalSign the decimal sign money shows with (`.` or `,` …, by the same language as `money`)
 * @property {(text: unknown, currency: string) => number | null} amountOf an amount typed with that decimal sign (no
 *   thousands separators) as minor units, or null
 * @property {(minor: number, currency: string) => string} amountText minor units as a plain number to type, with that sign
 */

/**
 * The decimal sign of a language (`.` when the runtime does not know it).
 * @param {string} locale
 */
const decimalSignOf = (locale) => {
	try {
		return new Intl.NumberFormat(locale).formatToParts(1.5).find((part) => part.type === 'decimal')?.value ?? '.';
	} catch {
		return '.';
	}
};

/**
 * The formatters of a widget: the website's Format and business time zone (widget config) and the viewer's language
 * and time zone.
 * @param {WidgetConfig} config
 * @param {{ navigator?: { language?: string } } | null | undefined} win
 * @returns {Formats}
 */
export const formatsOf = (config, win) => {
	const format = config.format ?? DEFAULT_FORMAT;
	const timeZone = config.timeZone ?? 'UTC';
	const viewer = viewerOf(win);
	/** @param {string | null | undefined} iso @param {'date' | 'datetime' | 'time'} style @param {string} [zone] */
	const at = (iso, style, zone) =>
		formatDate(iso, zone ? { ...format, times: 'business' } : format, { timeZone: zone ?? timeZone, style, viewer });
	const decimalSign = decimalSignOf(format.locale || viewer.locale || 'en-US');
	return Object.freeze({
		money: (amount, currency) => formatMoney(Math.round(Number(amount) || 0), currency, format, viewer),
		dateText: (iso, { time = true, zone } = {}) => at(iso, time ? 'datetime' : 'date', zone),
		timeText: (iso, zone) => at(iso, 'time', zone),
		decimalSign,
		// with a decimal comma a dot is the thousands separator: refused, never read as the decimal sign
		amountOf: (text, currency) => {
			const value = typeof text === 'string' ? text.trim() : '';
			if (decimalSign === '.') return fromDecimal(value, currency);
			return value.includes('.') ? null : fromDecimal(value.replace(decimalSign, '.'), currency);
		},
		amountText: (minor, currency) => toDecimal(minor, currency).replace('.', decimalSign),
	});
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
 * A labeled field: the label, then the control (ids are made unique per widget by the caller's prefix).
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
 * A line's quantity as shoppers read it: pieces, or the measured amount and its unit (`2.5 m`) when the answer gives
 * the line's `measure { unit, quantityText }`.
 * @param {Texts} t
 * @param {{ quantity: number, measure?: { unit: string, quantityText: string } | null }} line
 */
export const quantityShown = (t, line) =>
	line.measure ? t('shop.amount', { quantity: line.measure.quantityText, unit: line.measure.unit }) : String(line.quantity);

/**
 * A price with the "was" price beside it when it is higher; a range ("from – to") when the highest price is higher
 * (E8); per unit (`/ m`) for an item sold in a unit of its own.
 * @param {Document} doc
 * @param {Texts} t
 * @param {Formats} formats
 * @param {{ price: number, max?: number | null, was?: number | null, currency: string, big?: boolean,
 *   unit?: string | null }} input `unit`: the unit of measure the price is for
 */
export const priceNode = (doc, t, { money }, { price, max = null, was = null, currency, big = false, unit = null }) =>
	h(
		doc,
		'p',
		{ class: big ? 'price big' : 'price' },
		max !== null && max > price
			? t('shop.priceRange', { min: money(price, currency), max: money(max, currency) })
			: money(price, currency),
		unit ? h(doc, 'span', { class: 'per' }, t('shop.perUnit', { unit })) : null,
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
 * A return or warranty time as the merchant typed it (E14: `1 year`, `6 months`, `30 days`), in the website's words;
 * '' for none.
 * @param {Texts} t
 * @param {unknown} time `{ amount, unit }`
 */
export const timeText = (t, time) => {
	const { amount, unit } = /** @type {{ amount?: unknown, unit?: unknown }} */ (time ?? {});
	const n = Number(amount);
	if (!Number.isSafeInteger(n) || n <= 0) return '';
	const key = unit === 'years' ? 'year' : unit === 'months' ? 'month' : 'day';
	return n === 1 ? t(`time.${key}`) : t(`time.${key}s`, { count: n });
};

/**
 * The warranty of an item as shoppers read it (E12, E14): its time as typed; '' without a warranty.
 * @param {Texts} t
 * @param {unknown} time
 */
export const warrantyText = (t, time) => {
	const text = timeText(t, time);
	return text ? t('shop.warranty', { time: text }) : '';
};

// ------------------------------------------------------------------------------------------------ rich text (E3)

/**
 * A link address rich text may keep: an https address (without a user name) or a path on the website (`/…`, never
 * `//…` or `/\…`); '' otherwise.
 * @param {string | null} value
 */
export const safeHref = (value) => {
	const raw = (value ?? '').trim();
	if (/^\/(?![/\\])[^\s\\]*$/.test(raw)) return raw;
	try {
		const url = new URL(raw);
		return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
	} catch {
		return '';
	}
};

/**
 * Rich text (a product's `descriptionHtml`, an HTML policy) as nodes of `doc`: the HTML is parsed in an inert
 * document (nothing loads or runs) and only the allowed elements are built again, with the `href` of links when it is
 * safe; text is copied as text. The string itself is never inserted.
 * @param {Document} doc
 * @param {unknown} html
 * @returns {DocumentFragment}
 */
export const richText = (doc, html) => {
	const out = doc.createDocumentFragment();
	if (typeof html !== 'string' || !html.trim()) return out;
	const template = doc.implementation.createHTMLDocument('').createElement('template');
	template.innerHTML = html;
	/** @param {Node} from @param {Node} to */
	const copy = (from, to) => {
		for (const node of from.childNodes) {
			if (node.nodeType === 3) to.appendChild(doc.createTextNode(node.nodeValue ?? ''));
			if (node.nodeType !== 1) continue;
			const lower = /** @type {Element} */ (node).localName.toLowerCase();
			if (RICH_DROPPED.has(lower)) continue;
			const name = RICH_SYNONYMS[lower] ?? lower;
			if (!RICH_TAGS.has(name)) {
				copy(node, to);
				continue;
			}
			const made = doc.createElement(name);
			if (name === 'a') {
				const raw = String(/** @type {Element} */ (node).getAttribute('href') ?? '').trim();
				const href = CONTACT_LINK.test(raw) ? raw : safeHref(raw);
				if (href) made.setAttribute('href', href);
				if (href.startsWith('https://')) made.setAttribute('rel', 'noopener');
			}
			if (name !== 'br') copy(node, made);
			to.appendChild(made);
		}
	};
	copy(template.content, out);
	return out;
};

/**
 * Plain text as paragraphs (split at blank lines).
 * @param {Document} doc
 * @param {unknown} text
 * @returns {HTMLElement[]}
 */
export const paragraphs = (doc, text) =>
	String(text ?? '')
		.split(/\n\s*\n/)
		.map((part) => part.trim())
		.filter(Boolean)
		.map((part) => h(doc, 'p', {}, part));

// -------------------------------------------------------------------------------------------------------- cards

/**
 * A product card (grid, wishlist): the picture (a 2×2 grid of the variants' first photos when there are several, E6),
 * name linking to the product page, Featured (E2), brand, price or price range (E8), rating, grades, stock.
 * @param {Document} doc
 * @param {Texts} t
 * @param {Formats} formats
 * @param {{ id: string, name: string, url: string, image: string | null, price: number, compareAtPrice?: number | null,
 *   priceMax?: number | null, featured?: boolean, imageSize?: { width: number, height: number } | null,
 *   cardImages?: Array<{ url: string | null, alt: string, width?: number, height?: number }>,
 *   currency: string, inStock: boolean, rating?: { average: number, count: number }, brand?: { name: string } | string | null,
 *   grades?: string[], measure?: { unit: string } | null }} card `measure`: sold in a unit of its own
 * @param {Child[]} [actions]
 */
export const productCard = (doc, t, formats, card, actions = []) => {
	const brand = typeof card.brand === 'string' ? card.brand : (card.brand?.name ?? '');
	const rating = ratingText(t, card.rating);
	const photos = (card.cardImages ?? []).filter((photo) => typeof photo?.url === 'string' && photo.url);
	const image = card.image ?? photos[0]?.url ?? null;
	// each picture's size, so the page does not move while it loads (G14)
	const size = card.image ? card.imageSize : photos[0];
	/**
	 * @param {{ width?: number, height?: number } | null | undefined} of
	 * @returns {Record<string, string>}
	 */
	const sized = (of) =>
		of && Number.isSafeInteger(of.width) && Number.isSafeInteger(of.height)
			? { width: String(of.width), height: String(of.height) }
			: {};
	const picture =
		photos.length > 1
			? h(
					doc,
					'span',
					{ class: 'quad' },
					...photos
						.slice(0, 4)
						.map((photo) =>
							h(doc, 'img', { src: String(photo.url), alt: photo.alt || card.name, loading: 'lazy', ...sized(photo) }),
						),
				)
			: image
				? h(doc, 'img', { src: image, alt: card.name, loading: 'lazy', ...sized(size) })
				: null;
	const tags = [
		card.featured ? h(doc, 'span', { class: 'badge accent' }, t('shop.featured')) : null,
		card.inStock ? null : h(doc, 'span', { class: 'badge danger' }, t('shop.outOfStock')),
	].filter(Boolean);
	return h(
		doc,
		'li',
		{ class: 'card', 'data-product': card.id },
		picture ? h(doc, 'a', { class: 'pic', href: card.url, tabindex: '-1', 'aria-hidden': 'true' }, picture) : null,
		tags.length > 0 ? h(doc, 'span', { class: 'tags' }, ...tags) : null,
		h(doc, 'a', { class: 'name', href: card.url }, card.name),
		brand ? h(doc, 'span', { class: 'meta' }, brand) : null,
		priceNode(doc, t, formats, {
			price: card.price,
			max: card.priceMax ?? null,
			was: card.compareAtPrice ?? null,
			currency: card.currency,
			unit: card.measure?.unit ?? null,
		}),
		rating ? h(doc, 'span', { class: 'meta' }, rating) : null,
		card.grades && card.grades.length > 0 ? h(doc, 'span', { class: 'meta' }, card.grades.join(' · ')) : null,
		actions.some(Boolean) ? h(doc, 'div', { class: 'actions' }, ...actions) : null,
	);
};
