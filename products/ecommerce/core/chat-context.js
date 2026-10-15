/**
 * Chat's live store context (PLAN 0.8.10 E37, C1): the shop basics (payment methods with their notes, the cash
 * handling fee, delivery fees and free-delivery amounts, pickup points with their address and hours, the loyalty earn
 * rate, the top categories, the return window and the warranty; parity P5-17), the shop's policies, the newest products
 * with their shown price per grade (with the price struck through above it), the deals table, the product the visitor
 * is viewing and, with a verified sign-in, the visitor's first name, city and points, written as one plain text of at
 * most {@link MAX_CONTEXT} characters that Chat adds to the AI's instructions. The visitor and the viewed product matter
 * most, so each part has its own share and the policies take what is left. Warranties read as the shopper widgets show
 * them (whole months when the days make them). Labels are English (text the server makes, K7). No I/O.
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

/** The payment methods as the context names them. */
const PAYMENT_WORDS = Object.freeze({
	cod: 'Cash on delivery',
	online: 'Online payment',
	bank_transfer: 'Bank transfer',
	pickup: 'Pay at pickup',
});

/** Policy names in the context. */
const POLICY_TITLES = Object.freeze({
	shipping: 'Delivery',
	returns: 'Returns',
	warranty: 'Warranty',
	privacy: 'Privacy',
	terms: 'Terms',
});

/**
 * @typedef {object} ContextParts
 * @property {string} business the business name
 * @property {Array<{ key: string, text: string }>} policies plain text
 * @property {Array<{ name: string, url: string, inStock: boolean,
 *   prices: Array<{ grade: string | null, priceText: string, compareAtPriceText: string | null, inStock: boolean }> }>}
 *   products newest first
 * @property {Array<{ name: string, discountLabel: string, badgeLabel: string, endsText: string, description: string }>} deals
 * @property {{ name: string, url: string, summary: string, priceRange: { minText: string, maxText: string },
 *   variants: Array<{ options: Record<string, string>, grade: string | null, priceText: string,
 *   compareAtPriceText: string | null, inStock: boolean, stockLeft: number | null, warrantyDays: number | null }> } | null}
 *   product
 * @property {{ firstName: string, city: string, points: number | null } | null} visitor
 * @property {ShopBasics | null} [basics]
 */

/**
 * The shop basics (parity P5-17): each part empty or null while its feature is off.
 * @typedef {object} ShopBasics
 * @property {Array<{ method: string, note: string }>} payments the methods offered, in the merchant's order, with the
 *   merchant's note for each
 * @property {number} codFeePercent the cash handling fee of cash on delivery (0 = none)
 * @property {{ fee: number, feeText: string, freeOver: number, freeOverText: string } | null} delivery the fee where no
 *   zone matches and the amount over which delivery is free (0 = never)
 * @property {Array<{ name: string, fee: number, feeText: string, freeOver: number, freeOverText: string }>} zones
 * @property {Array<{ name: string, address: string, hours: string }>} pickup the pickup points
 * @property {number | null} earnPercent loyalty points earned, as a percent back
 * @property {string[]} categories the top categories shoppers see
 * @property {number | null} returnDays the return window (0 = no returns)
 * @property {number | null} warrantyDays the store's warranty (0 = none)
 */

/**
 * A warranty as the shopper widgets show it (`ui/shop-common.js` `warrantyText`): whole months when the days make
 * them, else days; '' for none.
 * @param {number | null | undefined} days
 */
export const warrantyWords = (days) => {
	const n = Number(days);
	if (days === null || days === undefined || !Number.isSafeInteger(n) || n <= 0) return '';
	if (n % 30 === 0) return n === 30 ? '1 month' : `${n / 30} months`;
	return n === 1 ? '1 day' : `${n} days`;
};

/**
 * A shown price with the price struck through above it (`$40.00 (was $50.00)`).
 * @param {{ priceText: string, compareAtPriceText: string | null }} price
 */
const priceWords = (price) =>
	price.compareAtPriceText ? `${price.priceText} (was ${price.compareAtPriceText})` : price.priceText;

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
 * @param {ContextParts['visitor']} visitor
 */
const visitorLines = (visitor) => {
	if (!visitor) return [];
	const facts = [
		visitor.firstName ? `first name ${oneLine(visitor.firstName, 60)}` : '',
		visitor.city ? `city ${oneLine(visitor.city, 80)}` : '',
		visitor.points === null ? '' : `${visitor.points} loyalty points`,
	].filter(Boolean);
	return facts.length > 0 ? ['## Signed-in visitor', `- ${facts.join('; ')}`] : [];
};

/**
 * The viewed product's part.
 * @param {ContextParts['product']} product
 */
const productLines = (product) => {
	if (!product) return [];
	const range =
		product.priceRange.minText === product.priceRange.maxText
			? product.priceRange.minText
			: `${product.priceRange.minText} – ${product.priceRange.maxText}`;
	return [
		'## Product the visitor is viewing',
		`${oneLine(product.name, 160)} (${range}) ${product.url}`,
		...(product.summary ? [oneLine(product.summary, 300)] : []),
		...product.variants.map((variant) => {
			const options = Object.values(variant.options).join(' / ');
			const stock = !variant.inStock
				? 'out of stock'
				: variant.stockLeft === null
					? 'in stock'
					: `${variant.stockLeft} in stock`;
			const parts = [
				options || 'Standard',
				variant.grade ? `grade ${variant.grade}` : '',
				priceWords(variant),
				stock,
				variant.warrantyDays ? `${warrantyWords(variant.warrantyDays)} warranty` : '',
			].filter(Boolean);
			return `- ${oneLine(parts.join(', '), 200)}`;
		}),
	];
};

/**
 * A delivery fee with its free-delivery amount.
 * @param {{ fee: number, feeText: string, freeOver: number, freeOverText: string }} rule
 */
const feeWords = (rule) =>
	`${rule.fee > 0 ? rule.feeText : 'free'}${rule.fee > 0 && rule.freeOver > 0 ? `, free over ${rule.freeOverText}` : ''}`;

/**
 * The shop basics' part.
 * @param {ShopBasics | null | undefined} basics
 */
const basicsLines = (basics) => {
	if (!basics) return [];
	const payments = basics.payments.map((entry) => {
		const name = PAYMENT_WORDS[/** @type {keyof typeof PAYMENT_WORDS} */ (entry.method)] ?? entry.method;
		return entry.note ? `${name} (${oneLine(entry.note, 160)})` : name;
	});
	const warranty = warrantyWords(basics.warrantyDays);
	const lines = [
		payments.length > 0 ? `- Payment: ${payments.join('; ')}` : '',
		basics.codFeePercent > 0 ? `- Cash on delivery adds a ${basics.codFeePercent}% cash handling fee` : '',
		basics.delivery ? `- Delivery: ${feeWords(basics.delivery)}` : '',
		...basics.zones.map((zone) => `- Delivery to ${oneLine(zone.name, 80)}: ${feeWords(zone)}`),
		...basics.pickup.map(
			(point) =>
				`- Pickup: ${oneLine([point.name, point.address, point.hours ? `hours ${point.hours}` : ''].filter(Boolean).join(', '), 240)}`,
		),
		basics.earnPercent !== null && basics.earnPercent > 0 ? `- Loyalty: ${basics.earnPercent}% back in points` : '',
		basics.categories.length > 0 ? `- Categories: ${oneLine(basics.categories.join(', '), 400)}` : '',
		basics.returnDays === null
			? ''
			: basics.returnDays > 0
				? `- Returns: within ${basics.returnDays} days of delivery`
				: '- Returns: not accepted',
		basics.warrantyDays === null ? '' : warranty ? `- Warranty: ${warranty}` : '- Warranty: none',
	].filter(Boolean);
	return lines.length > 0 ? ['## Shop basics', ...lines] : [];
};

/**
 * The deals table.
 * @param {ContextParts['deals']} deals
 */
const dealLines = (deals) =>
	deals.length === 0
		? []
		: [
				'## Deals now',
				'| Deal | Discount | Ends |',
				'| --- | --- | --- |',
				...deals.map(
					(deal) =>
						`| ${oneLine(deal.badgeLabel ? `${deal.name} (${deal.badgeLabel})` : deal.name, 120)} | ${oneLine(
							deal.discountLabel,
							60,
						)} | ${oneLine(deal.endsText || 'no end date', 40)} |`,
				),
			];

/**
 * The newest products with their price per grade.
 * @param {ContextParts['products']} products
 */
const newestLines = (products) =>
	products.length === 0
		? []
		: [
				'## Newest products',
				...products.map((item) => {
					const prices = item.prices
						.map(
							(price) =>
								`${price.grade ? `${price.grade} ` : ''}${priceWords(price)}${price.inStock ? '' : ' (out of stock)'}`,
						)
						.join(', ');
					return `- ${oneLine(item.name, 120)}: ${oneLine(prices, 240)} ${item.url}`;
				}),
			];

/**
 * The policies, each sharing the room left.
 * @param {ContextParts['policies']} policies
 * @param {number} budget
 */
const policyLines = (policies, budget) => {
	if (policies.length === 0 || budget < 40) return [];
	const heading = '## Store policies';
	const each = Math.floor((budget - heading.length - 1) / policies.length) - 1;
	if (each < 20) return [];
	return [
		heading,
		...policies.map((policy) =>
			oneLine(`${POLICY_TITLES[/** @type {keyof typeof POLICY_TITLES} */ (policy.key)] ?? policy.key}: ${policy.text}`, each),
		),
	];
};

/**
 * The context text: the business, the shop basics, the policies, the newest products, the deals, the viewed product
 * and the visitor, at most {@link MAX_CONTEXT} characters.
 * @param {ContextParts} parts
 * @returns {string}
 */
export const contextText = (parts) => {
	const head = [`# ${oneLine(parts.business, 120)} — live store facts`];
	const basics = fit(basicsLines(parts.basics), SHARE.basics);
	const visitor = fit(visitorLines(parts.visitor), SHARE.visitor);
	const product = fit(productLines(parts.product), SHARE.product);
	const deals = fit(dealLines(parts.deals), SHARE.deals);
	const products = fit(newestLines(parts.products), SHARE.products);
	const taken = sizeOf(head) + sizeOf(basics) + sizeOf(visitor) + sizeOf(product) + sizeOf(deals) + sizeOf(products);
	const policies = policyLines(parts.policies, MAX_CONTEXT - taken);
	const text = [...head, ...basics, ...policies, ...products, ...deals, ...product, ...visitor].join('\n');
	return text.length > MAX_CONTEXT ? `${text.slice(0, MAX_CONTEXT - 1)}…` : text;
};
