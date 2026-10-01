/**
 * Mode B headless core of the `widget` element: state, actions, subscribe, validate, strings, destroy (Part E §4).
 * Framework-agnostic and DOM-free. `client` is the element's Mode C client (`GET /v1/widgets/:configurator` and
 * `POST /v1/evaluations` with the website's `pk_` key), so every resolution, price and URL is the server's — the
 * default renderer (ui/configurator.js) and any merchant-built UI use exactly this core.
 *
 * URL sync goes through the injected `url` port (`read()` → the page's query string, `write(search, mode)`), so the
 * core never touches `location` or `history` itself.
 */
import { formatMoney } from '../core/money.js';
import { createTranslator } from './strings.js';

/** @typedef {{ type?: string, title?: string, status?: number, detail?: string, code?: string }} Problem */
/**
 * @template T
 * @typedef {{ ok: true, value: T } | { ok: false, problem?: Problem, error?: Problem }} Result
 */
/**
 * @typedef {object} Evaluation `POST /v1/evaluations`
 * @property {Record<string, string | string[] | number>} selection
 * @property {boolean} complete
 * @property {string[]} missing
 * @property {Array<{ group: string, from: unknown, to: unknown, reason: string }>} adjusted
 * @property {string[]} applicable
 * @property {{ id: string, sku: string | null, inStock: boolean } | null} combination
 * @property {boolean} inStock
 * @property {number} quantity
 * @property {Array<{ key: string, applicable: boolean, options: Array<{ key: string, state: string }> }>} states
 * @property {{ currency: string | null, unit: number, total: number, quantity: number } | null} price
 * @property {{ search: string, history: 'replace' | 'push' } | null} url
 * @property {Record<string, unknown> | null} notify
 */
/**
 * @typedef {object} WidgetBootstrap `GET /v1/widgets/:configurator`
 * @property {{ id: string, key: string | null, name: string, version: number, schema: { groups: any[] } }} configurator
 * @property {{ layout: string, showPrice: boolean, showSummary: boolean, showOutOfStock: boolean, showAdjustments: boolean,
 *   urlSync: boolean, history: 'replace' | 'push', inStock: string }} settings
 * @property {Evaluation | null} evaluation
 * @property {{ code: string } | null} problem
 */
/**
 * @typedef {{ widget: (ref: string, query: { search: string }) => Promise<Result<WidgetBootstrap>>,
 *   evaluate: (body: Record<string, unknown>) => Promise<Result<Evaluation>> }} ConfiguratorClient
 */
/** @typedef {{ read: () => string, write: (search: string, mode: 'replace' | 'push') => void }} UrlPort */
/**
 * @typedef {object} OptionView
 * @property {string} key
 * @property {string} label
 * @property {string | null} description
 * @property {string | null} swatch
 * @property {string | null} image
 * @property {'selected' | 'available' | 'out_of_stock' | 'conflict'} state
 * @property {boolean} selected
 * @property {boolean} disabled cannot be picked (out of stock while stock is required)
 * @property {string | null} stateText
 */
/**
 * @typedef {object} GroupView
 * @property {string} key
 * @property {string} label
 * @property {string | null} description
 * @property {'single' | 'multi' | 'range' | 'text'} type
 * @property {'pills' | 'dropdown' | 'swatches'} display
 * @property {boolean} required
 * @property {unknown} value
 * @property {OptionView[]} options
 * @property {number | null} min
 * @property {number | null} max
 * @property {number | null} step
 * @property {number | null} maxLength
 */
/**
 * @typedef {object} ConfiguratorState
 * @property {'idle' | 'loading' | 'ready' | 'error'} status
 * @property {boolean} busy an evaluation is in flight
 * @property {string | null} configuratorId
 * @property {string} title
 * @property {GroupView[]} groups applicable groups, in order
 * @property {Record<string, unknown>} selection
 * @property {boolean} complete
 * @property {string | null} missingText
 * @property {boolean} inStock
 * @property {string | null} outOfStockText
 * @property {Record<string, unknown> | null} notify
 * @property {string | null} priceText
 * @property {Evaluation['price']} price
 * @property {Array<{ label: string, value: string }>} summary
 * @property {string | null} notice what the resolver changed, and why
 * @property {string | null} error
 * @property {boolean} showPrice
 * @property {boolean} showSummary
 * @property {boolean} requireStock
 */

/**
 * @param {{ config?: Record<string, unknown>, strings?: Record<string, string>, client: ConfiguratorClient,
 *   configurator: string, url?: UrlPort | null, emit?: (name: string, data: Record<string, unknown>) => void }} options
 *   `config` = the widget element's feature values (the bootstrap's settings win)
 */
export const createConfigurator = ({ config = {}, strings = {}, client, configurator, url = null, emit = () => {} }) => {
	const t = createTranslator(strings);
	const locale = strings['widget.locale'] || 'en';
	/** @type {Set<(state: ConfiguratorState) => void>} */
	const listeners = new Set();
	let destroyed = false;
	let sequence = 0;
	/** @type {WidgetBootstrap | null} */
	let boot = null;
	/** @type {ConfiguratorState} */
	let state = Object.freeze({
		status: 'idle',
		busy: false,
		configuratorId: null,
		title: t('widget.title'),
		groups: [],
		selection: {},
		complete: false,
		missingText: null,
		inStock: true,
		outOfStockText: null,
		notify: null,
		priceText: null,
		price: null,
		summary: [],
		notice: null,
		error: null,
		showPrice: config.show_price !== false,
		showSummary: config.show_summary !== false,
		requireStock: false,
	});
	/** @param {Partial<ConfiguratorState>} patch */
	const set = (patch) => {
		if (destroyed) return;
		state = Object.freeze({ ...state, ...patch });
		for (const listener of listeners) listener(state);
	};
	/** @param {Problem | undefined} problem */
	const message = (problem) => {
		const code = problem?.code;
		return t(code === 'not_found' || code === 'no_valid_combination' ? `widget.error.${code}` : 'widget.error.request_failed');
	};

	const schemaGroups = () => /** @type {any[]} */ (boot?.configurator.schema.groups ?? []);
	/** @param {string} key */
	const groupOf = (key) => schemaGroups().find((group) => group.key === key);
	/** Text of a value for notices and the summary. @param {any} group @param {unknown} value */
	const valueText = (group, value) => {
		const label = (/** @type {unknown} */ key) =>
			group?.options?.find((/** @type {any} */ o) => o.key === key)?.label ?? String(key);
		if (Array.isArray(value)) return value.length > 0 ? value.map(label).join(t('widget.list.separator')) : t('widget.none');
		if (value === null || value === undefined || value === '') return t('widget.none');
		return group?.type === 'single' ? label(value) : String(value);
	};

	/** @param {Evaluation} evaluation */
	const apply = (evaluation) => {
		const settings = /** @type {WidgetBootstrap} */ (boot).settings;
		const requireStock = settings.inStock === 'require';
		const applicable = new Set(evaluation.applicable);
		const layout = settings.layout ?? config.layout ?? 'pills';
		/** @type {GroupView[]} */
		const groups = schemaGroups()
			.filter((group) => applicable.has(group.key))
			.map((group) => {
				const states = new Map(
					(evaluation.states.find((entry) => entry.key === group.key)?.options ?? []).map((o) => [o.key, o.state]),
				);
				const hasSwatches = group.options.some((/** @type {any} */ o) => o.swatch || o.image);
				const display =
					group.display ??
					(layout === 'dropdowns' ? 'dropdown' : layout === 'swatches' && hasSwatches ? 'swatches' : 'pills');
				const options = group.options
					.filter((/** @type {any} */ option) => !option.hidden)
					.map((/** @type {any} */ option) => {
						const optionState = /** @type {OptionView['state']} */ (states.get(option.key) ?? 'available');
						return {
							key: option.key,
							label: option.label,
							description: option.description ?? null,
							swatch: option.swatch ?? null,
							image: option.image ?? null,
							state: optionState,
							selected: optionState === 'selected',
							disabled: optionState === 'out_of_stock' && requireStock,
							stateText:
								optionState === 'out_of_stock'
									? t('widget.state.out_of_stock')
									: optionState === 'conflict'
										? t('widget.state.conflict')
										: null,
						};
					})
					.filter(
						(/** @type {OptionView} */ option) =>
							settings.showOutOfStock || option.state !== 'out_of_stock' || option.selected,
					);
				return {
					key: group.key,
					label: group.label,
					description: group.description ?? null,
					type: group.type,
					display,
					required: group.required,
					value: evaluation.selection[group.key] ?? null,
					options,
					min: group.min ?? null,
					max: group.max ?? null,
					step: group.step ?? null,
					maxLength: group.maxLength ?? null,
				};
			});
		const changes = evaluation.adjusted.map((change) => {
			const group = groupOf(change.group);
			return change.to === null
				? t('widget.notice.removed', { group: group?.label ?? change.group })
				: t('widget.notice.change', { group: group?.label ?? change.group, value: valueText(group, change.to) });
		});
		const price = evaluation.price;
		const priceText = price
			? price.quantity > 1
				? t('widget.price.total', {
						quantity: price.quantity,
						unit: formatMoney(price.unit, price.currency, locale),
						total: formatMoney(price.total, price.currency, locale),
					})
				: formatMoney(price.unit, price.currency, locale)
			: null;
		set({
			status: 'ready',
			busy: false,
			groups,
			selection: evaluation.selection,
			complete: evaluation.complete,
			missingText:
				evaluation.missing.length > 0
					? t('widget.missing', {
							groups: evaluation.missing.map((key) => groupOf(key)?.label ?? key).join(t('widget.list.separator')),
						})
					: null,
			inStock: evaluation.inStock,
			outOfStockText: evaluation.inStock ? null : t('widget.out_of_stock'),
			notify: evaluation.notify,
			priceText,
			price,
			summary: groups.map((group) => ({ label: group.label, value: valueText(groupOf(group.key), group.value) })),
			notice:
				settings.showAdjustments && changes.length > 0
					? t('widget.notice.adjusted', { changes: changes.join(t('widget.list.separator')) })
					: null,
			error: null,
			showPrice: settings.showPrice && price !== null,
			showSummary: settings.showSummary,
			requireStock,
		});
		if (settings.urlSync && evaluation.url && url) url.write(evaluation.url.search, evaluation.url.history ?? settings.history);
	};

	/**
	 * Evaluate a selection after a change of `changed`.
	 * @param {Record<string, unknown>} selection
	 * @param {string} changed
	 * @returns {Promise<Result<Evaluation>>}
	 */
	const evaluate = async (selection, changed) => {
		if (!boot) return { ok: false, problem: { code: 'not_loaded' } };
		const mine = (sequence += 1);
		set({ busy: true, selection });
		const result = await client.evaluate({
			configurator: boot.configurator.id,
			selection,
			changed,
			...(url ? { search: url.read() } : {}),
		});
		if (mine !== sequence) return result; // a newer pick superseded this one
		if (result.ok) {
			apply(result.value);
			emit('widget.changed', { group: changed, complete: result.value.complete, inStock: result.value.inStock });
		} else set({ busy: false, error: message(result.problem ?? result.error) });
		return result;
	};

	const actions = Object.freeze({
		/** Load the configurator and evaluate the page's URL. @returns {Promise<Result<WidgetBootstrap>>} */
		load: async () => {
			set({ status: 'loading', error: null });
			const result = await client.widget(configurator, { search: url ? url.read() : '' });
			if (!result.ok) {
				set({ status: 'error', error: message(result.problem ?? result.error) });
				return result;
			}
			boot = result.value;
			set({ configuratorId: boot.configurator.id, title: boot.configurator.name });
			if (boot.evaluation) apply(boot.evaluation);
			else set({ status: 'error', error: message(/** @type {Problem} */ (boot.problem ?? undefined)) });
			return result;
		},
		/**
		 * Pick an option (single choice) or set a value (range, text); `null` clears an optional group.
		 * @param {string} group
		 * @param {unknown} value
		 */
		pick: (group, value) => evaluate({ ...state.selection, [group]: value }, group),
		/**
		 * Add or remove an option of a multi-choice group.
		 * @param {string} group
		 * @param {string} option
		 */
		toggle: (group, option) => {
			const current = state.selection[group];
			const list = Array.isArray(current) ? current : [];
			return evaluate(
				{ ...state.selection, [group]: list.includes(option) ? list.filter((key) => key !== option) : [...list, option] },
				group,
			);
		},
		/** Back to the defaults (every group cleared, so URL parameters do not bring the old picks back). */
		reset: () => evaluate(Object.fromEntries(schemaGroups().map((group) => [group.key, null])), ''),
		/** Hand the out-of-stock combination to a notify-me form (emits `widget.notify_requested`). */
		requestNotify: async () => {
			if (!state.notify) return { ok: /** @type {const} */ (false), problem: { code: 'in_stock' } };
			emit('widget.notify_requested', state.notify);
			return { ok: /** @type {const} */ (true), value: state.notify };
		},
	});

	return Object.freeze({
		/** @returns {ConfiguratorState} immutable snapshot */
		state: () => state,
		actions,
		/**
		 * @param {(state: ConfiguratorState) => void} listener
		 * @returns {() => void}
		 */
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		/**
		 * Field problems of a pick before it is sent: an unknown group or option, a number out of range, text too long.
		 * @param {unknown} input `{ group, value }`
		 * @returns {Array<{ path: string, code: string, message: string }>}
		 */
		validate: (input) => {
			const { group: key, value } = /** @type {{ group?: unknown, value?: unknown }} */ (input ?? {});
			const group = typeof key === 'string' ? groupOf(key) : undefined;
			if (!group) return [{ path: '/group', code: 'unknown_group', message: t('widget.error.invalid') }];
			if (value === null) return [];
			const known = (/** @type {unknown} */ k) => group.options?.some((/** @type {any} */ o) => o.key === k);
			const valid =
				group.type === 'single'
					? known(value)
					: group.type === 'multi'
						? Array.isArray(value) && value.every(known)
						: group.type === 'range'
							? typeof value === 'number' && value >= group.min && value <= group.max
							: typeof value === 'string' && value.length <= group.maxLength;
			return valid ? [] : [{ path: '/value', code: 'invalid', message: t('widget.error.invalid') }];
		},
		strings,
		t,
		destroy: () => {
			destroyed = true;
			listeners.clear();
		},
	});
};
