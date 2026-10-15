/**
 * Shop health (PLAN 0.8.10 E41): what needs fixing, as checks with a count and a link — active products without
 * photos, images on short-lived links (no public address of the images, SEO audit G1), archived products still
 * featured, variants out of stock and low on stock (E44's level), the business name, country and logo (business.json;
 * search engines need the country for shipping and return markup and show the logo, G2, G5), the website's address,
 * the delivery days (Google shows shipping only with them, G5.4; while Delivery zones is on), a payment method shoppers
 * can use, and badly formed tag ids in Growth (only while Growth's token is pasted; else the check is skipped). The products' checks are one `$facet` pipeline that
 * starts with a `$match` on the website. Judged on read; nothing is stored. No I/O.
 * @module
 */
import { variantStockCounts, variantStockStages } from './catalog-query.js';

/** The checks, in the order they are answered. */
export const HEALTH_CHECKS = Object.freeze(
	/** @type {const} */ ([
		'products_without_photos',
		'images_short_lived',
		'archived_featured',
		'variants_out_of_stock',
		'variants_low_stock',
		'business_name',
		'business_country',
		'business_logo',
		'website_address',
		'delivery_days',
		'payment_methods',
		'pixel_ids',
	]),
);

/** @typedef {(typeof HEALTH_CHECKS)[number]} HealthKey */
/** @typedef {{ key: HealthKey, status: 'ok' | 'attention' | 'skipped', count: number, link: string | null }} HealthCheck */

/**
 * Growth's tag id forms (its `core/config.js`), by the Growth feature and setting that hold them.
 * @type {ReadonlyArray<{ feature: string, setting: string, form: RegExp }>}
 */
const TAG_FORMS = Object.freeze([
	{ feature: 'meta_pixel', setting: 'pixelId', form: /^\d{6,20}$/ },
	{ feature: 'google_tags', setting: 'ga4Id', form: /^G-[A-Z0-9]{4,20}$/ },
	{ feature: 'google_tags', setting: 'adsId', form: /^AW-\d{5,15}$/ },
	{ feature: 'google_tags', setting: 'gtmId', form: /^GTM-[A-Z0-9]{4,12}$/ },
	{ feature: 'tiktok_pixel', setting: 'pixelId', form: /^[A-Z0-9]{10,30}$/ },
]);

/** Names that are not a public web address (reserved and local top-level names). */
const LOCAL_NAMES = Object.freeze(['localhost', 'local', 'test', 'example', 'invalid', 'internal', 'lan', 'home']);

/**
 * The products' checks as one pipeline: active products without photos, archived products still featured, and the
 * variants by stock (E44).
 * @param {string} websiteId
 * @param {number} level the `catalog` setting `lowStock`
 */
export const healthPipeline = (websiteId, level) => [
	{ $match: { websiteId } },
	{
		$facet: {
			noPhotos: [{ $match: { status: 'active', 'media.0': { $exists: false } } }, { $count: 'n' }],
			archivedFeatured: [{ $match: { status: 'archived', featured: true } }, { $count: 'n' }],
			variants: variantStockStages(level),
		},
	},
];

/**
 * Whether a website's address is a public web address: a name with a dot, not an IP address, not a local or reserved
 * name (`localhost`, `.local`, `.test` …).
 * @param {string} domain
 */
export const isPublicAddress = (domain) => {
	const name = String(domain ?? '')
		.toLowerCase()
		.replace(/:\d+$/, '');
	if (!name.includes('.') || /^[\d.]+$/.test(name) || name.includes(':') || name.startsWith('[')) return false;
	return !LOCAL_NAMES.includes(name.split('.').at(-1) ?? '');
};

/**
 * The tag ids of Growth's settings answer (`GET /v1/settings`) that are set on a switched-on feature but not in the form
 * that feature takes, as `<feature>.<setting>`.
 * @param {unknown} answer
 * @returns {string[]}
 */
export const badTagIds = (answer) => {
	const list = /** @type {{ features?: unknown } | null} */ (answer)?.features;
	/** @type {any[]} */
	const features = Array.isArray(list) ? list : [];
	const on = new Map(
		features
			.filter((feature) => feature && feature.on === true && typeof feature.key === 'string')
			.map((feature) => [String(feature.key), feature.values ?? {}]),
	);
	return TAG_FORMS.flatMap(({ feature, setting, form }) => {
		const value = on.get(feature)?.[setting];
		const id = typeof value === 'string' ? value.trim() : '';
		return id !== '' && !form.test(id) ? [`${feature}.${setting}`] : [];
	});
};

/**
 * The payment methods shoppers can use now (E22–E24): cash on delivery while its feature is on and not switched off;
 * online payment and bank transfer when offered and Payments is connected (bank transfer also when staff record
 * transfers by hand); pay at pickup when offered and a pickup location exists.
 * @param {{ cod: boolean, offered: ReadonlyArray<string>, paymentsConnected: boolean, bankManual: boolean, pickup: boolean }} input
 * @returns {string[]}
 */
export const paymentMethodsOn = ({ cod, offered, paymentsConnected, bankManual, pickup }) => [
	...(cod ? ['cod'] : []),
	...(paymentsConnected && offered.includes('online') ? ['online'] : []),
	...((paymentsConnected || bankManual) && offered.includes('bank_transfer') ? ['bank_transfer'] : []),
	...(pickup && offered.includes('pickup') ? ['pickup'] : []),
];

/**
 * The checks from what was read.
 * @param {object} input
 * @param {any} input.facets the single document {@link healthPipeline} answers
 * @param {{ name: string, country: string | null, logo: string | null }} input.business business.json with its defaults
 *   (name = the domain when missing)
 * @param {string} input.domain the website's address
 * @param {string[]} input.paymentMethods {@link paymentMethodsOn}
 * @param {string[] | null} input.badTags {@link badTagIds}, or null when Growth's token is not pasted or Growth did not
 *   answer (the check is skipped)
 * @param {boolean | null} input.shortLived whether images go out on short-lived signed links (storage connected, no
 *   public address of the images); null without storage (the check is skipped)
 * @param {boolean | null} input.deliveryDays whether both delivery day settings are set; null while Delivery zones is off
 *   (the check is skipped)
 * @returns {{ checks: HealthCheck[], attention: number }}
 */
export const healthOf = ({ facets, business, domain, paymentMethods, badTags, shortLived, deliveryDays }) => {
	/** @param {string} name */
	const counted = (name) => Number(facets?.[name]?.[0]?.n ?? 0);
	const variants = variantStockCounts(Array.isArray(facets?.variants) ? facets.variants : []);
	const name = String(business.name ?? '').trim();
	const file = `https://${domain}/.well-known/business.json`;
	/** @type {Record<HealthKey, { count: number | null, link: string | null }>} */
	const found = {
		products_without_photos: { count: counted('noPhotos'), link: '/v1/products?status=active&hasMedia=0' },
		images_short_lived: { count: shortLived === null ? null : shortLived ? 1 : 0, link: null },
		archived_featured: { count: counted('archivedFeatured'), link: '/v1/products?status=archived&featured=1' },
		variants_out_of_stock: { count: variants.out, link: '/v1/products?stockState=out,partial' },
		variants_low_stock: { count: variants.low, link: '/v1/products?lowStock=1' },
		business_name: { count: name === '' || name.toLowerCase() === domain.toLowerCase() ? 1 : 0, link: file },
		business_country: { count: business.country ? 0 : 1, link: file },
		business_logo: { count: business.logo ? 0 : 1, link: file },
		website_address: { count: isPublicAddress(domain) ? 0 : 1, link: null },
		delivery_days: { count: deliveryDays === null ? null : deliveryDays ? 0 : 1, link: null },
		payment_methods: { count: paymentMethods.length === 0 ? 1 : 0, link: null },
		pixel_ids: { count: badTags === null ? null : badTags.length, link: null },
	};
	const checks = HEALTH_CHECKS.map((key) => {
		const { count, link } = found[key];
		return /** @type {HealthCheck} */ ({
			key,
			status: count === null ? 'skipped' : count > 0 ? 'attention' : 'ok',
			count: count ?? 0,
			link,
		});
	});
	return { checks, attention: checks.filter((check) => check.status === 'attention').length };
};
