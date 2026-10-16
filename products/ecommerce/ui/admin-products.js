/**
 * The products section of the catalog admin widget (PLAN 0.8.8; PLAN 0.8.10 E2, E7, K4) as a list-and-detail screen:
 * search, status chips with their counts, a Filters dialog (category, several brands and grades, featured, stock state
 * with counts, photos, low stock, kind; with SEO on, the order by SEO score and a score below 50 or 80, E42), the
 * total, Load more, and a selection for bulk changes (status, price, stock,
 * add to or remove from a category, and (E23) brand, tags, item type, compare-at price and any field; `bulk_actions`) and for generating the variants of many products (`variants`).
 * The picked product's detail and editor are in `./admin-product.js` and `./admin-product-editor.js`.
 * @module
 */
import { PRODUCT_STATUSES, STOCK_STATES } from '../core/model.js';
import { query, wholeOf } from './admin-kit.js';
import { checkGroup } from './admin-fields.js';
import { STATUS_TONES, productDetail } from './admin-product.js';
import { productEditor } from './admin-product-editor.js';
import { createScreen, fieldsOf } from './admin-screen.js';
import { categoryChoices } from './admin-taxonomy.js';
import { typeChoices } from './admin-types.js';

/** @typedef {import('./admin-kit.js').Kit} Kit */
/** @typedef {import('./admin-taxonomy.js').Lookups} Lookups */
/**
 * What the product's detail and editor ask of the list.
 * @typedef {{ lookups: Lookups, show: (product: any, message?: string) => void, edit: (product: any | null) => void,
 *   removed: () => Promise<unknown>, serials: (product: any) => void }} ProductContext
 */

/** Bulk changes of products. */
const BULK_ACTIONS = Object.freeze([
	'status',
	'price',
	'stock',
	'add_category',
	'remove_category',
	'brand',
	'add_tags',
	'remove_tags',
	'item_type',
	'compare_at_price',
	'field',
]);

/**
 * A field value typed in the bulk dialog as the product API takes it (E23): a number, yes or no, several values
 * separated by commas, else the text; '' clears it (null).
 * @param {any} field @param {string} text
 */
const fieldValueOf = (field, text) => {
	const value = text.trim();
	if (value === '') return null;
	/** @param {string} one */
	const typed = (one) => (field?.type === 'number' ? Number(one) : one);
	if (field?.type === 'yes_no') return ['true', 'yes', '1'].includes(value.toLowerCase());
	if (field?.multiple)
		return value
			.split(',')
			.map((one) => one.trim())
			.filter(Boolean)
			.map(typed);
	return typed(value);
};

/**
 * A list row from a whole product (after a change in its detail).
 * @param {any} product
 */
export const rowOf = (product) => {
	/** @type {any[]} */
	const variants = product.variants;
	return {
		id: product.id,
		name: product.name,
		status: product.status,
		kind: product.kind,
		price: product.price,
		trackStock: product.trackStock,
		stock: variants.filter((variant) => variant.active).reduce((sum, variant) => sum + variant.stock, 0),
		skus: variants.map((variant) => variant.sku).filter(Boolean),
		featured: product.featured === true,
		stockState: product.stockState,
		mediaCount: product.media.length,
		...(typeof product.seo?.score === 'number' ? { seoScore: product.seo.score } : {}),
	};
};

/** The SEO score filters (E42): products scored below these. */
const SEO_BELOW = Object.freeze(['50', '80']);

/**
 * An amount typed with an optional minus sign, in minor units (null when empty, NaN when not an amount).
 * @param {Kit} kit @param {string} text
 */
const signedAmount = (kit, text) => {
	const value = text.trim();
	const negative = /^[-−]/.test(value);
	const minor = kit.amount(negative ? value.slice(1) : value);
	return minor === null || Number.isNaN(minor) ? minor : negative ? -minor : minor;
};

/**
 * The products section.
 * @param {Kit} kit @param {HTMLElement} panel @param {Lookups} lookups
 * @param {import('./admin-serials.js').Links} links
 */
export const productsTab = (kit, panel, lookups, links) => {
	const { t, h, has } = kit;
	const filters = {
		status: '',
		category: '',
		/** @type {string[]} */ brand: [],
		/** @type {string[]} */ grade: [],
		featured: '',
		/** @type {string[]} */ stockState: [],
		hasMedia: '',
		lowStock: false,
		kind: '',
		sort: '',
		seoBelow: '',
		/** @type {Record<string, string[]>} the values picked per filterable field, by its slug (E24) */ fields: {},
	};
	/** @type {Set<string>} */
	const selected = new Set();
	let selecting = false;
	/** @type {string | null} */
	let cursor = null;
	const search = kit.input('', { type: 'search', placeholder: t('catalogAdmin.searchProducts') });

	/** The list's query (without the page), with some filters left out or more values. @param {Record<string, string>} [over] */
	const params = (over = {}) =>
		query({
			q: search.value.trim(),
			status: filters.status,
			category: filters.category,
			brand: filters.brand.join(','),
			grade: filters.grade.join(','),
			featured: filters.featured,
			stockState: filters.stockState.join(','),
			hasMedia: filters.hasMedia,
			lowStock: filters.lowStock,
			kind: filters.kind,
			sort: filters.sort,
			seoBelow: filters.seoBelow,
			...Object.fromEntries(
				Object.entries(filters.fields)
					.filter(([, values]) => values.length > 0)
					.map(([ref, values]) => [`attr.${ref}`, values.join(',')]),
			),
			...over,
		});

	/**
	 * The fields staff filter by (E24): the active product and variant fields marked filterable, one per slug.
	 * @returns {Array<{ ref: string, name: string, type: string, choices: Array<{ value: string, label: string }> }>}
	 */
	const filterableFields = () => {
		/** @type {Map<string, any>} */
		const byRef = new Map();
		for (const field of /** @type {any[]} */ (lookups.state.attributes))
			if ((field.on === 'product' || field.on === 'variant') && field.active !== false && field.show?.filter) {
				const ref = field.slug || field.id;
				if (!byRef.has(ref)) byRef.set(ref, { ref, name: field.name, type: field.type, choices: field.choices ?? [] });
			}
		return [...byRef.values()];
	};

	const chips = h('div', { class: 'chipbar', role: 'group', 'aria-label': t('admin.status') });
	const total = kit.text('p', { class: 'muted total' }, '');
	const filterButton = kit.button(t('catalogAdmin.filters'), () => openFilters());
	const clear = kit.button(t('catalogAdmin.clearFilters'), () => {
		Object.assign(filters, {
			category: '',
			brand: [],
			grade: [],
			featured: '',
			stockState: [],
			hasMedia: '',
			lowStock: false,
			kind: '',
			sort: '',
			seoBelow: '',
			fields: {},
		});
		return reload();
	});
	const selectToggle = kit.button(t('catalogAdmin.select'), () => {
		selecting = !selecting;
		selected.clear();
		drawBar();
		screen.redraw();
	});
	selectToggle.hidden = !has('bulk_actions') && !has('variants');
	const picked = kit.text('span', {}, '');
	const bar = h('div', { class: 'selectbar' }, [
		picked,
		kit.button(t('catalogAdmin.selectShown'), () => {
			for (const item of screen.items()) selected.add(item.id);
			drawBar();
			screen.redraw();
		}),
		has('bulk_actions') ? kit.button(t('catalogAdmin.bulkChange'), () => bulkDialog()) : null,
		has('variants') ? kit.button(t('catalogAdmin.generate'), () => generateMany()) : null,
	]);

	/** How many filters of the dialog are on. */
	const filterCount = () =>
		[filters.category, filters.featured, filters.hasMedia, filters.kind, filters.sort, filters.seoBelow].filter(Boolean)
			.length +
		filters.brand.length +
		filters.grade.length +
		filters.stockState.length +
		(filters.lowStock ? 1 : 0);
	const drawBar = () => {
		bar.hidden = !selecting;
		selectToggle.replaceChildren(selecting ? t('catalogAdmin.selectDone') : t('catalogAdmin.select'));
		picked.replaceChildren(t('catalogAdmin.selected', { count: selected.size }));
		const on = filterCount();
		filterButton.replaceChildren(t('catalogAdmin.filters'), kit.countBadge(on > 0 ? on : null) ?? '');
		clear.hidden = on === 0;
	};

	/** @param {Record<string, number>} groups @param {number} all */
	const drawChips = (groups, all) =>
		chips.replaceChildren(
			...['', 'active', 'draft', 'archived'].map((key) => {
				const chip = kit.text(
					'button',
					{ type: 'button', class: 'chip', 'aria-pressed': filters.status === key ? 'true' : 'false' },
					key ? t(`catalogAdmin.status.${key}`) : t('admin.all'),
				);
				chip.append(kit.countBadge(key ? (groups[key] ?? 0) : all) ?? '');
				chip.addEventListener('click', () => {
					filters.status = key;
					void reload();
				});
				return chip;
			}),
		);

	/** @param {string | null} [pick] */
	const reload = async (pick = null) => {
		selected.clear();
		drawBar();
		const [answer, counted, statuses] = await Promise.all([
			kit.call('GET', `/v1/admin/products${params()}`),
			kit.call('GET', `/v1/admin/products/count${params({ sort: '' })}`),
			kit.call('GET', `/v1/admin/products/counts${params({ status: '', sort: '', by: 'status' })}`),
		]);
		drawChips(statuses.ok ? statuses.data.groups : {}, statuses.ok ? statuses.data.total : 0);
		total.replaceChildren(
			counted.ok
				? t(counted.data.capped ? 'catalogAdmin.totalCapped' : 'catalogAdmin.total', { count: counted.data.count })
				: '',
		);
		if (!answer.ok) {
			more.hidden = true;
			screen.set([]);
			return kit.fail(screen.line, answer);
		}
		cursor = answer.data.nextCursor ?? null;
		/** @type {any[]} */
		const items = answer.data.items;
		screen.set(items, pick);
		kit.say(screen.line, items.length === 0 ? t('catalogAdmin.noProducts') : '');
		more.hidden = !answer.data.hasMore;
		return answer;
	};
	const more = kit.button(t('admin.more'), async () => {
		const answer = await kit.call('GET', `/v1/admin/products${params({ cursor: cursor ?? '' })}`);
		if (!answer.ok) return kit.fail(screen.line, answer);
		cursor = answer.data.nextCursor ?? null;
		screen.append(answer.data.items);
		more.hidden = !answer.data.hasMore;
		return answer;
	});
	more.hidden = true;

	/** The filters dialog, with counts by stock state, brand, grade and featured. */
	const openFilters = async () => {
		const fields = filterableFields();
		const by = [
			'stockState',
			'brand',
			...(lookups.grades().length > 0 ? ['grade'] : []),
			'featured',
			...fields.map((field) => `attr.${field.ref}`),
		];
		const answers = await Promise.all(
			by.map((name) => kit.call('GET', `/v1/admin/products/counts${params({ [name]: '', sort: '', by: name })}`)),
		);
		/** @type {Record<string, Record<string, number>>} */
		const counts = Object.fromEntries(
			by.map((name, index) => {
				const answer = answers[index];
				return [name, answer?.ok ? answer.data.groups : {}];
			}),
		);
		const category = kit.select(
			[{ value: '', label: t('admin.all') }, ...categoryChoices(lookups.state.categories)],
			filters.category,
		);
		const kinds = ['physical', ...(has('digital_goods') ? ['digital'] : []), ...(has('bookings') ? ['service'] : [])];
		const kind = kit.select(
			[{ value: '', label: t('admin.all') }, ...kinds.map((key) => ({ value: key, label: t(`catalogAdmin.kind.${key}`) }))],
			filters.kind,
		);
		const featuredCounts = /** @type {Record<string, number>} */ (counts.featured);
		const featured = kit.select(
			[
				{ value: '', label: t('catalogAdmin.any') },
				{
					value: '1',
					label: t('catalogAdmin.withCount', { label: t('catalogAdmin.featuredOnly'), count: featuredCounts.true ?? 0 }),
				},
				{
					value: '0',
					label: t('catalogAdmin.withCount', {
						label: t('catalogAdmin.notFeatured'),
						count: (featuredCounts.false ?? 0) + (featuredCounts.none ?? 0),
					}),
				},
			],
			filters.featured,
		);
		const photos = kit.select(
			[
				{ value: '', label: t('catalogAdmin.any') },
				{ value: '1', label: t('catalogAdmin.withPhotos') },
				{ value: '0', label: t('catalogAdmin.withoutPhotos') },
			],
			filters.hasMedia,
		);
		const lowStock = kit.toggle(t('catalogAdmin.lowStock'), filters.lowStock === true, { inline: true });
		// with SEO on: the lowest score first, and a score below a mark (E42)
		const order = kit.select(
			[
				{ value: '', label: t('catalogAdmin.newestFirst') },
				{ value: 'seo_score', label: t('catalogAdmin.lowestSeoFirst') },
			],
			filters.sort,
		);
		const seoBelow = kit.select(
			[
				{ value: '', label: t('catalogAdmin.any') },
				...SEO_BELOW.map((value) => ({ value, label: t('catalogAdmin.seoBelow', { score: value }) })),
			],
			filters.seoBelow,
		);
		const brands = checkGroup(
			kit,
			t('catalogAdmin.brands'),
			lookups.state.brands.map((brand) => ({ value: brand.id, label: brand.name })),
			filters.brand,
			counts.brand,
		);
		const grades = checkGroup(
			kit,
			t('catalogAdmin.grades'),
			lookups.grades().map((grade) => ({ value: grade.key, label: grade.label })),
			filters.grade,
			counts.grade,
		);
		const states = checkGroup(
			kit,
			t('catalogAdmin.stockState'),
			STOCK_STATES.map((key) => ({ value: key, label: t(`catalogAdmin.stockState.${key}`) })),
			filters.stockState,
			counts.stockState,
		);
		// a group per filterable field (E24): its choices, else the values products hold
		const fieldGroups = fields.map((field) => {
			const held = /** @type {Record<string, number>} */ (counts[`attr.${field.ref}`] ?? {});
			const choices =
				field.type === 'choice'
					? field.choices
					: field.type === 'yes_no'
						? [
								{ value: 'true', label: t('admin.yes') },
								{ value: 'false', label: t('admin.no') },
							]
						: Object.keys(held)
								.filter((value) => value !== 'none')
								.map((value) => ({ value, label: value }));
			return { ref: field.ref, group: checkGroup(kit, field.name, choices, filters.fields[field.ref] ?? [], held) };
		});
		kit.dialog({
			title: t('catalogAdmin.filters'),
			wide: true,
			body: [
				fieldsOf(kit, [
					kit.field(t('catalogAdmin.category'), category),
					kinds.length > 1 ? kit.field(t('catalogAdmin.kind'), kind) : null,
					kit.field(t('catalogAdmin.featured'), featured),
					kit.field(t('catalogAdmin.photos'), photos),
					has('seo') ? kit.field(t('catalogAdmin.order'), order) : null,
					has('seo') ? kit.field(t('catalogAdmin.seoScore'), seoBelow) : null,
					lowStock.node,
				]),
				states.node,
				lookups.state.brands.length > 0 ? brands.node : null,
				lookups.grades().length > 0 ? grades.node : null,
				...fieldGroups.map((entry) => entry.group.node),
			],
			submitLabel: t('catalogAdmin.showProducts'),
			onSubmit: async () => {
				Object.assign(filters, {
					category: category.value,
					kind: kind.value,
					featured: featured.value,
					hasMedia: photos.value,
					lowStock: lowStock.box.checked,
					brand: brands.value(),
					grade: lookups.grades().length > 0 ? grades.value() : [],
					stockState: states.value(),
					sort: has('seo') ? order.value : '',
					seoBelow: has('seo') ? seoBelow.value : '',
					fields: Object.fromEntries(fieldGroups.map((entry) => [entry.ref, entry.group.value()])),
				});
				await reload();
				return null;
			},
		});
	};

	/** Bulk changes of the selected products (`bulk_actions`). */
	const bulkDialog = () => {
		if (selected.size === 0) return kit.say(screen.line, t('admin.selectFirst'), true);
		const action = kit.select(BULK_ACTIONS.map((key) => ({ value: key, label: t(`catalogAdmin.bulk.${key}`) })));
		const status = kit.select(PRODUCT_STATUSES.map((key) => ({ value: key, label: t(`catalogAdmin.status.${key}`) })));
		const priceMode = kit.select([
			{ value: 'percent', label: t('catalogAdmin.byPercent') },
			{ value: 'fixed', label: t('catalogAdmin.byAmount') },
		]);
		const price = kit.input('', { inputmode: 'decimal' });
		const stock = kit.input('', { type: 'number', min: '0', step: '1' });
		const location = kit.select(lookups.state.locations.map((item) => ({ value: item.id, label: item.name })));
		const category = kit.select(categoryChoices(lookups.state.categories));
		// any field (E23): brand, tags, item type, compare-at price, product and variant fields
		const brand = kit.select([
			{ value: '', label: t('catalogAdmin.noBrand') },
			...lookups.state.brands.map((item) => ({ value: item.id, label: item.name })),
		]);
		const tags = kit.input('', { maxlength: '1300', placeholder: t('admin.tagPlaceholder') });
		const type = kit.select(typeChoices(kit, null, null, t('catalogAdmin.typeAsCategory')));
		const compareMode = kit.select(
			['percent', 'set', 'clear'].map((mode) => ({ value: mode, label: t(`catalogAdmin.compareAt.${mode}`) })),
		);
		const compareValue = kit.input('', { inputmode: 'decimal' });
		/** @type {any[]} */
		const fields = lookups.state.attributes.filter((item) => item.on === 'product' || item.on === 'variant');
		const field = kit.select(fields.map((item) => ({ value: item.id, label: item.name })));
		const fieldValue = kit.input('', { maxlength: '1000' });
		const parts = {
			status: kit.field(t('admin.status'), status),
			price: fieldsOf(kit, [kit.field(t('catalogAdmin.priceChange'), priceMode), kit.field(t('catalogAdmin.priceBy'), price)]),
			stock: fieldsOf(kit, [
				kit.field(t('catalogAdmin.stockSet'), stock),
				has('multi_location') ? kit.field(t('catalogAdmin.location'), location) : null,
			]),
			category: kit.field(t('catalogAdmin.category'), category),
			brand: kit.field(t('catalogAdmin.brand'), brand),
			tags: fieldsOf(kit, [kit.text('p', { class: 'muted' }, t('admin.tagsHint')), kit.field(t('admin.tags'), tags)]),
			type: kit.field(t('catalogAdmin.itemType'), type),
			compareAt: fieldsOf(kit, [
				kit.field(t('catalogAdmin.compareAtChange'), compareMode),
				kit.field(t('catalogAdmin.compareAtBy'), compareValue),
			]),
			field: fieldsOf(kit, [
				kit.field(t('catalogAdmin.fieldToSet'), field),
				kit.field(t('catalogAdmin.fieldValue'), fieldValue),
				kit.text('p', { class: 'muted' }, t('catalogAdmin.fieldValueHint')),
			]),
		};
		const sync = () => {
			parts.status.hidden = action.value !== 'status';
			parts.price.hidden = action.value !== 'price';
			parts.stock.hidden = action.value !== 'stock';
			parts.category.hidden = !action.value.endsWith('_category');
			parts.brand.hidden = action.value !== 'brand';
			parts.tags.hidden = !action.value.endsWith('_tags');
			parts.type.hidden = action.value !== 'item_type';
			parts.compareAt.hidden = action.value !== 'compare_at_price';
			compareValue.disabled = compareMode.value === 'clear';
			parts.field.hidden = action.value !== 'field';
		};
		compareMode.addEventListener('change', sync);
		action.addEventListener('change', sync);
		sync();
		kit.dialog({
			title: t('catalogAdmin.bulkTitle', { count: selected.size }),
			body: [
				kit.field(t('catalogAdmin.bulkAction'), action),
				parts.status,
				parts.price,
				parts.stock,
				parts.category,
				parts.brand,
				parts.tags,
				parts.type,
				parts.compareAt,
				parts.field,
			],
			submitLabel: t('catalogAdmin.applyToSelected'),
			onSubmit: async () => {
				/** @type {Record<string, unknown>} */
				let values;
				if (action.value === 'status') values = { status: status.value };
				else if (action.value === 'price') {
					const value =
						priceMode.value === 'percent' ? Number(price.value.replace('−', '-')) : signedAmount(kit, price.value);
					if (price.value.trim() === '' || value === null || !Number.isFinite(value)) return t('admin.checkNumbers');
					values = { price: { mode: priceMode.value, value } };
				} else if (action.value === 'stock') {
					const units = wholeOf(stock.value);
					if (units === null || Number.isNaN(units)) return t('admin.checkNumbers');
					values = { stock: units, ...(has('multi_location') ? { locationId: location.value } : {}) };
				} else if (action.value === 'brand') values = { brandId: brand.value || null };
				else if (action.value.endsWith('_tags'))
					values = {
						tags: tags.value
							.split(',')
							.map((tag) => tag.trim())
							.filter(Boolean),
					};
				else if (action.value === 'item_type') values = { typeKey: type.value || null };
				else if (action.value === 'compare_at_price') {
					const mode = compareMode.value;
					const value =
						mode === 'clear' ? undefined : mode === 'percent' ? Number(compareValue.value) : kit.amount(compareValue.value);
					if (mode !== 'clear' && (value === null || value === undefined || !Number.isFinite(value)))
						return t('admin.checkNumbers');
					values = { compareAt: { mode, ...(value === undefined ? {} : { value }) } };
				} else if (action.value === 'field')
					values = {
						field: field.value,
						value: fieldValueOf(
							fields.find((item) => item.id === field.value),
							fieldValue.value,
						),
					};
				else values = { categoryId: category.value };
				const answer = await kit.call('POST', '/v1/admin/products/bulk', {
					ids: [...selected],
					action: action.value,
					...values,
				});
				if (!answer.ok) return kit.reason(answer);
				await reload(screen.current());
				/** @type {Array<{ id: string, message: string }>} the products whose own check refused the change */
				const refused = answer.data.refused ?? [];
				kit.say(
					screen.line,
					[
						t('catalogAdmin.bulkDone', { changed: answer.data.changed, matched: answer.data.matched }),
						...(refused.length > 0
							? [t('catalogAdmin.bulkRefused', { count: refused.length, reason: refused[0]?.message ?? '' })]
							: []),
					].join(' '),
					refused.length > 0,
				);
				return null;
			},
		});
		return null;
	};

	/** Generate the missing variants of the selected products (`variants`, E7). */
	const generateMany = () => {
		if (selected.size === 0) return kit.say(screen.line, t('admin.selectFirst'), true);
		const price = kit.input('', { inputmode: 'decimal' });
		const stock = kit.input('', { type: 'number', min: '0', step: '1' });
		const names = new Map(screen.items().map((item) => [item.id, item.name]));
		kit.dialog({
			title: t('catalogAdmin.generateMany', { count: selected.size }),
			body: [
				kit.text('p', {}, t('catalogAdmin.generateManyNote')),
				fieldsOf(kit, [
					kit.field(t('catalogAdmin.generatePrice'), price),
					has('multi_location') ? null : kit.field(t('catalogAdmin.generateStock'), stock),
				]),
			],
			submitLabel: t('catalogAdmin.generate'),
			onSubmit: async () => {
				const amount = kit.amount(price.value);
				const units = wholeOf(stock.value);
				if (Number.isNaN(amount) || Number.isNaN(units)) return t('admin.checkNumbers');
				const answer = await kit.call('POST', '/v1/admin/products/variants/generate', {
					ids: [...selected],
					...(amount === null ? {} : { price: amount }),
					...(units === null || has('multi_location') ? {} : { stock: units }),
				});
				if (!answer.ok) return kit.reason(answer);
				/** @type {Array<{ id: string, added?: number, error?: string, code?: string, path?: string }>} */
				const results = answer.data.results;
				const failed = results.filter((row) => row.error);
				await reload(screen.current());
				kit.say(
					screen.line,
					[
						t('catalogAdmin.generatedMany', { added: answer.data.added }),
						...failed.map((row) =>
							t('catalogAdmin.generateFailed', {
								name: names.get(row.id) ?? row.id,
								// the website's words for the field or the problem, never the server's English (PLAN 0.4.10)
								reason: kit.refusal(row.code ?? '', row.path ? [{ path: row.path }] : undefined),
							}),
						),
					].join(' '),
					failed.length > 0,
				);
				return null;
			},
		});
		return null;
	};

	/** @type {ProductContext} */
	const context = {
		lookups,
		show: (product, message = '') => {
			const row = rowOf(product);
			screen.replace(row);
			kit.put(screen.view.detail, [screen.view.back, ...productDetail(kit, product, context, message)]);
		},
		edit: (product) => {
			const editor = productEditor(kit, {
				product,
				lookups,
				saved: (next, isNew, message) => (isNew ? reload(next.id) : context.show(next, message ?? t('admin.saved'))),
				// the open product is read again (photos may have been uploaded while editing)
				cancel: () => screen.set(screen.items()),
			});
			if (!product) return screen.show([editor]);
			kit.put(screen.view.detail, [screen.view.back, editor]);
			return screen.view.show('detail');
		},
		removed: () => reload(),
		serials: (product) => links.serialsOf({ id: product.id, name: product.name, variants: product.variants }),
	};

	/** @param {any} row */
	const openProduct = (row) => {
		const box = h('div', {}, [kit.text('p', { class: 'muted' }, t('catalogAdmin.loading'))]);
		void kit.call('GET', `/v1/admin/products/${row.id}`).then((answer) => {
			if (screen.current() !== row.id) return;
			if (answer.ok) context.show(answer.data);
			else {
				const line = kit.status();
				kit.fail(line, answer);
				box.replaceChildren(line);
			}
		});
		return [box];
	};

	const form = h('form', { class: 'row inline' }, [
		kit.field(t('admin.search'), search),
		kit.text('button', { type: 'submit', class: 'secondary' }, t('admin.searchButton')),
	]);
	form.addEventListener('submit', (event) => {
		event.preventDefault();
		void reload();
	});

	const screen = createScreen(kit, panel, {
		tools: [
			h('div', { class: 'tools' }, [
				form,
				kit.button(t('catalogAdmin.newProduct'), () => context.edit(null), { primary: true }),
			]),
			chips,
			h('div', { class: 'row inline' }, [total, filterButton, clear, selectToggle]),
			bar,
		],
		empty: t('catalogAdmin.noProducts'),
		idOf: (item) => item.id,
		row: (item) => {
			/** @type {import('./admin-kit.js').Child} */
			let lead = null;
			if (selecting) {
				const pick = kit.check('', selected.has(item.id));
				pick.box.setAttribute('aria-label', t('admin.select', { name: item.name }));
				pick.node.addEventListener('click', (event) => event.stopPropagation());
				pick.box.addEventListener('change', () => {
					if (pick.box.checked) selected.add(item.id);
					else selected.delete(item.id);
					drawBar();
				});
				lead = pick.node;
			}
			return {
				name: item.name,
				tone: STATUS_TONES[item.status] ?? 'neutral',
				toneLabel: t(`catalogAdmin.status.${item.status}`),
				figure: kit.money(item.price),
				meta: [
					item.trackStock ? t('catalogAdmin.inStockCount', { count: item.stock }) : t('catalogAdmin.notTracked'),
					item.featured ? t('catalogAdmin.featured') : '',
					typeof item.seoScore === 'number' ? t('catalogAdmin.seoScoreOf', { score: item.seoScore }) : '',
					item.skus.join(', '),
				]
					.filter(Boolean)
					.join(' · '),
				lead,
			};
		},
		detail: openProduct,
	});
	screen.tail.append(more);
	drawBar();
	void reload();
};
