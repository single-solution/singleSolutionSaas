/**
 * Product performance (R7 #113): how each product does in the shop funnel, from the standard shop events' items
 * (`ss:view_item`, `ss:add_to_cart`, `ss:begin_checkout`, `ss:purchase`, which Ecommerce's widgets or the merchant's
 * own pages send; Growth never reads another product's data).
 *
 * Each funnel event adds to the day's totals (the one document per day, PLAN 0.8.9), per product id: `item_view`,
 * `item_cart` (its sum: units added), `item_checkout` and `item_purchase` (its sum: units bought) count the events that
 * name the product, once per event; `item_revenue` (`<id>\n<currency>`) counts the units bought with a price and sums
 * price × units, per currency; `item_name` (`<id>\n<name>`) counts the name the events gave it, and the report shows
 * the name given most. Raw events keep only ids and quantities, so the raw events stay as light as before.
 * @module
 */
import { toCsv } from '@ss/contracts/csv';
import { toDecimal } from '@ss/contracts/format';

/** The daily totals' metrics of product performance. */
export const PRODUCT_METRICS = Object.freeze([
	'item_view',
	'item_cart',
	'item_checkout',
	'item_purchase',
	'item_revenue',
	'item_name',
]);

/** The funnel step → its product metric. */
const STEP_METRIC = Object.freeze(
	/** @type {Record<string, string>} */ ({
		view_item: 'item_view',
		add_to_cart: 'item_cart',
		begin_checkout: 'item_checkout',
		purchase: 'item_purchase',
	}),
);
/** The metrics whose sum counts units. */
const UNIT_METRICS = Object.freeze(['item_cart', 'item_purchase']);

/** What the products report sorts by. */
export const PRODUCT_SORTS = Object.freeze([
	'views',
	'carts',
	'checkouts',
	'purchases',
	'units',
	'revenue',
	'cartRate',
	'conversion',
	'name',
]);

/** Rows a report gives unless asked for fewer or more (`limit`, at most {@link MAX_LIMIT}). */
const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 1000;

/** @typedef {{ id: string, variantId: string | null, quantity: number, name: string, price: number | null }} EventItem */
/** @typedef {{ metric: string, key: string, count: number, sum: number }} Increment */

/**
 * The daily totals' increments of a funnel event's items: once per product named (its units summed), its revenue per
 * currency on a purchase (items with a price), and the name it was given.
 * @param {string} type the event type
 * @param {ReadonlyArray<EventItem>} items
 * @param {string | null} currency
 * @returns {Increment[]}
 */
export const itemTotals = (type, items, currency) => {
	const metric = STEP_METRIC[type];
	if (!metric) return [];
	/** @type {Map<string, { units: number, priced: number, amount: number, name: string }>} */
	const products = new Map();
	for (const item of items) {
		const found = products.get(item.id) ?? { units: 0, priced: 0, amount: 0, name: '' };
		found.units += item.quantity;
		if (currency !== null && item.price !== null) {
			found.priced += item.quantity;
			found.amount += item.price * item.quantity;
		}
		if (!found.name && item.name) found.name = item.name;
		products.set(item.id, found);
	}
	/** @type {Increment[]} */
	const out = [];
	for (const [id, found] of products) {
		out.push({ metric, key: id, count: 1, sum: UNIT_METRICS.includes(metric) ? found.units : 0 });
		if (metric === 'item_purchase' && found.priced > 0 && Number.isSafeInteger(found.amount))
			out.push({ metric: 'item_revenue', key: `${id}\n${currency}`, count: found.priced, sum: found.amount });
		if (found.name) out.push({ metric: 'item_name', key: `${id}\n${found.name}`, count: 1, sum: 0 });
	}
	return out;
};

/**
 * @typedef {object} ProductRow one product over the report's days
 * @property {string} id
 * @property {string} name the name the events gave it most ('' when they gave none)
 * @property {number} views
 * @property {number} carts add-to-cart events naming it
 * @property {number} checkouts
 * @property {number} purchases orders naming it
 * @property {number} units units bought
 * @property {Array<{ currency: string, amount: number }>} revenue per currency (minor units), in the report's order
 * @property {number | null} cartRate add-to-carts per 100 views (null without views)
 * @property {number | null} conversion purchases per 100 views (null without views)
 */

/** @param {number} part @param {number} whole */
const rate = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

/**
 * The products report from the totals of a range: one row per product, sorted (`sort` one of {@link PRODUCT_SORTS},
 * views by default; `order` desc by default, empty rates last either way; revenue compares the currencies in the
 * report's order), the first `limit` rows; `currencies` from the most revenue to the least, `total` every product.
 * @param {ReadonlyArray<Increment>} rows the totals of {@link PRODUCT_METRICS}
 * @param {{ sort?: unknown, order?: unknown, limit?: number }} options
 */
export const productReport = (rows, { sort, order, limit = DEFAULT_LIMIT }) => {
	/** @type {Map<string, Omit<ProductRow, 'revenue' | 'cartRate' | 'conversion'> & { money: Map<string, number>, named: number }>} */
	const products = new Map();
	/** @type {Map<string, number>} */
	const byCurrency = new Map();
	for (const row of rows) {
		if (!PRODUCT_METRICS.includes(row.metric)) continue;
		const cut = row.key.indexOf('\n');
		const id = cut === -1 ? row.key : row.key.slice(0, cut);
		const extra = cut === -1 ? '' : row.key.slice(cut + 1);
		const product = products.get(id) ?? {
			id,
			name: '',
			views: 0,
			carts: 0,
			checkouts: 0,
			purchases: 0,
			units: 0,
			money: new Map(),
			named: 0,
		};
		products.set(id, product);
		if (row.metric === 'item_view') product.views += row.count;
		else if (row.metric === 'item_cart') product.carts += row.count;
		else if (row.metric === 'item_checkout') product.checkouts += row.count;
		else if (row.metric === 'item_purchase') {
			product.purchases += row.count;
			product.units += row.sum;
		} else if (row.metric === 'item_revenue') {
			product.money.set(extra, (product.money.get(extra) ?? 0) + row.sum);
			byCurrency.set(extra, (byCurrency.get(extra) ?? 0) + row.sum);
		} else if (row.count > product.named || (row.count === product.named && extra < product.name)) {
			product.name = extra;
			product.named = row.count;
		}
	}
	const currencies = [...byCurrency].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([currency]) => currency);
	/** @type {ProductRow[]} */
	const items = [...products.values()]
		.filter((product) => product.views + product.carts + product.checkouts + product.purchases > 0)
		.map((product) => ({
			id: product.id,
			name: product.name,
			views: product.views,
			carts: product.carts,
			checkouts: product.checkouts,
			purchases: product.purchases,
			units: product.units,
			revenue: currencies
				.filter((currency) => product.money.has(currency))
				.map((currency) => ({ currency, amount: Number(product.money.get(currency)) })),
			cartRate: rate(product.carts, product.views),
			conversion: rate(product.purchases, product.views),
		}));
	const by = typeof sort === 'string' && PRODUCT_SORTS.includes(sort) ? sort : 'views';
	const direction = order === 'asc' ? 1 : -1;
	/** @param {ProductRow} item @param {string} currency */
	const amountIn = (item, currency) => item.revenue.find((entry) => entry.currency === currency)?.amount ?? 0;
	/** @param {ProductRow} a @param {ProductRow} b */
	const compare = (a, b) => {
		if (by === 'name') return direction * (a.name || a.id).localeCompare(b.name || b.id);
		if (by === 'revenue') {
			for (const currency of currencies) {
				const difference = amountIn(a, currency) - amountIn(b, currency);
				if (difference !== 0) return direction * difference;
			}
			return 0;
		}
		const left = /** @type {number | null} */ (a[/** @type {keyof ProductRow} */ (by)]);
		const right = /** @type {number | null} */ (b[/** @type {keyof ProductRow} */ (by)]);
		if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1;
		return direction * (left - right);
	};
	items.sort((a, b) => compare(a, b) || b.purchases - a.purchases || a.id.localeCompare(b.id));
	return { currencies, total: items.length, items: items.slice(0, Math.max(0, limit)) };
};

/**
 * The products report as a CSV file: a column per measure, the rates in percent, and a revenue column per currency in
 * major units (`revenue_USD`: 60.00).
 * @param {{ currencies: string[], items: ProductRow[] }} report
 */
export const productsCsv = ({ currencies, items }) =>
	toCsv(
		[
			'product_id',
			'name',
			'views',
			'add_to_carts',
			'checkouts',
			'purchases',
			'units',
			'cart_rate_percent',
			'conversion_percent',
			...currencies.map((currency) => `revenue_${currency}`),
		],
		items.map((item) => [
			item.id,
			item.name,
			item.views,
			item.carts,
			item.checkouts,
			item.purchases,
			item.units,
			item.cartRate,
			item.conversion,
			...currencies.map((currency) => {
				const entry = item.revenue.find((one) => one.currency === currency);
				return entry ? toDecimal(entry.amount, currency) : null;
			}),
		]),
	);
