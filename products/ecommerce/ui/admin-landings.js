/**
 * Landing pages in the catalog admin widget (feature `landing_pages`, PLAN 0.8.10 E15) as a list-and-detail screen:
 * the list filtered by category, brand, grade and a search, each row with its address, how many of its products are in
 * stock and whether search engines index it now; the editor (category, brand, grade, heading, title, description,
 * introduction, FAQs and indexable auto / yes / no); AI copy suggestions (with `ai_copy`) to check and apply; Delete.
 * @module
 */
import { query } from './admin-kit.js';
import { faqsEditor } from './admin-fields.js';
import { card, createScreen, deleteEntry, detailHead, fieldsOf, masonryOf, readFrom, saveDialog } from './admin-screen.js';
import { categoryChoices, faqList } from './admin-taxonomy.js';

/** @typedef {import('./admin-kit.js').Kit} Kit */
/** @typedef {import('./admin-taxonomy.js').Lookups} Lookups */
/**
 * @typedef {{ id: string, categoryId: string | null, brandId: string | null, grade: string | null, h1: string,
 *   title: string, description: string, intro: string, faqs: Array<{ question: string, answer: string }>,
 *   indexable: 'auto' | 'yes' | 'no', url?: string, inStock?: number, indexed?: boolean }} Landing
 */

/** The copy AI can suggest for a landing page. */
const AI_FIELDS = Object.freeze(['h1', 'title', 'description', 'intro', 'faqs']);

/**
 * What a landing page lists, for people (`Chairs · Acme · Grade A`).
 * @param {Lookups} lookups @param {Landing} landing
 */
const comboOf = (lookups, landing) => {
	const grades = new Map(lookups.grades().map((grade) => [grade.key, grade.label]));
	return [
		lookups.nameOf('categories', landing.categoryId),
		lookups.nameOf('brands', landing.brandId),
		landing.grade ? (grades.get(landing.grade) ?? landing.grade) : '',
	]
		.filter(Boolean)
		.join(' · ');
};

/**
 * Choices of a select: none, then the items.
 * @param {string} none @param {Array<{ value: string, label: string }>} items
 */
const withNone = (none, items) => [{ value: '', label: none }, ...items];

/** @param {Kit} kit @param {HTMLElement} panel @param {Lookups} lookups */
export const landingsTab = (kit, panel, lookups) => {
	const { t, h, has } = kit;
	const path = '/v1/admin/landings';
	const gradeChoices = lookups.grades().map((grade) => ({ value: grade.key, label: grade.label }));
	const brandChoices = lookups.state.brands.map((brand) => ({ value: brand.id, label: brand.name }));
	const search = kit.input('', { type: 'search', placeholder: t('catalogAdmin.searchLandings') });
	const category = kit.select(withNone(t('admin.all'), categoryChoices(lookups.state.categories)));
	const brand = kit.select(withNone(t('admin.all'), brandChoices));
	const grade = kit.select(withNone(t('admin.all'), gradeChoices));

	/** @param {string | null} [pick] @returns {Promise<unknown>} */
	const load = async (pick = null) => {
		const answer = await kit.call(
			'GET',
			`${path}${query({ q: search.value.trim(), category: category.value, brand: brand.value, grade: grade.value })}`,
		);
		if (!answer.ok) return kit.fail(screen.line, answer);
		/** @type {Landing[]} */
		const items = answer.data.items ?? [];
		screen.set(items, pick);
		kit.say(screen.line, items.length === 0 ? t('catalogAdmin.noLandings') : '');
		return answer;
	};
	/** @param {any} saved */
	const after = async (saved) => {
		await load(saved.id);
	};
	/** @param {Landing} landing */
	const nameOf = (landing) => landing.h1 || landing.title || comboOf(lookups, landing) || landing.id;

	/** @param {Landing | null} landing */
	const edit = (landing) => {
		const categoryPick = kit.select(
			withNone(t('catalogAdmin.anyCategory'), categoryChoices(lookups.state.categories)),
			landing?.categoryId ?? '',
		);
		const brandPick = kit.select(withNone(t('catalogAdmin.anyBrand'), brandChoices), landing?.brandId ?? '');
		const gradePick = kit.select(withNone(t('catalogAdmin.anyGrade'), gradeChoices), landing?.grade ?? '');
		const h1 = kit.input(landing?.h1 ?? '', { maxlength: '200' });
		const title = kit.input(landing?.title ?? '', { maxlength: '200' });
		const description = kit.area(landing?.description ?? '', { rows: '2', maxlength: '500' });
		const intro = kit.area(landing?.intro ?? '', { rows: '5', maxlength: '5000' });
		const indexable = kit.select(
			['auto', 'yes', 'no'].map((key) => ({ value: key, label: t(`catalogAdmin.indexable.${key}`) })),
			landing?.indexable ?? 'auto',
		);
		const faqs = faqsEditor(kit, landing?.faqs ?? []);
		saveDialog(kit, {
			title: landing ? t('admin.editing', { name: nameOf(landing) }) : t('catalogAdmin.newLanding'),
			wide: true,
			path,
			id: landing?.id ?? null,
			body: [
				fieldsOf(kit, [
					kit.field(t('catalogAdmin.category'), categoryPick),
					kit.field(t('catalogAdmin.brand'), brandPick),
					gradeChoices.length > 0 ? kit.field(t('catalogAdmin.grade'), gradePick) : null,
					kit.field(t('catalogAdmin.indexableTitle'), indexable),
				]),
				fieldsOf(kit, [kit.field(t('catalogAdmin.landingH1'), h1), kit.field(t('catalogAdmin.seoTitle'), title)]),
				kit.field(t('catalogAdmin.seoDescription'), description),
				kit.field(t('catalogAdmin.landingIntro'), intro),
				faqs.node,
			],
			value: () =>
				categoryPick.value || brandPick.value || gradePick.value
					? {
							categoryId: categoryPick.value || null,
							brandId: brandPick.value || null,
							grade: gradePick.value || null,
							h1: h1.value,
							title: title.value,
							description: description.value,
							intro: intro.value,
							faqs: faqs.value(),
							indexable: indexable.value,
						}
					: t('catalogAdmin.landingNeedsOne'),
			saved: after,
		});
	};

	/**
	 * AI copy (E15): ask for suggestions of the fields picked, change them if needed, and apply the ones checked.
	 * @param {Landing} landing
	 */
	const writeWithAi = (landing) => {
		const note = kit.status();
		const picks = AI_FIELDS.map((key) => ({ key, ...kit.check(t(`catalogAdmin.landingField.${key}`), true) }));
		const results = h('div');
		/** @type {Array<{ key: string, use: HTMLInputElement, node: HTMLElement, read: () => unknown }>} */
		let got = [];
		const suggest = kit.button(
			t('catalogAdmin.suggest'),
			async () => {
				kit.say(note, t('catalogAdmin.aiWorking'));
				const answer = await kit.call('POST', `${path}/${landing.id}/ai-copy`, {
					fields: picks.filter((pick) => pick.box.checked).map((pick) => pick.key),
				});
				if (!answer.ok) return kit.fail(note, answer);
				const suggestions = answer.data.suggestions;
				got = AI_FIELDS.filter((key) => suggestions[key] !== undefined).map((key) => {
					const use = kit.check(t('catalogAdmin.applyField', { field: t(`catalogAdmin.landingField.${key}`) }), true);
					if (key === 'faqs') {
						const editor = faqsEditor(kit, suggestions.faqs, t('catalogAdmin.landingField.faqs'));
						return { key, use: use.box, node: h('div', {}, [use.node, editor.node]), read: () => editor.value() };
					}
					const control =
						key === 'intro' ? kit.area(String(suggestions[key]), { rows: '5' }) : kit.input(String(suggestions[key]));
					return {
						key,
						use: use.box,
						node: h('div', {}, [use.node, kit.field(t(`catalogAdmin.landingField.${key}`), control)]),
						read: () => control.value,
					};
				});
				kit.put(
					results,
					got.map((entry) => entry.node),
				);
				kit.say(note, t('catalogAdmin.aiCheck'));
				return answer;
			},
			{ primary: true },
		);
		kit.dialog({
			title: t('catalogAdmin.aiCopy'),
			wide: true,
			body: [
				h(
					'div',
					{ class: 'checks' },
					picks.map((pick) => pick.node),
				),
				suggest,
				note,
				results,
			],
			submitLabel: t('catalogAdmin.applySuggestions'),
			onSubmit: async () => {
				const chosen = got.filter((entry) => entry.use.checked);
				if (chosen.length === 0) return t('catalogAdmin.nothingToApply');
				const answer = await kit.call(
					'PATCH',
					`${path}/${landing.id}`,
					Object.fromEntries(chosen.map((entry) => [entry.key, entry.read()])),
				);
				if (!answer.ok) return kit.reason(answer);
				await after(answer.data);
				return null;
			},
		});
	};

	/** @param {Landing} landing */
	const detail = (landing) => [
		detailHead(kit, {
			title: nameOf(landing),
			badges: [
				kit.badge(
					t(landing.indexed ? 'catalogAdmin.indexed' : 'catalogAdmin.notIndexed'),
					landing.indexed ? 'success' : 'neutral',
				),
			],
			actions: [kit.button(t('admin.edit'), () => edit(landing), { primary: true })],
			more: [
				has('ai_copy') ? { label: t('catalogAdmin.aiCopy'), onSelect: () => writeWithAi(landing) } : null,
				deleteEntry(kit, { name: nameOf(landing), path: `${path}/${landing.id}`, done: () => after({ id: null }) }),
			],
		}),
		kit.fieldGrid([
			[t('catalogAdmin.landingLists'), comboOf(lookups, landing)],
			[
				t('catalogAdmin.landingUrl'),
				landing.url ? h('a', { href: landing.url, target: '_blank', rel: 'noopener' }, [landing.url]) : '',
			],
			[t('catalogAdmin.inStockHere'), String(landing.inStock ?? 0)],
			[t('catalogAdmin.indexableTitle'), t(`catalogAdmin.indexable.${landing.indexable}`)],
		]),
		masonryOf(kit, [
			card(kit, t('catalogAdmin.landingCopy'), [
				kit.fieldGrid([
					[t('catalogAdmin.landingH1'), landing.h1],
					[t('catalogAdmin.seoTitle'), landing.title],
					[t('catalogAdmin.seoDescription'), landing.description],
				]),
				landing.intro ? kit.text('p', { class: 'prose' }, landing.intro) : null,
			]),
			card(kit, t('catalogAdmin.faqs'), [faqList(kit, landing.faqs)]),
		]),
	];

	const filters = h('form', { class: 'row inline' }, [
		kit.field(t('admin.search'), search),
		kit.field(t('catalogAdmin.category'), category),
		kit.field(t('catalogAdmin.brand'), brand),
		gradeChoices.length > 0 ? kit.field(t('catalogAdmin.grade'), grade) : null,
	]);
	filters.addEventListener('submit', (event) => {
		event.preventDefault();
		void load();
	});
	for (const control of [category, brand, grade]) control.addEventListener('change', () => void load());

	const screen = createScreen(kit, panel, {
		tools: [
			h('div', { class: 'tools' }, [filters, kit.button(t('catalogAdmin.newLanding'), () => edit(null), { primary: true })]),
		],
		empty: t('catalogAdmin.noLandings'),
		read: readFrom(kit, path),
		idOf: (landing) => landing.id,
		row: (landing) => ({
			name: nameOf(landing),
			tone: landing.indexed ? 'success' : 'neutral',
			toneLabel: t(landing.indexed ? 'catalogAdmin.indexed' : 'catalogAdmin.notIndexed'),
			figure: t('catalogAdmin.inStockFigure', { count: landing.inStock ?? 0 }),
			meta: landing.url ?? '',
		}),
		detail,
	});
	void load();
};
