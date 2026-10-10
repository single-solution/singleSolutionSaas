/**
 * Chat's live store context (PLAN 0.8.10 E37, C1): the shop's policies, the newest products with their price per
 * grade, the deals table, the product the visitor is viewing and, with a verified sign-in, the visitor's first name,
 * city and points, written as one plain text of at most {@link MAX_CONTEXT} characters that Chat adds to the AI's
 * instructions. The visitor and the viewed product matter most, so each part has its own share and the policies take
 * what is left. Labels are English (text the server makes, K7). No I/O.
 * @module
 */

/** The longest context text. */
export const MAX_CONTEXT = 6000;
/** The newest products the context lists. */
export const CONTEXT_PRODUCTS = 10;
/** The deals the context lists. */
export const CONTEXT_DEALS = 10;

/** Each part's share of the text; the policies take the rest (at least about 1,300 characters). */
const SHARE = Object.freeze({ visitor: 300, product: 1600, deals: 1200, products: 1500 });

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
 *   prices: Array<{ grade: string | null, priceText: string, inStock: boolean }> }>} products newest first
 * @property {Array<{ name: string, discountLabel: string, badgeLabel: string, endsText: string, description: string }>} deals
 * @property {{ name: string, url: string, summary: string, priceRange: { minText: string, maxText: string },
 *   variants: Array<{ options: Record<string, string>, grade: string | null, priceText: string, inStock: boolean,
 *   stockLeft: number | null, warrantyDays: number | null }> } | null} product
 * @property {{ firstName: string, city: string, points: number | null } | null} visitor
 */

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
				variant.priceText,
				stock,
				variant.warrantyDays ? `${variant.warrantyDays} days warranty` : '',
			].filter(Boolean);
			return `- ${oneLine(parts.join(', '), 200)}`;
		}),
	];
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
								`${price.grade ? `${price.grade} ` : ''}${price.priceText}${price.inStock ? '' : ' (out of stock)'}`,
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
 * The context text: the business, the policies, the newest products, the deals, the viewed product and the visitor,
 * at most {@link MAX_CONTEXT} characters.
 * @param {ContextParts} parts
 * @returns {string}
 */
export const contextText = (parts) => {
	const head = [`# ${oneLine(parts.business, 120)} — live store facts`];
	const visitor = fit(visitorLines(parts.visitor), SHARE.visitor);
	const product = fit(productLines(parts.product), SHARE.product);
	const deals = fit(dealLines(parts.deals), SHARE.deals);
	const products = fit(newestLines(parts.products), SHARE.products);
	const taken = sizeOf(head) + sizeOf(visitor) + sizeOf(product) + sizeOf(deals) + sizeOf(products);
	const policies = policyLines(parts.policies, MAX_CONTEXT - taken);
	const text = [...head, ...policies, ...products, ...deals, ...product, ...visitor].join('\n');
	return text.length > MAX_CONTEXT ? `${text.slice(0, MAX_CONTEXT - 1)}…` : text;
};
