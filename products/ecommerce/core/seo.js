/**
 * Catalog SEO (PLAN 0.8.8: meta and structured data, sitemaps): page titles and descriptions, schema.org JSON-LD for
 * product and category pages, and sitemap XML. The merchant's site serves all of it on its own domain from the
 * product's API (PLAN 0.4.10). Only values the shop really has are emitted — never an invented rating, price or
 * condition. Every text that goes into XML is escaped, and JSON-LD comes as text that can never close its
 * `<script>` element. Pure functions, no I/O.
 * @module
 */
import { valueLabel } from './catalog.js';
import { toDecimal, zonedDay } from '@ss/contracts/format';

/** @typedef {import('./model.js').ProductRecord} ProductRecord */
/** @typedef {import('./model.js').VariantRecord} VariantRecord */
/** @typedef {'new' | 'used' | 'refurbished'} Condition */

const SCHEMA = 'https://schema.org';

/** Condition → schema.org `OfferItemCondition`. */
const CONDITION_URL = Object.freeze({
	new: `${SCHEMA}/NewCondition`,
	used: `${SCHEMA}/UsedCondition`,
	refurbished: `${SCHEMA}/RefurbishedCondition`,
});

/**
 * Characters XML 1.0 does not allow (control characters other than tab and line breaks, lone surrogates, U+FFFE/F).
 */
const NOT_XML =
	// eslint-disable-next-line no-control-regex
	/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Text safe inside an XML element or attribute.
 * @param {unknown} value
 */
export const escapeXml = (value) =>
	String(value ?? '')
		.replace(NOT_XML, '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');

/**
 * JSON for a `<script type="application/ld+json">` element: `<`, `>`, `&`, U+2028 and U+2029 escaped, so the text can
 * never close the element (`</script>`) or start a comment, whatever the merchant typed.
 * @param {unknown} node
 */
export const scriptJson = (node) =>
	JSON.stringify(node)
		.replace(/</g, '\\u003c')
		.replace(/>/g, '\\u003e')
		.replace(/&/g, '\\u0026')
		.replace(/\u2028/g, '\\u2028')
		.replace(/\u2029/g, '\\u2029');

export {
	clip,
	fillTemplate,
	fillTitle,
	pageTitle,
	pageName,
	patternText,
	asWritten,
	metaDescription,
	writtenSummary,
} from './seo-text.js';

/**
 * Whether a variant can be bought now (a variant marked sold out cannot, E9).
 * @param {Pick<ProductRecord, 'trackStock'>} product
 * @param {Pick<VariantRecord, 'stock' | 'soldOut'>} variant
 */
export const variantInStock = (product, variant) => !variant.soldOut && (!product.trackStock || variant.stock > 0);

/**
 * The variants shown and sold.
 * @param {Pick<ProductRecord, 'variants'>} product
 */
export const activeVariants = (product) => product.variants.filter((variant) => variant.active);

/**
 * Option values of a variant as one label (`Blue / Large`).
 * @param {Pick<VariantRecord, 'options'>} variant
 */
export const variantLabel = (variant) => Object.values(variant.options ?? {}).join(' / ');

/**
 * Drop empty members (undefined, null, '' and empty lists) of a JSON-LD node, one level deep.
 * @param {Record<string, unknown>} node
 */
const compact = (node) =>
	Object.fromEntries(
		Object.entries(node).filter(
			([, value]) => value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0),
		),
	);

/**
 * `BreadcrumbList` of a page: its trail from the home page.
 * @param {Array<{ name: string, url: string }>} trail
 */
const breadcrumbJsonLd = (trail) => ({
	'@type': 'BreadcrumbList',
	itemListElement: trail.map((step, index) => ({ '@type': 'ListItem', position: index + 1, name: step.name, item: step.url })),
});

/**
 * A feed item id (E17), also a variant's id in structured data when it has no SKU of its own (G5): the id the shop's
 * earlier product feed listed the variant under, kept by an import (`feedId`), so shopping catalogs keep the items they
 * already list and markup and feed name the same item; else the variant's own id.
 * @param {Pick<VariantRecord, 'id' | 'feedId'>} variant
 */
export const feedItemId = (variant) => variant.feedId || variant.id;

/**
 * The item group of a product (SG-24), the same in feeds and structured data (G5): the group id the shop's earlier feed
 * sent, kept by an import (`feedGroupId`); else the product id when it has several variants, else ''.
 * @param {Pick<ProductRecord, 'id' | 'feedGroupId'>} product
 * @param {boolean} many
 */
export const feedGroupId = (product, many) => product.feedGroupId || (many ? product.id : '');

/**
 * How long an order takes to arrive, in whole days: handling (packing) and transit (on the way).
 * @typedef {{ handling: { min: number, max: number }, transit: { min: number, max: number } }} DeliveryTime
 */

/**
 * The days a list of whole days says (the delivery settings `handlingDays`): the fewest and the most
 * of them, or null for an empty list (not set).
 * @param {unknown} list
 * @returns {{ min: number, max: number } | null}
 */
export const daysRange = (list) => {
	const days = (Array.isArray(list) ? list : []).filter((day) => Number.isSafeInteger(day) && day >= 0);
	return days.length > 0 ? { min: Math.min(...days), max: Math.max(...days) } : null;
};

/**
 * How returned items come back and who pays to send them (the `returns` settings `returnMethod`, `returnShippingFee`
 * and `returnShippingFeeAmount`, G5.3).
 * @typedef {{ method: 'by_mail' | 'in_store' | 'both', fee: 'shopper_pays' | 'free' | 'fixed', feeAmount: number }} ReturnTerms
 */

/**
 * A shop's return policy for structured data: the business's country, the return terms and the store-wide window
 * (the site answer's policy, with its `@id`); null where the shop gives none.
 * @typedef {{ country: string, terms: ReturnTerms, store: { id: string, days: number } | null }} ReturnPolicy
 */

/**
 * @typedef {object} ProductPage
 * @property {ProductRecord} product
 * @property {string} url the canonical product page
 * @property {string[]} images absolute image addresses
 * @property {string} description
 * @property {string | null} brand brand name
 * @property {string} currency
 * @property {(variant: VariantRecord) => Condition | ''} condition the condition of a variant (its grade's, E10)
 * @property {string} seller the business name
 * @property {Array<{ name: string, url: string }>} trail home and categories, without the product
 * @property {(variant: VariantRecord) => string} variantName a variant's name (the `seo` setting `variantTitle`, G6)
 * @property {(variant: VariantRecord) => import('./promotions.js').ShownPrice} shown a variant's shown price
 *   (`shownPrice`, G4)
 * @property {MemberPrice[]} [memberPrices] member prices (role pricing on, G17): each offer adds its price for each
 *   tier of the site's member program
 * @property {string} [timeZone] the business time zone, whose days a sale's last day is (UTC without one)
 * @property {import('./measure.js').Measure | null} [measure] sold in a unit of its own (its type's `measure`, while
 *   the feature is on): each price is for one unit, said with a `UnitPriceSpecification` when the unit is tied to a
 *   standard measure
 * @property {(variant: VariantRecord) => string} [variantUrl] a variant's page (E13)
 * @property {(variant: VariantRecord) => string | null} [variantImage] a variant's first photo (E6); without one the
 *   variant shows the product's photos
 * @property {string | null} [shippingPolicy] the `@id` of the store-wide shipping policy (the site answer's, once it is
 *   complete: the business's country and the delivery days), which physical goods point to (G5.5)
 * @property {(ReturnPolicy & { days: (variant: VariantRecord) => number | null }) | null} [returns] the return policy
 *   and each item's return window in days (0 = not returnable, null = not known: no policy)
 * @property {Array<{ name: string, rating: number, title: string, body: string, at: Date | string | null }>} [reviews]
 *   approved reviews shown as review nodes (E16)
 * @property {boolean} [faqMarkup] whether the product's questions are also given as `FAQPage` markup (the `seo` setting
 *   `faqMarkup`; Google shows no FAQ rich results since 2026-05-07, other engines may read it)
 * @property {(variant: VariantRecord | null) => FieldTarget[]} [values] the values of the fields structured data names
 *   (`show.jsonLd`): the product's own (null), else a variant's
 * @property {ReadonlyMap<string, string>} [axes] option name → the schema.org property its variant field names (`color`,
 *   `material`, `size`, `pattern`), for `variesBy`: only these options are named (E34)
 */

/**
 * A field value a place names (structured data or a feed): where it goes, its value as shoppers read it, each of its
 * values so (`values`) and as stored (`raw`, as text).
 * @typedef {{ target: string, name: string, value: string, values: string[], raw: string[] }} FieldTarget
 */

/**
 * The values of the fields a place names (`show.jsonLd` or `show.feeds`): each active field with a target there, in
 * the fields' order, its value as shoppers read it (a choice's label, a number with its unit).
 * @param {Record<string, unknown>} values a product's specs or a variant's attributes
 * @param {ReadonlyMap<string, import('./model.js').AttributeRecord>} fields
 * @param {'jsonLd' | 'feeds'} place
 * @returns {FieldTarget[]}
 */
export const fieldTargets = (values, fields, place) =>
	Object.keys(values)
		.flatMap((id) => {
			const field = fields.get(id);
			return field && field.active && field.show[place] !== 'none' ? [field] : [];
		})
		.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))
		.map((field) => {
			const value = values[field.id];
			const each = Array.isArray(value) ? value : [value];
			return {
				target: field.show[place],
				name: field.name,
				value: valueLabel(field, value),
				values: each.map((entry) => valueLabel(field, entry)),
				raw: each.map(String),
			};
		});

/**
 * Structured data properties of field values: `color`, `material`, `size` and `pattern` as such (the first of each),
 * the others as `additionalProperty` name and value pairs.
 * @param {FieldTarget[]} values
 */
const propertiesOf = (values) => {
	/** @type {Record<string, unknown>} */
	const out = {};
	const extra = values
		.filter((entry) => entry.target === 'additionalProperty')
		.map((entry) => ({ '@type': 'PropertyValue', name: entry.name, value: entry.value }));
	for (const entry of values)
		if (entry.target !== 'additionalProperty' && !(entry.target in out)) out[entry.target] = entry.value;
	if (extra.length > 0) out.additionalProperty = extra;
	return out;
};

/**
 * The delivery fee of one item at a price: free from the free-delivery amount (0 = never free), as the cart charges it
 * (SG-2).
 * @param {{ fee: number, freeOver?: number }} shipping
 * @param {number} price
 */
export const shippingFee = ({ fee, freeOver = 0 }, price) => (freeOver > 0 && price >= freeOver ? 0 : fee);

/**
 * A number of days as schema.org takes it.
 * @param {{ min: number, max: number }} days
 */
const daysValue = ({ min, max }) => ({ '@type': 'QuantitativeValue', minValue: min, maxValue: max, unitCode: 'DAY' });

/**
 * A member price of the site's member program (SEO audit G17): a role price's tier (`tierId`, the `@id` the site answer
 * gives it) and its percent off the price shown, rounded half up to `unit` (whole units with the Format's `wholeUnits`),
 * as the cart takes it off; or (E31) its price list: a price by variant id and by product id (`prices`).
 * @typedef {{ tierId: string, percent: number, unit: number, prices?: ReadonlyMap<string, number> | null }} MemberPrice
 */

/**
 * A price for a member tier: the price shown less the tier's percent, as the cart computes a role discount (E19); a
 * price-list tier's `off` (what its listed price takes off the variant's price, E31) comes off the price shown.
 * @param {number} price @param {MemberPrice & { off?: number }} member
 */
const memberPriceOf = (price, { percent, unit, off }) =>
	off !== undefined
		? Math.max(0, price - off)
		: price - Math.min(price, Math.round((price * percent) / 100 / unit + 1e-9) * unit);

/**
 * The member prices of one variant (E31): a percent tier as it is; a price-list tier only where it lists the variant
 * (else its product) below the variant's price, as what that takes off.
 * @param {ReadonlyArray<MemberPrice>} members @param {ProductRecord} product @param {VariantRecord} variant
 * @returns {Array<MemberPrice & { off?: number }>}
 */
const membersOf = (members, product, variant) =>
	members.flatMap((member) => {
		if (!member.prices) return [member];
		const listed = member.prices.get(variant.id) ?? member.prices.get(product.id);
		return listed !== undefined && listed < variant.price ? [{ ...member, off: variant.price - listed }] : [];
	});

/**
 * The price specifications of an offer: none, one, or a list.
 * @param {Array<Record<string, unknown>>} list
 */
const specifications = (list) => (list.length === 0 ? null : list.length === 1 ? list[0] : list);

/**
 * The price of an offer (G4): the shown price; the struck-through price beside it (`StrikethroughPrice`, never on the
 * active price); member prices (G17); and for a sale that holds all day with an end, when it started (`validFrom`)
 * and its last day (`priceValidUntil`, the day before an end at midnight, a day in the business time zone; Google may
 * drop a listing whose date is past). An item sold in a unit of its own tied to a standard measure says what each
 * price is for (`referenceQuantity`: the amount and its UN/CEFACT code), the shown price as a `UnitPriceSpecification`
 * too; without a standard measure nothing is said of the unit.
 * @param {import('./promotions.js').ShownPrice} shown
 * @param {string} currency
 * @param {Array<MemberPrice & { off?: number }>} members
 * @param {string} timeZone
 * @param {import('./measure.js').Measure | null} [measure]
 */
const offerPrice = (shown, currency, members, timeZone, measure = null) => {
	// only a unit tied to a standard measure says what each price is for (never guessed)
	const standard = measure?.standard ?? null;
	const per = standard
		? { referenceQuantity: { '@type': 'QuantitativeValue', value: standard.amount, unitCode: standard.code } }
		: {};
	return {
		price: toDecimal(shown.price, currency),
		priceCurrency: currency,
		priceSpecification: specifications([
			...(standard
				? [{ '@type': 'UnitPriceSpecification', price: toDecimal(shown.price, currency), priceCurrency: currency, ...per }]
				: []),
			...(shown.was === null
				? []
				: [
						{
							'@type': 'UnitPriceSpecification',
							priceType: `${SCHEMA}/StrikethroughPrice`,
							price: toDecimal(shown.was, currency),
							priceCurrency: currency,
							...per,
						},
					]),
			// a member's price for each tier (G17): never with a priceType
			...members.map((member) => ({
				'@type': 'UnitPriceSpecification',
				price: toDecimal(memberPriceOf(shown.price, member), currency),
				priceCurrency: currency,
				validForMemberTier: { '@id': member.tierId },
				...per,
			})),
		]),
		validFrom: shown.sale?.until && shown.sale.from ? new Date(shown.sale.from).toISOString() : null,
		priceValidUntil: shown.sale?.until ? zonedDay(new Date(new Date(shown.sale.until).getTime() - 1), timeZone) : null,
	};
};

/** How items come back → schema.org `ReturnMethodEnumeration`. */
const RETURN_METHODS = Object.freeze({
	by_mail: [`${SCHEMA}/ReturnByMail`],
	in_store: [`${SCHEMA}/ReturnInStore`],
	both: [`${SCHEMA}/ReturnByMail`, `${SCHEMA}/ReturnInStore`],
});

/**
 * A money amount as schema.org takes it.
 * @param {Record<string, number>} amounts `value`, `minValue` or `maxValue` in minor units
 * @param {string} currency
 */
const moneyValue = (amounts, currency) => ({
	'@type': 'MonetaryAmount',
	...Object.fromEntries(Object.entries(amounts).map(([key, amount]) => [key, toDecimal(amount, currency)])),
	currency,
});

/**
 * A return policy (G5): a window of `days` after delivery (0 = not returnable) in the country, with how items come back
 * and who pays to send them (G5.3; a fixed fee of 0 is a free return, Google takes a return fee only above 0).
 * @param {Pick<ReturnPolicy, 'country' | 'terms'>} policy
 * @param {number} days
 * @param {string} currency
 * @param {Record<string, unknown>} [id] its `@id`, for the store-wide policy other pages point to
 */
const returnPolicyOf = ({ country, terms }, days, currency, id = {}) => {
	const fixed = terms.fee === 'fixed' && terms.feeAmount > 0;
	const fee = terms.fee === 'shopper_pays' ? 'ReturnFeesCustomerResponsibility' : fixed ? 'ReturnShippingFees' : 'FreeReturn';
	const methods = RETURN_METHODS[terms.method] ?? RETURN_METHODS.by_mail;
	return compact({
		'@type': 'MerchantReturnPolicy',
		...id,
		applicableCountry: country,
		returnPolicyCategory: `${SCHEMA}/${days > 0 ? 'MerchantReturnFiniteReturnWindow' : 'MerchantReturnNotPermitted'}`,
		merchantReturnDays: days > 0 ? days : null,
		returnMethod: days > 0 ? (methods.length === 1 ? methods[0] : methods) : null,
		returnFees: days > 0 ? `${SCHEMA}/${fee}` : null,
		returnShippingFeesAmount: days > 0 && fixed ? moneyValue({ value: terms.feeAmount }, currency) : null,
	});
};

/**
 * The offer details of one variant (E16, G5.5): physical goods point to the store-wide shipping policy (once it is
 * complete); the item's return policy points to the store-wide one when its window is the store's, else is its own.
 * @param {ProductPage} page
 * @param {VariantRecord} variant
 */
const offerExtras = ({ product, currency, shippingPolicy, returns }, variant) => {
	const days = returns ? returns.days(variant) : null;
	return {
		shippingDetails:
			product.kind === 'physical' && shippingPolicy
				? { '@type': 'OfferShippingDetails', hasShippingService: { '@id': shippingPolicy } }
				: null,
		hasMerchantReturnPolicy:
			returns && days !== null
				? returns.store?.days === days
					? { '@id': returns.store.id }
					: returnPolicyOf(returns, days, currency)
				: null,
	};
};

/**
 * The store-wide shipping policy (G5.5, Google's `ShippingService` of the business, launched 2025-11-12): delivery to
 * the business's country at the first plain delivery rate of its zone (E5), free from the rate's free-delivery amount
 * (0 = never), with the handling days and the rate's days in transit.
 * @param {{ country: string, fee: number, freeOver: number, deliveryTime: DeliveryTime }} shipping
 * @param {string} currency
 * @param {string} id its `@id`
 */
const shippingServiceOf = ({ country, fee, freeOver, deliveryTime }, currency, id) => {
	const destination = { '@type': 'DefinedRegion', addressCountry: country };
	const transitTime = { '@type': 'ServicePeriod', duration: daysValue(deliveryTime.transit) };
	/** @param {number} rate @param {Record<string, number> | null} value the order values it is for */
	const condition = (rate, value) =>
		compact({
			'@type': 'ShippingConditions',
			shippingDestination: destination,
			orderValue: value ? moneyValue(value, currency) : null,
			shippingRate: moneyValue({ value: rate }, currency),
			transitTime,
		});
	return {
		'@type': 'ShippingService',
		'@id': id,
		fulfillmentType: `${SCHEMA}/FulfillmentTypeDelivery`,
		handlingTime: { '@type': 'ServicePeriod', duration: daysValue(deliveryTime.handling) },
		shippingConditions:
			freeOver > 0 && fee > 0
				? [condition(fee, { minValue: 0, maxValue: freeOver - 1 }), condition(0, { minValue: freeOver })]
				: [condition(fee, null)],
	};
};

/**
 * `FAQPage` of a page's questions, or null.
 * @param {Array<{ question: string, answer: string }> | undefined} faqs
 * @param {string} url
 */
export const faqJsonLd = (faqs, url) =>
	faqs && faqs.length > 0
		? {
				'@type': 'FAQPage',
				'@id': `${url}#faq`,
				mainEntity: faqs.map((faq) => ({
					'@type': 'Question',
					name: faq.question,
					acceptedAnswer: { '@type': 'Answer', text: faq.answer },
				})),
			}
		: null;

/**
 * The variants offered for sale: active and priced above 0 (merchant listings need a price above 0, as feeds do).
 * @param {Pick<ProductRecord, 'variants'>} product
 */
export const offeredVariants = (product) => activeVariants(product).filter((variant) => variant.price > 0);

/** The specs `{topSpecs}` names. */
const TOP_SPECS = 3;

/**
 * The facts a product's title and description patterns take (G6), from what is offered now, filled on every read so
 * they never go stale: `{minPrice}` and `{maxPrice}` (the lowest and highest price), `{price}` (the price, or the range
 * `lowest – highest`), `{options}` and `{inStockOptions}` (the option values offered, and those in stock, axis by axis),
 * `{conditions}` (the labels of the grades offered, in the grades' order) and `{topSpecs}` (the first 3 specs as
 * `Name: value unit`). Each is '' when the product has none.
 * @param {Pick<ProductRecord, 'variants' | 'options' | 'trackStock'>} product
 * @param {{ money: (amount: number) => string, grades: ReadonlyMap<string, { label: string }>,
 *   specs: ReadonlyArray<{ name: string, label: string, unit: string }>, priceOf?: (variant: VariantRecord) => number }} context
 *   `grades`: the product's grades in the list's order; `specs`: its specs in their order; `priceOf`: the price a
 *   variant is offered at
 */
export const productFacts = (product, { money, grades, specs, priceOf = (variant) => variant.price }) => {
	const offered = offeredVariants(product);
	const prices = offered.map(priceOf);
	const low = prices.length > 0 ? Math.min(...prices) : null;
	const high = prices.length > 0 ? Math.max(...prices) : null;
	/** @param {VariantRecord[]} variants */
	const valuesOf = (variants) =>
		product.options
			.flatMap((axis) => axis.values.filter((value) => variants.some((variant) => variant.options?.[axis.name] === value)))
			.join(', ');
	return {
		minPrice: low === null ? '' : money(low),
		maxPrice: high === null ? '' : money(high),
		price: low === null || high === null ? '' : low === high ? money(low) : `${money(low)} – ${money(high)}`,
		options: valuesOf(offered),
		inStockOptions: valuesOf(offered.filter((variant) => variantInStock(product, variant))),
		conditions: [...grades.entries()]
			.filter(([key]) => offered.some((variant) => variant.grade === key))
			.map(([, grade]) => grade.label)
			.join(', '),
		topSpecs: specs
			.slice(0, TOP_SPECS)
			.map((spec) => `${spec.name}: ${spec.label}${spec.unit ? ` ${spec.unit}` : ''}`)
			.join(', '),
	};
};

/**
 * Product structured data as a JSON-LD graph (E16, G5): a `ProductGroup` with each variant offered as a `Product` (its
 * own image, else the product's; its SKU, else its feed item id; its GTIN and MPN when known; its condition by grade,
 * offer, shipping and return policy) when there are several, else one `Product`; the rating and review nodes; the `BreadcrumbList`; and, while the
 * merchant asks for it, a `FAQPage` of the product's questions. A product with nothing offered (no active variant
 * priced above 0) has no Product node: a Product without offers is not valid markup.
 * @param {ProductPage} page
 */
export const productJsonLd = (page) => {
	const { product, url, images, description, brand, currency, seller, trail } = page;
	// a variant a deal makes free is not offered either (a price above 0, G4)
	const variants = offeredVariants(product).filter((variant) => page.shown(variant).price > 0);
	/** @param {VariantRecord} variant */
	const offerOf = (variant) =>
		compact({
			'@type': 'Offer',
			url: page.variantUrl?.(variant) ?? url,
			...offerPrice(
				page.shown(variant),
				currency,
				membersOf(page.memberPrices ?? [], product, variant),
				page.timeZone ?? 'UTC',
				page.measure ?? null,
			),
			availability: `${SCHEMA}/${variantInStock(product, variant) ? 'InStock' : 'OutOfStock'}`,
			itemCondition: (() => {
				const condition = page.condition(variant);
				return condition ? CONDITION_URL[condition] : '';
			})(),
			seller: seller ? { '@type': 'Organization', name: seller } : null,
			...offerExtras(page, variant),
		});
	const rating =
		product.rating.count > 0
			? {
					'@type': 'AggregateRating',
					ratingValue: Math.round(product.rating.average * 10) / 10,
					reviewCount: product.rating.count,
					bestRating: 5,
					worstRating: 1,
				}
			: null;
	const reviews = (page.reviews ?? []).map((review) =>
		compact({
			'@type': 'Review',
			name: review.title,
			reviewBody: review.body,
			datePublished: review.at ? new Date(review.at).toISOString().slice(0, 10) : '',
			author: { '@type': 'Person', name: review.name },
			reviewRating: { '@type': 'Rating', ratingValue: review.rating, bestRating: 5, worstRating: 1 },
		}),
	);
	const shared = {
		description,
		image: images,
		brand: brand ? { '@type': 'Brand', name: brand } : null,
		aggregateRating: rating,
		review: reviews,
	};
	/** @type {Record<string, unknown> | null} */
	let node = null;
	if (variants.length > 1) {
		node = compact({
			'@type': 'ProductGroup',
			'@id': `${url}#product`,
			name: product.name,
			url,
			productGroupID: feedGroupId(product, true),
			...propertiesOf(page.values?.(null) ?? []),
			// only options whose variant field the merchant mapped to a schema.org property (E34)
			variesBy: product.options.flatMap((axis) => {
				const named = page.axes?.get(axis.name);
				return named ? [`${SCHEMA}/${named}`] : [];
			}),
			...shared,
			hasVariant: variants.map((variant) =>
				compact({
					'@type': 'Product',
					name: page.variantName(variant) || product.name,
					sku: variant.sku || feedItemId(variant),
					gtin: variant.gtin,
					mpn: variant.mpn,
					image: page.variantImage?.(variant) || images,
					...Object.fromEntries(
						Object.entries(variant.options ?? {}).flatMap(([axis, value]) => {
							const property = page.axes?.get(axis);
							return property ? [[property, value]] : [];
						}),
					),
					...propertiesOf(page.values?.(variant) ?? []),
					offers: offerOf(variant),
				}),
			),
		});
	} else if (variants.length === 1) {
		const sole = /** @type {VariantRecord} */ (variants[0]);
		node = compact({
			'@type': 'Product',
			'@id': `${url}#product`,
			name: product.name,
			url,
			sku: sole.sku || feedItemId(sole),
			gtin: sole.gtin,
			mpn: sole.mpn,
			...shared,
			...propertiesOf([...(page.values?.(null) ?? []), ...(page.values?.(sole) ?? [])]),
			offers: offerOf(sole),
		});
	}
	return {
		'@context': SCHEMA,
		'@graph': [
			node,
			breadcrumbJsonLd([...trail, { name: product.name, url }]),
			page.faqMarkup ? faqJsonLd(product.faqs, url) : null,
		].filter((entry) => entry !== null),
	};
};

/**
 * `CollectionPage` of a category or landing page, with its `ItemList` of products, its `BreadcrumbList` and a
 * `FAQPage` of its questions, as a JSON-LD graph (E15, E16).
 * @param {{ name: string, description: string, url: string, image: string | null, trail: Array<{ name: string, url: string }>,
 *   items?: Array<{ name: string, url: string }>, faqs?: Array<{ question: string, answer: string }> }} page
 *   `trail`: home and the ancestors, without the page itself
 */
export const categoryJsonLd = ({ name, description, url, image, trail, items = [], faqs = [] }) => ({
	'@context': SCHEMA,
	'@graph': [
		compact({ '@type': 'CollectionPage', '@id': `${url}#page`, name, description, url, image }),
		items.length > 0
			? {
					'@type': 'ItemList',
					'@id': `${url}#items`,
					itemListElement: items.map((item, index) => ({
						'@type': 'ListItem',
						position: index + 1,
						url: item.url,
						name: item.name,
					})),
				}
			: null,
		breadcrumbJsonLd([...trail, { name, url }]),
		faqJsonLd(faqs, url),
	].filter((entry) => entry !== null),
});

/**
 * The `@id`s of the site answer's nodes (E49): on the home page, where other pages point to them.
 * @param {string} home the home page's address
 */
export const siteIds = (home) => ({
	organization: `${home}#organization`,
	website: `${home}#website`,
	returnPolicy: `${home}#return_policy`,
	shippingPolicy: `${home}#shipping_policy`,
	memberProgram: `${home}#member_program`,
	/** @param {string} role a role price's Accounts role */
	memberTier: (role) => `${home}#member_tier_${encodeURIComponent(role)}`,
});

/** A day as schema.org opening hours write it. */
const DAY = '(?:Mo|Tu|We|Th|Fr|Sa|Su)';
/** One group of days with its hours, as schema.org `openingHours` takes it (`Mo-Fr 09:00-17:00`, `Sa,Su 10:00-14:00`). */
const OPENING_HOURS = new RegExp(
	`^${DAY}(?:-${DAY})?(?:,${DAY}(?:-${DAY})?)*(?: (?:[01]\\d|2[0-3]):[0-5]\\d-(?:[01]\\d|2[0-4]):[0-5]\\d)?$`,
);

/**
 * Opening hours as structured data takes them, from text the merchant wrote: one group of days with its hours per line
 * (`Mo-Fr 09:00-17:00`); none when any line is written another way (hours are never guessed from free text).
 * @param {unknown} text
 * @returns {string[]}
 */
export const openingHoursOf = (text) => {
	const lines = String(text ?? '')
		.split(/\r?\n|;/)
		.map((line) => line.trim().replace(/\s+/g, ' '))
		.filter(Boolean);
	return lines.length > 0 && lines.every((line) => OPENING_HOURS.test(line)) ? lines : [];
};

/**
 * What the home page says about the business and the website (E49, SEO audit G2).
 * @typedef {object} SitePage
 * @property {string} home the home page's address
 * @property {string} name the site name (the `seo` setting `brandName`, else the business name)
 * @property {string} alternateName another name of the site ('' = none)
 * @property {string} type the schema.org type: `OnlineStore`, or the local business type the merchant picked (E35)
 * @property {string | null} logo
 * @property {string | null} email
 * @property {string | null} telephone
 * @property {{ street: string, country: string }} address the address as written ('' = none) and the country code
 * @property {string[]} sameAs the business's profiles on other sites
 * @property {string[]} openingHours a local business's hours ({@link openingHoursOf})
 * @property {string} currency
 * @property {(Pick<ReturnPolicy, 'country' | 'terms'> & { days: number }) | null} returns the store's return window
 *   (0 = not returnable) and terms, null: none given
 * @property {{ country: string, fee: number, freeOver: number, deliveryTime: DeliveryTime } | null} shipping the
 *   store's delivery to the business's country, null: not complete
 * @property {Array<{ role: string, name: string }>} [memberTiers] the member program's tiers (role prices, G17): each
 *   gives its members a lower price; none = no program
 */

/**
 * The home page's structured data as a JSON-LD graph (E49, SEO audit G2): the business as an `OnlineStore` (or the
 * local business type the merchant picked, at its pickup point, E35) with its name, address, logo, contacts, profiles, hours, its store-wide return
 * and shipping policies and its member program (G17), which product offers point to by `@id`; and the `WebSite` with
 * its name. Only values the shop has.
 * @param {SitePage} page
 */
export const siteJsonLd = (page) => {
	const ids = siteIds(page.home);
	const street = page.address.street
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.join(', ');
	const address =
		street || page.address.country
			? compact({ '@type': 'PostalAddress', streetAddress: street, addressCountry: page.address.country })
			: null;
	return {
		'@context': SCHEMA,
		'@graph': [
			compact({
				'@type': page.type,
				'@id': ids.organization,
				name: page.name,
				alternateName: page.alternateName,
				url: page.home,
				logo: page.logo,
				email: page.email,
				telephone: page.telephone,
				address,
				sameAs: page.sameAs,
				openingHours: page.openingHours,
				hasMerchantReturnPolicy: page.returns
					? returnPolicyOf(page.returns, page.returns.days, page.currency, { '@id': ids.returnPolicy })
					: null,
				hasShippingService: page.shipping ? shippingServiceOf(page.shipping, page.currency, ids.shippingPolicy) : null,
				hasMemberProgram:
					page.memberTiers && page.memberTiers.length > 0
						? {
								'@type': 'MemberProgram',
								'@id': ids.memberProgram,
								name: page.name,
								description: page.memberTiers.map((tier) => tier.name).join(', '),
								url: page.home,
								hasTiers: page.memberTiers.map((tier) => ({
									'@type': 'MemberProgramTier',
									'@id': ids.memberTier(tier.role),
									name: tier.name,
									hasTierBenefit: `${SCHEMA}/TierBenefitLoyaltyPrice`,
								})),
							}
						: null,
			}),
			compact({
				'@type': 'WebSite',
				'@id': ids.website,
				name: page.name,
				alternateName: page.alternateName,
				url: page.home,
				publisher: { '@id': ids.organization },
			}),
		],
	};
};

/**
 * A page's social sharing tags (SEO audit G13): its Open Graph data — the type (`product` for a product page, else
 * `website`), the canonical address, the site name, title, description, image with its text, and a product's price
 * shown — and the Twitter card (a large image when there is one). Not a search signal: it makes shared links look right.
 * @param {{ type: 'website' | 'product', url: string | null, siteName: string, title: string, description: string,
 *   image: string | null, imageAlt?: string, price?: { amount: string, currency: string } | null }} page
 */
export const socialOf = ({ type, url, siteName, title, description, image, imageAlt = '', price = null }) => ({
	og: { type, url, siteName, title, description, image, imageAlt: image ? imageAlt : '', price },
	twitter: { card: image ? 'summary_large_image' : 'summary' },
});

/** Words a category's own text needs to stand as a page without products (G7.1). */
const OWN_TEXT_WORDS = 50;

/**
 * Whether a category has text of its own that makes it a page even without products (G7.1): a summary or description
 * of at least 50 words.
 * @param {{ description?: string, content?: { summary?: string } }} category
 */
export const hasOwnText = (category) =>
	[category.content?.summary, category.description].some(
		(text) =>
			String(text ?? '')
				.split(/\s+/)
				.filter(Boolean).length >= OWN_TEXT_WORDS,
	);

/**
 * The robots value of a page: `index, follow` unless its SEO fields say otherwise.
 * @param {{ noindex?: boolean, nofollow?: boolean } | undefined} seo
 */
export const robotsOf = (seo) => `${seo?.noindex ? 'noindex' : 'index'}, ${seo?.nofollow ? 'nofollow' : 'follow'}`;

/** The start of a sitemap file (with the image extension, E16). */
export const SITEMAP_HEAD =
	'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n';
/** The end of a sitemap file. */
export const SITEMAP_FOOT = '</urlset>\n';

/**
 * A sitemap's `<lastmod>` of a time, or '' without a valid one.
 * @param {Date | string | null | undefined} lastmod
 */
const lastmodOf = (lastmod) => {
	const date = lastmod ? new Date(lastmod) : null;
	return date && !Number.isNaN(date.getTime()) ? `<lastmod>${date.toISOString()}</lastmod>` : '';
};

/**
 * One address of a sitemap, with its images (E16).
 * @param {{ loc: string, lastmod: Date | string | null | undefined, images?: string[] }} entry
 */
export const sitemapEntry = ({ loc, lastmod, images = [] }) => {
	const pictures = images.map((image) => `<image:image><image:loc>${escapeXml(image)}</image:loc></image:image>`).join('');
	return `<url><loc>${escapeXml(loc)}</loc>${lastmodOf(lastmod)}${pictures}</url>\n`;
};

/**
 * A sitemap index pointing at the files of a large sitemap, each with the newest `lastmod` of its pages (G8.4).
 * @param {Array<{ loc: string, lastmod: Date | string | null | undefined }>} files
 */
export const sitemapIndex = (files) =>
	`<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${files
		.map(({ loc, lastmod }) => `<sitemap><loc>${escapeXml(loc)}</loc>${lastmodOf(lastmod)}</sitemap>\n`)
		.join('')}</sitemapindex>\n`;

/**
 * The address of one file of a split sitemap on the merchant's website: the sitemap address with `file=<name>` (E16).
 * @param {string} base the sitemap address (`/sitemap.xml` or an https address)
 * @param {string} domain
 * @param {string} file `categories`, `landings` or `products-<n>`
 */
export const sitemapFileUrl = (base, domain, file) => {
	const path = String(base || '/sitemap.xml');
	const absolute = /^https:\/\//.test(path) ? path : `https://${domain}${path.startsWith('/') ? '' : '/'}${path}`;
	return `${absolute}${absolute.includes('?') ? '&' : '?'}file=${encodeURIComponent(file)}`;
};

/**
 * The files of a sitemap index (E16): the home page with the categories, the landing and glossary pages, and the
 * products in files of at most `size` addresses each. Empty parts have no file (the home page's file is never empty).
 * @param {{ landings: number, products: number, size: number }} counts
 * @returns {string[]}
 */
export const sitemapFiles = ({ landings, products, size }) => [
	'categories',
	...(landings > 0 ? ['landings'] : []),
	...Array.from({ length: Math.ceil(products / size) }, (_, index) => `products-${index + 1}`),
];
