/**
 * The product grid with search, filters and sort (visitor widget `product_grid`, feature catalog; PLAN 0.8.8 Shopper
 * widgets, 0.8.10 E1, E2, E6, E8). Placed as `<div data-ss-ecommerce="product_grid" data-category="accessories"
 * data-brand="acme,zeta" data-grade="" data-attributes="" data-deal="" data-featured="" data-sort="newest" data-query=""
 * data-limit="24"></div>`: the data attributes are where the grid starts (`data-attributes`: field values by slug in
 * query form, for example `color=red,blue&size=m`, as a landing page by a field lists them); the shopper can change
 * everything.
 *
 * Filters (`./shop-filters.js`) come from the category tree (`GET /v1/shop/categories?include=coming_soon`: coming-soon
 * categories are shown as such and cannot be chosen), the category's brands (`GET /v1/shop/brands?category=`), the
 * deals (`GET /v1/shop/deals`, while `deals` is on) and the listing's facets: several brands, grades and attribute
 * values at once with their counts, the price range, in stock and featured. Sorts include recently updated and fewest
 * sold. Cards show the price range, Featured and a 2×2 grid of variant photos, link to the product page and carry the
 * wishlist and compare toggles while those features are on. The footer shows how many products match (`count=1`), page
 * numbers (`page=`) and Load more (the listing's cursor). The filters sit beside the products where the widget itself
 * is wide (a container query), and behind a Filters button where it is narrow.
 * @module
 */
import { fromDecimal } from '../core/money.js';
import { GROWTH_EVENTS } from '../core/growth-events.js';
import {
	MAX_PAGE_SIZE,
	announce,
	button,
	codeOf,
	currencyOf,
	field,
	formatsOf,
	h,
	keepFocus,
	mountShop,
	productCard,
	select,
	settingsOf,
	textsOf,
} from './shop-common.js';
import { compareIds, onCompareChange, toggleCompare } from './shop-compare-store.js';
import { activeCount, emptyKnown, filterControls, flattenCategories, listOf, remember } from './shop-filters.js';
import { savedOf } from './shop-saved.js';

/** The sorts of the listing (`GET /v1/shop/products?sort=`). */
export const GRID_SORTS = Object.freeze(['newest', 'price_asc', 'price_desc', 'top', 'rating', 'name', 'updated', 'sold_asc']);
/** The highest page number the listing takes. */
const MAX_PAGE_NUMBER = 500;
/** Deals read for the filter. */
const DEALS_READ = 50;

/** @typedef {import('./shop-filters.js').Filters} Filters */

/**
 * The page numbers shown: the first, the last and the ones around the current page; 0 marks a gap.
 * @param {number} current
 * @param {number} last
 * @returns {number[]}
 */
export const pageNumbers = (current, last) => {
	const wanted = [...new Set([1, current - 1, current, current + 1, last])]
		.filter((n) => n >= 1 && n <= last)
		.sort((a, b) => a - b);
	return wanted.flatMap((n, index) => (index > 0 && n - /** @type {number} */ (wanted[index - 1]) > 1 ? [0, n] : [n]));
};

/**
 * @param {import('./widget.js').VisitorMount} input
 * @returns {Promise<void>}
 */
export const mountProductGrid = async ({ host, config, shop, win }) => {
	const t = textsOf(config);
	const settings = settingsOf(config);
	const formats = formatsOf(config, win);
	const data = host.dataset;
	const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(data.limit) || settings.catalog.pageSize));
	const wishlistOn = shop.has('wishlist');
	const compareOn = shop.has('compare');
	const saved = savedOf(shop);
	/** @type {Filters} */
	const filters = {
		q: data.query ?? '',
		category: data.category ?? '',
		brands: listOf(data.brand),
		grades: listOf(data.grade),
		attributes: new Map(
			[...new URLSearchParams(data.attributes ?? '')]
				.map(([slug, values]) => /** @type {[string, string[]]} */ ([slug, listOf(values)]))
				.filter(([slug, values]) => slug !== '' && values.length > 0),
		),
		minPrice: '',
		maxPrice: '',
		inStock: false,
		featured: data.featured === '1' || data.featured === 'true',
		deal: data.deal ?? '',
		sort: GRID_SORTS.includes(data.sort ?? '') ? String(data.sort) : 'newest',
	};
	const known = emptyKnown();
	for (const grade of settings.catalog.grades) known.grades.set(grade.key, grade.label);
	/** @type {Set<string>} */
	const expanded = new Set();
	/** @type {any[]} */
	let items = [];
	/** @type {string | null} */
	let next = null;
	/** @type {any} */
	let facets = null;
	/** @type {{ total: number, capped: boolean } | null} */
	let found = null;
	/** the page of the first and of the last products shown */
	let firstPage = 1;
	let lastPage = 1;
	let currency = settings.currency;
	let state = /** @type {'loading' | 'ready' | 'error' | 'more'} */ ('loading');
	/** the words of a search its own box ran, until its answer is told to Growth @type {string | null} */
	let searching = null;
	let panelOpen = activeCount(filters) > 0;
	let seq = 0;
	let brandSeq = 0;

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
			const toggle = button(
				doc,
				t('grid.filters'),
				() => {
					panelOpen = !panelOpen;
					keepFocus(root, renderFilters);
				},
				{ class: 'secondary filter-toggle', 'aria-controls': 'ss-grid-filters', 'data-focus': 'filters' },
			);
			const form = h(
				doc,
				'form',
				{ class: 'toolbar', role: 'search' },
				field(doc, 'ss-grid-q', t('grid.search'), search),
				field(doc, 'ss-grid-sort', t('grid.sort'), sort),
				h(doc, 'button', { type: 'submit' }, t('grid.searchButton')),
				toggle,
			);
			const panel = h(doc, 'aside', { class: 'filter-panel', id: 'ss-grid-filters', 'aria-label': t('grid.filters') });
			const list = h(doc, 'ul', { class: 'grid', 'aria-label': t('grid.label') });
			const summary = h(doc, 'p', { class: 'meta' });
			const pages = h(doc, 'nav', { class: 'pages', 'aria-label': t('grid.pages') });
			const more = button(doc, t('grid.more'), () => void load('more'), { class: 'secondary more' });
			root.append(
				h(
					doc,
					'div',
					{ class: 'shop-frame' },
					form,
					h(
						doc,
						'div',
						{ class: 'listing' },
						panel,
						h(doc, 'div', { class: 'results' }, status, list, h(doc, 'div', { class: 'foot' }, summary, pages, more)),
					),
				),
			);

			form.addEventListener('submit', (event) => {
				event.preventDefault();
				const q = search.value.trim();
				if (q !== filters.q) forget();
				filters.q = q;
				// a search of its own box is told to Growth once it is answered (a search in the page's address is Growth's)
				searching = q || null;
				void load('filters');
			});
			sort.addEventListener('change', () => {
				filters.sort = sort.value;
				void load('filters');
			});

			/** @param {string} text */
			const say = (text) => {
				status.textContent = text;
			};

			/** Forget the values the facets named (the search or the category changed). */
			const forget = () => {
				known.attributes.clear();
				known.grades.clear();
				for (const grade of settings.catalog.grades) known.grades.set(grade.key, grade.label);
			};

			// ------------------------------------------------------------------------------------------- filters

			/**
			 * The query of the listing.
			 * @param {'filters' | 'page' | 'more'} mode
			 * @param {number} pageNo
			 */
			const queryOf = (mode, pageNo) => {
				const query = new URLSearchParams();
				if (filters.q) query.set('q', filters.q);
				if (filters.category) query.set('category', filters.category);
				if (filters.brands.length > 0) query.set('brand', filters.brands.join(','));
				if (filters.grades.length > 0) query.set('grade', filters.grades.join(','));
				for (const [slug, values] of filters.attributes) if (values.length > 0) query.set(`attr.${slug}`, values.join(','));
				const min = filters.minPrice ? fromDecimal(filters.minPrice, currency) : null;
				const max = filters.maxPrice ? fromDecimal(filters.maxPrice, currency) : null;
				if (min !== null) query.set('minPrice', String(min));
				if (max !== null) query.set('maxPrice', String(max));
				if (filters.inStock) query.set('inStock', 'true');
				if (filters.featured) query.set('featured', '1');
				if (filters.deal) query.set('deal', filters.deal);
				query.set('sort', filters.sort);
				query.set('limit', String(limit));
				if (mode === 'more' && next) query.set('cursor', next);
				if (mode === 'page') query.set('page', String(pageNo));
				if (mode === 'filters') query.set('count', '1');
				return query.toString();
			};

			/** Whether the typed prices are amounts. */
			const pricesValid = () =>
				[filters.minPrice, filters.maxPrice].every((value) => value === '' || fromDecimal(value, currency) !== null);

			const renderFilters = () => {
				const parts =
					facets || known.categories.length > 0 || known.brands.size > 0 || known.deals.length > 0
						? filterControls({
								doc,
								t,
								filters,
								facets,
								known,
								currency,
								expanded,
								onChange: (event, patch = {}) => {
									Object.assign(filters, patch);
									if (event === 'render') return keepFocus(root, renderFilters);
									if (event === 'category') {
										forget();
										void loadBrands();
									}
									if (event === 'price' && !pricesValid()) return say(t('grid.priceInvalid'));
									void load('filters');
								},
							})
						: [];
				const count = activeCount(filters);
				toggle.hidden = parts.length === 0;
				toggle.textContent = count > 0 ? t('grid.filtersCount', { count }) : t('grid.filters');
				toggle.setAttribute('aria-expanded', String(panelOpen));
				panel.hidden = parts.length === 0;
				panel.toggleAttribute('data-open', panelOpen);
				panel.replaceChildren(...parts);
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
				return productCard(doc, t, formats, item, actions);
			};

			/** The chosen category when it is coming soon (its products are not shown yet). */
			const comingSoon = () =>
				known.categories.find(
					(row) => row.status === 'coming_soon' && (row.id === filters.category || row.slug === filters.category),
				) ?? null;

			const renderFoot = () => {
				const pageCount = found ? Math.min(MAX_PAGE_NUMBER, Math.ceil(found.total / limit)) : 0;
				const from = (firstPage - 1) * limit + 1;
				summary.textContent =
					items.length === 0 || !found
						? ''
						: `${t('grid.showing', { from, to: from + items.length - 1 })} · ${t(
								found.capped ? 'grid.totalCapped' : 'grid.total',
								{ count: found.total },
							)}`;
				if (pageCount <= 1 || items.length === 0) {
					pages.replaceChildren();
					return;
				}
				/** @param {string} text @param {number} n @param {string} key @param {Record<string, string>} [attributes] */
				const go = (text, n, key, attributes = {}) =>
					button(doc, text, () => void load('page', n), { class: 'secondary', 'data-focus': `page.${key}`, ...attributes });
				const prev = go(t('grid.prevPage'), lastPage - 1, 'prev');
				const after = go(t('grid.nextPage'), lastPage + 1, 'next');
				prev.toggleAttribute('disabled', lastPage <= 1);
				after.toggleAttribute('disabled', lastPage >= pageCount);
				pages.replaceChildren(
					prev,
					...pageNumbers(lastPage, pageCount).map((n) =>
						n === 0
							? h(doc, 'span', { class: 'gap', 'aria-hidden': 'true' }, '…')
							: go(String(n), n, String(n), {
									'aria-label': t('grid.pageLabel', { n }),
									...(n === lastPage ? { 'aria-current': 'page' } : {}),
								}),
					),
					after,
				);
			};

			const renderList = () => {
				if (state === 'error' && items.length === 0) {
					list.replaceChildren();
					say(t('grid.error'));
				} else if (state === 'ready' && items.length === 0) {
					list.replaceChildren();
					const soon = comingSoon();
					say(soon ? t('grid.comingSoon', { name: soon.name }) : t('grid.empty'));
				} else {
					list.replaceChildren(...items.map(cardOf));
					say(state === 'loading' ? t('grid.loading') : state === 'error' ? t('grid.error') : '');
				}
				more.hidden = !next || state === 'loading';
				more.toggleAttribute('disabled', state === 'more');
				renderFoot();
				void marks();
			};

			/** Bring the top of the products into view after a page change (smoothly only when motion is welcome). */
			const toTop = () => {
				const still = win.matchMedia?.('(prefers-reduced-motion: reduce)').matches !== false;
				list.scrollIntoView?.({ block: 'start', behavior: still ? 'auto' : 'smooth' });
			};

			// ---------------------------------------------------------------------------------------------- load

			/**
			 * @param {'filters' | 'page' | 'more'} mode new filters (with the count), a page number, or the next products
			 * @param {number} [pageNo]
			 */
			const load = async (mode, pageNo = 1) => {
				if (!pricesValid()) return say(t('grid.priceInvalid'));
				seq += 1;
				const mine = seq;
				state = mode === 'more' ? 'more' : 'loading';
				if (mode === 'more') more.setAttribute('disabled', '');
				else say(t('grid.loading'));
				const answer = await shop.call(`/v1/shop/products?${queryOf(mode, pageNo)}`);
				if (mine !== seq) return;
				if (!answer.ok) {
					state = 'error';
					if (mode !== 'more') items = [];
					if (codeOf(answer) === 'validation_failed') say(t('grid.priceInvalid'));
					keepFocus(root, renderList);
					return;
				}
				const got = Array.isArray(answer.data.items) ? answer.data.items : [];
				items = mode === 'more' ? [...items, ...got] : got;
				next = answer.data.nextCursor ?? null;
				if (mode === 'more') lastPage += 1;
				else firstPage = lastPage = mode === 'page' ? pageNo : 1;
				if (typeof answer.data.total === 'number') found = { total: answer.data.total, capped: answer.data.capped === true };
				else if (mode === 'filters') found = null;
				if (answer.data.facets) {
					facets = answer.data.facets;
					remember(known, facets);
				}
				currency = currencyOf(settings, items[0]?.currency);
				if (searching !== null && mode === 'filters') {
					announce(win, GROWTH_EVENTS.search, { term: searching, results: found?.total ?? items.length });
					searching = null;
				}
				state = 'ready';
				keepFocus(root, () => {
					renderFilters();
					renderList();
				});
				if (mode === 'page') toTop();
			};

			/** The category tree (once). */
			const loadCategories = async () => {
				const answer = await shop.call('/v1/shop/categories?include=coming_soon');
				if (!answer.ok) return;
				known.categories = flattenCategories(answer.data.items);
				keepFocus(root, () => {
					renderFilters();
					renderList();
				});
			};

			/** The brands of the chosen category (all brands without one). */
			const loadBrands = async () => {
				brandSeq += 1;
				const mine = brandSeq;
				const query = filters.category ? `?category=${encodeURIComponent(filters.category)}` : '';
				const answer = await shop.call(`/v1/shop/brands${query}`);
				if (mine !== brandSeq || !answer.ok) return;
				known.brands = new Map(
					(answer.data.items ?? [])
						.filter((/** @type {any} */ brand) => brand.count > 0)
						.map((/** @type {any} */ brand) => [brand.slug, { id: brand.id, slug: brand.slug, name: brand.name }]),
				);
				if (facets) remember(known, facets);
				keepFocus(root, renderFilters);
			};

			/** The current deals (while deals are on). */
			const loadDeals = async () => {
				const answer = await shop.call(`/v1/shop/deals?limit=${DEALS_READ}`);
				if (!answer.ok) return;
				known.deals = (answer.data.items ?? []).map((/** @type {any} */ deal) => ({ id: deal.id, name: deal.name }));
				keepFocus(root, renderFilters);
			};

			const stops = [
				onCompareChange(win, () => void marks()),
				saved.onChange(() => void marks()),
				shop.onIdentity(() => void marks()),
			];
			renderFilters();
			void load('filters');
			void loadCategories();
			void loadBrands();
			if (shop.has('deals')) void loadDeals();
			return () => {
				for (const stop of stops) stop();
			};
		},
	});
};
