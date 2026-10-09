/**
 * The catalog's lists for the catalog admin widget (PLAN 0.8.8 Catalog): the category tree (with image and SEO text),
 * brands (with logo), attributes and stock locations, each a list with an editor, and serial numbers (add many,
 * search, mark faulty). Also the lookups other admin parts use: categories, brands, attributes and locations, and
 * searches of products, categories and brands for pickers.
 * @module
 */
import { entriesOf, query } from './admin-kit.js';

/** @typedef {import('./admin-kit.js').Kit} Kit */
/** @typedef {import('./admin-kit.js').Choice} Choice */
/** @typedef {{ id: string, name: string, slug?: string, parentId?: string | null, path?: string[], [key: string]: any }} Named */

/**
 * Categories in tree order (parents before their children, by sort then name), with their depth.
 * @param {Named[]} categories
 * @returns {Array<Named & { depth: number }>}
 */
const treeOrder = (categories) => {
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
 * The catalog lists the editors need, loaded with the ticket (empty when not allowed or off).
 * @param {Kit} kit
 */
export const createLookups = (kit) => {
	const state = {
		/** @type {Named[]} */ categories: [],
		/** @type {Named[]} */ brands: [],
		/** @type {Named[]} */ attributes: [],
		/** @type {Named[]} */ locations: [],
	};
	/** @param {string} path */
	const items = async (path) => {
		const answer = await kit.call('GET', path);
		return answer.ok ? /** @type {Named[]} */ (answer.data.items ?? []) : [];
	};
	const reload = async () => {
		const [categories, brands, attributes, locations] = await Promise.all([
			items('/v1/admin/categories'),
			items('/v1/admin/brands'),
			items('/v1/admin/attributes'),
			kit.has('multi_location') ? items('/v1/admin/locations') : Promise.resolve([]),
		]);
		Object.assign(state, { categories, brands, attributes, locations });
	};
	return { state, reload };
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
 * One field of a list editor.
 * @typedef {{ key: string, label: string, type: 'text' | 'area' | 'number' | 'check' | 'select', value: string | boolean,
 *   choices?: Choice[], attributes?: Record<string, string> }} FieldSpec
 */

/**
 * A list of records with an editor (categories, brands, attributes, locations): every record of the website is listed;
 * New and Edit open the editor; Save creates or changes; Delete asks once more. With `image`, a saved record also has
 * one image (upload to the merchant's storage, then attach; remove).
 * @param {Kit} kit
 * @param {HTMLElement} panel
 * @param {{ path: string, newKey: string, emptyKey: string, label: (item: Named) => string, meta: (item: Named) => string,
 *   order?: (items: Named[]) => Array<Named & { depth?: number }>, fields: (item: Named | null, items: Named[]) => FieldSpec[],
 *   body: (values: Record<string, string | boolean>) => Record<string, unknown>,
 *   image?: { for: 'category' | 'brand', field: 'image' | 'logo' }, changed: () => Promise<void> }} spec
 */
const recordList = (kit, panel, spec) => {
	const { t, h } = kit;
	const line = kit.status();
	const list = h('ul', { class: 'rows' });
	const editor = h('div');
	/** @type {Named[]} */
	let items = [];

	const load = async () => {
		const answer = await kit.call('GET', spec.path);
		if (!answer.ok) {
			kit.fail(line, answer);
			return;
		}
		items = answer.data.items ?? [];
		kit.say(line, items.length === 0 ? t(spec.emptyKey) : '');
		const ordered = spec.order ? spec.order(items) : items;
		list.replaceChildren(
			...ordered.map((item) =>
				h('li', {}, [
					h('div', { class: 'what', style: `padding-left: ${(item.depth ?? 0) * 16}px` }, [
						h('strong', {}, [spec.label(item)]),
						kit.text('span', { class: 'meta' }, spec.meta(item)),
					]),
					kit.button(t('admin.edit'), () => void edit(item)),
				]),
			),
		);
	};

	/** @param {Named | null} item @returns {HTMLElement} the editor's status line */
	const edit = (item) => {
		const note = kit.status();
		/** @type {Map<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>} */
		const controls = new Map();
		const fields = spec.fields(item, items).map((field) => {
			if (field.type === 'check') {
				const { box, node } = kit.check(field.label, field.value === true);
				controls.set(field.key, box);
				return node;
			}
			const control =
				field.type === 'area'
					? kit.area(String(field.value), field.attributes)
					: field.type === 'select'
						? kit.select(field.choices ?? [], String(field.value), field.attributes)
						: kit.input(String(field.value), {
								...(field.type === 'number' ? { type: 'number', step: '1' } : {}),
								...field.attributes,
							});
			controls.set(field.key, control);
			return kit.field(field.label, control);
		});
		const values = () =>
			Object.fromEntries(
				[...controls].map(([key, control]) => [
					key,
					control instanceof kit.win.HTMLInputElement && control.type === 'checkbox' ? control.checked : control.value,
				]),
			);
		const saveButton = kit.button(
			t('admin.save'),
			async () => {
				const answer = await kit.call(
					item ? 'PATCH' : 'POST',
					item ? `${spec.path}/${item.id}` : spec.path,
					spec.body(values()),
				);
				if (!answer.ok) {
					kit.fail(note, answer);
					return answer;
				}
				await Promise.all([load(), spec.changed()]);
				kit.say(edit(answer.data), t('admin.saved'));
				return answer;
			},
			{ primary: true },
		);
		const remove = item
			? kit.confirmButton(t('admin.delete'), t('admin.confirmDelete'), async () => {
					const answer = await kit.call('DELETE', `${spec.path}/${item.id}`);
					if (!answer.ok) {
						kit.fail(note, answer);
						return answer;
					}
					editor.replaceChildren();
					await Promise.all([load(), spec.changed()]);
					kit.say(line, t('admin.deleted'));
					return answer;
				})
			: null;
		const close = kit.button(t('admin.close'), () => editor.replaceChildren());
		editor.replaceChildren(
			kit.group(item ? t('admin.editing', { name: spec.label(item) }) : t(spec.newKey), [
				h('div', { class: 'fields' }, fields),
				item && spec.image ? imageOf(kit, spec, item, note) : null,
				h('div', { class: 'actions' }, [saveButton, remove, close]),
				note,
			]),
		);
		return note;
	};

	panel.append(h('div', { class: 'head' }, [kit.button(t(spec.newKey), () => void edit(null))]), line, list, editor);
	void load();
};

/**
 * The one image of a category or brand: shown, replaced by an upload, or removed.
 * @param {Kit} kit
 * @param {{ path: string, image?: { for: 'category' | 'brand', field: 'image' | 'logo' } }} spec
 * @param {Named} item
 * @param {HTMLElement} note
 */
const imageOf = (kit, spec, item, note) => {
	const { t, h } = kit;
	const image = /** @type {{ for: 'category' | 'brand', field: 'image' | 'logo' }} */ (spec.image);
	const at = `${spec.path}/${item.id}/${image.field}`;
	const shown = h('div', { class: 'thumbs' });
	/** @param {{ url?: string | null, alt?: string } | null} file */
	const draw = (file) =>
		shown.replaceChildren(
			...(file?.url ? [h('figure', {}, [kit.h('img', { src: file.url, alt: file.alt ?? '', class: 'photo' })])] : []),
		);
	draw(item[image.field]);
	const picker = kit.input('', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/avif' });
	picker.addEventListener('change', async () => {
		const file = picker.files?.[0];
		if (!file) return;
		kit.say(note, t('admin.uploading'));
		const asked = await kit.call('POST', '/v1/admin/catalog/uploads', {
			for: image.for,
			id: item.id,
			type: file.type,
			size: file.size,
		});
		if (!asked.ok) return kit.fail(note, asked);
		if (!(await kit.upload(asked.data.upload, file))) return kit.say(note, t('admin.uploadFailed'), true);
		const done = await kit.call('PUT', at, { key: asked.data.key, alt: item.name });
		if (!done.ok) return kit.fail(note, done);
		draw(done.data[image.field]);
		picker.value = '';
		kit.say(note, t('admin.saved'));
	});
	const remove = kit.button(t('admin.removeImage'), async () => {
		const answer = await kit.call('DELETE', at);
		if (!answer.ok) return kit.fail(note, answer);
		draw(null);
		kit.say(note, t('admin.saved'));
		return answer;
	});
	return kit.group(t('catalogAdmin.image'), [shown, kit.field(t('catalogAdmin.uploadImage'), picker), remove]);
};

/**
 * The categories section: the tree, each with parent, description, SEO text, sort and image.
 * @param {Kit} kit @param {HTMLElement} panel @param {Lookups} lookups
 */
export const categoriesTab = (kit, panel, lookups) => {
	const { t } = kit;
	recordList(kit, panel, {
		path: '/v1/admin/categories',
		newKey: 'catalogAdmin.newCategory',
		emptyKey: 'catalogAdmin.noCategories',
		label: (item) => item.name,
		meta: (item) => item.slug ?? '',
		order: treeOrder,
		fields: (item, items) => [
			{ key: 'name', label: t('catalogAdmin.name'), type: 'text', value: item?.name ?? '', attributes: { maxlength: '120' } },
			{ key: 'slug', label: t('catalogAdmin.slug'), type: 'text', value: item?.slug ?? '' },
			{
				key: 'parentId',
				label: t('catalogAdmin.parent'),
				type: 'select',
				value: item?.parentId ?? '',
				choices: [
					{ value: '', label: t('catalogAdmin.noParent') },
					...categoryChoices(
						items.filter((other) => !item || (other.id !== item.id && !(other.path ?? []).includes(item.id))),
					),
				],
			},
			{ key: 'description', label: t('catalogAdmin.description'), type: 'area', value: item?.description ?? '' },
			{ key: 'seoTitle', label: t('catalogAdmin.seoTitle'), type: 'text', value: item?.seo?.title ?? '' },
			{ key: 'seoDescription', label: t('catalogAdmin.seoDescription'), type: 'area', value: item?.seo?.description ?? '' },
			{ key: 'sort', label: t('catalogAdmin.sort'), type: 'number', value: String(item?.sort ?? 0) },
		],
		body: (values) => ({
			name: values.name,
			slug: values.slug,
			parentId: values.parentId || null,
			description: values.description,
			seo: { title: values.seoTitle, description: values.seoDescription },
			sort: Number(values.sort) || 0,
		}),
		image: { for: 'category', field: 'image' },
		changed: lookups.reload,
	});
};

/** @param {Kit} kit @param {HTMLElement} panel @param {Lookups} lookups */
export const brandsTab = (kit, panel, lookups) => {
	const { t } = kit;
	recordList(kit, panel, {
		path: '/v1/admin/brands',
		newKey: 'catalogAdmin.newBrand',
		emptyKey: 'catalogAdmin.noBrands',
		label: (item) => item.name,
		meta: (item) => item.slug ?? '',
		fields: (item) => [
			{ key: 'name', label: t('catalogAdmin.name'), type: 'text', value: item?.name ?? '' },
			{ key: 'slug', label: t('catalogAdmin.slug'), type: 'text', value: item?.slug ?? '' },
			{ key: 'description', label: t('catalogAdmin.description'), type: 'area', value: item?.description ?? '' },
		],
		body: (values) => ({ name: values.name, slug: values.slug, description: values.description }),
		image: { for: 'brand', field: 'logo' },
		changed: lookups.reload,
	});
};

/** Attribute types. */
const ATTRIBUTE_TYPES = Object.freeze(['text', 'number', 'boolean', 'choice']);

/** @param {Kit} kit @param {HTMLElement} panel @param {Lookups} lookups */
export const attributesTab = (kit, panel, lookups) => {
	const { t } = kit;
	recordList(kit, panel, {
		path: '/v1/admin/attributes',
		newKey: 'catalogAdmin.newAttribute',
		emptyKey: 'catalogAdmin.noAttributes',
		label: (item) => item.name,
		meta: (item) =>
			[t(`catalogAdmin.type.${item.type}`), item.unit, item.filterable ? t('catalogAdmin.filterable') : '']
				.filter(Boolean)
				.join(' · '),
		fields: (item) => [
			{ key: 'name', label: t('catalogAdmin.name'), type: 'text', value: item?.name ?? '' },
			{
				key: 'type',
				label: t('catalogAdmin.attributeType'),
				type: 'select',
				value: item?.type ?? 'text',
				choices: ATTRIBUTE_TYPES.map((type) => ({ value: type, label: t(`catalogAdmin.type.${type}`) })),
			},
			{ key: 'choices', label: t('catalogAdmin.choices'), type: 'text', value: (item?.choices ?? []).join(', ') },
			{ key: 'unit', label: t('catalogAdmin.unit'), type: 'text', value: item?.unit ?? '' },
			{ key: 'sort', label: t('catalogAdmin.sort'), type: 'number', value: String(item?.sort ?? 0) },
			{ key: 'filterable', label: t('catalogAdmin.filterable'), type: 'check', value: item?.filterable === true },
			{ key: 'comparable', label: t('catalogAdmin.comparable'), type: 'check', value: item?.comparable === true },
		],
		body: (values) => ({
			name: values.name,
			type: values.type,
			choices: values.type === 'choice' ? entriesOf(String(values.choices), true) : [],
			unit: values.unit,
			sort: Number(values.sort) || 0,
			filterable: values.filterable,
			comparable: values.comparable,
		}),
		changed: lookups.reload,
	});
};

/** @param {Kit} kit @param {HTMLElement} panel @param {Lookups} lookups */
export const locationsTab = (kit, panel, lookups) => {
	const { t } = kit;
	recordList(kit, panel, {
		path: '/v1/admin/locations',
		newKey: 'catalogAdmin.newLocation',
		emptyKey: 'catalogAdmin.noLocations',
		label: (item) => item.name,
		meta: (item) => (item.pickup ? t('catalogAdmin.pickup') : ''),
		fields: (item) => [
			{ key: 'name', label: t('catalogAdmin.name'), type: 'text', value: item?.name ?? '' },
			{ key: 'sort', label: t('catalogAdmin.sort'), type: 'number', value: String(item?.sort ?? 0) },
			{ key: 'pickup', label: t('catalogAdmin.pickup'), type: 'check', value: item?.pickup === true },
		],
		body: (values) => ({ name: values.name, sort: Number(values.sort) || 0, pickup: values.pickup }),
		changed: lookups.reload,
	});
};

/** Serial statuses. */
const SERIAL_STATUSES = Object.freeze(['in_stock', 'sold', 'faulty']);

/**
 * A variant's name for people: its option values, else its SKU, else `Default`.
 * @param {Kit} kit
 * @param {{ options?: Record<string, string>, sku?: string }} variant
 */
export const variantLabel = (kit, variant) =>
	Object.values(variant.options ?? {}).join(' / ') || variant.sku || kit.t('catalogAdmin.defaultVariant');

/**
 * The serials section: search and filter serial numbers, mark a unit faulty or back in stock, delete one, and add many for
 * a product variant (one per line).
 * @param {Kit} kit @param {HTMLElement} panel @param {Lookups} lookups
 */
export const serialsTab = (kit, panel, lookups) => {
	const { t, h } = kit;
	const line = kit.status();
	const search = kit.input('', { type: 'search' });
	const status = kit.select(
		[
			{ value: '', label: t('admin.all') },
			...SERIAL_STATUSES.map((key) => ({ value: key, label: t(`catalogAdmin.serial.${key}`) })),
		],
		'',
	);
	/** @param {any} serial */
	const rowOf = (serial) => {
		const item = h('li');
		const note = kit.status();
		/** @param {any} next */
		const draw = (next) => {
			/** @param {'in_stock' | 'faulty'} to */
			const mark = (to) =>
				kit.button(t(to === 'faulty' ? 'catalogAdmin.markFaulty' : 'catalogAdmin.markInStock'), async () => {
					const answer = await kit.call('PATCH', `/v1/admin/serials/${next.id}`, { status: to });
					if (!answer.ok) return kit.fail(note, answer);
					draw(answer.data);
					return answer;
				});
			kit.put(item, [
				h('div', { class: 'what' }, [
					h('strong', {}, [next.serial]),
					kit.text(
						'span',
						{ class: 'meta' },
						[t(`catalogAdmin.serial.${next.status}`), next.productId, next.orderId ?? ''].filter(Boolean).join(' · '),
					),
				]),
				next.status === 'in_stock' ? mark('faulty') : null,
				next.status === 'faulty' ? mark('in_stock') : null,
				next.status === 'sold'
					? null
					: kit.confirmButton(t('admin.delete'), t('admin.confirmDelete'), async () => {
							const answer = await kit.call('DELETE', `/v1/admin/serials/${next.id}`);
							if (!answer.ok) return kit.fail(note, answer);
							item.remove();
							return answer;
						}),
				note,
			]);
		};
		draw(serial);
		return item;
	};
	const pages = kit.pager({
		path: (cursor) => `/v1/admin/serials${query({ q: search.value.trim(), status: status.value, limit: 50, cursor })}`,
		row: rowOf,
		line,
		empty: t('catalogAdmin.noSerials'),
	});
	const filters = h('form', { class: 'row inline' }, [
		kit.field(t('admin.search'), search),
		kit.field(t('admin.status'), status),
		kit.text('button', { type: 'submit', class: 'secondary' }, t('admin.searchButton')),
	]);
	filters.addEventListener('submit', (event) => {
		event.preventDefault();
		void pages.load(true);
	});
	status.addEventListener('change', () => void pages.load(true));
	panel.append(
		addSerials(kit, lookups, () => void pages.load(true)),
		filters,
		line,
		pages.node,
	);
	void pages.load(true);
};

/**
 * Add serial numbers for a product variant: find the product, pick the variant (and location), one serial per line.
 * @param {Kit} kit @param {Lookups} lookups @param {() => void} added
 */
const addSerials = (kit, lookups, added) => {
	const { t, h } = kit;
	const note = kit.status();
	const search = kit.input('', { type: 'search' });
	const products = kit.select([{ value: '', label: t('catalogAdmin.pickProduct') }]);
	const variants = kit.select([]);
	const location = kit.select([]);
	const serials = kit.area('', { rows: '4' });
	const find = kit.button(t('admin.find'), async () => {
		const answer = await kit.call('GET', `/v1/admin/products${query({ q: search.value.trim(), limit: 20 })}`);
		if (!answer.ok) return kit.fail(note, answer);
		products.replaceChildren(
			kit.text('option', { value: '' }, t('catalogAdmin.pickProduct')),
			...(answer.data.items ?? []).map((/** @type {any} */ item) => kit.text('option', { value: item.id }, item.name)),
		);
		return answer;
	});
	products.addEventListener('change', async () => {
		variants.replaceChildren();
		if (!products.value) return;
		const answer = await kit.call('GET', `/v1/admin/products/${products.value}`);
		if (!answer.ok) return kit.fail(note, answer);
		variants.append(
			...(answer.data.variants ?? []).map((/** @type {any} */ variant) =>
				kit.text('option', { value: variant.id }, variantLabel(kit, variant)),
			),
		);
	});
	location.replaceChildren(
		kit.text('option', { value: '' }, t('catalogAdmin.noLocation')),
		...lookups.state.locations.map((item) => kit.text('option', { value: item.id }, item.name)),
	);
	const add = kit.button(
		t('catalogAdmin.addSerials'),
		async () => {
			const list = entriesOf(serials.value, true);
			const answer = await kit.call('POST', '/v1/admin/serials', {
				productId: products.value,
				variantId: variants.value,
				serials: list,
				...(location.value ? { locationId: location.value } : {}),
			});
			if (!answer.ok) return kit.fail(note, answer);
			serials.value = '';
			kit.say(note, t('catalogAdmin.serialsAdded', { count: answer.data.items.length }));
			added();
			return answer;
		},
		{ primary: true },
	);
	return kit.group(t('catalogAdmin.addSerials'), [
		h('div', { class: 'row inline' }, [kit.field(t('catalogAdmin.findProduct'), search), find]),
		h('div', { class: 'fields' }, [
			kit.field(t('catalogAdmin.product'), products),
			kit.field(t('catalogAdmin.variant'), variants),
			kit.has('multi_location') ? kit.field(t('catalogAdmin.location'), location) : null,
		]),
		kit.field(t('catalogAdmin.serialsOnePerLine'), serials),
		add,
		note,
	]);
};
