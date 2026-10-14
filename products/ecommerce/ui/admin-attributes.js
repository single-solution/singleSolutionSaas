/**
 * The fields section of the catalog admin widget (attributes widened into merchant fields, PLAN 0.8.10 E7 and dynamic
 * model §2) as a list-and-detail screen: every part of a field — name, slug (the filter name `attr.<slug>`), where its
 * values live (products, variants, units, orders or customers), its type (text, number, choice, yes/no, date), a unit,
 * a number's range and decimals, a date's days, several values and how many, choices as a value and a label, a text's
 * format (characters, length, starts, a pattern, a Luhn check digit, spaces dropped, upper case) with a live "Try a
 * value" check, whether it is required (an order field: at checkout or before a stage), where its values show (only
 * the places that fit where they live), the category it is the definition for (E45) and the categories it is for
 * (product and variant fields; unit fields apply through the item types that name them), when it is shown (always, for
 * some brands, some grades, or when another field has a value), active, sort, and its glossary page (title,
 * description, text and FAQs). Values of a field shown nowhere a shopper looks are the staff's alone.
 * @module
 */
import {
	CARD_MODES,
	CHECK_DIGITS,
	FEED_TARGETS,
	FIELD_DATES,
	FIELD_LIMITS,
	FIELD_ON,
	FIELD_TYPES,
	FORMAT_CHARS,
	JSONLD_TARGETS,
	REQUIRED_AT,
	SHOW_PLACES,
	checkFormat,
	checkFormatRule,
} from '../core/fields.js';
import { checkGroup, faqsEditor } from './admin-fields.js';
import { card, createScreen, deleteEntry, detailHead, fieldsOf, masonryOf, saveDialog, yesNo } from './admin-screen.js';
import { categoryChoices, faqList } from './admin-taxonomy.js';

/** @typedef {import('./admin-kit.js').Kit} Kit */
/** @typedef {import('./admin-taxonomy.js').Lookups} Lookups */
/** @typedef {import('./admin-taxonomy.js').Named} Named */

/** Visibility rules. */
const VISIBILITY = Object.freeze(['always', 'brands', 'grades', 'attribute']);
/** The places a field shows that are a yes or no (the others pick one of their values). */
const SHOW_CHECKS = Object.freeze(['page', 'filter', 'compare', 'invoice', 'packingSlip', 'shopper', 'chat']);
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

/**
 * A field's format as people read it ('' = none).
 * @param {Kit} kit @param {any} format
 */
export const formatText = (kit, format) => {
	if (!format) return '';
	const { t } = kit;
	return [
		t(`catalogAdmin.chars.${format.chars}`),
		format.minLength === format.maxLength
			? t('catalogAdmin.lengthExactly', { length: format.minLength })
			: t('catalogAdmin.lengthRange', { min: format.minLength, max: format.maxLength }),
		format.startsWith.length > 0 ? t('catalogAdmin.startsWithText', { starts: format.startsWith.join(', ') }) : '',
		format.mask ? t('catalogAdmin.maskText', { mask: format.mask }) : '',
		format.checkDigit === 'none' ? '' : t(`catalogAdmin.checkDigit.${format.checkDigit}`),
		format.ignoreSpaces ? t('catalogAdmin.ignoreSpaces') : '',
		format.upperCase ? t('catalogAdmin.upperCase') : '',
	]
		.filter(Boolean)
		.join(' · ');
};

/**
 * Where a field's values show, as people read it.
 * @param {Kit} kit @param {any} item
 */
const showText = (kit, item) => {
	const { t } = kit;
	const show = item.show ?? {};
	const places = /** @type {readonly string[]} */ (SHOW_PLACES[/** @type {keyof typeof SHOW_PLACES} */ (item.on)] ?? []);
	const shown = places.flatMap((place) => {
		const value = show[place];
		if (value === false || value === 'none' || value === undefined) return [];
		if (place === 'card') return [t(`catalogAdmin.card.${value}`)];
		if (place === 'feeds') return [t('catalogAdmin.feedsAs', { target: t(`catalogAdmin.feeds.${value}`) })];
		if (place === 'jsonLd') return [t('catalogAdmin.jsonLdAs', { target: t(`catalogAdmin.jsonLd.${value}`) })];
		return [t(`catalogAdmin.show.${place}`)];
	});
	return shown.length === 0 ? t('catalogAdmin.staffOnly') : shown.join(' · ');
};

/**
 * The format builder of a text field: its parts and a "Try a value" box that checks a value as the server will.
 * @param {Kit} kit @param {any} start the field's format (null = none)
 */
const formatEditor = (kit, start) => {
	const { t, h } = kit;
	const on = kit.check(t('catalogAdmin.formatOn'), start !== null && start !== undefined);
	const format = start ?? {};
	const chars = kit.select(
		FORMAT_CHARS.map((key) => ({ value: key, label: t(`catalogAdmin.chars.${key}`) })),
		format.chars ?? 'any',
	);
	const minLength = kit.input(String(format.minLength ?? 1), { type: 'number', min: '1', max: '200', step: '1' });
	const maxLength = kit.input(String(format.maxLength ?? 200), { type: 'number', min: '1', max: '200', step: '1' });
	const starts = kit.input((format.startsWith ?? []).join(', '), { maxlength: '230' });
	const mask = kit.input(format.mask ?? '', { maxlength: '64', spellcheck: 'false' });
	const checkDigit = kit.select(
		CHECK_DIGITS.map((key) => ({ value: key, label: t(`catalogAdmin.checkDigit.${key}`) })),
		format.checkDigit ?? 'none',
	);
	const ignoreSpaces = kit.check(t('catalogAdmin.ignoreSpaces'), format.ignoreSpaces === true);
	const upperCase = kit.check(t('catalogAdmin.upperCase'), format.upperCase === true);
	const tryValue = kit.input('', { maxlength: '200', spellcheck: 'false' });
	const result = kit.status();
	/** The format as sent: null when off. */
	const value = () =>
		on.box.checked
			? {
					chars: chars.value,
					minLength: Number(minLength.value),
					maxLength: Number(maxLength.value),
					startsWith: starts.value
						.split(',')
						.map((start) => start.trim())
						.filter(Boolean),
					mask: mask.value.trim(),
					checkDigit: checkDigit.value,
					ignoreSpaces: ignoreSpaces.box.checked,
					upperCase: upperCase.box.checked,
				}
			: null;
	/** Check the tried value against the format as it stands (the format's own problems first). */
	const check = () => {
		const typed = tryValue.value;
		if (!typed.trim()) return kit.say(result, '');
		const rule = checkFormatRule(value());
		if (!rule.ok) return kit.say(result, t('catalogAdmin.formatBroken'), true);
		if (!rule.value) return kit.say(result, t('catalogAdmin.tryMatches', { value: typed.trim() }));
		const checked = checkFormat(typed, rule.value);
		return checked.ok
			? kit.say(result, t('catalogAdmin.tryMatches', { value: checked.value }))
			: kit.say(
					result,
					`${t('fields.notFormat', { value: typed.trim(), field: t('catalogAdmin.thisField') })} ${t(`fields.problem.${checked.code}`)}`,
					true,
				);
	};
	const parts = h('div', {}, [
		h('div', { class: 'fields' }, [
			kit.field(t('catalogAdmin.chars'), chars),
			kit.field(t('catalogAdmin.minLength'), minLength),
			kit.field(t('catalogAdmin.maxLength'), maxLength),
			kit.field(t('catalogAdmin.startsWith'), starts),
			kit.field(t('catalogAdmin.mask'), mask),
			kit.field(t('catalogAdmin.checkDigit'), checkDigit),
		]),
		h('div', { class: 'fields' }, [ignoreSpaces.node, upperCase.node]),
		kit.field(t('catalogAdmin.tryValue'), tryValue),
		result,
	]);
	const sync = () => {
		parts.hidden = !on.box.checked;
		check();
	};
	for (const control of [
		on.box,
		chars,
		minLength,
		maxLength,
		starts,
		mask,
		checkDigit,
		ignoreSpaces.box,
		upperCase.box,
		tryValue,
	])
		for (const event of ['input', 'change']) control.addEventListener(event, sync);
	sync();
	return { node: kit.group(t('catalogAdmin.formatTitle'), [on.node, parts]), value };
};

/** @param {Kit} kit @param {HTMLElement} panel @param {Lookups} lookups */
export const attributesTab = (kit, panel, lookups) => {
	const { t, h } = kit;
	const path = '/v1/admin/attributes';
	let needle = '';
	const place = kit.select([
		{ value: '', label: t('admin.all') },
		...FIELD_ON.map((key) => ({ value: key, label: t(`catalogAdmin.on.${key}`) })),
	]);
	/** @type {Named[]} */
	let all = [];
	/** @param {string | null} [pick] */
	const show = (pick = null) => {
		const shown = all.filter(
			(item) =>
				(!place.value || item.on === place.value) &&
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
			FIELD_TYPES.map((key) => ({ value: key, label: t(`catalogAdmin.type.${key}`) })),
			item?.type ?? 'text',
		);
		const on = kit.select(
			FIELD_ON.map((key) => ({ value: key, label: t(`catalogAdmin.on.${key}`) })),
			item?.on ?? 'product',
		);
		const unit = kit.input(item?.unit ?? '', { maxlength: '20' });
		const sort = kit.input(String(item?.sort ?? 0), { type: 'number', step: '1' });
		const min = kit.input(item?.min ?? '', { type: 'number', step: 'any' });
		const max = kit.input(item?.max ?? '', { type: 'number', step: 'any' });
		const decimals = kit.select(
			[0, 1, 2, 3].map((count) => ({ value: String(count), label: String(count) })),
			String(item?.decimals ?? 2),
		);
		const dates = kit.select(
			FIELD_DATES.map((key) => ({ value: key, label: t(`catalogAdmin.dates.${key}`) })),
			item?.dates ?? 'any',
		);
		const multiple = kit.check(t('catalogAdmin.multiple'), item?.multiple === true);
		const maxValues = kit.input(String(item?.multiple ? item.maxValues : FIELD_LIMITS.values), {
			type: 'number',
			min: '2',
			max: String(FIELD_LIMITS.values),
			step: '1',
		});
		const required = kit.check(t('catalogAdmin.required'), item?.required === true);
		const requiredAt = kit.select(
			REQUIRED_AT.map((key) => ({ value: key, label: t(`catalogAdmin.requiredAt.${key}`) })),
			item?.requiredAt ?? 'checkout',
		);
		const active = kit.check(t('catalogAdmin.attributeActive'), item?.active !== false);
		const choices = choicesEditor(kit, choicesOf(item));
		const format = formatEditor(kit, item?.format ?? null);
		const given = item?.show ?? {};
		const checks = new Map(SHOW_CHECKS.map((key) => [key, kit.check(t(`catalogAdmin.show.${key}`), given[key] === true)]));
		const cardMode = kit.select(
			CARD_MODES.map((key) => ({ value: key, label: t(`catalogAdmin.card.${key}`) })),
			given.card ?? 'none',
		);
		const feeds = kit.select(
			FEED_TARGETS.map((key) => ({ value: key, label: t(`catalogAdmin.feeds.${key}`) })),
			given.feeds ?? 'none',
		);
		const jsonLd = kit.select(
			JSONLD_TARGETS.map((key) => ({ value: key, label: t(`catalogAdmin.jsonLd.${key}`) })),
			given.jsonLd ?? 'none',
		);
		const cardField = kit.field(t('catalogAdmin.cardDisplay'), cardMode);
		const feedsField = kit.field(t('catalogAdmin.show.feeds'), feeds);
		const jsonLdField = kit.field(t('catalogAdmin.show.jsonLd'), jsonLd);
		// a new product or variant field shows on the page and in Chat, as attributes always did
		if (!item) for (const key of ['page', 'chat']) /** @type {any} */ (checks.get(key)).box.checked = true;
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
					.filter((entry) => entry.id !== item?.id && (entry.on === 'product' || entry.on === 'variant'))
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
		const numberRow = fieldsOf(kit, [
			kit.field(t('catalogAdmin.min'), min),
			kit.field(t('catalogAdmin.max'), max),
			kit.field(t('catalogAdmin.decimals'), decimals),
		]);
		const datesField = kit.field(t('catalogAdmin.dates'), dates);
		const unitField = kit.field(t('catalogAdmin.unit'), unit);
		const maxValuesField = kit.field(t('catalogAdmin.maxValues'), maxValues);
		const requiredAtField = kit.field(t('catalogAdmin.requiredAtTitle'), requiredAt);
		const forField = kit.field(t('catalogAdmin.attributeFor'), forCategory);
		const showGroup = kit.group(t('catalogAdmin.showTitle'), [
			fieldsOf(kit, [...[...checks.values()].map((entry) => entry.node), cardField, feedsField, jsonLdField]),
			kit.text('p', { class: 'muted' }, t('catalogAdmin.staffOnlyNote')),
		]);
		const visibilityGroup = kit.group(t('catalogAdmin.visibilityTitle'), [
			kit.field(t('catalogAdmin.visibleWhenTitle'), when),
			brands.node,
			grades.node,
			otherRow,
		]);
		const glossaryGroup = kit.group(t('catalogAdmin.glossary'), [
			kit.field(t('catalogAdmin.glossaryTitle'), glossaryTitle),
			kit.field(t('catalogAdmin.glossaryDescription'), glossaryDescription),
			kit.field(t('catalogAdmin.glossaryBody'), glossaryBody),
			glossaryFaqs.node,
		]);
		const sync = () => {
			const where = /** @type {keyof typeof SHOW_PLACES} */ (on.value);
			const catalog = where === 'product' || where === 'variant';
			const places = /** @type {readonly string[]} */ (SHOW_PLACES[where]);
			for (const [key, entry] of checks) entry.node.hidden = !places.includes(key);
			cardField.hidden = !places.includes('card');
			feedsField.hidden = !places.includes('feeds');
			jsonLdField.hidden = !places.includes('jsonLd');
			choices.node.hidden = type.value !== 'choice';
			numberRow.hidden = type.value !== 'number';
			datesField.hidden = type.value !== 'date';
			unitField.hidden = type.value === 'yes_no' || type.value === 'date';
			format.node.hidden = type.value !== 'text';
			multiple.node.hidden = type.value !== 'text' && type.value !== 'choice';
			maxValues.max = String(where === 'unit' ? FIELD_LIMITS.unitValues : FIELD_LIMITS.values);
			maxValuesField.hidden = multiple.node.hidden || !multiple.box.checked;
			required.node.hidden = where === 'customer';
			requiredAtField.hidden = where !== 'order' || !required.box.checked;
			forField.hidden = !catalog;
			categories.node.hidden = !catalog;
			visibilityGroup.hidden = !catalog;
			glossaryGroup.hidden = !catalog;
			brands.node.hidden = when.value !== 'brands';
			grades.node.hidden = when.value !== 'grades';
			otherRow.hidden = when.value !== 'attribute';
		};
		for (const control of [type, on, when, multiple.box, required.box]) control.addEventListener('change', sync);
		sync();
		/** @param {HTMLInputElement} input */
		const numberOf = (input) => (input.value.trim() === '' ? null : Number(input.value));
		saveDialog(kit, {
			title: item ? t('admin.editing', { name: item.name }) : t('catalogAdmin.newAttribute'),
			wide: true,
			path,
			id: item?.id ?? null,
			body: [
				fieldsOf(kit, [
					kit.field(t('catalogAdmin.name'), name),
					kit.field(t('catalogAdmin.slug'), slug),
					kit.field(t('catalogAdmin.attributeOn'), on),
					kit.field(t('catalogAdmin.attributeType'), type),
					unitField,
					datesField,
					kit.field(t('catalogAdmin.sort'), sort),
					forField,
				]),
				numberRow,
				fieldsOf(kit, [multiple.node, maxValuesField, required.node, requiredAtField, active.node]),
				choices.node,
				format.node,
				showGroup,
				categories.node,
				visibilityGroup,
				glossaryGroup,
			],
			value: () => {
				const where = /** @type {keyof typeof SHOW_PLACES} */ (on.value);
				const places = /** @type {readonly string[]} */ (SHOW_PLACES[where]);
				const catalog = where === 'product' || where === 'variant';
				/** @type {Record<string, unknown>} */
				const shown = {};
				for (const [key, entry] of checks) if (places.includes(key)) shown[key] = entry.box.checked;
				if (places.includes('card')) shown.card = cardMode.value;
				if (places.includes('feeds')) shown.feeds = feeds.value;
				if (places.includes('jsonLd')) shown.jsonLd = jsonLd.value;
				const several = !multiple.node.hidden && multiple.box.checked;
				return {
					name: name.value,
					slug: slug.value.trim(),
					on: on.value,
					type: type.value,
					unit: unitField.hidden ? '' : unit.value,
					sort: Number(sort.value) || 0,
					min: type.value === 'number' ? numberOf(min) : null,
					max: type.value === 'number' ? numberOf(max) : null,
					decimals: type.value === 'number' ? Number(decimals.value) : 0,
					dates: type.value === 'date' ? dates.value : 'any',
					multiple: several,
					...(several ? { maxValues: Number(maxValues.value) } : {}),
					format: type.value === 'text' ? format.value() : null,
					required: where !== 'customer' && required.box.checked,
					requiredAt: where === 'order' && required.box.checked ? requiredAt.value : null,
					show: shown,
					active: active.box.checked,
					choices: type.value === 'choice' ? choices.value() : [],
					categoryId: !forField.hidden ? forCategory.value || null : null,
					categoryIds: !categories.node.hidden ? categories.value() : [],
					visibility: !catalog
						? { when: 'always' }
						: when.value === 'brands'
							? { when: 'brands', ids: brands.value() }
							: when.value === 'grades'
								? { when: 'grades', ids: grades.value() }
								: when.value === 'attribute'
									? { when: 'attribute', attributeId: other.value, value: otherValue.value.trim() }
									: { when: 'always' },
					seo: catalog
						? {
								title: glossaryTitle.value.trim(),
								description: glossaryDescription.value.trim(),
								body: glossaryBody.value.trim(),
								faqs: glossaryFaqs.value(),
							}
						: { title: '', description: '', body: '', faqs: [] },
				};
			},
			saved: after,
		});
	};

	/** @param {Named} item */
	const detail = (item) => {
		const choices = choicesOf(item);
		/** @type {string[]} */
		const scope = item.categoryIds ?? [];
		const catalog = item.on === 'product' || item.on === 'variant';
		return [
			detailHead(kit, {
				title: item.name,
				badges: [
					kit.badge(
						t(item.active === false ? 'catalogAdmin.inactive' : 'catalogAdmin.active'),
						item.active === false ? 'neutral' : 'success',
					),
					kit.badge(t(`catalogAdmin.on.${item.on}`)),
					...(item.required ? [kit.badge(t('catalogAdmin.required'), 'warning')] : []),
				],
				actions: [kit.button(t('admin.edit'), () => edit(item), { primary: true })],
				more: [deleteEntry(kit, { name: item.name, path: `${path}/${item.id}`, done: () => after({ id: null }) })],
			}),
			kit.fieldGrid(
				/** @type {Array<[string, string]>} */ ([
					...(catalog ? [[t('catalogAdmin.filterName'), item.slug ? `attr.${item.slug}` : '']] : []),
					[t('catalogAdmin.attributeType'), t(`catalogAdmin.type.${item.type}`)],
					...(item.unit ? [[t('catalogAdmin.unit'), item.unit]] : []),
					...(item.type === 'number'
						? [
								[t('catalogAdmin.min'), item.min === null ? '' : String(item.min)],
								[t('catalogAdmin.max'), item.max === null ? '' : String(item.max)],
								[t('catalogAdmin.decimals'), String(item.decimals)],
							]
						: []),
					...(item.type === 'date' ? [[t('catalogAdmin.dates'), t(`catalogAdmin.dates.${item.dates}`)]] : []),
					...(item.format ? [[t('catalogAdmin.formatTitle'), formatText(kit, item.format)]] : []),
					[
						t('catalogAdmin.multiple'),
						item.multiple ? t('catalogAdmin.upTo', { count: item.maxValues }) : yesNo(kit, false),
					],
					[
						t('catalogAdmin.required'),
						item.requiredAt ? t(`catalogAdmin.requiredAt.${item.requiredAt}`) : yesNo(kit, item.required === true),
					],
					[t('catalogAdmin.showTitle'), showText(kit, item)],
					[t('catalogAdmin.sort'), String(item.sort ?? 0)],
					...(catalog
						? [
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
							]
						: []),
					...(catalog ? [[t('catalogAdmin.visibilityTitle'), visibilityText(kit, lookups, item)]] : []),
				]),
			),
			masonryOf(kit, [
				item.type === 'choice'
					? card(kit, t('catalogAdmin.choicesTitle'), [
							kit.table(
								[t('catalogAdmin.choiceValueHead'), t('catalogAdmin.choiceLabelHead')],
								choices.map((choice) => [choice.value, choice.label]),
							),
						])
					: null,
				catalog
					? card(kit, t('catalogAdmin.glossary'), [
							kit.fieldGrid([
								[t('catalogAdmin.glossaryTitle'), item.seo?.title ?? ''],
								[t('catalogAdmin.glossaryDescription'), item.seo?.description ?? ''],
							]),
							item.seo?.body ? kit.text('p', { class: 'prose' }, item.seo.body) : null,
							faqList(kit, item.seo?.faqs),
						])
					: null,
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
				t(`catalogAdmin.on.${item.on}`),
				item.unit,
				showText(kit, item),
			]
				.filter(Boolean)
				.join(' · '),
		}),
		detail,
	});
	place.addEventListener('change', () => show());
	void load();
};
