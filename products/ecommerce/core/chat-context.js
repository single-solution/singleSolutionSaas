/**
 * Chat's live store context (PLAN 0.8.10 E37, C1): the shop basics (payment methods by their names, with their notes
 * and fees, delivery fees and free-delivery amounts, pickup points with their address and hours, the loyalty earn
 * rate, the top categories, the return window and the warranty; parity P5-17), the shop's policies, the newest products
 * with their shown price per grade (with the price struck through above it), the deals table, the product the visitor
 * is viewing and, with a verified sign-in, the visitor's first name, city and points, written as one plain text of at
 * most {@link MAX_CONTEXT} characters that Chat adds to the AI's instructions. The visitor and the viewed product matter
 * most, so each part has its own share and the policies take what is left. Warranties read as the shopper widgets show
 * them (whole months when the days make them). Its headings and labels are the website's texts `chat.context.*` and
 * the payment methods are named as the website's `payment_methods` list names them (E33, E2: the merchant's words, in
 * their language; {@link contextWordsOf}), never English built into the code. No I/O.
 * @module
 */

/** The longest context text. */
export const MAX_CONTEXT = 6000;
/** The newest products the context lists. */
export const CONTEXT_PRODUCTS = 10;
/** The deals the context lists. */
export const CONTEXT_DEALS = 10;
/** The categories and delivery zones the shop basics list at most. */
export const CONTEXT_BASICS = 20;

/** Each part's share of the text; the policies take the rest (at least about 1,300 characters). */
const SHARE = Object.freeze({ visitor: 300, product: 1600, basics: 700, deals: 900, products: 1200 });

/**
 * The words of the context: the website's text `chat.context.<word>` of each (E33), with `{placeholders}`.
 */
export const CONTEXT_WORDS = Object.freeze(
	/** @type {const} */ ([
		'title',
		'basics',
		'payment',
		'fee',
		'delivery',
		'deliveryTo',
		'free',
		'freeOver',
		'pickup',
		'hours',
		'loyalty',
		'categories',
		'returns',
		'noReturns',
		'warrantyLine',
		'noWarranty',
		'policies',
		'newest',
		'soldOut',
		'per',
		'deals',
		'dealColumns',
		'noEnd',
		'dealFree',
		'dealOff',
		'product',
		'standard',
		'grade',
		'inStock',
		'stockLeft',
		'outOfStock',
		'warranty',
		'year',
		'years',
		'month',
		'months',
		'day',
		'days',
		'was',
		'visitor',
		'firstName',
		'city',
		'points',
	]),
);
/** The context's words. @typedef {Record<typeof CONTEXT_WORDS[number], string>} ContextWords */

/**
 * The context's words from a website's texts ('' for a text it has not).
 * @param {Readonly<Record<string, string>>} texts
 * @returns {ContextWords}
 */
export const contextWordsOf = (texts) =>
	/** @type {ContextWords} */ (Object.fromEntries(CONTEXT_WORDS.map((word) => [word, texts[`chat.context.${word}`] ?? ''])));

/**
 * A word with its `{placeholders}` filled.
 * @param {string} text @param {Record<string, string | number>} [values]
 */
const say = (text, values = {}) =>
	text.replace(/\{([A-Za-z]+)\}/g, (whole, name) => (Object.hasOwn(values, name) ? String(values[name]) : whole));

/**
 * @typedef {object} ContextParts
 * @property {string} business the business name
 * @property {Array<{ key: string, title: string, text: string }>} policies the merchant's, plain text (E27)
 * @property {Array<{ id?: string, name: string, url: string, inStock: boolean,
 *   prices: Array<{ grade: string | null, priceText: string, compareAtPriceText: string | null, inStock: boolean }> }>}
 *   products newest first
 * @property {ReadonlyMap<string, string>} [units] the unit of measure of the products sold in a unit of their own
 *   (their prices are per unit), by product id
 * @property {Array<{ name: string, discountLabel: string, badgeLabel: string, endsText: string, description: string }>} deals
 * @property {{ name: string, url: string, summary: string, priceRange: { minText: string, maxText: string },
 *   variants: Array<{ options: Record<string, string>, grade: string | null, priceText: string,
 *   compareAtPriceText: string | null, inStock: boolean, stockLeft: number | null, stockLeftText?: string | null,
 *   warrantyTime: import('./durations.js').Duration | null }>, measure?: { unit: string } | null } | null} product `measure`: sold by length, weight
 *   or volume (prices per unit, stock in its unit)
 * @property {{ firstName: string, city: string, points: number | null } | null} visitor
 * @property {ShopBasics | null} [basics]
 * @property {ContextWords} words the headings and labels ({@link contextWordsOf})
 */

/**
 * The shop basics (parity P5-17): each part empty or null while its feature is off.
 * @typedef {object} ShopBasics
 * @property {Array<{ method: string, name: string, note: string, feePercent: number }>} payments the methods offered,
 *   in the list's order, with the merchant's name, note and fee (a percent, 0 = none) for each
 * @property {{ fee: number, feeText: string, freeOver: number, freeOverText: string } | null} delivery the fee where no
 *   zone matches and the amount over which delivery is free (0 = never)
 * @property {Array<{ name: string, fee: number, feeText: string, freeOver: number, freeOverText: string }>} zones
 * @property {Array<{ name: string, address: string, hours: string }>} pickup the pickup points
 * @property {number | null} earnPercent loyalty points earned, as a percent back
 * @property {string[]} categories the top categories shoppers see
 * @property {import('./durations.js').Duration | null} returnTime the return window (0 = no returns; null: unknown)
 * @property {import('./durations.js').Duration | null} warrantyTime the store's warranty (0 = none)
 */

/**
 * A return or warranty time as the merchant typed it (E14: `1 year`, `6 months`, `30 days`), in the website's words;
 * '' for none.
 * @param {import('./durations.js').Duration | null | undefined} time @param {ContextWords} words
 */
export const timeWords = (time, words) => {
	if (!time || !Number.isSafeInteger(time.amount) || time.amount <= 0) return '';
	const n = time.amount;
	if (time.unit === 'years') return n === 1 ? words.year : say(words.years, { count: n });
	if (time.unit === 'months') return n === 1 ? words.month : say(words.months, { count: n });
	return n === 1 ? words.day : say(words.days, { count: n });
};

/**
 * A shown price with the price struck through above it (`$40.00 (was $50.00)`, the text `was`).
 * @param {{ priceText: string, compareAtPriceText: string | null }} price @param {ContextWords} words
 */
const priceWords = (price, words) =>
	price.compareAtPriceText ? say(words.was, { price: price.priceText, was: price.compareAtPriceText }) : price.priceText;

/**
 * One line without line breaks or table bars, cut to `max` characters.
 * @param {unknown} value
 * @param {number} [max]
 */
export const oneLine = (value, max = 300) => {
	const text = String(value ?? '')
		.replace(/[\r\n\t]+/g, ' ')
		.replace(/\|/g, '/')
		.replace(/\s{2,}/g, ' ')
		.trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/**
 * Lines that fit in `budget` characters (with their line breaks); a line that does not fit is cut when it is the
 * first, else left out with every line after it.
 * @param {string[]} lines
 * @param {number} budget
 */
const fit = (lines, budget) => {
	/** @type {string[]} */
	const out = [];
	let used = 0;
	for (const line of lines) {
		const cost = line.length + 1;
		if (used + cost > budget) {
			if (out.length === 0 && budget > 20) out.push(`${line.slice(0, budget - 2)}…`);
			break;
		}
		out.push(line);
		used += cost;
	}
	return out;
};

/** @param {string[]} lines */
const sizeOf = (lines) => lines.reduce((n, line) => n + line.length + 1, 0);

/**
 * The visitor's part.
 * @param {ContextParts['visitor']} visitor @param {ContextWords} words
 */
const visitorLines = (visitor, words) => {
	if (!visitor) return [];
	const facts = [
		visitor.firstName ? say(words.firstName, { name: oneLine(visitor.firstName, 60) }) : '',
		visitor.city ? say(words.city, { city: oneLine(visitor.city, 80) }) : '',
		visitor.points === null ? '' : say(words.points, { points: visitor.points }),
	].filter(Boolean);
	return facts.length > 0 ? [`## ${words.visitor}`, `- ${facts.join('; ')}`] : [];
};

/**
 * The viewed product's part.
 * @param {ContextParts['product']} product @param {ContextWords} words
 */
const productLines = (product, words) => {
	if (!product) return [];
	const per = product.measure ? ` ${say(words.per, { unit: product.measure.unit })}` : '';
	const range =
		product.priceRange.minText === product.priceRange.maxText
			? product.priceRange.minText
			: `${product.priceRange.minText} – ${product.priceRange.maxText}`;
	return [
		`## ${words.product}`,
		`${oneLine(product.name, 160)} (${range}${per}) ${product.url}`,
		...(product.summary ? [oneLine(product.summary, 300)] : []),
		...product.variants.map((variant) => {
			const options = Object.values(variant.options).join(' / ');
			const stock = !variant.inStock
				? words.outOfStock
				: variant.stockLeft === null
					? words.inStock
					: say(words.stockLeft, { count: variant.stockLeftText ?? variant.stockLeft });
			const parts = [
				options || words.standard,
				variant.grade ? say(words.grade, { grade: variant.grade }) : '',
				`${priceWords(variant, words)}${per}`,
				stock,
				timeWords(variant.warrantyTime, words)
					? say(words.warranty, { warranty: timeWords(variant.warrantyTime, words) })
					: '',
			].filter(Boolean);
			return `- ${oneLine(parts.join(', '), 200)}`;
		}),
	];
};

/**
 * A delivery fee with its free-delivery amount.
 * @param {{ fee: number, feeText: string, freeOver: number, freeOverText: string }} rule @param {ContextWords} words
 */
const feeWords = (rule, words) =>
	rule.fee <= 0
		? words.free
		: rule.freeOver > 0
			? say(words.freeOver, { fee: rule.feeText, amount: rule.freeOverText })
			: rule.feeText;

/**
 * The shop basics' part.
 * @param {ShopBasics | null | undefined} basics @param {ContextWords} words
 */
const basicsLines = (basics, words) => {
	if (!basics) return [];
	const payments = basics.payments.map((entry) => {
		const extra = [
			entry.note ? oneLine(entry.note, 160) : '',
			entry.feePercent > 0 ? say(words.fee, { percent: entry.feePercent }) : '',
		].filter(Boolean);
		const name = oneLine(entry.name, 60);
		return extra.length > 0 ? `${name} (${extra.join('; ')})` : name;
	});
	const warranty = timeWords(basics.warrantyTime, words);
	const lines = [
		payments.length > 0 ? say(words.payment, { methods: payments.join('; ') }) : '',
		basics.delivery ? say(words.delivery, { fee: feeWords(basics.delivery, words) }) : '',
		...basics.zones.map((zone) => say(words.deliveryTo, { zone: oneLine(zone.name, 80), fee: feeWords(zone, words) })),
		...basics.pickup.map((point) =>
			say(words.pickup, {
				point: oneLine(
					[point.name, point.address, point.hours ? say(words.hours, { hours: point.hours }) : '']
						.filter(Boolean)
						.join(', '),
					240,
				),
			}),
		),
		basics.earnPercent !== null && basics.earnPercent > 0 ? say(words.loyalty, { percent: basics.earnPercent }) : '',
		basics.categories.length > 0 ? say(words.categories, { names: oneLine(basics.categories.join(', '), 400) }) : '',
		basics.returnTime === null
			? ''
			: timeWords(basics.returnTime, words)
				? say(words.returns, { time: timeWords(basics.returnTime, words) })
				: words.noReturns,
		basics.warrantyTime === null ? '' : warranty ? say(words.warrantyLine, { warranty }) : words.noWarranty,
	]
		.filter(Boolean)
		.map((line) => `- ${line}`);
	return lines.length > 0 ? [`## ${words.basics}`, ...lines] : [];
};

/**
 * The deals table (`dealColumns`: the three column names, split by `|`).
 * @param {ContextParts['deals']} deals @param {ContextWords} words
 */
const dealLines = (deals, words) =>
	deals.length === 0
		? []
		: [
				`## ${words.deals}`,
				`| ${words.dealColumns
					.split('|')
					.map((name) => name.trim())
					.join(' | ')} |`,
				'| --- | --- | --- |',
				...deals.map(
					(deal) =>
						`| ${oneLine(deal.badgeLabel ? `${deal.name} (${deal.badgeLabel})` : deal.name, 120)} | ${oneLine(
							deal.discountLabel,
							60,
						)} | ${oneLine(deal.endsText || words.noEnd, 40)} |`,
				),
			];

/**
 * The newest products with their price per grade (per unit for an item sold in a unit of its own).
 * @param {ContextParts['products']} products @param {ContextWords} words
 * @param {ReadonlyMap<string, string>} [units]
 */
const newestLines = (products, words, units = new Map()) =>
	products.length === 0
		? []
		: [
				`## ${words.newest}`,
				...products.map((item) => {
					const unit = item.id ? units.get(item.id) : undefined;
					const per = unit ? ` ${say(words.per, { unit })}` : '';
					const prices = item.prices
						.map(
							(price) =>
								`${price.grade ? `${price.grade} ` : ''}${priceWords(price, words)}${per}${price.inStock ? '' : ` (${words.soldOut})`}`,
						)
						.join(', ');
					return `- ${oneLine(item.name, 120)}: ${oneLine(prices, 240)} ${item.url}`;
				}),
			];

/**
 * The policies, each sharing the room left.
 * @param {ContextParts['policies']} policies
 * @param {number} budget @param {ContextWords} words
 */
const policyLines = (policies, budget, words) => {
	if (policies.length === 0 || budget < 40) return [];
	const heading = `## ${words.policies}`;
	const each = Math.floor((budget - heading.length - 1) / policies.length) - 1;
	if (each < 20) return [];
	return [heading, ...policies.map((policy) => oneLine(`${policy.title}: ${policy.text}`, each))];
};

/**
 * The context text: the business, the shop basics, the policies, the newest products, the deals, the viewed product
 * and the visitor, at most {@link MAX_CONTEXT} characters.
 * @param {ContextParts} parts
 * @returns {string}
 */
export const contextText = (parts) => {
	const { words } = parts;
	const head = [`# ${say(words.title, { business: oneLine(parts.business, 120) })}`];
	const basics = fit(basicsLines(parts.basics, words), SHARE.basics);
	const visitor = fit(visitorLines(parts.visitor, words), SHARE.visitor);
	const product = fit(productLines(parts.product, words), SHARE.product);
	const deals = fit(dealLines(parts.deals, words), SHARE.deals);
	const products = fit(newestLines(parts.products, words, parts.units), SHARE.products);
	const taken = sizeOf(head) + sizeOf(basics) + sizeOf(visitor) + sizeOf(product) + sizeOf(deals) + sizeOf(products);
	const policies = policyLines(parts.policies, MAX_CONTEXT - taken, words);
	const text = [...head, ...basics, ...policies, ...products, ...deals, ...product, ...visitor].join('\n');
	return text.length > MAX_CONTEXT ? `${text.slice(0, MAX_CONTEXT - 1)}…` : text;
};
