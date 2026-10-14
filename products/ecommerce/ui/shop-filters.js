/**
 * The product grid's filters (PLAN 0.8.10 E1, E2, E8): the category (from the category tree, coming-soon categories
 * shown as such and not chosen), several brands, grades and attribute values at once as checkbox lists with the
 * listing's facet counts (`attr.<slug>`, values by their labels), the price range, in stock, featured and a deal. The
 * lists keep what the shopper saw before a value was chosen (the brands of the category, the grades of the website and
 * the values the facets named since the search or category last changed), so choosing one value does not hide the
 * others; a value the latest facets do not name shows without a count. Long lists show their first values and a
 * Show all button.
 * @module
 */
import { toDecimal } from '../core/money.js';
import { button, field, h, select } from './shop-common.js';

/** @typedef {import('./shop-common.js').Texts} Texts */

/** Values a list shows before Show all. */
const SHORT_LIST = 8;

/**
 * What the grid filters by.
 * @typedef {object} Filters
 * @property {string} q
 * @property {string} category id or slug ('' = all)
 * @property {string[]} brands ids or slugs (any of them)
 * @property {string[]} grades grade keys (any of them)
 * @property {Map<string, string[]>} attributes attribute slug → values (any of them)
 * @property {string} minPrice as typed, in the shop's currency
 * @property {string} maxPrice
 * @property {boolean} inStock
 * @property {boolean} featured
 * @property {string} deal a deal id ('' = all products)
 * @property {string} sort
 */

/**
 * A category of the tree, flattened in order with its depth.
 * @typedef {{ id: string, slug: string, name: string, depth: number, status: string }} CategoryRow
 */

/**
 * What the grid knows of the catalog besides the latest facets.
 * @typedef {object} Known
 * @property {CategoryRow[]} categories
 * @property {Map<string, { id: string, slug: string, name: string }>} brands by slug
 * @property {Map<string, string>} grades key → label
 * @property {Map<string, { slug: string, name: string, unit: string, type: string, values: Map<string, string> }>} attributes
 *   by slug, values → label
 * @property {Array<{ id: string, name: string }>} deals
 */

/** @returns {Known} */
export const emptyKnown = () => ({
	categories: [],
	brands: new Map(),
	grades: new Map(),
	attributes: new Map(),
	deals: [],
});

/**
 * Comma-separated values (trimmed, empty ones left out).
 * @param {string | undefined} value
 */
export const listOf = (value) =>
	(value ?? '')
		.split(',')
		.map((part) => part.trim())
		.filter(Boolean);

/**
 * The category tree (`GET /v1/shop/categories`) in order, each with its depth.
 * @param {unknown} nodes
 * @param {number} [depth]
 * @returns {CategoryRow[]}
 */
export const flattenCategories = (nodes, depth = 0) =>
	(Array.isArray(nodes) ? nodes : []).flatMap((node) =>
		node && typeof node.id === 'string'
			? [
					{
						id: node.id,
						slug: String(node.slug ?? node.id),
						name: String(node.name ?? node.slug ?? node.id),
						depth,
						status: node.status === 'coming_soon' ? 'coming_soon' : 'active',
					},
					...flattenCategories(node.children, depth + 1),
				]
			: [],
	);

/**
 * Keep what the latest facets named (brands, grades, attribute values), so the lists stay while values are chosen.
 * @param {Known} known
 * @param {any} facets
 */
export const remember = (known, facets) => {
	for (const brand of facets?.brands ?? []) known.brands.set(brand.slug, { id: brand.id, slug: brand.slug, name: brand.name });
	for (const grade of facets?.grades ?? []) known.grades.set(grade.key, grade.label);
	for (const attribute of facets?.attributes ?? []) {
		const slug = String(attribute.slug ?? attribute.id);
		const kept = known.attributes.get(slug) ?? {
			slug,
			name: attribute.name,
			unit: attribute.unit ?? '',
			type: attribute.type,
			values: new Map(),
		};
		for (const entry of attribute.values ?? []) kept.values.set(String(entry.value), String(entry.label ?? entry.value));
		known.attributes.set(slug, kept);
	}
};

/**
 * How many filters are set (the filter button shows it).
 * @param {Filters} filters
 */
export const activeCount = (filters) =>
	[
		filters.category,
		filters.brands.length > 0,
		filters.grades.length > 0,
		filters.minPrice || filters.maxPrice,
		filters.inStock,
		filters.featured,
		filters.deal,
		...[...filters.attributes.values()].map((values) => values.length > 0),
	].filter(Boolean).length;

/**
 * Every filter cleared (the search and the sort stay).
 * @returns {Partial<Filters>}
 */
export const clearedFilters = () => ({
	category: '',
	brands: [],
	grades: [],
	attributes: new Map(),
	minPrice: '',
	maxPrice: '',
	inStock: false,
	featured: false,
	deal: '',
});

/** @param {string} value a value as a `data-focus` key part */
const focusKey = (value) => value.replace(/[^\w.:-]/g, '_');

/**
 * The filter controls.
 * @param {object} input
 * @param {Document} input.doc
 * @param {Texts} input.t
 * @param {Filters} input.filters
 * @param {any} input.facets the latest facets (null before the first answer)
 * @param {Known} input.known
 * @param {string} input.currency
 * @param {Set<string>} input.expanded lists showing all their values (kept across renders)
 * @param {(event: 'load' | 'category' | 'price' | 'render', patch?: Partial<Filters>) => void} input.onChange the
 *   filters change by `patch`; `category` reloads the brands too; `price` checks the typed prices first; `render` only
 *   draws the filters again (Show all)
 * @returns {HTMLElement[]}
 */
export const filterControls = ({ doc, t, filters, facets, known, currency, expanded, onChange }) => {
	/** @type {HTMLElement[]} */
	const parts = [];

	// the category: the tree when it was read, else the facets
	/** @type {Map<string, number>} */
	const categoryCounts = new Map((facets?.categories ?? []).map((/** @type {any} */ c) => [c.id, Number(c.count)]));
	/** @type {CategoryRow[]} */
	const tree =
		known.categories.length > 0
			? known.categories
			: (facets?.categories ?? []).map((/** @type {any} */ c) => ({
					id: c.id,
					slug: c.slug,
					name: c.name,
					depth: 0,
					status: 'active',
				}));
	if (tree.length > 0 || filters.category) {
		const chosen = tree.find((row) => row.id === filters.category || row.slug === filters.category);
		const control = /** @type {HTMLSelectElement} */ (h(doc, 'select', { 'data-focus': 'category' }));
		control.append(h(doc, 'option', { value: '' }, t('grid.allCategories')));
		for (const row of tree) {
			const soon = row.status === 'coming_soon';
			const count = categoryCounts.get(row.id);
			const name = soon
				? t('grid.comingSoonOption', { name: row.name })
				: count === undefined
					? row.name
					: t('grid.facetValue', { value: row.name, count });
			const option = h(doc, 'option', { value: row.slug }, `${' '.repeat(row.depth)}${name}`);
			if (soon && row !== chosen) option.setAttribute('disabled', '');
			control.append(option);
		}
		if (filters.category && !chosen) control.append(h(doc, 'option', { value: filters.category }, filters.category));
		control.value = chosen?.slug ?? filters.category;
		control.addEventListener('change', () => {
			onChange('category', { category: control.value });
		});
		parts.push(field(doc, 'ss-grid-category', t('grid.category'), control));
	}

	/**
	 * A checkbox list.
	 * @param {string} id
	 * @param {string} legend
	 * @param {Array<{ value: string, text: string, count: number | undefined, same?: string[] }>} rows `same`: other
	 *   spellings of the value that count as chosen (a brand's id)
	 * @param {string[]} chosen
	 * @param {(next: string[]) => Partial<Filters>} patch the change of the filters choosing `next`
	 */
	const checkList = (id, legend, rows, chosen, patch) => {
		const all = [...rows];
		for (const value of chosen)
			if (!all.some((row) => row.value === value || row.same?.includes(value)))
				all.push({ value, text: value, count: undefined });
		if (all.length === 0) return;
		const isChosen = (/** @type {(typeof all)[number]} */ row) =>
			chosen.includes(row.value) || Boolean(row.same?.some((other) => chosen.includes(other)));
		const open = expanded.has(id) || all.length <= SHORT_LIST + 1;
		const shown = open ? all : all.filter((row, index) => index < SHORT_LIST || isChosen(row));
		const boxes = shown.map((row) => {
			const box = /** @type {HTMLInputElement} */ (
				h(doc, 'input', { type: 'checkbox', 'data-focus': `${id}.${focusKey(row.value)}` })
			);
			box.checked = isChosen(row);
			box.addEventListener('change', () => {
				const rest = chosen.filter((value) => value !== row.value && !row.same?.includes(value));
				onChange('load', patch(box.checked ? [...rest, row.value] : rest));
			});
			return h(
				doc,
				'label',
				{ class: 'check' },
				box,
				row.count === undefined ? row.text : t('grid.facetValue', { value: row.text, count: row.count }),
			);
		});
		const toggle =
			all.length > SHORT_LIST + 1
				? button(
						doc,
						open ? t('grid.showFewer') : t('grid.showAll', { count: all.length }),
						() => {
							if (open) expanded.delete(id);
							else expanded.add(id);
							onChange('render');
						},
						{ class: 'link', 'aria-expanded': String(open), 'data-focus': `${id}.more` },
					)
				: null;
		parts.push(h(doc, 'fieldset', {}, h(doc, 'legend', {}, legend), h(doc, 'div', { class: 'values' }, ...boxes), toggle));
	};

	// brands: those of the category, then any the facets named
	/** @type {Map<string, number>} */
	const brandCounts = new Map((facets?.brands ?? []).map((/** @type {any} */ b) => [b.slug, Number(b.count)]));
	checkList(
		'brand',
		t('grid.brand'),
		[...known.brands.values()].map((brand) => ({
			value: brand.slug,
			text: brand.name,
			count: brandCounts.get(brand.slug),
			same: [brand.id],
		})),
		filters.brands,
		(next) => ({ brands: next }),
	);

	if (facets?.price || filters.minPrice || filters.maxPrice) {
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
				onChange('price', { [key]: input.value.trim() });
			});
			return input;
		};
		parts.push(
			h(
				doc,
				'div',
				{ class: 'row' },
				field(doc, 'ss-grid-min', t('grid.minPrice', { currency }), priceInput('minPrice', facets?.price?.min)),
				field(doc, 'ss-grid-max', t('grid.maxPrice', { currency }), priceInput('maxPrice', facets?.price?.max)),
			),
		);
	}

	// grades: the website's, then any the facets named
	/** @type {Map<string, number>} */
	const gradeCounts = new Map((facets?.grades ?? []).map((/** @type {any} */ g) => [g.key, Number(g.count)]));
	checkList(
		'grade',
		t('grid.grade'),
		[...known.grades.entries()].map(([key, label]) => ({ value: key, text: label, count: gradeCounts.get(key) })),
		filters.grades,
		(next) => ({ grades: next }),
	);

	// attributes by slug, their values by label
	/** @type {Map<string, Map<string, number>>} */
	const valueCounts = new Map(
		(facets?.attributes ?? []).map((/** @type {any} */ a) => [
			String(a.slug ?? a.id),
			new Map((a.values ?? []).map((/** @type {any} */ v) => [String(v.value), Number(v.count)])),
		]),
	);
	const slugs = new Set([...known.attributes.keys(), ...filters.attributes.keys()]);
	for (const slug of slugs) {
		const attribute = known.attributes.get(slug);
		/** @param {string} value @param {string} label */
		const shown = (value, label) => (attribute?.type === 'yes_no' ? t(value === 'true' ? 'shop.yes' : 'shop.no') : label);
		checkList(
			`attr.${slug}`,
			attribute?.name ?? slug,
			[...(attribute?.values.entries() ?? [])].map(([value, label]) => ({
				value,
				text: shown(value, label),
				count: valueCounts.get(slug)?.get(value),
			})),
			filters.attributes.get(slug) ?? [],
			(next) => ({ attributes: new Map(filters.attributes).set(slug, next) }),
		);
	}

	// a deal (while deals are on)
	if (known.deals.length > 0 || filters.deal) {
		/** @type {Array<[string, string]>} */
		const options = [
			['', t('grid.anyDeal')],
			...known.deals.map((deal) => /** @type {[string, string]} */ ([deal.id, deal.name])),
		];
		if (filters.deal && !known.deals.some((deal) => deal.id === filters.deal)) options.push([filters.deal, filters.deal]);
		const control = select(doc, options, filters.deal, { 'data-focus': 'deal' });
		control.addEventListener('change', () => {
			onChange('load', { deal: control.value });
		});
		parts.push(field(doc, 'ss-grid-deal', t('grid.deal'), control));
	}

	/** @param {'inStock' | 'featured'} key @param {string} text */
	const flag = (key, text) => {
		const box = /** @type {HTMLInputElement} */ (h(doc, 'input', { type: 'checkbox', 'data-focus': key }));
		box.checked = filters[key];
		box.addEventListener('change', () => {
			onChange('load', { [key]: box.checked });
		});
		return h(doc, 'label', { class: 'check' }, box, text);
	};
	parts.push(h(doc, 'div', { class: 'flags' }, flag('inStock', t('grid.inStock')), flag('featured', t('grid.featured'))));

	if (activeCount(filters) > 0)
		parts.push(
			button(doc, t('grid.clearFilters'), () => onChange('category', clearedFilters()), {
				class: 'secondary',
				'data-focus': 'clear',
			}),
		);
	return parts;
};
