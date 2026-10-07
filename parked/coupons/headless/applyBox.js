/**
 * Mode B headless core of the `apply_box` element: state, actions, subscribe, validate, strings, destroy (Part E §4).
 * Framework-agnostic and DOM-free. `client` is the element's Mode C client (`POST /v1/quotes` with the website's `pk_`
 * key; the customer comes from `SS-Identity`), already scoped by the runtime; the default renderer (ui/applyBox.js) and
 * any merchant-built UI use exactly this core. Every code goes through a quote of all applied codes, so the stacking
 * policy, limits and eligibility are the server's — the box never decides a discount itself.
 */
import { codeFromUrl } from '../core/links.js';
import { formatMoney } from '../core/money.js';
import { createTranslator } from './strings.js';

/** @typedef {{ type?: string, title?: string, status?: number, detail?: string, code?: string }} Problem */
/**
 * @template T
 * @typedef {{ ok: true, value: T } | { ok: false, problem?: Problem, error?: Problem }} Result
 */
/**
 * @typedef {object} QuoteView `POST /v1/quotes`
 * @property {string} currency
 * @property {number} subtotal
 * @property {number} discount
 * @property {number} shipping
 * @property {number} shippingDiscount
 * @property {number} total
 * @property {boolean} freeShipping
 * @property {Array<{ itemId: string, variantId: string | null, quantity: number }>} gifts
 * @property {Array<{ code: string, name: string, discount: number, shippingDiscount: number, freeShipping: boolean }>} applied
 * @property {Array<{ code: string, reason: string }>} rejected
 */
/** @typedef {{ quote: (body: { codes: string[], cart: Record<string, unknown> }) => Promise<Result<QuoteView>> }} ApplyBoxClient */
/**
 * @typedef {object} ApplyBoxState
 * @property {'idle' | 'loading' | 'ready' | 'error'} status
 * @property {string} code the code being typed
 * @property {ReadonlyArray<{ code: string, name: string, savingsText: string }>} applied
 * @property {QuoteView | null} quote last quote of the applied codes
 * @property {string | null} savingsText total saved, formatted
 * @property {string | null} message resolved, user-facing confirmation
 * @property {string | null} error resolved, user-facing error
 * @property {string | null} errorCode stable code of the last error
 * @property {number} maxCodes
 * @property {boolean} expanded collapsible variant
 * @property {string} variant
 * @property {boolean} showSavings
 */

const CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * @param {{ config?: Record<string, unknown>, strings?: Record<string, string>, client: ApplyBoxClient,
 *   cart?: Record<string, unknown> | null, identity?: unknown, emit?: (name: string, data: Record<string, unknown>) => void }} options
 *   `config` = the element's feature values (+ `auto_apply_param` from the codes element)
 */
export const createApplyBox = ({ config = {}, strings = {}, client, cart = null, emit = () => {} }) => {
	const t = createTranslator(strings);
	const locale = strings['apply_box.locale'] || 'en';
	const maxCodes =
		Number.isInteger(config.max_codes) && /** @type {number} */ (config.max_codes) > 0
			? /** @type {number} */ (config.max_codes)
			: 1;
	const param = typeof config.auto_apply_param === 'string' ? config.auto_apply_param : 'coupon';
	/** @type {Set<(state: ApplyBoxState) => void>} */
	const listeners = new Set();
	let destroyed = false;
	/** @type {Record<string, unknown> | null} */
	let currentCart = cart;
	/** @type {ApplyBoxState} */
	let state = Object.freeze({
		status: 'idle',
		code: '',
		applied: [],
		quote: null,
		savingsText: null,
		message: null,
		error: null,
		errorCode: null,
		maxCodes,
		expanded: config.variant !== 'collapsible',
		variant: config.variant === 'collapsible' ? 'collapsible' : 'inline',
		showSavings: config.show_savings !== false,
	});
	/** @param {Partial<ApplyBoxState>} patch */
	const set = (patch) => {
		if (destroyed) return;
		state = Object.freeze({ ...state, ...patch });
		for (const listener of listeners) listener(state);
	};
	/** @param {string} code */
	const errorText = (code) => {
		const key = `apply_box.error.${code}`;
		const text = t(key);
		return text === key ? t('apply_box.error.request_failed') : text;
	};
	/** @param {number} minor @param {string} currency */
	const money = (minor, currency) => formatMoney(minor, currency, locale);

	/**
	 * Quote a set of codes; returns the quote or a problem code.
	 * @param {string[]} codes
	 * @returns {Promise<{ ok: true, quote: QuoteView } | { ok: false, code: string }>}
	 */
	const quoteFor = async (codes) => {
		if (!currentCart) return { ok: false, code: 'cart_required' };
		const result = await client.quote({ codes, cart: currentCart });
		if (result.ok) return { ok: true, quote: result.value };
		return { ok: false, code: result.problem?.code ?? result.error?.code ?? 'request_failed' };
	};

	/** @param {QuoteView} quote */
	const appliedOf = (quote) =>
		quote.applied.map((coupon) => ({
			code: coupon.code,
			name: coupon.name,
			savingsText:
				coupon.freeShipping && coupon.discount === 0
					? t('apply_box.free_shipping')
					: money(coupon.discount + coupon.shippingDiscount, quote.currency),
		}));

	/** @param {QuoteView | null} quote */
	const savingsOf = (quote) =>
		quote && quote.applied.length > 0 && quote.discount + quote.shippingDiscount > 0
			? t('apply_box.savings', { amount: money(quote.discount + quote.shippingDiscount, quote.currency) })
			: null;

	/**
	 * @param {unknown} input
	 * @returns {Array<{ path: string, code: string, message: string }>}
	 */
	const validate = (input) => {
		const code = typeof input === 'string' ? input.trim() : '';
		if (code === '') return [{ path: '/code', code: 'required', message: t('apply_box.error.required') }];
		if (!CODE.test(code)) return [{ path: '/code', code: 'code_invalid', message: t('apply_box.error.code_not_found') }];
		return [];
	};

	/**
	 * Re-quote the applied codes (cart changed, a code removed).
	 * @param {string[]} codes
	 */
	const requote = async (codes) => {
		if (codes.length === 0) {
			set({ status: 'ready', applied: [], quote: null, savingsText: null, error: null, errorCode: null });
			return { ok: true, value: null };
		}
		set({ status: 'loading' });
		const result = await quoteFor(codes);
		if (!result.ok) {
			set({ status: 'error', error: errorText(result.code), errorCode: result.code });
			return { ok: false, problem: { code: result.code } };
		}
		set({
			status: 'ready',
			applied: appliedOf(result.quote),
			quote: result.quote,
			savingsText: savingsOf(result.quote),
			error: null,
			errorCode: null,
		});
		return { ok: true, value: result.quote };
	};

	const actions = Object.freeze({
		/** @param {unknown} code */
		setCode: async (code) => {
			set({ code: typeof code === 'string' ? code : '', error: null, errorCode: null, message: null });
			return { ok: true, value: state.code };
		},
		/**
		 * The cart the codes apply to (`{ currency, lines, … }` as `POST /v1/quotes` takes it); re-quotes applied codes.
		 * @param {Record<string, unknown> | null} next
		 */
		setCart: async (next) => {
			currentCart = next;
			return requote(state.applied.map((entry) => entry.code));
		},
		/** Apply the typed code (with the already applied ones). */
		apply: async () => {
			const problems = validate(state.code);
			if (problems.length > 0) {
				const first = /** @type {{ code: string, message: string }} */ (problems[0]);
				set({ status: 'error', error: first.message, errorCode: first.code });
				return { ok: false, problem: { code: 'validation_failed' } };
			}
			const code = state.code.trim();
			const current = state.applied.map((entry) => entry.code);
			if (current.some((entry) => entry.toUpperCase() === code.toUpperCase())) {
				set({ status: 'error', error: errorText('already_applied'), errorCode: 'already_applied' });
				return { ok: false, problem: { code: 'already_applied' } };
			}
			if (current.length >= maxCodes) {
				set({ status: 'error', error: errorText('too_many_coupons'), errorCode: 'too_many_coupons' });
				return { ok: false, problem: { code: 'too_many_coupons' } };
			}
			set({ status: 'loading', error: null, errorCode: null, message: null });
			const result = await quoteFor([...current, code]);
			if (!result.ok) {
				set({ status: 'error', error: errorText(result.code), errorCode: result.code });
				return { ok: false, problem: { code: result.code } };
			}
			const quote = result.quote;
			const rejected = quote.rejected.find((entry) => entry.code.toUpperCase() === code.toUpperCase());
			if (rejected || !quote.applied.some((entry) => entry.code.toUpperCase() === code.toUpperCase())) {
				const reason = rejected?.reason ?? 'not_eligible';
				set({ status: 'error', error: errorText(reason), errorCode: reason });
				emit('apply_box.rejected', { reason });
				return { ok: false, problem: { code: reason } };
			}
			set({
				status: 'ready',
				code: '',
				applied: appliedOf(quote),
				quote,
				savingsText: savingsOf(quote),
				message: t('apply_box.applied', {
					code: code.toUpperCase(),
					amount: money(quote.discount + quote.shippingDiscount, quote.currency),
				}),
				error: null,
				errorCode: null,
			});
			emit('apply_box.applied', { codes: quote.applied.length });
			return { ok: true, value: quote };
		},
		/** @param {string} code */
		remove: async (code) => {
			const remaining = state.applied.map((entry) => entry.code).filter((entry) => entry !== code);
			set({ message: null });
			const result = await requote(remaining);
			emit('apply_box.removed', { codes: remaining.length });
			return result;
		},
		clear: async () => requote([]),
		/** Toggle the collapsible variant. */
		toggle: async () => {
			set({ expanded: !state.expanded });
			return { ok: true, value: state.expanded };
		},
		/**
		 * Auto-apply a code carried by a link (`?coupon=CODE`), when `auto_apply_from_url` is on.
		 * @param {unknown} href the page URL (passed in: no DOM access here)
		 */
		applyFromUrl: async (href) => {
			if (config.auto_apply_from_url === false) return { ok: false, problem: { code: 'disabled' } };
			const code = codeFromUrl(href, param);
			if (!code) return { ok: false, problem: { code: 'no_code' } };
			set({ code, expanded: true });
			return actions.apply();
		},
	});

	return Object.freeze({
		/** @returns {ApplyBoxState} immutable snapshot */
		state: () => state,
		actions,
		/**
		 * @param {(state: ApplyBoxState) => void} listener
		 * @returns {() => void}
		 */
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		validate,
		strings,
		t,
		formatMoney: money,
		destroy: () => {
			destroyed = true;
			listeners.clear();
		},
	});
};
