/**
 * The attributes section of the catalog admin widget (PLAN 0.8.10 E7) as a list-and-detail screen: every field of an
 * attribute — name, slug (the filter name `attr.<slug>`), type, unit, where its values live (product or variant),
 * several values, choices as a value and a label, the category it is the definition for (E45: the same slug once per
 * category, with its own name, choices, unit and glossary), the categories it belongs to, when it is shown (always, for some
 * brands, some grades, or when another attribute has a value), how product cards show it, active, filterable,
 * comparable, sort, and its glossary page (title, description, text and FAQs).
 * @module
 */
import { checkGroup, faqsEditor } from './admin-fields.js';
import { card, createScreen, deleteEntry, detailHead, fieldsOf, masonryOf, saveDialog, yesNo } from './admin-screen.js';
import { categoryChoices, faqList } from './admin-taxonomy.js';

/** @typedef {import('./admin-kit.js').Kit} Kit */
/** @typedef {import('./admin-taxonomy.js').Lookups} Lookups */
/** @typedef {import('./admin-taxonomy.js').Named} Named */

/** Attribute types, places, visibility rules and card displays. */
const TYPES = Object.freeze(['text', 'number', 'boolean', 'choice']);
const PLACES = Object.freeze(['product', 'variant']);
const VISIBILITY = Object.freeze(['always', 'brands', 'grades', 'attribute']);
const CARDS = Object.freeze(['none', 'image', 'chips']);
/** At most this many choices. */
const MAX_CHOICES = 100;

/**
 * The choices of an attribute as `{ value, label }`.
 * @param {Named | null} attribute
 * @returns {Array<{ value: string, label: string }>}
 */
export const choicesOf = (attribute) =>
	(attribute?.choices ?? []).map((/** @type {any} */ choice) => ({
		value: String(choice.value),
		label: String(choice.label),
	}));

/**
 * Choices as rows of a value and a label, removable, with Add.
 * @param {Kit} kit @param {Array<{ value: string, label: string }>} start
 */
const choicesEditor = (kit, start) => {
	const { t, h } = kit;
	const rows = h('div', { class: 'choices' });
	/** @type {Array<{ value: HTMLInputElement, label: HTMLInputElement }>} */
	let entries = [];
	/** @param {{ value: string, label: string }} choice */
	const make = (choice) => ({
		value: kit.input(choice.value, { maxlength: '200' }),
		label: kit.input(choice.label === choice.value ? '' : choice.label, { maxlength: '200' }),
	});
	const draw = () => {
		rows.replaceChildren(
			...entries.map((entry, index) =>
				h('div', { class: 'row inline' }, [
					kit.field(t('catalogAdmin.choiceValue', { number: index + 1 }), entry.value),
					kit.field(t('catalogAdmin.choiceLabel', { number: index + 1 }), entry.label),
					kit.button(
						t('admin.remove'),
						() => {
							entries = entries.filter((other) => other !== entry);
							draw();
						},
						{ attributes: { 'aria-label': t('catalogAdmin.removeChoice', { number: index + 1 }) } },
					),
				]),
			),
		);
		add.hidden = entries.length >= MAX_CHOICES;
	};
	const add = kit.button(t('catalogAdmin.addChoice'), () => {
		entries.push(make({ value: '', label: '' }));
		draw();
	});
	entries = start.map(make);
	draw();
	return {
		node: kit.group(t('catalogAdmin.choicesTitle'), [rows, add]),
		value: () =>
			entries
				.map((entry) => ({ value: entry.value.value.trim(), label: entry.label.value.trim() }))
				.filter((choice) => choice.value)
				.map((choice) => ({ value: choice.value, label: choice.label || choice.value })),
	};
};

/**
 * When an attribute is shown, for people.
 * @param {Kit} kit @param {Lookups} lookups @param {Named} item
 */
const visibilityText = (kit, lookups, item) => {
	const rule = item.visibility ?? { when: 'always' };
	if (rule.when === 'brands')
		return kit.t('catalogAdmin.visibleForBrands', {
			names: (rule.ids ?? []).map((/** @type {string} */ id) => lookups.nameOf('brands', id)).join(', '),
		});
	if (rule.when === 'grades') {
		const grades = new Map(lookups.grades().map((grade) => [grade.key, grade.label]));
		return kit.t('catalogAdmin.visibleForGrades', {
			names: (rule.ids ?? []).map((/** @type {string} */ id) => grades.get(id) ?? id).join(', '),
		});
	}
	if (rule.when === 'attribute')
		return kit.t('catalogAdmin.visibleWhen', { name: lookups.nameOf('attributes', rule.attributeId), value: rule.value ?? '' });
	return kit.t('catalogAdmin.visibility.always');
};

/** @param {Kit} kit @param {HTMLElement} panel @param {Lookups} lookups */
export const attributesTab = (kit, panel, lookups) => {
	const { t, h } = kit;
	const path = '/v1/admin/attributes';
	let needle = '';
	const place = kit.select([
		{ value: '', label: t('admin.all') },
		...PLACES.map((key) => ({ value: key, label: t(`catalogAdmin.on.${key}`) })),
	]);
	/** @type {Named[]} */
	let all = [];
	/** @param {string | null} [pick] */
	const show = (pick = null) => {
		const shown = all.filter(
			(item) =>
				(!place.value || (item.on ?? 'product') === place.value) &&
				(!needle || `${item.name} ${item.slug ?? ''}`.toLowerCase().includes(needle)),
		);
		screen.set(shown, pick);
		kit.say(screen.line, all.length === 0 ? t('catalogAdmin.noAttributes') : shown.length === 0 ? t('admin.noMatches') : '');
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
		const slug = kit.input(item?.slug ?? '', { maxlength: '120' });
		const type = kit.select(
			TYPES.map((key) => ({ value: key, label: t(`catalogAdmin.type.${key}`) })),
			item?.type ?? 'text',
		);
		const on = kit.select(
			PLACES.map((key) => ({ value: key, label: t(`catalogAdmin.on.${key}`) })),
			item?.on ?? 'product',
		);
		const unit = kit.input(item?.unit ?? '', { maxlength: '20' });
		const sort = kit.input(String(item?.sort ?? 0), { type: 'number', step: '1' });
		const cardMode = kit.select(
			CARDS.map((key) => ({ value: key, label: t(`catalogAdmin.card.${key}`) })),
			item?.card ?? 'none',
		);
		const multiple = kit.check(t('catalogAdmin.multiple'), item?.multiple === true);
		const filterable = kit.check(t('catalogAdmin.filterable'), item?.filterable === true);
		const comparable = kit.check(t('catalogAdmin.comparable'), item?.comparable === true);
		const active = kit.check(t('catalogAdmin.attributeActive'), item?.active !== false);
		const choices = choicesEditor(kit, choicesOf(item));
		const forCategory = kit.select(
			[
				{ value: '', label: t('catalogAdmin.everyCategory') },
				...lookups.state.categories.map((category) => ({ value: category.id, label: category.name })),
			],
			item?.categoryId ?? '',
		);
		const categories = checkGroup(
			kit,
			t('catalogAdmin.attributeCategories'),
			categoryChoices(lookups.state.categories),
			item?.categoryIds ?? [],
		);
		const rule = item?.visibility ?? { when: 'always', ids: [], attributeId: null, value: null };
		const when = kit.select(
			VISIBILITY.map((key) => ({ value: key, label: t(`catalogAdmin.visibility.${key}`) })),
			rule.when,
		);
		const brands = checkGroup(
			kit,
			t('catalogAdmin.brands'),
			lookups.state.brands.map((brand) => ({ value: brand.id, label: brand.name })),
			rule.when === 'brands' ? rule.ids : [],
		);
		const grades = checkGroup(
			kit,
			t('catalogAdmin.grades'),
			lookups.grades().map((grade) => ({ value: grade.key, label: grade.label })),
			rule.when === 'grades' ? rule.ids : [],
		);
		const other = kit.select(
			[
				{ value: '', label: t('catalogAdmin.pickAttribute') },
				...lookups.state.attributes
					.filter((entry) => entry.id !== item?.id)
					.map((entry) => ({ value: entry.id, label: entry.name })),
			],
			rule.attributeId ?? '',
		);
		const otherValue = kit.input(rule.value ?? '', { maxlength: '200' });
		const otherRow = fieldsOf(kit, [
			kit.field(t('catalogAdmin.otherAttribute'), other),
			kit.field(t('catalogAdmin.otherValue'), otherValue),
		]);
		const glossary = item?.seo ?? { title: '', description: '', body: '', faqs: [] };
		const glossaryTitle = kit.input(glossary.title ?? '', { maxlength: '200' });
		const glossaryDescription = kit.area(glossary.description ?? '', { maxlength: '500', rows: '2' });
		const glossaryBody = kit.area(glossary.body ?? '', { maxlength: '20000', rows: '5' });
		const glossaryFaqs = faqsEditor(kit, glossary.faqs ?? [], t('catalogAdmin.glossaryFaqs'));
		const sync = () => {
			choices.node.hidden = type.value !== 'choice';
			brands.node.hidden = when.value !== 'brands';
			grades.node.hidden = when.value !== 'grades';
			otherRow.hidden = when.value !== 'attribute';
		};
		type.addEventListener('change', sync);
		when.addEventListener('change', sync);
		sync();
		saveDialog(kit, {
			title: item ? t('admin.editing', { name: item.name }) : t('catalogAdmin.newAttribute'),
			wide: true,
			path,
			id: item?.id ?? null,
			body: [
				fieldsOf(kit, [
					kit.field(t('catalogAdmin.name'), name),
					kit.field(t('catalogAdmin.slug'), slug),
					kit.field(t('catalogAdmin.attributeType'), type),
					kit.field(t('catalogAdmin.attributeOn'), on),
					kit.field(t('catalogAdmin.unit'), unit),
					kit.field(t('catalogAdmin.sort'), sort),
					kit.field(t('catalogAdmin.cardDisplay'), cardMode),
					kit.field(t('catalogAdmin.attributeFor'), forCategory),
				]),
				fieldsOf(kit, [multiple.node, filterable.node, comparable.node, active.node]),
				choices.node,
				categories.node,
				kit.group(t('catalogAdmin.visibilityTitle'), [
					kit.field(t('catalogAdmin.visibleWhenTitle'), when),
					brands.node,
					grades.node,
					otherRow,
				]),
				kit.group(t('catalogAdmin.glossary'), [
					kit.field(t('catalogAdmin.glossaryTitle'), glossaryTitle),
					kit.field(t('catalogAdmin.glossaryDescription'), glossaryDescription),
					kit.field(t('catalogAdmin.glossaryBody'), glossaryBody),
					glossaryFaqs.node,
				]),
			],
			value: () => ({
				name: name.value,
				slug: slug.value.trim(),
				type: type.value,
				on: on.value,
				unit: unit.value,
				sort: Number(sort.value) || 0,
				card: cardMode.value,
				multiple: multiple.box.checked,
				filterable: filterable.box.checked,
				comparable: comparable.box.checked,
				active: active.box.checked,
				choices: type.value === 'choice' ? choices.value() : [],
				categoryId: forCategory.value || null,
				categoryIds: categories.value(),
				visibility:
					when.value === 'brands'
						? { when: 'brands', ids: brands.value() }
						: when.value === 'grades'
							? { when: 'grades', ids: grades.value() }
							: when.value === 'attribute'
								? { when: 'attribute', attributeId: other.value, value: otherValue.value.trim() }
								: { when: 'always' },
				seo: {
					title: glossaryTitle.value.trim(),
					description: glossaryDescription.value.trim(),
					body: glossaryBody.value.trim(),
					faqs: glossaryFaqs.value(),
				},
			}),
			saved: after,
		});
	};

	/** @param {Named} item */
	const detail = (item) => {
		const choices = choicesOf(item);
		/** @type {string[]} */
		const scope = item.categoryIds ?? [];
		return [
			detailHead(kit, {
				title: item.name,
				badges: [
					kit.badge(
						t(item.active === false ? 'catalogAdmin.inactive' : 'catalogAdmin.active'),
						item.active === false ? 'neutral' : 'success',
					),
					kit.badge(t(`catalogAdmin.on.${item.on ?? 'product'}`)),
				],
				actions: [kit.button(t('admin.edit'), () => edit(item), { primary: true })],
				more: [deleteEntry(kit, { name: item.name, path: `${path}/${item.id}`, done: () => after({ id: null }) })],
			}),
			kit.fieldGrid([
				[t('catalogAdmin.filterName'), item.slug ? `attr.${item.slug}` : ''],
				[t('catalogAdmin.attributeType'), t(`catalogAdmin.type.${item.type}`)],
				[t('catalogAdmin.unit'), item.unit ?? ''],
				[t('catalogAdmin.multiple'), yesNo(kit, item.multiple)],
				[t('catalogAdmin.filterable'), yesNo(kit, item.filterable)],
				[t('catalogAdmin.comparable'), yesNo(kit, item.comparable)],
				[t('catalogAdmin.cardDisplay'), t(`catalogAdmin.card.${item.card ?? 'none'}`)],
				[t('catalogAdmin.sort'), String(item.sort ?? 0)],
				[
					t('catalogAdmin.attributeFor'),
					item.categoryId ? lookups.nameOf('categories', item.categoryId) : t('catalogAdmin.everyCategory'),
				],
				[
					t('catalogAdmin.attributeCategories'),
					scope.length === 0
						? t('catalogAdmin.allCategories')
						: scope.map((id) => lookups.nameOf('categories', id)).join(', '),
				],
				[t('catalogAdmin.visibilityTitle'), visibilityText(kit, lookups, item)],
			]),
			masonryOf(kit, [
				item.type === 'choice'
					? card(kit, t('catalogAdmin.choicesTitle'), [
							kit.table(
								[t('catalogAdmin.choiceValueHead'), t('catalogAdmin.choiceLabelHead')],
								choices.map((choice) => [choice.value, choice.label]),
							),
						])
					: null,
				card(kit, t('catalogAdmin.glossary'), [
					kit.fieldGrid([
						[t('catalogAdmin.glossaryTitle'), item.seo?.title ?? ''],
						[t('catalogAdmin.glossaryDescription'), item.seo?.description ?? ''],
					]),
					item.seo?.body ? kit.text('p', { class: 'prose' }, item.seo.body) : null,
					faqList(kit, item.seo?.faqs),
				]),
			]),
		];
	};

	const screen = createScreen(kit, panel, {
		tools: [
			h('div', { class: 'tools' }, [
				h('div', { class: 'row inline' }, [
					(() => {
						const search = kit.input('', { type: 'search', placeholder: t('catalogAdmin.searchList') });
						search.addEventListener('input', () => {
							needle = search.value.trim().toLowerCase();
							show();
						});
						return kit.field(t('admin.search'), search);
					})(),
					kit.field(t('catalogAdmin.attributeOn'), place),
				]),
				kit.button(t('catalogAdmin.newAttribute'), () => edit(null), { primary: true }),
			]),
		],
		empty: t('catalogAdmin.noAttributes'),
		idOf: (item) => item.id,
		row: (item) => ({
			name: item.name,
			tone: item.active === false ? 'neutral' : 'success',
			toneLabel: t(item.active === false ? 'catalogAdmin.inactive' : 'catalogAdmin.active'),
			figure: t(`catalogAdmin.type.${item.type}`),
			meta: [
				item.slug,
				item.categoryId ? lookups.nameOf('categories', item.categoryId) : '',
				t(`catalogAdmin.on.${item.on ?? 'product'}`),
				item.unit,
				item.filterable ? t('catalogAdmin.filterable') : '',
			]
				.filter(Boolean)
				.join(' · '),
		}),
		detail,
	});
	place.addEventListener('change', () => show());
	void load();
};
