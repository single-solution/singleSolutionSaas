/**
 * Mode B headless core of the `price_deltas` element: prices a configuration in the page with the same pure pricer as
 * the API (base or combination price, option deltas, unit prices, rules@1 delta rules, rounding) and formats it with
 * the catalog's locale. The `client` (`POST /v1/quotes`) is used when given, else the configurator's public view is
 * priced locally. DOM-free; the element shape of Part E §4.
 */
import { compileSchema } from '../core/compile.js';
import { formatMoney } from '../core/money.js';
import { priceOf } from '../core/pricing.js';
import { parseSchema } from '../core/schema.js';
import { createTranslator } from './strings.js';

/**
 * @typedef {object} PriceState
 * @property {'idle' | 'ready' | 'error'} status
 * @property {import('../core/pricing.js').Price | null} price
 * @property {string | null} unitText
 * @property {string | null} totalText
 * @property {string | null} error
 */
/** @typedef {{ quote: (body: Record<string, unknown>) => Promise<{ ok: boolean, value?: any, problem?: { code?: string } }> }} QuoteClient */

/**
 * @param {{ config?: Record<string, unknown>, strings?: Record<string, string>, client?: QuoteClient | null,
 *   configurator?: { id: string, schema: unknown } | null, currency?: string | null, now?: () => number,
 *   emit?: (name: string, data: Record<string, unknown>) => void }} options
 *   `config` = the price_deltas feature values; `currency` = the website's currency (fallback)
 */
export const createPriceDeltas = ({
	config = {},
	strings = {},
	client = null,
	configurator = null,
	currency = null,
	now = () => Date.now(),
	emit = () => {},
}) => {
	const t = createTranslator(strings);
	const locale = strings['widget.locale'] || 'en';
	/** @type {Set<(state: PriceState) => void>} */
	const listeners = new Set();
	let destroyed = false;
	const parsed = configurator ? parseSchema(configurator.schema) : null;
	const built = parsed?.ok ? compileSchema(parsed.schema) : null;
	const compiled = built?.ok ? built.compiled : null;
	/** @type {PriceState} */
	let state = Object.freeze({ status: 'idle', price: null, unitText: null, totalText: null, error: null });
	/** @param {Partial<PriceState>} patch */
	const set = (patch) => {
		if (destroyed) return;
		state = Object.freeze({ ...state, ...patch });
		for (const listener of listeners) listener(state);
	};
	const rounding = {
		mode: /** @type {any} */ (config.rounding_mode ?? 'none'),
		increment: typeof config.rounding_increment === 'number' ? config.rounding_increment : 1,
		ending: typeof config.rounding_ending === 'number' ? config.rounding_ending : 0,
	};
	/** @param {import('../core/pricing.js').Price | null} price */
	const show = (price) => {
		set({
			status: 'ready',
			price,
			unitText: price ? formatMoney(price.unit, price.currency, locale) : null,
			totalText: price ? formatMoney(price.total, price.currency, locale) : null,
			error: null,
		});
		emit('price_deltas.priced', { unit: price?.unit ?? null, currency: price?.currency ?? null });
	};

	const actions = Object.freeze({
		/**
		 * Price a selection (a resolution's `selection` and `combination`, or a full selection for a quote).
		 * @param {{ selection: Record<string, unknown>, combination?: { id: string } | null, quantity?: number }} input
		 */
		price: async (input) => {
			if (client && configurator) {
				const result = await client.quote({
					configurator: configurator.id,
					selection: input.selection,
					quantity: input.quantity,
				});
				if (!result.ok) {
					set({ status: 'error', error: t('widget.error.request_failed') });
					return result;
				}
				show(result.value.price);
				return result;
			}
			if (!compiled) {
				set({ status: 'error', error: t('resolver.error.invalid') });
				return { ok: /** @type {const} */ (false), problem: { code: 'not_loaded' } };
			}
			const result = priceOf(
				compiled,
				{ selection: input.selection, combination: input.combination ?? null, quantity: input.quantity },
				{ rounding, currency, now: now() },
			);
			if (!result.ok) {
				set({ status: 'error', error: t('widget.error.request_failed') });
				return { ok: /** @type {const} */ (false), problem: { code: result.code } };
			}
			show(result.price);
			return { ok: /** @type {const} */ (true), value: result.price };
		},
	});

	return Object.freeze({
		/** @returns {PriceState} */
		state: () => state,
		actions,
		/** @param {(state: PriceState) => void} listener */
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		/**
		 * @param {unknown} input
		 * @returns {Array<{ path: string, code: string, message: string }>}
		 */
		validate: (input) => {
			const value = /** @type {Record<string, unknown>} */ (input ?? {});
			return value.selection !== null && typeof value.selection === 'object' && !Array.isArray(value.selection)
				? []
				: [{ path: '/selection', code: 'required', message: t('resolver.error.invalid') }];
		},
		/** Format integer minor units with the catalog's locale. @param {number} minor @param {string | null} code */
		format: (minor, code) => formatMoney(minor, code, locale),
		strings,
		destroy: () => {
			destroyed = true;
			listeners.clear();
		},
	});
};
