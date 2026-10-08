/**
 * Products and catalog (admin widget `catalog_admin`, ticket with `catalog.edit`; PLAN 0.8.8): the product list with
 * search, status, category, brand and low-stock filters and Load more; bulk changes of the selected products (Bulk
 * actions); the product editor (`./admin-product.js`); and tabs for categories, brands, attributes, locations
 * (Multi-location stock) and serial numbers (Grades and serials) (`./admin-taxonomy.js`).
 * @module
 */
import { mountAdmin, query } from './admin-kit.js';
import { productEditor } from './admin-product.js';
import {
	attributesTab,
	brandsTab,
	categoriesTab,
	categoryChoices,
	createLookups,
	locationsTab,
	serialsTab,
} from './admin-taxonomy.js';

/** @typedef {import('./admin-kit.js').Kit} Kit */
/** @typedef {import('./admin-taxonomy.js').Lookups} Lookups */

/** Bulk changes of products. */
const BULK_ACTIONS = Object.freeze(['status', 'price', 'stock', 'add_category', 'remove_category']);

/**
 * @param {import('./widget.js').AdminMount} input
 * @returns {Promise<void>}
 */
export const mountCatalogAdmin = async (input) => {
	mountAdmin(input, 'catalog-admin', 'catalogAdmin.title', (kit, box) => {
		const { t, has } = kit;
		const lookups = createLookups(kit);
		const ready = lookups.reload();
		box.append(
			kit.tabs([
				{
					key: 'products',
					label: t('catalogAdmin.products'),
					render: (panel) => void ready.then(() => productsTab(kit, panel, lookups)),
				},
				{ key: 'categories', label: t('catalogAdmin.categories'), render: (panel) => categoriesTab(kit, panel, lookups) },
				{ key: 'brands', label: t('catalogAdmin.brands'), render: (panel) => brandsTab(kit, panel, lookups) },
				{ key: 'attributes', label: t('catalogAdmin.attributes'), render: (panel) => attributesTab(kit, panel, lookups) },
				...(has('multi_location')
					? [
							{
								key: 'locations',
								label: t('catalogAdmin.locations'),
								render: (/** @type {HTMLElement} */ panel) => locationsTab(kit, panel, lookups),
							},
						]
					: []),
				...(has('grades_serials')
					? [
							{
								key: 'serials',
								label: t('catalogAdmin.serials'),
								render: (/** @type {HTMLElement} */ panel) => void ready.then(() => serialsTab(kit, panel, lookups)),
							},
						]
					: []),
			]),
		);
	});
};

/**
 * The products tab: filters, the list with Load more, bulk changes and the editor.
 * @param {Kit} kit @param {HTMLElement} panel @param {Lookups} lookups
 */
const productsTab = (kit, panel, lookups) => {
	const { t, h, has } = kit;
	const line = kit.status();
	const listView = h('div');
	const editorView = h('div');
	/** @type {Set<string>} */
	const selected = new Set();

	const search = kit.input('', { type: 'search', placeholder: t('catalogAdmin.searchProducts') });
	const status = kit.select([
		{ value: '', label: t('admin.all') },
		...['draft', 'active', 'archived'].map((key) => ({ value: key, label: t(`catalogAdmin.status.${key}`) })),
	]);
	const category = kit.select([{ value: '', label: t('admin.all') }, ...categoryChoices(lookups.state.categories)]);
	const brand = kit.select([
		{ value: '', label: t('admin.all') },
		...lookups.state.brands.map((item) => ({ value: item.id, label: item.name })),
	]);
	const lowStock = kit.check(t('catalogAdmin.lowStock'));

	/** @param {any} product */
	const rowOf = (product) => {
		const pick = kit.check('', selected.has(product.id));
		pick.box.setAttribute('aria-label', t('admin.select', { name: product.name }));
		pick.box.addEventListener('change', () => {
			if (pick.box.checked) selected.add(product.id);
			else selected.delete(product.id);
		});
		return h('li', {}, [
			has('bulk_actions') ? pick.node : null,
			h('div', { class: 'what' }, [
				h('strong', {}, [product.name]),
				kit.text(
					'span',
					{ class: 'meta' },
					[
						t(`catalogAdmin.status.${product.status}`),
						kit.money(product.price),
						product.trackStock ? t('catalogAdmin.inStockCount', { count: product.stock }) : t('catalogAdmin.notTracked'),
						product.skus.join(', '),
					]
						.filter(Boolean)
						.join(' · '),
				),
			]),
			kit.button(t('admin.edit'), () => edit(product.id)),
		]);
	};
	const pages = kit.pager({
		path: (cursor) =>
			`/v1/admin/products${query({
				q: search.value.trim(),
				status: status.value,
				category: category.value,
				brand: brand.value,
				lowStock: lowStock.box.checked,
				cursor,
			})}`,
		row: rowOf,
		line,
		empty: t('catalogAdmin.noProducts'),
	});
	const reload = () => {
		selected.clear();
		return pages.load(true);
	};

	/** @param {string | null} id */
	const edit = (id) => {
		listView.hidden = true;
		editorView.replaceChildren(
			productEditor(kit, {
				id,
				lookups,
				done: (changed) => {
					editorView.replaceChildren();
					listView.hidden = false;
					if (changed) void reload();
				},
			}),
		);
	};

	const filters = h('form', { class: 'row inline' }, [
		kit.field(t('admin.search'), search),
		kit.field(t('admin.status'), status),
		kit.field(t('catalogAdmin.category'), category),
		kit.field(t('catalogAdmin.brand'), brand),
		lowStock.node,
		kit.text('button', { type: 'submit', class: 'secondary' }, t('admin.searchButton')),
	]);
	filters.addEventListener('submit', (event) => {
		event.preventDefault();
		void reload();
	});
	for (const control of [status, category, brand, lowStock.box]) control.addEventListener('change', () => void reload());

	kit.put(listView, [
		h('div', { class: 'head' }, [kit.button(t('catalogAdmin.newProduct'), () => edit(null), { primary: true })]),
		filters,
		has('bulk_actions') ? bulkOf(kit, lookups, selected, reload) : null,
		line,
		pages.node,
	]);
	panel.append(listView, editorView);
	void reload();
};

/**
 * Bulk changes of the selected products: status, price (percent), stock (set, at a location), add to or remove from
 * a category.
 * @param {Kit} kit @param {Lookups} lookups @param {Set<string>} selected @param {() => Promise<unknown>} reload
 */
const bulkOf = (kit, lookups, selected, reload) => {
	const { t, h } = kit;
	const note = kit.status();
	const action = kit.select(BULK_ACTIONS.map((key) => ({ value: key, label: t(`catalogAdmin.bulk.${key}`) })));
	const status = kit.select(
		['draft', 'active', 'archived'].map((key) => ({ value: key, label: t(`catalogAdmin.status.${key}`) })),
	);
	const percent = kit.input('', { type: 'number', step: 'any' });
	const stock = kit.input('', { type: 'number', min: '0', step: '1' });
	const location = kit.select(lookups.state.locations.map((item) => ({ value: item.id, label: item.name })));
	const category = kit.select(categoryChoices(lookups.state.categories));
	const parts = {
		status: kit.field(t('admin.status'), status),
		price: kit.field(t('catalogAdmin.pricePercent'), percent),
		stock: h('div', { class: 'row' }, [
			kit.field(t('catalogAdmin.stockSet'), stock),
			kit.has('multi_location') ? kit.field(t('catalogAdmin.location'), location) : null,
		]),
		category: kit.field(t('catalogAdmin.category'), category),
	};
	const show = () => {
		parts.status.hidden = action.value !== 'status';
		parts.price.hidden = action.value !== 'price';
		parts.stock.hidden = action.value !== 'stock';
		parts.category.hidden = !action.value.endsWith('_category');
	};
	action.addEventListener('change', show);
	show();
	const apply = kit.button(t('catalogAdmin.applyToSelected'), async () => {
		if (selected.size === 0) return kit.say(note, t('admin.selectFirst'), true);
		/** @type {Record<string, unknown>} */
		const values =
			action.value === 'status'
				? { status: status.value }
				: action.value === 'price'
					? { price: { mode: 'percent', value: Number(percent.value) } }
					: action.value === 'stock'
						? { stock: Number(stock.value), ...(kit.has('multi_location') ? { locationId: location.value } : {}) }
						: { categoryId: category.value };
		const answer = await kit.call('POST', '/v1/admin/products/bulk', { ids: [...selected], action: action.value, ...values });
		if (!answer.ok) return kit.fail(note, answer);
		kit.say(note, t('catalogAdmin.bulkDone', { changed: answer.data.changed, matched: answer.data.matched }));
		await reload();
		return answer;
	});
	return kit.group(t('catalogAdmin.bulkTitle'), [
		h('div', { class: 'row inline' }, [
			kit.field(t('catalogAdmin.bulkAction'), action),
			parts.status,
			parts.price,
			parts.stock,
			parts.category,
			apply,
		]),
		note,
	]);
};
