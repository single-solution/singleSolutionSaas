/**
 * What a shop still has to set, shown as the setup checklist of the Overview (owner 2026-10-17): the settings and
 * lists the switched-on features need, each with one plain line on why and a button to the exact section of Settings.
 * The connections the features need (database, storage, tokens) come from the manifest's `neededBy`, so none is listed
 * here, and no store value is written into the code: a step is ticked from what the merchant saved.
 *
 * `when`: the features that make a step apply; `section`: the inner-sidebar section its button opens (a setting opens
 * the section of its own group). The currency and the image address are ticked the same way (their warnings stay in
 * `tabs.js`); Payments, Notifications and the Atlas Search index have steps of their own there.
 * @module
 */
import { fill } from '@ss/ui/dashboard';
import { TEXTS } from './texts.js';

/** @typedef {import('@ss/ui/dashboard').SetupRequirement} SetupRequirement */

const O = TEXTS.overview;

/** @param {unknown} value */
const list = (value) => (Array.isArray(value) ? value : []);

/** @type {ReadonlyArray<SetupRequirement>} */
export const SETUP = Object.freeze([
	{
		key: 'store-details',
		when: ['store_details'],
		list: 'store_details',
		done: (/** @type {{ name?: string } | null} */ value) => String(value?.name ?? '').trim() !== '',
		label: 'Add your store details',
		why: 'Your store name, contact details and opening hours show on your site, in order emails and in search results.',
		action: 'Add details',
		section: 'store_details',
	},
	{
		key: 'currency',
		when: ['catalog'],
		setting: 'catalog.currency',
		// ticked only when the merchant sets it themselves (USD stays the default until then)
		own: true,
		label: O.currency.step,
		why: 'Every price is in this currency. Set it before you add prices.',
		action: 'Set currency',
		detail: (/** @type {unknown} */ value) => fill(O.currency.now, { currency: String(value ?? '') }),
	},
	{
		key: 'product-url',
		when: ['catalog'],
		setting: 'catalog.productUrl',
		confirm: true,
		label: 'Set the product page address',
		why: 'Where your product pages live on your website, for example /shop/{slug}. Links and search results point there.',
		action: 'Set address',
		detail: (/** @type {unknown} */ value) => String(value ?? ''),
	},
	{
		key: 'category-url',
		when: ['catalog'],
		setting: 'catalog.categoryUrl',
		confirm: true,
		label: 'Set the category page address',
		why: 'Where your category pages live on your website, for example /categories/{slug}.',
		action: 'Set address',
		detail: (/** @type {unknown} */ value) => String(value ?? ''),
	},
	{
		key: 'attribute-url',
		when: ['landing_pages'],
		setting: 'landing_pages.attributeUrl',
		optional: true,
		label: 'Set the attribute page address',
		why: 'Where the page of one attribute, such as a color or a size, lives on your website. Empty: no attribute pages.',
		action: 'Set address',
		detail: (/** @type {unknown} */ value) => String(value ?? ''),
	},
	{
		key: 'media',
		when: ['catalog'],
		after: 'storage',
		setting: 'catalog.mediaBaseUrl',
		label: O.media.step,
		why: 'Where your storage serves your images from, for example a CDN address. Images then load fast and keep their address.',
		action: 'Set address',
		detail: (/** @type {unknown} */ value) => String(value ?? ''),
	},
	{
		key: 'payment-method',
		when: ['checkout'],
		list: 'payment_methods',
		done: (/** @type {unknown} */ value) => list(value).some((/** @type {{ active?: boolean }} */ method) => method.active),
		label: 'Offer a way to pay',
		why: 'Shoppers cannot place an order until at least one payment method is on.',
		action: 'Open payment methods',
		section: 'checkout.payment-methods',
	},
	{
		key: 'delivery-zone',
		when: ['delivery_zones'],
		list: 'delivery_zones',
		done: (/** @type {unknown} */ value) =>
			list(value).some((/** @type {{ rates?: unknown[] }} */ zone) => list(zone.rates).length > 0),
		label: 'Add a delivery zone with a rate',
		why: 'A zone says where you deliver and a rate what it costs. Shoppers outside every zone cannot order delivery.',
		action: 'Open delivery zones',
		section: 'delivery_zones',
	},
	{
		key: 'order-steps',
		when: ['checkout'],
		list: 'order_flow',
		done: (/** @type {{ statuses?: unknown[] } | null} */ value) => list(value?.statuses).length > 0,
		label: 'Check your order steps',
		why: 'The steps an order goes through, from placed to delivered, and who can move it from one to the next.',
		action: 'Open order steps',
		section: 'checkout.order-flow',
		detail: (/** @type {{ statuses?: unknown[] } | null} */ value) => `${list(value?.statuses).length} steps`,
	},
	{
		key: 'tax-rules',
		when: ['taxes'],
		list: 'tax_rules',
		label: 'Add a tax rule',
		why: 'Taxes is on, but nothing is added to prices until a rule says where and how much.',
		action: 'Open tax rules',
		section: 'taxes',
	},
	{
		key: 'guests',
		when: ['checkout'],
		setting: 'checkout.guests',
		confirm: true,
		optional: true,
		label: 'Decide on guest checkout',
		why: 'Off: shoppers sign in to order. On: anyone can order with a name and a phone number or email.',
		action: 'Choose',
	},
]);
