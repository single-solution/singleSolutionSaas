/**
 * A product's detail in the catalog admin widget (PLAN 0.6; PLAN 0.8.8 Catalog, Items; PLAN 0.8.10 E2–E16): the head
 * (name, status and featured badges; Edit and Stock; a More menu with AI copy, Generate variants, Photos, Video and
 * Delete behind a typed confirmation), the facts, and cards for variants, photos, video, the description (rich text
 * built safely), specs, the attribute setup, FAQs, SEO and the digital delivery. The Stock dialog sets or adjusts the
 * units of each variant (at a location with multi-location stock) and marks variants sold out; AI copy suggests the
 * summary, description, SEO title and description and FAQs to check and apply. The editor is
 * `./admin-product-editor.js`.
 * @module
 */
import { faqsEditor, paragraphsOf, richNodes, seoChecks, seoFacts } from './admin-fields.js';
import { digitalCard, photosDialog, videoDialog, videoText } from './admin-media.js';
import { card, deleteEntry, detailHead, masonryOf, yesNo } from './admin-screen.js';
import { variantLabel } from './admin-taxonomy.js';
import { partsOf, showsTypes, typeLabel, typeNamed } from './admin-types.js';
import { generateDialog, stockAmount, stockText } from './admin-variants.js';
import { timeText } from './shop-common.js';

/** @typedef {import('./admin-kit.js').Kit} Kit */
/** @typedef {import('./admin-kit.js').Tone} Tone */
/** @typedef {import('./admin-products.js').ProductContext} ProductContext */

/** Product statuses and their status colors. */
export const STATUS_TONES = Object.freeze(
	/** @type {Record<string, Tone>} */ ({ active: 'success', draft: 'warning', archived: 'neutral' }),
);
/** The texts AI copy can suggest for a product. */
const AI_FIELDS = Object.freeze(['summary', 'description', 'seoTitle', 'seoDescription', 'faqs']);

/**
 * The price of a product for people: one price, or the lowest and highest.
 * @param {Kit} kit @param {any} product
 */
const priceText = (kit, product) =>
	typeof product.priceMax === 'number' && product.priceMax > product.price
		? kit.t('catalogAdmin.priceRange', { from: kit.money(product.price), to: kit.money(product.priceMax) })
		: kit.money(product.price);

/**
 * The Stock dialog: per variant set or adjust its units (at a location with multi-location stock), and sold out.
 * @param {Kit} kit @param {any} product @param {ProductContext} context
 */
const stockDialog = (kit, product, context) => {
	const { t, has } = kit;
	const { locations } = context.lookups.state;
	/** @type {any[]} */
	const variants = product.variants;
	// sold in a unit of its own: typed in its unit (thousandths in the API)
	const measure = product.type?.measure ?? null;
	const rows = variants.map((variant) => {
		const label = variantLabel(kit, variant);
		const mode = kit.pick(
			[
				{ value: 'adjust', label: t('catalogAdmin.adjustBy') },
				{ value: 'set', label: t('catalogAdmin.setTo') },
			],
			'adjust',
			{ 'aria-label': t('catalogAdmin.howOf', { variant: label }) },
		);
		const units = measure
			? kit.input('', { inputmode: 'decimal', 'aria-label': t('catalogAdmin.unitsOf', { variant: label }) })
			: kit.input('', { type: 'number', step: '1', 'aria-label': t('catalogAdmin.unitsOf', { variant: label }) });
		const location = kit.select(
			locations.map((item) => ({ value: item.id, label: item.name })),
			'',
			{ 'aria-label': t('catalogAdmin.locationOf', { variant: label }) },
		);
		const soldOut = kit.check('', variant.soldOut === true);
		soldOut.box.setAttribute('aria-label', t('catalogAdmin.soldOutOf', { variant: label }));
		return { variant, label, mode, units, location, soldOut: soldOut.box };
	});
	kit.dialog({
		title: t('catalogAdmin.stockOfProduct', { name: product.name }),
		wide: true,
		body: [
			kit.text('p', { class: 'muted' }, t(product.trackStock ? 'catalogAdmin.stockNote' : 'catalogAdmin.stockNotTracked')),
			kit.table(
				[
					t('catalogAdmin.variant'),
					t('catalogAdmin.stockNow'),
					t('catalogAdmin.how'),
					t('catalogAdmin.units'),
					...(has('multi_location') ? [t('catalogAdmin.location')] : []),
					t('catalogAdmin.soldOut'),
				],
				rows.map((row) => [
					row.label,
					stockText(kit, row.variant, locations, measure),
					row.mode,
					row.units,
					...(has('multi_location') ? [row.location] : []),
					row.soldOut,
				]),
			),
		],
		submitLabel: t('catalogAdmin.changeStock'),
		onSubmit: async () => {
			/** @type {Array<Record<string, unknown>>} */
			const changes = [];
			for (const row of rows) {
				const value = stockAmount(row.units.value, measure);
				if (Number.isNaN(value)) return t('admin.checkNumbers');
				const soldOut = row.soldOut.checked !== (row.variant.soldOut === true);
				if (value === null && !soldOut) continue;
				changes.push({
					variantId: row.variant.id,
					...(value === null
						? {}
						: { [row.mode.value]: value, ...(has('multi_location') ? { locationId: row.location.value } : {}) }),
					...(soldOut ? { soldOut: row.soldOut.checked } : {}),
				});
			}
			if (changes.length === 0) return t('catalogAdmin.nothingToChange');
			const answer = await kit.call('POST', `/v1/admin/products/${product.id}/stock`, { changes });
			if (!answer.ok) return kit.reason(answer);
			context.show(answer.data, t('catalogAdmin.stockSaved'));
			return null;
		},
	});
};

/**
 * AI copy (E16): ask for suggestions of the texts picked, change them if needed, and apply the ones checked.
 * @param {Kit} kit @param {any} product @param {ProductContext} context
 */
const aiDialog = (kit, product, context) => {
	const { t, h } = kit;
	const note = kit.status();
	const picks = AI_FIELDS.map((key) => ({ key, ...kit.check(t(`catalogAdmin.aiField.${key}`), true) }));
	const results = h('div');
	/** @type {Array<{ key: string, use: HTMLInputElement, node: HTMLElement, read: () => any }>} */
	let got = [];
	const suggest = kit.button(
		t('catalogAdmin.suggest'),
		async () => {
			kit.say(note, t('catalogAdmin.aiWorking'));
			const answer = await kit.call('POST', `/v1/admin/products/${product.id}/ai-copy`, {
				fields: picks.filter((pick) => pick.box.checked).map((pick) => pick.key),
			});
			if (!answer.ok) return kit.fail(note, answer);
			const suggestions = answer.data.suggestions;
			got = AI_FIELDS.filter((key) => suggestions[key] !== undefined).map((key) => {
				const use = kit.check(t('catalogAdmin.applyField', { field: t(`catalogAdmin.aiField.${key}`) }), true);
				if (key === 'faqs') {
					const editor = faqsEditor(kit, suggestions.faqs, t('catalogAdmin.aiField.faqs'));
					return { key, use: use.box, node: h('div', {}, [use.node, editor.node]), read: () => editor.value() };
				}
				const control =
					key === 'description' || key === 'seoDescription'
						? kit.area(String(suggestions[key]), { rows: key === 'description' ? '6' : '3' })
						: kit.input(String(suggestions[key]));
				return {
					key,
					use: use.box,
					node: h('div', {}, [use.node, kit.field(t(`catalogAdmin.aiField.${key}`), control)]),
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
			const chosen = new Map(got.filter((entry) => entry.use.checked).map((entry) => [entry.key, entry.read()]));
			if (chosen.size === 0) return t('catalogAdmin.nothingToApply');
			/** @type {Record<string, unknown>} */
			const body = {};
			if (chosen.has('summary')) body.summary = chosen.get('summary');
			if (chosen.has('description')) body.descriptionHtml = paragraphsOf(String(chosen.get('description')));
			if (chosen.has('faqs')) body.faqs = chosen.get('faqs');
			if (chosen.has('seoTitle') || chosen.has('seoDescription'))
				body.seo = {
					...(chosen.has('seoTitle') ? { title: chosen.get('seoTitle') } : {}),
					...(chosen.has('seoDescription') ? { description: chosen.get('seoDescription') } : {}),
					// kept as AI copy (G6)
					source: 'ai',
				};
			const answer = await kit.call('PATCH', `/v1/admin/products/${product.id}`, body);
			if (!answer.ok) return kit.reason(answer);
			context.show(answer.data, t('catalogAdmin.aiApplied'));
			return null;
		},
	});
};

/**
 * Whether a product's setup has values of variant attributes to generate from (E7).
 * @param {any} product @param {import('./admin-taxonomy.js').Lookups} lookups
 */
const canGenerate = (product, lookups) =>
	(product.attributeSetup ?? []).some(
		(/** @type {any} */ entry) =>
			lookups.state.attributes.find((attribute) => attribute.id === entry.attributeId)?.on === 'variant' &&
			entry.values.length + entry.customValues.length > 0,
	);

/**
 * The detail of a product.
 * @param {Kit} kit @param {any} product @param {ProductContext} context @param {string} [message]
 * @returns {import('./admin-kit.js').Child[]}
 */
export const productDetail = (kit, product, context, message = '') => {
	const { t, h, has } = kit;
	const { lookups } = context;
	const note = kit.status();
	kit.say(note, message);
	/** @type {any[]} */
	const variants = product.variants;
	const active = variants.filter((variant) => variant.active);
	const grades = new Map(lookups.grades().map((grade) => [grade.key, grade.label]));
	const attributes = new Map(lookups.state.attributes.map((attribute) => [attribute.id, attribute]));
	/** @param {any} attribute @param {unknown} value */
	const valueText = (attribute, value) =>
		(Array.isArray(value) ? value : [value])
			.map((entry) =>
				attribute?.type === 'yes_no'
					? yesNo(kit, entry === true)
					: ((attribute?.choices ?? []).find((/** @type {any} */ choice) => choice.value === entry)?.label ?? String(entry)),
			)
			.join(', ');
	const descriptionNodes = product.descriptionHtml
		? richNodes(kit.doc, product.descriptionHtml)
		: product.description
			? [kit.text('p', { class: 'prose' }, product.description)]
			: [kit.emptyState(t('catalogAdmin.nothingYet'))];
	/** @param {string} key */
	const open = (key) => () => {
		// a removed photo also leaves the variants (as the server does)
		if (key === 'photos')
			photosDialog(kit, product, (media) => {
				const kept = new Set(media.map((file) => file.key));
				context.show({
					...product,
					media,
					variants: variants.map((variant) => ({
						...variant,
						media: (variant.media ?? []).filter((/** @type {any} */ file) => kept.has(file.key)),
					})),
				});
			});
		if (key === 'video') videoDialog(kit, product, (next) => context.show(next, t('admin.saved')));
	};
	return [
		detailHead(kit, {
			title: product.name,
			badges: [
				kit.badge(t(`catalogAdmin.status.${product.status}`), STATUS_TONES[product.status] ?? 'neutral'),
				product.featured ? kit.badge(t('catalogAdmin.featured')) : null,
				product.kind === 'physical' ? null : kit.badge(t(`catalogAdmin.kind.${product.kind}`)),
			],
			actions: [
				kit.button(t('admin.edit'), () => context.edit(product), { primary: true }),
				kit.button(t('catalogAdmin.stockButton'), () => stockDialog(kit, product, context)),
			],
			more: [
				has('ai_copy') ? { label: t('catalogAdmin.aiCopy'), onSelect: () => aiDialog(kit, product, context) } : null,
				has('variants') && canGenerate(product, lookups)
					? {
							label: t('catalogAdmin.generateVariants'),
							onSelect: () =>
								generateDialog(kit, {
									productId: product.id,
									done: (next, added) => context.show(next, t('catalogAdmin.generated', { added })),
									measure: product.type?.measure ?? null,
								}),
						}
					: null,
				partsOf(kit, typeNamed(kit, product.type?.key, product.kind)).units
					? { label: t('catalogAdmin.serialsOfProduct'), onSelect: () => context.serials(product) }
					: null,
				{ label: t('catalogAdmin.managePhotos'), onSelect: open('photos') },
				{ label: t('catalogAdmin.changeVideo'), onSelect: open('video') },
				deleteEntry(kit, { name: product.name, path: `/v1/admin/products/${product.id}`, done: context.removed }),
			],
		}),
		note,
		kit.fieldGrid([
			[t('catalogAdmin.price'), priceText(kit, product)],
			[
				t('catalogAdmin.stock'),
				product.trackStock
					? t('catalogAdmin.inStockCount', { count: active.reduce((sum, variant) => sum + variant.stock, 0) })
					: t('catalogAdmin.notTracked'),
			],
			[t('catalogAdmin.stockStateTitle'), product.stockState ? t(`catalogAdmin.stockState.${product.stockState}`) : ''],
			[t('catalogAdmin.variants'), t('catalogAdmin.variantCount', { count: variants.length, active: active.length })],
			[
				t('catalogAdmin.categories'),
				product.categoryIds.map((/** @type {string} */ id) => lookups.nameOf('categories', id)).join(', '),
			],
			[t('catalogAdmin.brand'), lookups.nameOf('brands', product.brandId)],
			[t('catalogAdmin.tagsTitle'), product.tags.join(', ')],
			[t('catalogAdmin.slug'), product.slug],
			[t('catalogAdmin.earlierSlugsTitle'), (product.previousSlugs ?? []).join(', ')],
			[t('catalogAdmin.returnTimeTitle'), timeText(t, product.returnTime)],
			[t('catalogAdmin.warrantyTimeTitle'), timeText(t, product.warrantyTime)],
			[
				t('catalogAdmin.itemType'),
				showsTypes(kit, product.typeKey) ? typeLabel(kit, product.type?.key ?? product.kind, '') : '',
			],
			[
				t('catalogAdmin.sizeChart'),
				has('size_charts')
					? product.hideSizeGuide
						? t('catalogAdmin.sizeGuideHidden')
						: lookups.nameOf('charts', product.sizeChartId) || t('catalogAdmin.chartFromBrand')
					: '',
			],
			[
				t('catalogAdmin.duration'),
				product.kind === 'service' && product.booking ? String(product.booking.durationMinutes) : '',
			],
			[t('catalogAdmin.updated'), product.updatedAt ? kit.when(product.updatedAt) : ''],
		]),
		masonryOf(kit, [
			card(kit, has('variants') ? t('catalogAdmin.variants') : t('catalogAdmin.priceAndStock'), [
				kit.table(
					[
						t('catalogAdmin.variant'),
						t('catalogAdmin.sku'),
						t('catalogAdmin.gtin'),
						t('catalogAdmin.price'),
						t('catalogAdmin.stock'),
						...(has('grades_serials') ? [t('catalogAdmin.grade')] : []),
						t('admin.status'),
					],
					variants.map((variant) => [
						variantLabel(kit, variant),
						variant.sku,
						variant.gtin ?? '',
						variant.compareAtPrice
							? `${kit.money(variant.price)} (${kit.money(variant.compareAtPrice)})`
							: kit.money(variant.price),
						stockText(kit, variant, lookups.state.locations, product.type?.measure ?? null),
						...(has('grades_serials') ? [variant.grade ? (grades.get(variant.grade) ?? variant.grade) : ''] : []),
						!variant.active
							? kit.badge(t('catalogAdmin.offSale'))
							: variant.soldOut
								? kit.badge(t('catalogAdmin.soldOut'), 'warning')
								: kit.badge(t('catalogAdmin.onSale'), 'success'),
					]),
				),
			]),
			card(
				kit,
				t('catalogAdmin.images'),
				[
					product.media.length === 0
						? kit.emptyState(t('catalogAdmin.noPhotosYet'))
						: h(
								'div',
								{ class: 'thumbs' },
								product.media.map((/** @type {any} */ file) =>
									h('figure', {}, [
										file.url
											? kit.h('img', { src: file.url, alt: file.alt ?? '' })
											: kit.text('span', {}, file.alt || file.key),
									]),
								),
							),
				],
				[kit.button(t('catalogAdmin.managePhotos'), open('photos'))],
			),
			card(
				kit,
				t('catalogAdmin.video'),
				[kit.text('p', {}, videoText(kit, product.video))],
				[kit.button(t('catalogAdmin.changeVideo'), open('video'))],
			),
			card(kit, t('catalogAdmin.description'), [
				product.summary ? kit.text('p', { class: 'summary-line' }, product.summary) : null,
				h('div', { class: 'rich' }, descriptionNodes),
			]),
			Object.keys(product.specs).length > 0
				? card(kit, t('catalogAdmin.specs'), [
						kit.fieldGrid(
							Object.entries(product.specs).map(([id, value]) => [
								attributes.get(id)?.name ?? id,
								valueText(attributes.get(id), value),
							]),
						),
					])
				: null,
			(product.attributeSetup ?? []).length > 0
				? card(kit, t('catalogAdmin.attributeSetup'), [
						kit.fieldGrid(
							product.attributeSetup.map((/** @type {any} */ entry) => [
								attributes.get(entry.attributeId)?.name ?? entry.attributeId,
								[...entry.values, ...entry.customValues].map(String).join(', '),
							]),
						),
					])
				: null,
			card(kit, t('catalogAdmin.faqs'), [
				(product.faqs ?? []).length > 0
					? h(
							'dl',
							{ class: 'faqs' },
							product.faqs.flatMap((/** @type {any} */ faq) => [
								kit.text('dt', {}, faq.question),
								kit.text('dd', {}, faq.answer),
							]),
						)
					: kit.emptyState(t('catalogAdmin.nothingYet')),
			]),
			card(kit, t('catalogAdmin.seo'), [kit.fieldGrid(seoFacts(kit, product.seo)), seoChecks(kit, product.seo)]),
			product.kind === 'digital' && has('digital_goods') ? digitalCard(kit, product) : null,
		]),
	];
};
