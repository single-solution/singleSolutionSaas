/**
 * Shop health (PLAN 0.8.10 E41, parity P5-18, SEO audit §3.2 A): what needs fixing, as checks with a count and a link.
 * The catalog: no active product at all, active products without photos or without a variant that can be bought,
 * variants priced 0 (left out of structured data and feeds), photos without their text or under 500 × 500 pixels (the
 * catalogs' minimum), images on short-lived links (no public address of the images, G1), descriptions under 20 words,
 * names, SEO titles and SEO descriptions used twice, SEO titles over 60 characters, canonical addresses on another
 * site, products the feeds send of a brand without a GTIN, or with neither a brand nor a GTIN or MPN (G5, G11), categories shoppers see without a product, glossary pages without their own text (G7), archived
 * products still featured, variants out of stock and low on stock (E44's level). The setup: the business name,
 * country, logo and phone (the website settings in the Portal; search engines need the country for shipping and return markup and show the
 * logo, G2, G5), the website's address, the storage for photos, the delivery days (Google shows shipping only with
 * them, G5.4), a payment method shoppers can use, the bank details shoppers pay to, someone to get staff alerts and the
 * admin page they link to, and badly formed tag ids in Growth (only while Growth's token is pasted). A check that does
 * not apply (its feature off, nothing to read) is skipped. The products' checks are one `$facet` pipeline that starts
 * with a `$match` on the website; categories and brands are judged from their lists. Judged on read; nothing is stored.
 * No I/O.
 * @module
 */
import { variantStockCounts, variantStockStages } from './catalog-query.js';
import { escapeRegex } from './search.js';

/** The checks, in the order they are answered. */
export const HEALTH_CHECKS = Object.freeze(
	/** @type {const} */ ([
		'no_products',
		'products_without_photos',
		'products_not_buyable',
		'variants_priced_zero',
		'images_without_alt',
		'images_too_small',
		'images_short_lived',
		'short_descriptions',
		'duplicate_names',
		'duplicate_titles',
		'duplicate_descriptions',
		'long_titles',
		'canonical_elsewhere',
		'branded_without_gtin',
		'missing_identifiers',
		'empty_categories',
		'glossary_without_text',
		'archived_featured',
		'variants_out_of_stock',
		'variants_low_stock',
		'business_name',
		'business_country',
		'business_logo',
		'business_phone',
		'website_address',
		'storage',
		'delivery_days',
		'payment_methods',
		'pay_details',
		'staff_alerts',
		'admin_url',
		'pixel_ids',
	]),
);

/** @typedef {(typeof HEALTH_CHECKS)[number]} HealthKey */
/** @typedef {{ key: HealthKey, status: 'ok' | 'attention' | 'skipped', count: number, link: string | null }} HealthCheck */

/** The least size of a photo shopping catalogs take (Merchant Center, from 2027). */
const PHOTO_MIN = 500;
/** A description shorter than this many words is too short to describe a product. */
const SHORT_WORDS = 20;
/** The longest SEO title search engines show whole. */
const TITLE_MAX = 60;

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

/** A text field that holds something. */
const FILLED = Object.freeze({ $nin: ['', null] });

/**
 * The stages that count the records sharing a value with another (case-insensitive), after a `$match`.
 * @param {string} field
 */
const sharedStages = (field) => [
	{ $group: { _id: { $toLower: `$${field}` }, n: { $sum: 1 } } },
	{ $match: { n: { $gt: 1 } } },
	{ $group: { _id: null, n: { $sum: '$n' } } },
];

/**
 * The products' checks as one pipeline: the active products and those without photos, without a variant that can be
 * bought, with a variant priced 0, photos without their text or too small, short descriptions, names and own SEO
 * titles and descriptions used twice, long SEO titles, canonical addresses on another site, products without the
 * identifiers the feeds need, the categories that have active products shoppers see (not of a hidden brand), archived
 * products still featured, and the variants by stock (E44).
 * @param {string} websiteId
 * @param {number} level the `catalog` setting `lowStock`
 * @param {{ domain: string, skuAs: 'none' | 'gtin' | 'mpn', hiddenBrandIds: string[],
 *   measured?: import('./catalog-query.js').MeasuredScope | null }} site the website's address; what the feeds send the
 *   SKU as for variants without their own GTIN or MPN; the brands shoppers do not see; the products sold by length,
 *   weight or volume (their low stock counts units)
 */
export const healthPipeline = (websiteId, level, { domain, skuAs, hiddenBrandIds, measured = null }) => {
	const active = { $match: { status: 'active' } };
	// the products the feeds send: active, with an offered variant priced above 0
	const listed = { status: 'active', variants: { $elemMatch: { active: true, price: { $gt: 0 } } } };
	const gtin = [{ gtin: FILLED }, ...(skuAs === 'gtin' ? [{ sku: FILLED }] : [])];
	const identifier = [...gtin, { mpn: FILLED }, ...(skuAs === 'mpn' ? [{ sku: FILLED }] : [])];
	return [
		{ $match: { websiteId } },
		{
			$facet: {
				active: [active, { $count: 'n' }],
				noPhotos: [{ $match: { status: 'active', 'media.0': { $exists: false } } }, { $count: 'n' }],
				notBuyable: [
					{ $match: { status: 'active', variants: { $not: { $elemMatch: { active: true, price: { $gt: 0 } } } } } },
					{ $count: 'n' },
				],
				pricedZero: [
					active,
					{ $unwind: '$variants' },
					{ $match: { 'variants.active': true, 'variants.price': { $lte: 0 } } },
					{ $count: 'n' },
				],
				noAlt: [{ $match: { status: 'active', media: { $elemMatch: { alt: { $in: ['', null] } } } } }, { $count: 'n' }],
				smallPhotos: [
					{
						$match: {
							status: 'active',
							media: { $elemMatch: { $or: [{ width: { $lt: PHOTO_MIN } }, { height: { $lt: PHOTO_MIN } }] } },
						},
					},
					{ $count: 'n' },
				],
				shortText: [
					active,
					{
						$match: {
							$expr: {
								$lt: [
									{ $size: { $regexFindAll: { input: { $ifNull: ['$description', ''] }, regex: '\\S+' } } },
									SHORT_WORDS,
								],
							},
						},
					},
					{ $count: 'n' },
				],
				sameNames: [active, ...sharedStages('name')],
				sameTitles: [{ $match: { status: 'active', 'seo.title': FILLED } }, ...sharedStages('seo.title')],
				sameDescriptions: [{ $match: { status: 'active', 'seo.description': FILLED } }, ...sharedStages('seo.description')],
				longTitles: [
					{ $match: { status: 'active', $expr: { $gt: [{ $strLenCP: { $ifNull: ['$seo.title', ''] } }, TITLE_MAX] } } },
					{ $count: 'n' },
				],
				canonicalElsewhere: [
					{
						$match: {
							status: 'active',
							'seo.canonicalUrl': {
								$regex: /^https?:\/\//i,
								$not: new RegExp(`^https://${escapeRegex(domain)}(/|$)`, 'i'),
							},
						},
					},
					{ $count: 'n' },
				],
				brandedNoGtin: [
					{ $match: { ...listed, brandId: { $type: 'string' } } },
					{ $match: { variants: { $not: { $elemMatch: { active: true, $or: gtin } } } } },
					{ $count: 'n' },
				],
				noIdentifiers: [
					{ $match: { ...listed, brandId: { $not: { $type: 'string' } } } },
					{ $match: { variants: { $not: { $elemMatch: { active: true, $or: identifier } } } } },
					{ $count: 'n' },
				],
				categories: [
					{ $match: { status: 'active', brandId: { $nin: hiddenBrandIds } } },
					{ $unwind: '$categoryIds' },
					{ $group: { _id: '$categoryIds' } },
				],
				archivedFeatured: [{ $match: { status: 'archived', featured: true } }, { $count: 'n' }],
				variants: variantStockStages(level, measured),
			},
		},
	];
};

/**
 * Whether an address is on another site than the website (an absolute address of another host).
 * @param {string} address
 * @param {string} domain
 */
const elsewhere = (address, domain) =>
	/^https?:\/\//i.test(address) && !new RegExp(`^https://${escapeRegex(domain)}(/|$)`, 'i').test(address);

/**
 * The SEO checks of categories and brands, and the categories shoppers see without a product (in them or below them;
 * G7): own SEO titles and descriptions used twice, SEO titles over 60 characters, canonical addresses on another site.
 * @param {object} input
 * @param {ReadonlyArray<{ id: string, path: string[], seo: { title: string, description: string, canonicalUrl: string } }>} input.categories
 *   the categories shoppers see
 * @param {ReadonlyArray<{ seo: { title: string, description: string, canonicalUrl: string } }>} input.brands
 * @param {ReadonlyArray<string>} input.stocked the categories that have active products
 * @param {string} input.domain
 */
export const taxonomyHealth = ({ categories, brands, stocked, domain }) => {
	const records = [...categories, ...brands];
	/** @param {'title' | 'description'} field */
	const shared = (field) => {
		/** @type {Map<string, number>} */
		const counts = new Map();
		for (const record of records) {
			const value = String(record.seo?.[field] ?? '').toLowerCase();
			if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
		}
		return [...counts.values()].filter((n) => n > 1).reduce((sum, n) => sum + n, 0);
	};
	const filled = new Set(stocked);
	return {
		sameTitles: shared('title'),
		sameDescriptions: shared('description'),
		longTitles: records.filter((record) => String(record.seo?.title ?? '').length > TITLE_MAX).length,
		canonicalElsewhere: records.filter((record) => elsewhere(String(record.seo?.canonicalUrl ?? ''), domain)).length,
		emptyCategories: categories.filter(
			(category) =>
				!filled.has(category.id) && !categories.some((other) => other.path.includes(category.id) && filled.has(other.id)),
		).length,
	};
};

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
 * The payment methods shoppers can use now (E2): the active ones of the list, those paid through Payments (online, or
 * first through Payments) while Payments is connected, and those paid at pickup while a pickup point exists.
 * @param {{ methods: ReadonlyArray<import('./payment-methods.js').PaymentMethodRecord>, paymentsConnected: boolean,
 *   pickup: boolean }} input
 * @returns {string[]} their keys
 */
export const paymentMethodsOn = ({ methods, paymentsConnected, pickup }) =>
	methods
		.filter(
			(method) =>
				method.active &&
				(method.kind === 'gateway' || (method.kind === 'pay_first' && method.via === 'payments')
					? paymentsConnected
					: true) &&
				(method.kind === 'at_pickup' ? pickup : true),
		)
		.map((method) => method.key);

/**
 * What the setup checks read; null where a check does not apply (it is skipped).
 * @typedef {object} SetupFacts
 * @property {boolean} storage the Storage connection is set (photos are uploaded to it)
 * @property {number | null} payUnready the active methods paid first (or with an advance paid by hand) that do not tell
 *   shoppers where to pay: no account with a value and no instructions (by hand), or Payments' method of their key not
 *   ready; null while there is none, or Payments did not answer
 * @property {boolean | null} staffAlerted someone gets staff alerts (recipients or Accounts staff, through
 *   Notifications); null while Staff alerts is off
 * @property {boolean | null} adminUrl the admin page staff alerts link to is set; null while Staff alerts is off
 * @property {boolean | null} feeds whether the feeds check identifiers: null while Feeds is off; `missingIdentifiers`
 *   only while the feeds setting identifierExists is auto
 * @property {boolean} [missingIdentifiers]
 * @property {number | null} glossaryWithoutText active fields without their glossary text, while their pages have an
 *   address; null otherwise
 */

/**
 * The checks from what was read.
 * @param {object} input
 * @param {any} input.facets the single document {@link healthPipeline} answers
 * @param {ReturnType<typeof taxonomyHealth>} input.taxonomy
 * @param {{ name: string, country: string | null, logo: string | null, phone: string | null }} input.business
 *   the business facts of the Portal's website settings, with their defaults (name = the domain when missing)
 * @param {string} input.domain the website's address
 * @param {string | null} [input.businessLink] where the merchant sets the business facts (the Portal's Website settings ›
 *   Business), the link of the business checks; null: none
 * @param {string[]} input.paymentMethods {@link paymentMethodsOn}
 * @param {string[] | null} input.badTags {@link badTagIds}, or null when Growth's token is not pasted or Growth did not
 *   answer (the check is skipped)
 * @param {boolean | null} input.shortLived whether images go out on short-lived signed links (storage connected, no
 *   public address of the images); null without storage (the check is skipped)
 * @param {boolean | null} input.deliveryDays whether both delivery day settings are set; null while Delivery zones is off
 *   (the check is skipped)
 * @param {SetupFacts} input.setup
 * @returns {{ checks: HealthCheck[], attention: number }}
 */
export const healthOf = ({
	facets,
	taxonomy,
	business,
	domain,
	businessLink = null,
	paymentMethods,
	badTags,
	shortLived,
	deliveryDays,
	setup,
}) => {
	/** @param {string} name */
	const counted = (name) => Number(facets?.[name]?.[0]?.n ?? 0);
	/** @param {boolean | null | undefined} fine */
	const flag = (fine) => (fine === null || fine === undefined ? null : fine ? 0 : 1);
	const variants = variantStockCounts(Array.isArray(facets?.variants) ? facets.variants : []);
	const name = String(business.name ?? '').trim();
	const file = businessLink;
	/** @type {Record<HealthKey, { count: number | null, link: string | null }>} */
	const found = {
		no_products: { count: counted('active') === 0 ? 1 : 0, link: null },
		products_without_photos: { count: counted('noPhotos'), link: '/v1/products?status=active&hasMedia=0' },
		products_not_buyable: { count: counted('notBuyable'), link: null },
		variants_priced_zero: { count: counted('pricedZero'), link: null },
		images_without_alt: { count: counted('noAlt'), link: null },
		images_too_small: { count: counted('smallPhotos'), link: null },
		images_short_lived: { count: shortLived === null ? null : shortLived ? 1 : 0, link: null },
		short_descriptions: { count: counted('shortText'), link: null },
		duplicate_names: { count: counted('sameNames'), link: null },
		duplicate_titles: { count: counted('sameTitles') + taxonomy.sameTitles, link: null },
		duplicate_descriptions: { count: counted('sameDescriptions') + taxonomy.sameDescriptions, link: null },
		long_titles: { count: counted('longTitles') + taxonomy.longTitles, link: null },
		canonical_elsewhere: { count: counted('canonicalElsewhere') + taxonomy.canonicalElsewhere, link: null },
		branded_without_gtin: { count: setup.feeds === null ? null : counted('brandedNoGtin'), link: null },
		missing_identifiers: {
			count: setup.feeds === null || !setup.missingIdentifiers ? null : counted('noIdentifiers'),
			link: null,
		},
		empty_categories: { count: taxonomy.emptyCategories, link: null },
		glossary_without_text: { count: setup.glossaryWithoutText, link: null },
		archived_featured: { count: counted('archivedFeatured'), link: '/v1/products?status=archived&featured=1' },
		variants_out_of_stock: { count: variants.out, link: '/v1/products?stockState=out,partial' },
		variants_low_stock: { count: variants.low, link: '/v1/products?lowStock=1' },
		business_name: { count: name === '' || name.toLowerCase() === domain.toLowerCase() ? 1 : 0, link: file },
		business_country: { count: business.country ? 0 : 1, link: file },
		business_logo: { count: business.logo ? 0 : 1, link: file },
		business_phone: { count: business.phone ? 0 : 1, link: file },
		website_address: { count: isPublicAddress(domain) ? 0 : 1, link: null },
		storage: { count: flag(setup.storage), link: null },
		delivery_days: { count: deliveryDays === null ? null : deliveryDays ? 0 : 1, link: null },
		payment_methods: { count: paymentMethods.length === 0 ? 1 : 0, link: null },
		pay_details: { count: setup.payUnready, link: null },
		staff_alerts: { count: flag(setup.staffAlerted), link: null },
		admin_url: { count: flag(setup.adminUrl), link: null },
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
