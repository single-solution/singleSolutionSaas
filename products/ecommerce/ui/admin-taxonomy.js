/**
 * The catalog's lists for the catalog admin widget (PLAN 0.8.8 Catalog; PLAN 0.8.10 E1, E5, E11, E13, E16), each a
 * list-and-detail screen (PLAN 0.6): the category tree (status, icon, content, FAQs, size chart, item type, Google
 * product category, SEO, image, earlier addresses), brands (status, categories, size chart, SEO, logo) and stock
 * locations. Also the lookups other admin parts use (categories, brands, attributes, locations, size charts and
 * grades) and the searches of products, categories and brands for pickers.
 * @module
 */
import { query } from './admin-kit.js';
import {
	chartChoices,
	checkGroup,
	contentEditor,
	earlierSlugs,
	faqsEditor,
	pageLinks,
	seoChecks,
	seoEditor,
	seoFacts,
} from './admin-fields.js';
import { card, createScreen, deleteEntry, detailHead, fieldsOf, readFrom, saveDialog, yesNo } from './admin-screen.js';
import { showsTypes, typeChoices, typeLabel } from './admin-types.js';

/** @typedef {import('./admin-kit.js').Kit} Kit */
/** @typedef {import('./admin-kit.js').Choice} Choice */
/** @typedef {import('./admin-kit.js').Tone} Tone */
/** @typedef {{ id: string, name: string, slug?: string, parentId?: string | null, path?: string[], [key: string]: any }} Named */

/** Image types the catalog stores. */
export const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,image/avif';

/** Category statuses (E1) and their status colors. */
const CATEGORY_TONES = Object.freeze(
	/** @type {Record<string, Tone>} */ ({ active: 'success', coming_soon: 'warning', hidden: 'neutral' }),
);
/** Brand statuses (E1). */
const BRAND_TONES = Object.freeze(/** @type {Record<string, Tone>} */ ({ active: 'success', hidden: 'neutral' }));

/**
 * Categories in tree order (parents before their children, by sort then name), with their depth.
 * @param {Named[]} categories
 * @returns {Array<Named & { depth: number }>}
 */
export const treeOrder = (categories) => {
	/** @type {Array<Named & { depth: number }>} */
	const out = [];
	/** @param {string | null} parentId @param {number} depth */
	const walk = (parentId, depth) => {
		const children = categories
			.filter((category) => (category.parentId ?? null) === parentId)
			.sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.name.localeCompare(b.name));
		for (const child of children) {
			out.push({ ...child, depth });
			walk(child.id, depth + 1);
		}
	};
	walk(null, 0);
	const placed = new Set(out.map((category) => category.id));
	for (const category of categories) if (!placed.has(category.id)) out.push({ ...category, depth: 0 });
	return out;
};

/**
 * Category choices for a select, indented by depth.
 * @param {Named[]} categories
 * @returns {Choice[]}
 */
export const categoryChoices = (categories) =>
	treeOrder(categories).map((category) => ({ value: category.id, label: `${'— '.repeat(category.depth)}${category.name}` }));

/**
 * Grades of the website, when the widget settings carry them (`settings.catalog.grades: [{ key, label, active,
 * typeKeys }]`; `active` false: not offered for new variants; `typeKeys`: the item types it is for, none = every type).
 * @param {Kit} kit
 * @returns {Array<{ key: string, label: string, active?: boolean, typeKeys?: string[] }>}
 */
export const gradesOf = (kit) => {
	const list = kit.settings.catalog?.grades;
	return Array.isArray(list) ? list : [];
};

/**
 * The catalog lists the editors need, loaded with the ticket (empty when not allowed or off).
 * @param {Kit} kit
 */
export const createLookups = (kit) => {
	const state = {
		/** @type {Named[]} */ categories: [],
		/** @type {Named[]} */ brands: [],
		/** @type {Named[]} */ attributes: [],
		/** @type {Named[]} */ locations: [],
		/** @type {Named[]} */ charts: [],
	};
	/** @param {string} path */
	const items = async (path) => {
		const answer = await kit.call('GET', path);
		return answer.ok ? /** @type {Named[]} */ (answer.data.items ?? []) : [];
	};
	const reload = async () => {
		const [categories, brands, attributes, locations, charts] = await Promise.all([
			items('/v1/admin/categories'),
			items('/v1/admin/brands'),
			items('/v1/admin/attributes'),
			kit.has('multi_location') ? items('/v1/admin/locations') : Promise.resolve([]),
			kit.has('size_charts') ? items('/v1/admin/size-charts') : Promise.resolve([]),
		]);
		// an attribute defined for one category is named with it in the editors' pickers (E45)
		const named = attributes.map((attribute) =>
			attribute.categoryId
				? {
						...attribute,
						name: kit.t('catalogAdmin.attributeInCategory', {
							name: attribute.name,
							category: categories.find((category) => category.id === attribute.categoryId)?.name ?? attribute.categoryId,
						}),
					}
				: attribute,
		);
		Object.assign(state, { categories, brands, attributes: named, locations, charts });
	};
	/** A name by id among a list (the id when unknown). @param {'categories' | 'brands' | 'locations' | 'charts' | 'attributes'} kind @param {string | null | undefined} id */
	const nameOf = (kind, id) => (id ? (state[kind].find((item) => item.id === id)?.name ?? id) : '');
	return { state, reload, nameOf, grades: () => gradesOf(kit) };
};

/** @typedef {ReturnType<typeof createLookups>} Lookups */

/**
 * Searches for pickers: products by name or SKU, categories and brands by name. Each answers null when the ticket does
 * not allow reading them (the picker then takes typed ids).
 * @param {Kit} kit
 */
export const createSearches = (kit) => {
	/** @type {{ categories: Named[] | null, brands: Named[] | null }} */
	const cache = { categories: null, brands: null };
	/** @param {'categories' | 'brands'} kind */
	const listOf = async (kind) => {
		const known = cache[kind];
		if (known) return known;
		const answer = await kit.call('GET', `/v1/admin/${kind}`);
		if (!answer.ok) return null;
		cache[kind] = answer.data.items ?? [];
		return cache[kind];
	};
	/** @param {'categories' | 'brands'} kind @returns {(text: string) => Promise<Array<{ id: string, label: string }> | null>} */
	const byName = (kind) => async (text) => {
		const found = await listOf(kind);
		if (!found) return null;
		const needle = text.toLowerCase();
		return found
			.filter((item) => item.name.toLowerCase().includes(needle))
			.slice(0, 20)
			.map((item) => ({ id: item.id, label: item.name }));
	};
	return {
		/** @param {string} text */
		products: async (text) => {
			const answer = await kit.call('GET', `/v1/admin/products${query({ q: text, limit: 10 })}`);
			if (!answer.ok) return null;
			return /** @type {Named[]} */ (answer.data.items ?? []).map((item) => ({ id: item.id, label: item.name }));
		},
		categories: byName('categories'),
		brands: byName('brands'),
		/** Names of known categories and brands, for chips. */
		names: async () => {
			const [categories, brands] = await Promise.all([listOf('categories'), listOf('brands')]);
			return new Map([...(categories ?? []), ...(brands ?? [])].map((item) => [item.id, item.name]));
		},
	};
};

/**
 * A variant's name for people: its option values, else its SKU, else `Default`.
 * @param {Kit} kit
 * @param {{ options?: Record<string, string>, sku?: string }} variant
 */
export const variantLabel = (kit, variant) =>
	Object.values(variant.options ?? {}).join(' / ') || variant.sku || kit.t('catalogAdmin.defaultVariant');

/**
 * The tools of a simple list: a search box (narrowing the list as you type) and more controls, with the Add button.
 * @param {Kit} kit @param {{ label: string, onAdd: () => void, onSearch: (text: string) => void, extra?: HTMLElement[] }} options
 */
const listTools = (kit, { label, onAdd, onSearch, extra = [] }) => {
	const search = kit.input('', { type: 'search', placeholder: kit.t('catalogAdmin.searchList') });
	search.addEventListener('input', () => onSearch(search.value.trim().toLowerCase()));
	return kit.h('div', { class: 'tools' }, [
		kit.h('div', { class: 'row inline' }, [kit.field(kit.t('admin.search'), search), ...extra]),
		kit.button(label, onAdd, { primary: true }),
	]);
};

/**
 * The one image of a category or brand: shown, replaced by an upload, or removed.
 * @param {Kit} kit
 * @param {{ path: string, for: 'category' | 'brand', field: 'image' | 'logo', item: Named,
 *   changed: (file: any) => void }} spec `changed` keeps the new image on the listed record
 */
const imageCard = (kit, { path, for: owner, field, item, changed }) => {
	const { t, h } = kit;
	const note = kit.status();
	const at = `${path}/${item.id}/${field}`;
	const shown = h('div', { class: 'thumbs' });
	/** @param {{ url?: string | null, alt?: string } | null} file */
	const draw = (file) => {
		shown.replaceChildren(
			...(file?.url ? [h('figure', {}, [kit.h('img', { src: file.url, alt: file.alt ?? '', class: 'photo' })])] : []),
		);
		remove.hidden = !file;
	};
	const picker = kit.input('', { type: 'file', accept: IMAGE_ACCEPT });
	picker.addEventListener('change', async () => {
		const file = picker.files?.[0];
		if (!file) return;
		kit.say(note, t('admin.uploading'));
		const asked = await kit.call('POST', '/v1/admin/catalog/uploads', {
			for: owner,
			id: item.id,
			type: file.type,
			size: file.size,
		});
		if (!asked.ok) return kit.fail(note, asked);
		if (!(await kit.upload(asked.data.upload, file))) return kit.say(note, t('admin.uploadFailed'), true);
		const done = await kit.call('PUT', at, { key: asked.data.key, alt: item.name });
		if (!done.ok) return kit.fail(note, done);
		draw(done.data[field]);
		changed(done.data[field]);
		picker.value = '';
		kit.say(note, t('admin.saved'));
	});
	const remove = kit.button(t('admin.removeImage'), async () => {
		const answer = await kit.call('DELETE', at);
		if (!answer.ok) return kit.fail(note, answer);
		draw(null);
		changed(null);
		kit.say(note, t('admin.saved'));
		return answer;
	});
	draw(item[field]);
	return card(kit, t(field === 'logo' ? 'catalogAdmin.logo' : 'catalogAdmin.image'), [
		shown,
		kit.field(t('catalogAdmin.uploadImage'), picker),
		remove,
		note,
	]);
};

/**
 * A long text as a card body (empty: a short line saying so).
 * @param {Kit} kit @param {string | null | undefined} value
 */
const textBlock = (kit, value) =>
	value ? kit.text('p', { class: 'prose' }, value) : kit.text('p', { class: 'muted' }, kit.t('catalogAdmin.nothingYet'));

/**
 * FAQs as a card body.
 * @param {Kit} kit @param {Array<{ question: string, answer: string }> | undefined} faqs
 */
export const faqList = (kit, faqs) =>
	faqs && faqs.length > 0
		? kit.h(
				'dl',
				{ class: 'faqs' },
				faqs.flatMap((faq) => [kit.text('dt', {}, faq.question), kit.text('dd', {}, faq.answer)]),
			)
		: kit.text('p', { class: 'muted' }, kit.t('catalogAdmin.nothingYet'));

/**
 * The categories section: the tree with status dots, a detail per category and its editor.
 * @param {Kit} kit @param {HTMLElement} panel @param {Lookups} lookups
 */
export const categoriesTab = (kit, panel, lookups) => {
	const { t, h, has } = kit;
	const path = '/v1/admin/categories';
	let needle = '';
	const status = kit.select([
		{ value: '', label: t('admin.all') },
		...Object.keys(CATEGORY_TONES).map((key) => ({ value: key, label: t(`catalogAdmin.categoryStatus.${key}`) })),
	]);
	/** @type {Named[]} */
	let all = [];
	/** @type {Record<string, number>} products in each category (not counting its subcategories) */
	let counts = {};
	/** @param {string | null} [pick] */
	const show = (pick = null) => {
		const ordered = treeOrder(all).filter(
			(item) =>
				(!status.value || (item.status ?? 'active') === status.value) &&
				(!needle || `${item.name} ${item.slug ?? ''}`.toLowerCase().includes(needle)),
		);
		screen.set(ordered, pick);
		kit.say(screen.line, all.length === 0 ? t('catalogAdmin.noCategories') : ordered.length === 0 ? t('admin.noMatches') : '');
	};
	/** @param {string | null} [pick] */
	const load = async (pick = null) => {
		const [answer, counted] = await Promise.all([
			kit.call('GET', path),
			kit.call('GET', '/v1/admin/products/counts?by=category'),
		]);
		if (!answer.ok) return kit.fail(screen.line, answer);
		all = answer.data.items ?? [];
		counts = counted.ok ? counted.data.groups : {};
		show(pick);
		return answer;
	};
	/** @param {any} saved */
	const after = async (saved) => {
		await Promise.all([lookups.reload(), load(saved.id)]);
	};
	/** Keep a new image on the category, listed and shown. @param {string} id @param {any} file */
	const keep = (id, file) => {
		for (const found of [...all, ...screen.items()].filter((other) => other.id === id)) found.image = file;
	};

	/** @param {Named | null} item @param {string | null} [parentId] */
	const edit = (item, parentId = null) => {
		const name = kit.input(item?.name ?? '', { maxlength: '120', required: '' });
		const slug = kit.input(item?.slug ?? '', { maxlength: '120' });
		const parent = kit.select(
			[
				{ value: '', label: t('catalogAdmin.noParent') },
				...categoryChoices(all.filter((other) => !item || (other.id !== item.id && !(other.path ?? []).includes(item.id)))),
			],
			item?.parentId ?? parentId ?? '',
		);
		const state = kit.select(
			Object.keys(CATEGORY_TONES).map((key) => ({ value: key, label: t(`catalogAdmin.categoryStatus.${key}`) })),
			item?.status ?? 'active',
		);
		const icon = kit.input(item?.icon ?? '', { maxlength: '40' });
		const sort = kit.input(String(item?.sort ?? 0), { type: 'number', step: '1' });
		// the item type its products have unless they name their own (dynamic model §1)
		const typed = showsTypes(kit, item?.typeKey);
		const type = kit.select(typeChoices(kit, null, item?.typeKey ?? null, t('catalogAdmin.typeAsParent')), item?.typeKey ?? '');
		const chart = kit.select(chartChoices(kit, lookups.state.charts), item?.sizeChartId ?? '');
		// its products' Google product category in the feeds (G11): empty = the one above it, else the shop's
		const googleCategory = kit.input(item?.googleCategory ?? '', { maxlength: '250' });
		const description = kit.area(item?.description ?? '', { rows: '4', maxlength: '5000' });
		const content = contentEditor(kit, item?.content);
		const faqs = faqsEditor(kit, item?.faqs ?? []);
		// the page as search engines will get it, from the values typed so far (R7 #105)
		const links = pageLinks(kit, all, []);
		const seo = seoEditor(kit, item?.seo, {
			kind: 'category',
			read: () => ({
				name: name.value.trim(),
				category: all.find((other) => other.id === parent.value)?.name ?? '',
				summary: content.value().summary,
				text: description.value,
				url: links.category({ ...(item ? { id: item.id } : {}), slug: slug.value.trim() || (item?.slug ?? '') }),
				image: item?.image?.url ?? '',
			}),
		});
		seo.watch(name, slug, parent, description, content.node);
		saveDialog(kit, {
			title: item ? t('admin.editing', { name: item.name }) : t('catalogAdmin.newCategory'),
			wide: true,
			path,
			id: item?.id ?? null,
			body: [
				fieldsOf(kit, [
					kit.field(t('catalogAdmin.name'), name),
					kit.field(t('catalogAdmin.slug'), slug),
					kit.field(t('catalogAdmin.parent'), parent),
					kit.field(t('admin.status'), state),
					kit.field(t('catalogAdmin.icon'), icon),
					kit.field(t('catalogAdmin.sort'), sort),
					typed ? kit.field(t('catalogAdmin.itemType'), type) : null,
					has('size_charts') ? kit.field(t('catalogAdmin.sizeChart'), chart) : null,
					has('feeds') ? kit.field(t('catalogAdmin.googleCategory'), googleCategory) : null,
				]),
				earlierSlugs(kit, item?.previousSlugs),
				kit.field(t('catalogAdmin.description'), description),
				content.node,
				faqs.node,
				seo.node,
			],
			value: () => ({
				name: name.value,
				slug: slug.value.trim(),
				parentId: parent.value || null,
				status: state.value,
				icon: icon.value.trim(),
				sort: Number(sort.value) || 0,
				description: description.value,
				content: content.value(),
				faqs: faqs.value(),
				seo: seo.value(),
				...(typed ? { typeKey: type.value || null } : {}),
				...(has('size_charts') ? { sizeChartId: chart.value || null } : {}),
				...(has('feeds') ? { googleCategory: googleCategory.value.trim() } : {}),
			}),
			saved: after,
		});
	};

	/** @param {Named} item */
	const detail = (item) => {
		const children = all.filter((other) => other.parentId === item.id).length;
		const state = item.status ?? 'active';
		return [
			detailHead(kit, {
				title: item.name,
				badges: [kit.badge(t(`catalogAdmin.categoryStatus.${state}`), CATEGORY_TONES[state])],
				actions: [
					kit.button(t('admin.edit'), () => edit(item), { primary: true }),
					kit.button(t('catalogAdmin.addSubcategory'), () => edit(null, item.id)),
				],
				more: [deleteEntry(kit, { name: item.name, path: `${path}/${item.id}`, done: () => after({ id: null }) })],
			}),
			kit.fieldGrid([
				[t('catalogAdmin.slug'), item.slug ?? ''],
				[t('catalogAdmin.parent'), item.parentId ? lookups.nameOf('categories', item.parentId) : t('catalogAdmin.noParent')],
				[t('catalogAdmin.productsHere'), String(counts[item.id] ?? 0)],
				[t('catalogAdmin.subcategories'), String(children)],
				[t('catalogAdmin.icon'), item.icon ?? ''],
				[t('catalogAdmin.sort'), String(item.sort ?? 0)],
				[
					t('catalogAdmin.itemType'),
					showsTypes(kit, item.typeKey) ? typeLabel(kit, item.typeKey, t('catalogAdmin.typeAsParent')) : '',
				],
				[t('catalogAdmin.sizeChart'), has('size_charts') ? lookups.nameOf('charts', item.sizeChartId) : ''],
				[t('catalogAdmin.googleCategoryTitle'), has('feeds') ? (item.googleCategory ?? '') : ''],
			]),
			earlierSlugs(kit, item.previousSlugs),
			kit.masonry([
				imageCard(kit, { path, for: 'category', field: 'image', item, changed: (file) => keep(item.id, file) }),
				card(kit, t('catalogAdmin.description'), [textBlock(kit, item.description)]),
				card(kit, t('catalogAdmin.content'), [
					textBlock(kit, item.content?.summary),
					...(item.content?.bullets?.length
						? [
								h(
									'ul',
									{ class: 'bullets' },
									item.content.bullets.map((/** @type {{ text: string, icon: string }} */ bullet) =>
										kit.text('li', {}, bullet.icon ? `${bullet.text} (${bullet.icon})` : bullet.text),
									),
								),
							]
						: []),
				]),
				card(kit, t('catalogAdmin.faqs'), [faqList(kit, item.faqs)]),
				card(kit, t('catalogAdmin.seo'), [kit.fieldGrid(seoFacts(kit, item.seo)), seoChecks(kit, item.seo)]),
			]),
		];
	};

	const screen = createScreen(kit, panel, {
		tools: [
			listTools(kit, {
				label: t('catalogAdmin.newCategory'),
				onAdd: () => edit(null),
				onSearch: (text) => {
					needle = text;
					show();
				},
				extra: [kit.field(t('admin.status'), status)],
			}),
		],
		empty: t('catalogAdmin.noCategories'),
		read: readFrom(kit, path),
		idOf: (item) => item.id,
		row: (item) => {
			const state = item.status ?? 'active';
			const children = all.filter((other) => other.parentId === item.id).length;
			return {
				name: item.name,
				tone: CATEGORY_TONES[state],
				toneLabel: t(`catalogAdmin.categoryStatus.${state}`),
				figure: t('catalogAdmin.productCount', { count: counts[item.id] ?? 0 }),
				meta: [item.slug, children > 0 ? t('catalogAdmin.subCount', { count: children }) : ''].filter(Boolean).join(' · '),
				depth: needle || status.value ? 0 : (item.depth ?? 0),
			};
		},
		detail,
	});
	status.addEventListener('change', () => show());
	void load();
};

/** @param {Kit} kit @param {HTMLElement} panel @param {Lookups} lookups */
export const brandsTab = (kit, panel, lookups) => {
	const { t, has } = kit;
	const path = '/v1/admin/brands';
	let needle = '';
	/** @type {Named[]} */
	let all = [];
	/** @type {Record<string, number>} */
	let counts = {};
	/** @param {string | null} [pick] */
	const show = (pick = null) => {
		const shown = all.filter((item) => !needle || `${item.name} ${item.slug ?? ''}`.toLowerCase().includes(needle));
		screen.set(shown, pick);
		kit.say(screen.line, all.length === 0 ? t('catalogAdmin.noBrands') : shown.length === 0 ? t('admin.noMatches') : '');
	};
	/** @param {string | null} [pick] */
	const load = async (pick = null) => {
		const [answer, counted] = await Promise.all([kit.call('GET', path), kit.call('GET', '/v1/admin/products/counts?by=brand')]);
		if (!answer.ok) return kit.fail(screen.line, answer);
		all = answer.data.items ?? [];
		counts = counted.ok ? (counted.data.groups ?? {}) : {};
		show(pick);
		return answer;
	};
	/** @param {any} saved */
	const after = async (saved) => {
		await Promise.all([lookups.reload(), load(saved.id)]);
	};
	/** Keep a new logo on the brand. @param {string} id @param {any} file */
	const keep = (id, file) => {
		for (const found of all.filter((other) => other.id === id)) found.logo = file;
	};

	/** @param {Named | null} item */
	const edit = (item) => {
		const name = kit.input(item?.name ?? '', { maxlength: '120', required: '' });
		const slug = kit.input(item?.slug ?? '', { maxlength: '120' });
		const state = kit.select(
			Object.keys(BRAND_TONES).map((key) => ({ value: key, label: t(`catalogAdmin.brandStatus.${key}`) })),
			item?.status ?? 'active',
		);
		const chart = kit.select(chartChoices(kit, lookups.state.charts), item?.sizeChartId ?? '');
		const description = kit.area(item?.description ?? '', { rows: '4', maxlength: '5000' });
		const categories = checkGroup(
			kit,
			t('catalogAdmin.brandCategories'),
			categoryChoices(lookups.state.categories),
			item?.categoryIds ?? [],
		);
		// the categories whose listings leave the brand's products out (with those below them)
		const hidden = checkGroup(
			kit,
			t('catalogAdmin.brandHiddenIn'),
			categoryChoices(lookups.state.categories),
			item?.hiddenIn ?? [],
		);
		// the brand's page as search engines will get it (R7 #105)
		const seo = seoEditor(kit, item?.seo, {
			kind: 'brand',
			read: () => ({ name: name.value.trim(), text: description.value }),
		});
		seo.watch(name, description);
		saveDialog(kit, {
			title: item ? t('admin.editing', { name: item.name }) : t('catalogAdmin.newBrand'),
			wide: true,
			path,
			id: item?.id ?? null,
			body: [
				fieldsOf(kit, [
					kit.field(t('catalogAdmin.name'), name),
					kit.field(t('catalogAdmin.slug'), slug),
					kit.field(t('admin.status'), state),
					has('size_charts') ? kit.field(t('catalogAdmin.sizeChart'), chart) : null,
				]),
				kit.field(t('catalogAdmin.description'), description),
				categories.node,
				hidden.node,
				seo.node,
			],
			value: () => ({
				name: name.value,
				slug: slug.value.trim(),
				status: state.value,
				description: description.value,
				categoryIds: categories.value(),
				hiddenIn: hidden.value(),
				seo: seo.value(),
				...(has('size_charts') ? { sizeChartId: chart.value || null } : {}),
			}),
			saved: after,
		});
	};

	/** @param {Named} item */
	const detail = (item) => {
		const state = item.status ?? 'active';
		/** @type {string[]} */
		const scope = item.categoryIds ?? [];
		return [
			detailHead(kit, {
				title: item.name,
				badges: [kit.badge(t(`catalogAdmin.brandStatus.${state}`), BRAND_TONES[state])],
				actions: [kit.button(t('admin.edit'), () => edit(item), { primary: true })],
				more: [deleteEntry(kit, { name: item.name, path: `${path}/${item.id}`, done: () => after({ id: null }) })],
			}),
			kit.fieldGrid([
				[t('catalogAdmin.slug'), item.slug ?? ''],
				[t('catalogAdmin.productsHere'), String(counts[item.id] ?? 0)],
				[
					t('catalogAdmin.brandCategories'),
					scope.length === 0
						? t('catalogAdmin.allCategories')
						: scope.map((id) => lookups.nameOf('categories', id)).join(', '),
				],
				[t('catalogAdmin.sizeChart'), has('size_charts') ? lookups.nameOf('charts', item.sizeChartId) : ''],
				[
					t('catalogAdmin.brandHiddenInShort'),
					(item.hiddenIn ?? []).map((/** @type {string} */ id) => lookups.nameOf('categories', id)).join(', '),
				],
			]),
			kit.masonry([
				imageCard(kit, { path, for: 'brand', field: 'logo', item, changed: (file) => keep(item.id, file) }),
				card(kit, t('catalogAdmin.description'), [textBlock(kit, item.description)]),
				card(kit, t('catalogAdmin.seo'), [kit.fieldGrid(seoFacts(kit, item.seo)), seoChecks(kit, item.seo)]),
			]),
		];
	};

	const screen = createScreen(kit, panel, {
		tools: [
			listTools(kit, {
				label: t('catalogAdmin.newBrand'),
				onAdd: () => edit(null),
				onSearch: (text) => {
					needle = text;
					show();
				},
			}),
		],
		empty: t('catalogAdmin.noBrands'),
		read: readFrom(kit, path),
		idOf: (item) => item.id,
		row: (item) => {
			const state = item.status ?? 'active';
			return {
				name: item.name,
				tone: BRAND_TONES[state],
				toneLabel: t(`catalogAdmin.brandStatus.${state}`),
				figure: t('catalogAdmin.productCount', { count: counts[item.id] ?? 0 }),
				meta: item.slug ?? '',
			};
		},
		detail,
	});
	void load();
};

/** @param {Kit} kit @param {HTMLElement} panel @param {Lookups} lookups */
export const locationsTab = (kit, panel, lookups) => {
	const { t } = kit;
	const path = '/v1/admin/locations';
	let needle = '';
	/** @type {Named[]} */
	let all = [];
	/** @param {string | null} [pick] */
	const show = (pick = null) => {
		const shown = all.filter((item) => !needle || item.name.toLowerCase().includes(needle));
		screen.set(shown, pick);
		kit.say(screen.line, all.length === 0 ? t('catalogAdmin.noLocations') : shown.length === 0 ? t('admin.noMatches') : '');
	};
	/** @param {string | null} [pick] */
	const load = async (pick = null) => {
		const answer = await kit.call('GET', path);
		if (!answer.ok) return kit.fail(screen.line, answer);
		all = answer.data.items ?? [];
		show(pick);
		return answer;
	};
	/** @param {any} saved */
	const after = async (saved) => {
		await Promise.all([lookups.reload(), load(saved.id)]);
	};
	/** @param {Named | null} item */
	const edit = (item) => {
		const name = kit.input(item?.name ?? '', { maxlength: '120', required: '' });
		const sort = kit.input(String(item?.sort ?? 0), { type: 'number', step: '1' });
		const pickup = kit.check(t('catalogAdmin.pickup'), item?.pickup === true);
		saveDialog(kit, {
			title: item ? t('admin.editing', { name: item.name }) : t('catalogAdmin.newLocation'),
			path,
			id: item?.id ?? null,
			body: [fieldsOf(kit, [kit.field(t('catalogAdmin.name'), name), kit.field(t('catalogAdmin.sort'), sort), pickup.node])],
			value: () => ({ name: name.value, sort: Number(sort.value) || 0, pickup: pickup.box.checked }),
			saved: after,
		});
	};
	const screen = createScreen(kit, panel, {
		tools: [
			listTools(kit, {
				label: t('catalogAdmin.newLocation'),
				onAdd: () => edit(null),
				onSearch: (text) => {
					needle = text;
					show();
				},
			}),
		],
		empty: t('catalogAdmin.noLocations'),
		idOf: (item) => item.id,
		row: (item) => ({
			name: item.name,
			toneLabel: item.name,
			figure: item.pickup ? t('catalogAdmin.pickupShort') : '',
			meta: t('catalogAdmin.sortOrder', { sort: item.sort ?? 0 }),
		}),
		detail: (item) => [
			detailHead(kit, {
				title: item.name,
				actions: [kit.button(t('admin.edit'), () => edit(item), { primary: true })],
				more: [
					deleteEntry(kit, {
						name: item.name,
						path: `${path}/${item.id}`,
						done: () => after({ id: null }),
						note: t('catalogAdmin.deleteLocationNote'),
					}),
				],
			}),
			kit.fieldGrid([
				[t('catalogAdmin.pickup'), yesNo(kit, item.pickup)],
				[t('catalogAdmin.sort'), String(item.sort ?? 0)],
			]),
		],
	});
	void load();
};
