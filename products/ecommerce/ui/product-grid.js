/**
 * The product grid with search, filters and sort (visitor widget `product_grid`, feature catalog; PLAN 0.8.8 Shopper
 * widgets). Placed as `<div data-ss-ecommerce="product_grid" data-category="phones" data-brand="" data-query=""
 * data-limit="24"></div>`: the data attributes are where the grid starts; the shopper can change everything. Filters
 * come from the listing's facets (categories, brands, price range, in stock, filterable attributes, grades); cards
 * link to the product page and carry the wishlist and compare toggles while those features are on. More products load
 * with the listing's cursor.
 * @module
 */
import { fromDecimal, toDecimal } from '../core/money.js';
import {
	button,
	codeOf,
	currencyOf,
	field,
	h,
	keepFocus,
	mountShop,
	productCard,
	select,
	settingsOf,
	textsOf,
} from './shop-common.js';
import { compareIds, onCompareChange, toggleCompare } from './shop-compare-store.js';
import { savedOf } from './shop-saved.js';

/** The sorts of the listing (`GET /v1/shop/products?sort=`). */
export const GRID_SORTS = Object.freeze(['newest', 'price_asc', 'price_desc', 'top', 'rating', 'name']);
/** Most products asked for at once (the listing's own limit). */
const MAX_LIMIT = 48;

/**
 * @typedef {object} Filters
 * @property {string} q
 * @property {string} category id or slug ('' = all)
 * @property {string} brand id or slug ('' = all)
 * @property {string} minPrice as typed, in the shop's currency
 * @property {string} maxPrice
 * @property {boolean} inStock
 * @property {Map<string, Set<string>>} attributes attribute id → values
 * @property {string} grade grade key ('' = all)
 * @property {string} sort
 */

/**
 * @param {import('./widget.js').VisitorMount} input
 * @returns {Promise<void>}
 */
export const mountProductGrid = async ({ host, config, shop, win }) => {
	const t = textsOf(config);
	const settings = settingsOf(config);
	const data = host.dataset;
	const limit = Math.min(MAX_LIMIT, Math.max(1, Number(data.limit) || settings.catalog.pageSize));
	const wishlistOn = shop.has('wishlist');
	const compareOn = shop.has('compare');
	const saved = savedOf(shop);
	/** @type {Filters} */
	const filters = {
		q: data.query ?? '',
		category: data.category ?? '',
		brand: data.brand ?? '',
		minPrice: '',
		maxPrice: '',
		inStock: false,
		attributes: new Map(),
		grade: '',
		sort: 'newest',
	};
	/** @type {any[]} */
	let items = [];
	/** @type {string | null} */
	let next = null;
	/** @type {any} */
	let facets = null;
	let currency = settings.currency;
	let state = /** @type {'loading' | 'ready' | 'error' | 'more'} */ ('loading');
	let seq = 0;

	mountShop({
		host,
		config,
		name: 'product-grid',
		render: (root) => {
			const doc = root.ownerDocument;
			const status = h(doc, 'p', { class: 'status', role: 'status' });
			const search = /** @type {HTMLInputElement} */ (
				h(doc, 'input', { type: 'search', maxlength: '200', placeholder: t('grid.searchPlaceholder'), 'data-focus': 'q' })
			);
			search.value = filters.q;
			const sort = select(
				doc,
				GRID_SORTS.map((key) => [key, t(`grid.sort.${key}`)]),
				filters.sort,
			);
			const form = h(
				doc,
				'form',
				{ class: 'toolbar', role: 'search' },
				field(doc, 'ss-grid-q', t('grid.search'), search),
				field(doc, 'ss-grid-sort', t('grid.sort'), sort),
				h(doc, 'button', { type: 'submit' }, t('grid.searchButton')),
			);
			const filterBox = h(doc, 'div');
			const list = h(doc, 'ul', { class: 'grid', 'aria-label': t('grid.label') });
			const more = button(doc, t('grid.more'), () => void load(true), { class: 'secondary more' });
			root.append(form, filterBox, status, list, more);

			form.addEventListener('submit', (event) => {
				event.preventDefault();
				filters.q = search.value.trim();
				void load(false);
			});
			sort.addEventListener('change', () => {
				filters.sort = sort.value;
				void load(false);
			});

			/** @param {string} text */
			const say = (text) => {
				status.textContent = text;
			};

			// ------------------------------------------------------------------------------------------- filters

			/** The query of the listing. @param {boolean} after */
			const queryOf = (after) => {
				const query = new URLSearchParams();
				if (filters.q) query.set('q', filters.q);
				if (filters.category) query.set('category', filters.category);
				if (filters.brand) query.set('brand', filters.brand);
				const min = filters.minPrice ? fromDecimal(filters.minPrice, currency) : null;
				const max = filters.maxPrice ? fromDecimal(filters.maxPrice, currency) : null;
				if (min !== null) query.set('minPrice', String(min));
				if (max !== null) query.set('maxPrice', String(max));
				if (filters.inStock) query.set('inStock', 'true');
				for (const [id, values] of filters.attributes) if (values.size > 0) query.set(`attr.${id}`, [...values].join(','));
				if (filters.grade) query.set('grade', filters.grade);
				query.set('sort', filters.sort);
				query.set('limit', String(limit));
				if (after && next) query.set('cursor', next);
				return query.toString();
			};

			/** Whether the typed prices are amounts. */
			const pricesValid = () =>
				[filters.minPrice, filters.maxPrice].every((value) => value === '' || fromDecimal(value, currency) !== null);

			/**
			 * A select of facet values, keeping the chosen one even when the facets no longer list it.
			 * @param {string} id
			 * @param {string} label
			 * @param {string} all
			 * @param {Array<{ id: string, slug: string, name: string, count: number }>} rows
			 * @param {'category' | 'brand'} key
			 */
			const facetSelect = (id, label, all, rows, key) => {
				/** @type {Array<[string, string]>} */
				const options = [
					['', all],
					...rows.map((row) => /** @type {[string, string]} */ ([row.slug, `${row.name} (${row.count})`])),
				];
				const chosen = filters[key];
				if (chosen && !rows.some((row) => row.slug === chosen || row.id === chosen)) options.push([chosen, chosen]);
				const value = rows.find((row) => row.id === chosen)?.slug ?? chosen;
				const control = select(doc, options, value, { 'data-focus': key });
				control.addEventListener('change', () => {
					filters[key] = control.value;
					void load(false);
				});
				return field(doc, id, label, control);
			};

			const renderFilters = () => {
				if (!facets) {
					filterBox.replaceChildren();
					return;
				}
				const parts = [];
				if (facets.categories.length > 0 || filters.category)
					parts.push(
						facetSelect('ss-grid-category', t('grid.category'), t('grid.allCategories'), facets.categories, 'category'),
					);
				if (facets.brands.length > 0 || filters.brand)
					parts.push(facetSelect('ss-grid-brand', t('grid.brand'), t('grid.allBrands'), facets.brands, 'brand'));
				if (facets.price || filters.minPrice || filters.maxPrice) {
					/** @param {'minPrice' | 'maxPrice'} key @param {number | undefined} bound */
					const priceInput = (key, bound) => {
						const input = /** @type {HTMLInputElement} */ (
							h(doc, 'input', {
								inputmode: 'decimal',
								'data-focus': key,
								placeholder: bound === undefined ? '' : toDecimal(bound, currency),
							})
						);
						input.value = filters[key];
						input.addEventListener('change', () => {
							filters[key] = input.value.trim();
							if (!pricesValid()) return say(t('grid.priceInvalid'));
							void load(false);
						});
						return input;
					};
					parts.push(
						h(
							doc,
							'div',
							{ class: 'row' },
							field(doc, 'ss-grid-min', t('grid.minPrice', { currency }), priceInput('minPrice', facets.price?.min)),
							field(doc, 'ss-grid-max', t('grid.maxPrice', { currency }), priceInput('maxPrice', facets.price?.max)),
						),
					);
				}
				const stock = /** @type {HTMLInputElement} */ (h(doc, 'input', { type: 'checkbox', 'data-focus': 'inStock' }));
				stock.checked = filters.inStock;
				stock.addEventListener('change', () => {
					filters.inStock = stock.checked;
					void load(false);
				});
				parts.push(h(doc, 'label', { class: 'check' }, stock, t('grid.inStock')));
				for (const attribute of facets.attributes) {
					const chosen = filters.attributes.get(attribute.id) ?? new Set();
					const boxes = attribute.values.map((/** @type {{ value: unknown, count: number }} */ entry) => {
						const value = String(entry.value);
						const box = /** @type {HTMLInputElement} */ (
							h(doc, 'input', {
								type: 'checkbox',
								'data-focus': `attr.${attribute.id}.${value.replace(/[^\w.:-]/g, '_')}`,
							})
						);
						box.checked = chosen.has(value);
						box.addEventListener('change', () => {
							const set = new Set(filters.attributes.get(attribute.id) ?? []);
							if (box.checked) set.add(value);
							else set.delete(value);
							filters.attributes.set(attribute.id, set);
							void load(false);
						});
						const shown =
							attribute.type === 'boolean'
								? t(value === 'true' ? 'shop.yes' : 'shop.no')
								: attribute.unit
									? `${value} ${attribute.unit}`
									: value;
						return h(doc, 'label', { class: 'check' }, box, t('grid.facetValue', { value: shown, count: entry.count }));
					});
					parts.push(
						h(doc, 'fieldset', {}, h(doc, 'legend', {}, attribute.name), h(doc, 'div', { class: 'values' }, ...boxes)),
					);
				}
				if (facets.grades.length > 0 || filters.grade) {
					const control = select(
						doc,
						[
							['', t('grid.allGrades')],
							...facets.grades.map(
								(/** @type {{ key: string, label: string, count: number }} */ grade) =>
									/** @type {[string, string]} */ ([grade.key, `${grade.label} (${grade.count})`]),
							),
						],
						filters.grade,
						{ 'data-focus': 'grade' },
					);
					control.addEventListener('change', () => {
						filters.grade = control.value;
						void load(false);
					});
					parts.push(field(doc, 'ss-grid-grade', t('grid.grade'), control));
				}
				const active =
					Boolean(filters.category || filters.brand || filters.minPrice || filters.maxPrice || filters.grade) ||
					filters.inStock ||
					[...filters.attributes.values()].some((set) => set.size > 0);
				if (active)
					parts.push(
						button(
							doc,
							t('grid.clearFilters'),
							() => {
								Object.assign(filters, {
									category: '',
									brand: '',
									minPrice: '',
									maxPrice: '',
									inStock: false,
									grade: '',
								});
								filters.attributes = new Map();
								void load(false);
							},
							{ class: 'secondary', 'data-focus': 'clear' },
						),
					);
				const details = h(doc, 'details', { class: 'filters' }, h(doc, 'summary', {}, t('grid.filters')), ...parts);
				if (active) details.setAttribute('open', '');
				filterBox.replaceChildren(details);
			};

			// --------------------------------------------------------------------------------------------- cards

			/** Mark the cards' wishlist and compare toggles. */
			const marks = async () => {
				const compared = compareIds(win);
				for (const node of list.querySelectorAll('[data-compare]'))
					node.setAttribute('aria-pressed', String(compared.includes(String(node.getAttribute('data-compare')))));
				if (!wishlistOn) return;
				const ids = await saved.ids();
				for (const node of list.querySelectorAll('[data-wish]')) {
					const on = ids.has(String(node.getAttribute('data-wish')));
					node.setAttribute('aria-pressed', String(on));
					node.textContent = t(on ? 'grid.saved' : 'grid.save');
				}
			};

			/** @param {any} item */
			const cardOf = (item) => {
				const actions = [];
				if (wishlistOn)
					actions.push(
						button(
							doc,
							t('grid.save'),
							async () => {
								if (!shop.signIn()) return say(t('wishlist.signIn'));
								const done = await saved.toggle(item.id);
								say(
									done.ok
										? t(done.saved ? 'wishlist.added' : 'wishlist.removed', { name: item.name })
										: t('wishlist.failed'),
								);
							},
							{
								class: 'icon',
								'data-wish': item.id,
								'aria-pressed': 'false',
								'aria-label': t('grid.saveLabel', { name: item.name }),
							},
						),
					);
				if (compareOn)
					actions.push(
						button(
							doc,
							t('grid.compare'),
							() => {
								const done = toggleCompare(win, item.id, settings.compare.max);
								if (!done.ok) say(t('compare.full', { max: settings.compare.max }));
							},
							{
								class: 'icon',
								'data-compare': item.id,
								'aria-pressed': 'false',
								'aria-label': t('grid.compareLabel', { name: item.name }),
							},
						),
					);
				return productCard(doc, t, item, actions);
			};

			const renderList = () => {
				if (state === 'error' && items.length === 0) {
					list.replaceChildren();
					say(t('grid.error'));
				} else if (state === 'ready' && items.length === 0) {
					list.replaceChildren();
					say(t('grid.empty'));
				} else {
					list.replaceChildren(...items.map(cardOf));
					say(state === 'loading' ? t('grid.loading') : state === 'error' ? t('grid.error') : '');
				}
				more.hidden = !next || state === 'loading';
				more.toggleAttribute('disabled', state === 'more');
				void marks();
			};

			// ---------------------------------------------------------------------------------------------- load

			/** @param {boolean} after load the next page */
			const load = async (after) => {
				if (!pricesValid()) return say(t('grid.priceInvalid'));
				seq += 1;
				const mine = seq;
				state = after ? 'more' : 'loading';
				if (after) more.setAttribute('disabled', '');
				else say(t('grid.loading'));
				const answer = await shop.call(`/v1/shop/products?${queryOf(after)}`);
				if (mine !== seq) return;
				if (!answer.ok) {
					state = 'error';
					if (!after) items = [];
					if (codeOf(answer) === 'validation_failed') say(t('grid.priceInvalid'));
					keepFocus(root, renderList);
					return;
				}
				items = after ? [...items, ...answer.data.items] : answer.data.items;
				next = answer.data.next ?? null;
				if (answer.data.facets) facets = answer.data.facets;
				currency = currencyOf(settings, items[0]?.currency);
				state = 'ready';
				keepFocus(root, () => {
					renderFilters();
					renderList();
				});
			};

			const stops = [
				onCompareChange(win, () => void marks()),
				saved.onChange(() => void marks()),
				shop.onIdentity(() => void marks()),
			];
			void load(false);
			return () => {
				for (const stop of stops) stop();
			};
		},
	});
};
