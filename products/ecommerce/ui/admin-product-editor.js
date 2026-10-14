/**
 * The product editor of the catalog admin widget (PLAN 0.8.8 Catalog, Items; PLAN 0.8.10 E2–E16), a full form in the
 * detail pane (it would still scroll a lot as a dialog): featured, status, kind, name, slug (earlier ones shown), summary,
 * the rich description, categories, brand, tags, specs (several values where the attribute takes several), the
 * attribute setup with Generate, option axes, the variants table, stock tracking, serials (yes / no / as its
 * categories say), digital and booking fields, the size chart and hiding the size guide, SEO fields, FAQs and the
 * return and warranty days. Prices are typed as decimals of the shop currency.
 * @module
 */
import { entriesOf, wholeOf } from './admin-kit.js';
import { choicesOf } from './admin-attributes.js';
import {
	chartChoices,
	checkGroup,
	earlierSlugs,
	faqsEditor,
	paragraphsOf,
	richEditor,
	seoEditor,
	triSelect,
} from './admin-fields.js';
import { fieldsOf } from './admin-screen.js';
import { categoryChoices } from './admin-taxonomy.js';
import { blankVariant, generateDialog, optionsEditor, setupEditor, variantsEditor } from './admin-variants.js';

/** @typedef {import('./admin-kit.js').Kit} Kit */
/** @typedef {import('./admin-taxonomy.js').Lookups} Lookups */
/** @typedef {import('./admin-taxonomy.js').Named} Named */

/**
 * A new product's fields.
 * @returns {any}
 */
const blank = () => ({
	id: null,
	name: '',
	slug: '',
	kind: 'physical',
	status: 'draft',
	featured: false,
	summary: '',
	description: '',
	descriptionHtml: '',
	categoryIds: [],
	brandId: null,
	tags: [],
	specs: {},
	attributeSetup: [],
	options: [],
	variants: [blankVariant()],
	trackStock: true,
	serialized: false,
	digital: null,
	booking: null,
	seo: {},
	faqs: [],
	sizeChartId: null,
	hideSizeGuide: false,
	returnDays: null,
	warrantyDays: null,
	media: [],
	previousSlugs: [],
});

/**
 * A control for a product field's value (spec): yes / no, a choice (checkboxes where it takes several), a number (in its
 * range and decimals), a date (in the days it takes) or text (comma separated where it takes several). A required field
 * says so in its label.
 * @param {Kit} kit @param {Named} attribute @param {unknown} current @param {string[]} own the product's own values
 * @returns {{ node: HTMLElement, read: () => unknown }}
 */
export const specControl = (kit, attribute, current, own) => {
	const { t } = kit;
	const named = attribute.unit ? `${attribute.name} (${attribute.unit})` : attribute.name;
	const label = attribute.required ? t('catalogAdmin.requiredLabel', { name: named }) : named;
	if (attribute.type === 'yes_no') {
		const select = kit.select(
			[
				{ value: '', label: t('catalogAdmin.notSet') },
				{ value: 'true', label: t('admin.yes') },
				{ value: 'false', label: t('admin.no') },
			],
			current === undefined || current === null ? '' : String(current),
		);
		return { node: kit.field(label, select), read: () => (select.value === '' ? null : select.value === 'true') };
	}
	if (attribute.type === 'choice') {
		const known = choicesOf(attribute);
		const choices = [
			...known,
			...own.filter((value) => !known.some((choice) => choice.value === value)).map((value) => ({ value, label: value })),
		];
		if (attribute.multiple) {
			const group = checkGroup(
				kit,
				label,
				choices,
				Array.isArray(current) ? current.map(String) : current ? [String(current)] : [],
			);
			return { node: group.node, read: () => (group.value().length > 0 ? group.value() : null) };
		}
		const select = kit.select([{ value: '', label: t('catalogAdmin.notSet') }, ...choices], current ? String(current) : '');
		return { node: kit.field(label, select), read: () => select.value || null };
	}
	if (attribute.type === 'number') {
		const decimals = Number(attribute.decimals ?? 2);
		const input = kit.input(typeof current === 'number' ? current : '', {
			type: 'number',
			step: decimals === 0 ? '1' : String(10 ** -decimals),
			...(attribute.min === null || attribute.min === undefined ? {} : { min: String(attribute.min) }),
			...(attribute.max === null || attribute.max === undefined ? {} : { max: String(attribute.max) }),
		});
		return { node: kit.field(label, input), read: () => (input.value.trim() === '' ? null : Number(input.value)) };
	}
	if (attribute.type === 'date') {
		const input = kit.input(typeof current === 'string' ? current : '', { type: 'date' });
		return { node: kit.field(label, input), read: () => input.value || null };
	}
	const input = kit.input(Array.isArray(current) ? current.join(', ') : String(current ?? ''), { maxlength: '200' });
	return {
		node: kit.field(attribute.multiple ? t('catalogAdmin.severalValues', { name: label }) : label, input),
		read: () => {
			if (!attribute.multiple) return input.value.trim() || null;
			const list = entriesOf(input.value, true);
			return list.length > 0 ? list : null;
		},
	};
};

/**
 * The product editor. `saved(product, isNew, message)` gets the saved product; `cancel()` goes back to the detail.
 * @param {Kit} kit
 * @param {{ product: any | null, lookups: Lookups, saved: (product: any, isNew: boolean, message?: string) => unknown,
 *   cancel: () => unknown }} options
 * @returns {HTMLElement}
 */
export const productEditor = (kit, { product: given, lookups, saved, cancel }) => {
	const { t, h, has } = kit;
	const box = h('div', { class: 'editor' });

	/** @param {any} product @param {string} [message] */
	const render = (product, message = '') => {
		const note = kit.status();
		const isNew = !product.id;
		const { categories, brands, attributes, charts } = lookups.state;
		/** @type {any[]} the product's photos (variant photos pick among them) */
		let photos = product.media;

		// ------------------------------------------------------------------------------------------------- basics
		const name = kit.input(product.name, { maxlength: '200', required: '' });
		const slug = kit.input(product.slug, { maxlength: '120' });
		const kinds = [
			'physical',
			...(has('digital_goods') || product.kind === 'digital' ? ['digital'] : []),
			...(has('bookings') || product.kind === 'booking' ? ['booking'] : []),
		];
		const kind = kit.select(
			kinds.map((key) => ({ value: key, label: t(`catalogAdmin.kind.${key}`) })),
			product.kind,
		);
		const status = kit.select(
			['draft', 'active', 'archived'].map((key) => ({ value: key, label: t(`catalogAdmin.status.${key}`) })),
			product.status,
		);
		const featured = kit.check(t('catalogAdmin.featuredProduct'), product.featured === true);
		const summary = kit.area(product.summary, { maxlength: '500' });
		const description = richEditor(kit, product.descriptionHtml || paragraphsOf(product.description));
		const brand = kit.select(
			[{ value: '', label: t('catalogAdmin.noBrand') }, ...brands.map((item) => ({ value: item.id, label: item.name }))],
			product.brandId ?? '',
		);
		const tags = kit.input(product.tags.join(', '));
		const categoryBoxes = checkGroup(kit, t('catalogAdmin.categories'), categoryChoices(categories), product.categoryIds);

		// ------------------------------------------------------------------------------------- setup and specs
		const generate =
			!isNew && has('variants')
				? kit.button(t('catalogAdmin.generate'), () =>
						generateDialog(kit, {
							productId: product.id,
							before: async () => {
								const answer = await save();
								if (!answer) return t('admin.checkNumbers');
								return answer.ok ? null : kit.reason(answer);
							},
							done: (next, added) => saved(next, false, t('catalogAdmin.generated', { added })),
						}),
					)
				: null;
		const setup = setupEditor(kit, product.attributeSetup ?? [], attributes, [generate]);
		const specAttributes = attributes.filter((attribute) => attribute.on === 'product');
		const specs = specAttributes.map((attribute) => ({
			attribute,
			...specControl(
				kit,
				attribute,
				product.specs?.[attribute.id],
				(product.attributeSetup ?? []).find((/** @type {any} */ entry) => entry.attributeId === attribute.id)?.customValues ??
					[],
			),
		}));

		// ----------------------------------------------------------------------------------------------- variants
		const options = optionsEditor(kit, product.options, () => variants.makeFrom(options.value()));
		const variants = variantsEditor(kit, {
			product,
			lookups,
			customOf: setup.customOf,
			axes: () => options.value(),
			photos: () => photos,
			uploaded: (media) => {
				photos = media;
			},
		});

		// ------------------------------------------------------------------------------------- stock and kinds
		const trackStock = kit.check(t('catalogAdmin.trackStock'), product.trackStock);
		const serialized = triSelect(kit, product.serialized ?? null, t('catalogAdmin.asCategories'));
		const licenceKeys = kit.check(t('catalogAdmin.licenceKeys'), product.digital?.licenceKeys === true);
		const downloadLimit = kit.input(String(product.digital?.downloadLimit ?? 0), { type: 'number', min: '0', step: '1' });
		const duration = kit.input(String(product.booking?.durationMinutes ?? 60), {
			type: 'number',
			min: '5',
			max: '1440',
			step: '5',
		});
		const digitalGroup = kit.group(t('catalogAdmin.digital'), [
			licenceKeys.node,
			kit.field(t('catalogAdmin.downloadLimit'), downloadLimit),
		]);
		const bookingGroup = kit.group(t('catalogAdmin.booking'), [kit.field(t('catalogAdmin.duration'), duration)]);
		const showKind = () => {
			digitalGroup.hidden = kind.value !== 'digital';
			bookingGroup.hidden = kind.value !== 'booking';
		};
		kind.addEventListener('change', showKind);
		showKind();
		const chart = kit.select(chartChoices(kit, charts), product.sizeChartId ?? '');
		const hideGuide = kit.check(t('catalogAdmin.hideSizeGuide'), product.hideSizeGuide === true);
		const seo = seoEditor(kit, product.seo);
		const faqs = faqsEditor(kit, product.faqs ?? []);
		/** @param {number | null | undefined} days */
		const daysInput = (days) =>
			kit.input(days === null || days === undefined ? '' : String(days), { type: 'number', min: '0', step: '1' });
		const returnDays = daysInput(product.returnDays);
		const warrantyDays = daysInput(product.warrantyDays);

		// --------------------------------------------------------------------------------------------------- save
		const bodyOf = () => {
			/** @type {Record<string, unknown>} */
			const specValues = {};
			for (const { attribute, read } of specs) {
				const value = read();
				if (value !== null && !(typeof value === 'number' && Number.isNaN(value))) specValues[attribute.id] = value;
			}
			const variantList = variants.value();
			const days = [returnDays, warrantyDays].map((input) => wholeOf(input.value));
			if (!variantList || days.some((value) => Number.isNaN(value))) return null;
			return {
				name: name.value,
				slug: slug.value.trim(),
				kind: kind.value,
				status: status.value,
				featured: featured.box.checked,
				summary: summary.value,
				descriptionHtml: description.value(),
				...(description.value() ? {} : { description: '' }),
				categoryIds: categoryBoxes.value(),
				brandId: brand.value || null,
				tags: entriesOf(tags.value, true),
				specs: specValues,
				...(attributes.length > 0 ? { attributeSetup: setup.value() } : {}),
				...(has('variants') ? { options: options.value() } : {}),
				variants: variantList,
				trackStock: trackStock.box.checked,
				...(has('grades_serials') ? { serialized: serialized.value() } : {}),
				...(kind.value === 'digital'
					? { digital: { licenceKeys: licenceKeys.box.checked, downloadLimit: Number(downloadLimit.value) || 0 } }
					: {}),
				...(kind.value === 'booking' ? { booking: { durationMinutes: Number(duration.value) } } : {}),
				...(has('size_charts') ? { sizeChartId: chart.value || null, hideSizeGuide: hideGuide.box.checked } : {}),
				seo: seo.value(),
				faqs: faqs.value(),
				...(has('returns') ? { returnDays: days[0], warrantyDays: days[1] } : {}),
			};
		};
		/** Save the form; the answer, or null when a number is wrong (the note says so). */
		const save = async () => {
			const body = bodyOf();
			if (!body) {
				kit.say(note, t('admin.checkNumbers'), true);
				return null;
			}
			const answer = await kit.call(
				isNew ? 'POST' : 'PATCH',
				isNew ? '/v1/admin/products' : `/v1/admin/products/${product.id}`,
				body,
			);
			if (!answer.ok) kit.fail(note, answer);
			return answer;
		};
		const saveButton = kit.button(
			t('admin.save'),
			async () => {
				const answer = await save();
				if (answer?.ok) await saved(answer.data, isNew);
				return answer;
			},
			{ primary: true },
		);

		kit.put(box, [
			h('div', { class: 'detail-head' }, [
				kit.text('h3', {}, isNew ? t('catalogAdmin.newProduct') : t('admin.editing', { name: product.name })),
				h('div', { class: 'actions' }, [saveButton, kit.button(t('admin.cancel'), cancel)]),
			]),
			note,
			fieldsOf(kit, [
				kit.field(t('catalogAdmin.name'), name),
				kit.field(t('catalogAdmin.slug'), slug),
				kit.field(t('catalogAdmin.kind'), kind),
				kit.field(t('admin.status'), status),
				kit.field(t('catalogAdmin.brand'), brand),
				kit.field(t('catalogAdmin.tags'), tags),
				featured.node,
			]),
			earlierSlugs(kit, product.previousSlugs),
			kit.field(t('catalogAdmin.summary'), summary),
			description.node,
			categories.length > 0 ? categoryBoxes.node : null,
			specs.length > 0
				? kit.group(t('catalogAdmin.specs'), [
						fieldsOf(
							kit,
							specs.map((spec) => spec.node),
						),
					])
				: null,
			attributes.length > 0 ? setup.node : null,
			has('variants') ? options.node : null,
			kit.group(has('variants') ? t('catalogAdmin.variants') : t('catalogAdmin.priceAndStock'), [
				isNew && has('variants') ? kit.text('p', { class: 'muted' }, t('catalogAdmin.photosAfterSave')) : null,
				variants.node,
			]),
			fieldsOf(kit, [
				trackStock.node,
				has('grades_serials') ? kit.field(t('catalogAdmin.serialized'), serialized.node) : null,
			]),
			digitalGroup,
			bookingGroup,
			has('size_charts')
				? kit.group(t('catalogAdmin.sizeGuide'), [
						fieldsOf(kit, [kit.field(t('catalogAdmin.sizeChart'), chart), hideGuide.node]),
					])
				: null,
			seo.node,
			faqs.node,
			has('returns')
				? fieldsOf(kit, [
						kit.field(t('catalogAdmin.returnDays'), returnDays),
						kit.field(t('catalogAdmin.warrantyDays'), warrantyDays),
					])
				: null,
		]);
		kit.say(note, message);
	};

	render(given ?? blank());
	return box;
};
