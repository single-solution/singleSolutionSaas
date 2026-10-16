/**
 * The product editor of the catalog admin widget (PLAN 0.8.8 Catalog, Items; PLAN 0.8.10 E2–E16), a full form in the
 * detail pane (it would still scroll a lot as a dialog): featured, status, kind, item type (when the merchant has
 * types), name, slug (earlier ones shown), summary, the rich description, categories, brand, tags, specs (several values
 * where the field takes several), the attribute setup with Generate, option axes, the variants table, stock tracking,
 * digital and booking fields, the size chart and hiding the size guide, SEO fields, FAQs, the return and warranty
 * days, and for an archived product the product that replaces it (SEO audit G9). The item type as the form stands (its own, its first category's, else the built-in one of its kind; dynamic
 * model §1) decides the sections shown: the fields it names, variants, grades, the size guide, packages, its own days,
 * downloads, license keys and booked slots. Prices are typed as decimals of the shop currency.
 * @module
 */
import { PRODUCT_STATUSES } from '../core/model.js';
import { typeTakes } from '../core/item-types.js';
import { entriesOf, query, timeInputs } from './admin-kit.js';
import { choicesOf } from './admin-attributes.js';
import {
	chartChoices,
	checkGroup,
	earlierSlugs,
	faqsEditor,
	pageLinks,
	paragraphsOf,
	plainOf,
	richEditor,
	seoEditor,
} from './admin-fields.js';
import { fieldsOf } from './admin-screen.js';
import { categoryChoices } from './admin-taxonomy.js';
import { productTypeOf, showsTypes, typeChoices } from './admin-types.js';
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
	typeKey: null,
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
	digital: null,
	booking: null,
	seo: {},
	faqs: [],
	sizeChartId: null,
	hideSizeGuide: false,
	returnTime: null,
	warrantyTime: null,
	replacedBy: null,
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
			...(has('bookings') || product.kind === 'service' ? ['service'] : []),
		];
		const kind = kit.select(
			kinds.map((key) => ({ value: key, label: t(`catalogAdmin.kind.${key}`) })),
			product.kind,
		);
		// its item type: its own, else its first category's (pickers of the types of its kind)
		const typed = showsTypes(kit, product.typeKey);
		const type = kit.select(
			typeChoices(kit, kind.value, product.typeKey ?? null, t('catalogAdmin.typeAsCategory')),
			product.typeKey ?? '',
		);
		const status = kit.select(
			PRODUCT_STATUSES.map((key) => ({ value: key, label: t(`catalogAdmin.status.${key}`) })),
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
							measure: product.type?.measure ?? null,
						}),
					)
				: null;
		const setup = setupEditor(kit, product.attributeSetup ?? [], attributes, [generate]);
		const typeNow = () =>
			productTypeOf(
				kit,
				{ kind: kind.value, typeKey: (typed && type.value) || null, categoryIds: categoryBoxes.value() },
				categories,
			);
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
			type: typeNow,
		});

		// ------------------------------------------------------------------------------------- stock and kinds
		const trackStock = kit.check(t('catalogAdmin.trackStock'), product.trackStock);
		const licenceKeys = kit.check(t('catalogAdmin.licenceKeys'), product.digital?.licenceKeys === true);
		const downloadLimit = kit.input(String(product.digital?.downloadLimit ?? 0), { type: 'number', min: '0', step: '1' });
		const duration = kit.input(String(product.booking?.durationMinutes ?? 60), {
			type: 'number',
			min: '5',
			max: '1440',
			step: '5',
		});
		// the booking schedule it is booked on, by key ('' = the first of Settings → Catalog → Booking schedules; E30)
		const schedule = kit.input(product.booking?.schedule ?? '', { maxlength: '40', autocomplete: 'off' });
		const downloadField = kit.field(t('catalogAdmin.downloadLimit'), downloadLimit);
		const digitalGroup = kit.group(t('catalogAdmin.digital'), [licenceKeys.node, downloadField]);
		const bookingGroup = kit.group(t('catalogAdmin.booking'), [
			kit.field(t('catalogAdmin.duration'), duration),
			kit.field(t('catalogAdmin.schedule'), schedule),
		]);
		const chart = kit.select(chartChoices(kit, charts), product.sizeChartId ?? '');
		const hideGuide = kit.check(t('catalogAdmin.hideSizeGuide'), product.hideSizeGuide === true);
		const guideGroup = kit.group(t('catalogAdmin.sizeGuide'), [
			fieldsOf(kit, [kit.field(t('catalogAdmin.sizeChart'), chart), hideGuide.node]),
		]);
		// the page as search engines will get it, from the values typed so far (R7 #105)
		const links = pageLinks(kit, categories, brands);
		const seo = seoEditor(kit, product.seo, {
			kind: 'product',
			read: () => {
				const categoryIds = categoryBoxes.value();
				return {
					name: name.value.trim(),
					brand: brands.find((item) => item.id === brand.value)?.name ?? '',
					category: categories.find((item) => item.id === categoryIds[0])?.name ?? '',
					summary: summary.value,
					text: plainOf(description.value()),
					url: links.product({
						id: product.id ?? '',
						slug: slug.value.trim() || product.slug,
						categoryIds,
						brandId: brand.value || null,
					}),
					image: photos.find((photo) => photo.url)?.url ?? '',
				};
			},
		});
		seo.watch(name, slug, summary, description.node, brand, categoryBoxes.node);
		const faqs = faqsEditor(kit, product.faqs ?? []);
		// its own return and warranty times: a number and its unit (E14)
		const returnTime = timeInputs(kit, product.returnTime ?? null, t('catalogAdmin.returnTime'));
		const warrantyTime = timeInputs(kit, product.warrantyTime ?? null, t('catalogAdmin.warrantyTime'));
		/** @param {string} label @param {ReturnType<typeof timeInputs>} time the number labelled, its unit beside it */
		const timeField = (label, time) => {
			const node = kit.field(label, time.amount);
			node.append(time.unit);
			return node;
		};
		const daysGroup = fieldsOf(kit, [
			timeField(t('catalogAdmin.returnTime'), returnTime),
			timeField(t('catalogAdmin.warrantyTime'), warrantyTime),
		]);
		// an archived product's replacement: found by name or SKU, its address leads there (G9)
		const findReplacement = kit.input('', { type: 'search' });
		const replacement = kit.select([{ value: '', label: t('catalogAdmin.noReplacement') }], '');
		if (product.replacedBy) {
			const current = kit.text('option', { value: product.replacedBy }, product.replacedBy);
			replacement.append(current);
			replacement.value = product.replacedBy;
			void kit.call('GET', `/v1/admin/products/${product.replacedBy}`).then((answer) => {
				if (answer.ok) current.textContent = answer.data.name;
			});
		}
		const replacementGroup = kit.group(t('catalogAdmin.replacedBy'), [
			kit.text('p', { class: 'muted' }, t('catalogAdmin.replacedByHint')),
			fieldsOf(kit, [
				kit.field(t('admin.search'), findReplacement),
				kit.button(t('admin.find'), async () => {
					const answer = await kit.call('GET', `/v1/admin/products${query({ q: findReplacement.value.trim(), limit: 20 })}`);
					if (!answer.ok) return kit.fail(note, answer);
					const kept = replacement.value;
					replacement.replaceChildren(
						kit.text('option', { value: '' }, t('catalogAdmin.noReplacement')),
						...[...replacement.options].filter((option) => option.value !== '' && option.value === kept),
						...(answer.data.items ?? [])
							.filter((/** @type {any} */ item) => item.id !== product.id && item.id !== kept)
							.map((/** @type {any} */ item) => kit.text('option', { value: item.id }, item.name)),
					);
					replacement.value = kept;
					return answer;
				}),
				kit.field(t('catalogAdmin.replacedBy'), replacement),
			]),
		]);
		const specsGroup = kit.group(t('catalogAdmin.specs'), [
			fieldsOf(
				kit,
				specs.map((spec) => spec.node),
			),
		]);

		// --------------------------------------------------------------------------------- by its item type
		/** What the type as the form stands has: each part shown or not (with today's features). */
		const partsNow = () => {
			const now = typeNow();
			const on = now.elements;
			return {
				type: now,
				variants: has('variants') && on.variants,
				chart: has('size_charts') && on.chart,
				days: has('returns') && on.warranty,
				downloads: kind.value === 'digital' && on.downloads,
				licenceKeys: kind.value === 'digital' && on.licenceKeys,
				slots: kind.value === 'service' && on.slots,
			};
		};
		const show = () => {
			const parts = partsNow();
			for (const spec of specs) spec.node.hidden = !typeTakes(parts.type, spec.attribute.id);
			specsGroup.hidden = specs.every((spec) => spec.node.hidden);
			setup.node.hidden = !parts.variants || attributes.length === 0;
			options.node.hidden = !parts.variants;
			digitalGroup.hidden = !parts.downloads && !parts.licenceKeys;
			licenceKeys.node.hidden = !parts.licenceKeys;
			downloadField.hidden = !parts.downloads;
			bookingGroup.hidden = !parts.slots;
			guideGroup.hidden = !parts.chart;
			daysGroup.hidden = !parts.days;
			replacementGroup.hidden = status.value !== 'archived';
			variants.draw();
		};
		kind.addEventListener('change', () => {
			// the types of the new kind
			const choices = typeChoices(kit, kind.value, product.typeKey ?? null, t('catalogAdmin.typeAsCategory'));
			const kept = choices.some((choice) => choice.value === type.value) ? type.value : '';
			type.replaceChildren(...choices.map((choice) => kit.text('option', { value: choice.value }, choice.label)));
			type.value = kept;
			show();
		});
		type.addEventListener('change', show);
		status.addEventListener('change', show);
		categoryBoxes.node.addEventListener('change', show);
		show();

		// --------------------------------------------------------------------------------------------------- save
		const bodyOf = () => {
			const parts = partsNow();
			/** @type {Record<string, unknown>} */
			const specValues = {};
			for (const { attribute, read } of specs) {
				const value = read();
				if (!typeTakes(parts.type, attribute.id)) continue;
				if (value !== null && !(typeof value === 'number' && Number.isNaN(value))) specValues[attribute.id] = value;
			}
			const variantList = variants.value();
			const days = [returnTime.read(), warrantyTime.read()];
			if (!variantList || days.some((value) => value !== null && Number.isNaN(value.amount))) return null;
			return {
				name: name.value,
				slug: slug.value.trim(),
				kind: kind.value,
				...(typed ? { typeKey: type.value || null } : {}),
				status: status.value,
				featured: featured.box.checked,
				summary: summary.value,
				descriptionHtml: description.value(),
				...(description.value() ? {} : { description: '' }),
				categoryIds: categoryBoxes.value(),
				brandId: brand.value || null,
				tags: entriesOf(tags.value, true),
				specs: specValues,
				...(parts.variants && attributes.length > 0 ? { attributeSetup: setup.value() } : {}),
				...(parts.variants ? { options: options.value() } : {}),
				variants: variantList,
				trackStock: trackStock.box.checked,
				...(kind.value === 'digital'
					? {
							digital: {
								...(parts.licenceKeys ? { licenceKeys: licenceKeys.box.checked } : {}),
								...(parts.downloads ? { downloadLimit: Number(downloadLimit.value) || 0 } : {}),
							},
						}
					: {}),
				...(parts.slots
					? { booking: { durationMinutes: Number(duration.value), schedule: schedule.value.trim().toLowerCase() } }
					: {}),
				...(parts.chart ? { sizeChartId: chart.value || null, hideSizeGuide: hideGuide.box.checked } : {}),
				seo: seo.value(),
				faqs: faqs.value(),
				...(parts.days ? { returnTime: days[0], warrantyTime: days[1] } : {}),
				...(status.value === 'archived' ? { replacedBy: replacement.value || null } : {}),
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
				typed ? kit.field(t('catalogAdmin.itemType'), type) : null,
				kit.field(t('admin.status'), status),
				kit.field(t('catalogAdmin.brand'), brand),
				kit.field(t('catalogAdmin.tags'), tags),
				featured.node,
			]),
			earlierSlugs(kit, product.previousSlugs),
			kit.field(t('catalogAdmin.summary'), summary),
			description.node,
			categories.length > 0 ? categoryBoxes.node : null,
			specs.length > 0 ? specsGroup : null,
			attributes.length > 0 ? setup.node : null,
			has('variants') ? options.node : null,
			kit.group(has('variants') ? t('catalogAdmin.variants') : t('catalogAdmin.priceAndStock'), [
				isNew && has('variants') ? kit.text('p', { class: 'muted' }, t('catalogAdmin.photosAfterSave')) : null,
				variants.node,
			]),
			fieldsOf(kit, [trackStock.node]),
			digitalGroup,
			bookingGroup,
			has('size_charts') ? guideGroup : null,
			seo.node,
			faqs.node,
			has('returns') ? daysGroup : null,
			isNew ? null : replacementGroup,
		]);
		kit.say(note, message);
	};

	render(given ?? blank());
	return box;
};
