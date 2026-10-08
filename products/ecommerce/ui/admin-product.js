/**
 * The product editor of the catalog admin widget (PLAN 0.8.8 Catalog, Items): name, slug, kind, status, texts,
 * categories, brand, tags, specs by attribute, options and the variants table (SKU, price, was price, cost, stock —
 * per location with multi-location stock — grade, active), stock tracking, serials, digital and booking fields, SEO
 * text and return/warranty days; then, for a saved product, its images (upload, order, alternative text, remove),
 * stock changes, AI copy (fills the fields as suggestions; nothing is saved until Save), licence keys and digital
 * files. Prices are typed as decimals of the shop currency.
 * @module
 */
import { safeFileName } from '../core/digital.js';
import { entriesOf, wholeOf } from './admin-kit.js';
import { categoryChoices, variantLabel } from './admin-taxonomy.js';

/** @typedef {import('./admin-kit.js').Kit} Kit */
/** @typedef {import('./admin-taxonomy.js').Lookups} Lookups */

/** Fields AI copy writes. */
const AI_FIELDS = Object.freeze(['summary', 'description', 'seoTitle', 'seoDescription']);
/** Image types the catalog stores. */
const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,image/avif';

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
	summary: '',
	description: '',
	categoryIds: [],
	brandId: null,
	tags: [],
	specs: {},
	options: [],
	variants: [
		{ sku: '', options: {}, price: 0, compareAtPrice: null, cost: null, stock: 0, locations: {}, grade: null, active: true },
	],
	trackStock: true,
	serialized: false,
	digital: null,
	booking: null,
	seo: { title: '', description: '' },
	returnDays: null,
	warrantyDays: null,
	media: [],
});

/**
 * Every combination of option values (`[{ Colour: 'Red', Size: 'S' }, …]`).
 * @param {Array<{ name: string, values: string[] }>} axes
 * @returns {Array<Record<string, string>>}
 */
const combinations = (axes) =>
	axes.reduce(
		/** @param {Array<Record<string, string>>} out */
		(out, axis) => out.flatMap((combo) => axis.values.map((value) => ({ ...combo, [axis.name]: value }))),
		[{}],
	);

/**
 * The product editor. `done(changed)` goes back to the list.
 * @param {Kit} kit
 * @param {{ id: string | null, lookups: Lookups, done: (changed: boolean) => void }} options
 * @returns {HTMLElement}
 */
export const productEditor = (kit, { id, lookups, done }) => {
	const { t, h, has } = kit;
	const box = h('div');
	const line = kit.status();
	box.append(line);
	let changed = false;

	/** @param {any} product @param {string} [message] */
	const render = (product, message = '') => {
		const note = kit.status();
		const isNew = !product.id;
		const { categories, brands, attributes, locations } = lookups.state;

		// ---------------------------------------------------------------------------------------------- basics
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
		const summary = kit.area(product.summary, { maxlength: '500' });
		const description = kit.area(product.description, { rows: '6' });
		const brand = kit.select(
			[{ value: '', label: t('catalogAdmin.noBrand') }, ...brands.map((item) => ({ value: item.id, label: item.name }))],
			product.brandId ?? '',
		);
		const tags = kit.input(product.tags.join(', '));
		const categoryBoxes = categoryChoices(categories).map((choice) => ({
			id: choice.value,
			...kit.check(choice.label, product.categoryIds.includes(choice.value)),
		}));

		// ----------------------------------------------------------------------------------------------- specs
		const specs = attributes.map((attribute) => {
			const current = product.specs[attribute.id];
			const value = current === undefined || current === null ? '' : String(current);
			const control =
				attribute.type === 'boolean'
					? kit.select(
							[
								{ value: '', label: t('catalogAdmin.notSet') },
								{ value: 'true', label: t('admin.yes') },
								{ value: 'false', label: t('admin.no') },
							],
							value,
						)
					: attribute.type === 'choice'
						? kit.select(
								[
									{ value: '', label: t('catalogAdmin.notSet') },
									...attribute.choices.map((/** @type {string} */ choice) => ({ value: choice, label: choice })),
								],
								value,
							)
						: kit.input(value, attribute.type === 'number' ? { type: 'number', step: 'any' } : {});
			return { attribute, control };
		});

		// --------------------------------------------------------------------------------------------- variants
		const axes = [0, 1, 2].map((index) => ({
			name: kit.input(product.options[index]?.name ?? '', { maxlength: '40' }),
			values: kit.input((product.options[index]?.values ?? []).join(', ')),
		}));
		const axesOf = () =>
			axes
				.map((axis) => ({ name: axis.name.value.trim(), values: entriesOf(axis.values.value, true) }))
				.filter((axis) => axis.name && axis.values.length > 0);
		/** @typedef {{ variant: any, sku: HTMLInputElement, price: HTMLInputElement, was: HTMLInputElement, cost: HTMLInputElement,
		 *   stock: HTMLInputElement | null, locations: Map<string, HTMLInputElement>, grade: HTMLInputElement | HTMLSelectElement,
		 *   active: HTMLInputElement }} VariantRow */
		/** @type {VariantRow[]} */
		let rows = [];
		const variantsBox = h('div');
		/** @type {Array<{ key: string, label: string }>} */
		const grades = gradesOf(kit);
		/** @param {any} variant @returns {VariantRow} */
		const rowFor = (variant) => {
			const locationInputs = new Map(
				has('multi_location') && !variant.id
					? locations.map((location) => [
							location.id,
							kit.input(String(variant.locations?.[location.id] ?? 0), {
								type: 'number',
								min: '0',
								step: '1',
								'aria-label': t('catalogAdmin.stockAt', { location: location.name }),
							}),
						])
					: [],
			);
			const label = variantLabel(kit, variant);
			return {
				variant,
				sku: kit.input(variant.sku, { maxlength: '64', 'aria-label': t('catalogAdmin.skuOf', { variant: label }) }),
				price: kit.input(kit.decimal(variant.price), {
					inputmode: 'decimal',
					'aria-label': t('catalogAdmin.priceOf', { variant: label }),
				}),
				was: kit.input(kit.decimal(variant.compareAtPrice), {
					inputmode: 'decimal',
					'aria-label': t('catalogAdmin.wasOf', { variant: label }),
				}),
				cost: kit.input(kit.decimal(variant.cost), {
					inputmode: 'decimal',
					'aria-label': t('catalogAdmin.costOf', { variant: label }),
				}),
				stock:
					!variant.id && !has('multi_location')
						? kit.input(String(variant.stock ?? 0), {
								type: 'number',
								min: '0',
								step: '1',
								'aria-label': t('catalogAdmin.stockOf', { variant: label }),
							})
						: null,
				locations: locationInputs,
				grade:
					grades.length > 0
						? kit.select(
								[
									{ value: '', label: t('catalogAdmin.noGrade') },
									...grades.map((grade) => ({ value: grade.key, label: grade.label })),
								],
								variant.grade ?? '',
								{ 'aria-label': t('catalogAdmin.gradeOf', { variant: label }) },
							)
						: kit.input(variant.grade ?? '', { 'aria-label': t('catalogAdmin.gradeOf', { variant: label }) }),
				active: (() => {
					const { box: active } = kit.check('', variant.active !== false);
					active.setAttribute('aria-label', t('catalogAdmin.activeOf', { variant: label }));
					return active;
				})(),
			};
		};
		const drawVariants = () => {
			const optionNames = axesOf().map((axis) => axis.name);
			const headers = [
				...(has('variants') ? [t('catalogAdmin.variant')] : []),
				t('catalogAdmin.sku'),
				t('catalogAdmin.price'),
				t('catalogAdmin.wasPrice'),
				t('catalogAdmin.cost'),
				t('catalogAdmin.stock'),
				...(has('grades_serials') ? [t('catalogAdmin.grade')] : []),
				t('catalogAdmin.active'),
				...(has('variants') && rows.length > 1 ? [''] : []),
			];
			variantsBox.replaceChildren(
				kit.table(
					headers,
					rows.map((entry) => [
						...(has('variants') ? [optionNames.map((axis) => entry.variant.options?.[axis] ?? '').join(' / ') || '—'] : []),
						entry.sku,
						entry.price,
						entry.was,
						entry.cost,
						entry.stock ??
							(entry.locations.size > 0
								? h('div', {}, [...entry.locations.values()])
								: kit.text('span', {}, stockText(kit, entry.variant, locations))),
						...(has('grades_serials') ? [entry.grade] : []),
						entry.active,
						...(has('variants') && rows.length > 1
							? [
									kit.button(t('admin.remove'), () => {
										rows = rows.filter((other) => other !== entry);
										drawVariants();
									}),
								]
							: []),
					]),
				),
			);
		};
		rows = product.variants.map(rowFor);
		const makeVariants = kit.button(t('catalogAdmin.makeVariants'), () => {
			const next = combinations(axesOf());
			const key = (/** @type {Record<string, string>} */ options) => JSON.stringify(Object.entries(options).sort());
			const known = new Map(rows.map((entry) => [key(entry.variant.options ?? {}), entry]));
			rows = next.map(
				(options) =>
					known.get(key(options)) ??
					rowFor({
						sku: '',
						options,
						price: 0,
						compareAtPrice: null,
						cost: null,
						stock: 0,
						locations: {},
						grade: null,
						active: true,
					}),
			);
			drawVariants();
		});
		drawVariants();

		// ------------------------------------------------------------------------------------- stock and kinds
		const trackStock = kit.check(t('catalogAdmin.trackStock'), product.trackStock);
		const serialized = kit.check(t('catalogAdmin.serialized'), product.serialized);
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

		const seoTitle = kit.input(product.seo.title, { maxlength: '200' });
		const seoDescription = kit.area(product.seo.description, { maxlength: '500' });
		const returnDays = kit.input(product.returnDays === null ? '' : String(product.returnDays), {
			type: 'number',
			min: '0',
			step: '1',
		});
		const warrantyDays = kit.input(product.warrantyDays === null ? '' : String(product.warrantyDays), {
			type: 'number',
			min: '0',
			step: '1',
		});

		// ------------------------------------------------------------------------------------------------ save
		const bodyOf = () => {
			/** @type {Record<string, string | number | boolean>} */
			const specValues = {};
			for (const { attribute, control } of specs) {
				if (control.value === '') continue;
				specValues[attribute.id] =
					attribute.type === 'number'
						? Number(control.value)
						: attribute.type === 'boolean'
							? control.value === 'true'
							: control.value;
			}
			let bad = false;
			/** @param {HTMLInputElement} input @param {boolean} required */
			const priceOf = (input, required) => {
				const value = kit.amount(input.value);
				if (Number.isNaN(value) || (required && value === null)) bad = true;
				return Number.isNaN(value) ? null : value;
			};
			const variants = rows.map((entry) => ({
				...(entry.variant.id ? { id: entry.variant.id } : {}),
				sku: entry.sku.value.trim(),
				options: has('variants') ? (entry.variant.options ?? {}) : {},
				price: priceOf(entry.price, true),
				compareAtPrice: priceOf(entry.was, false),
				cost: priceOf(entry.cost, false),
				active: entry.active.checked,
				...(has('grades_serials') ? { grade: entry.grade.value.trim() || null } : {}),
				...(entry.variant.id
					? {}
					: entry.locations.size > 0
						? { locations: Object.fromEntries([...entry.locations].map(([key, input]) => [key, Number(input.value) || 0])) }
						: { stock: Number(entry.stock?.value) || 0 }),
			}));
			const days = [returnDays, warrantyDays].map((input) => wholeOf(input.value));
			if (days.some((value) => Number.isNaN(value))) bad = true;
			if (bad) return null;
			return {
				name: name.value,
				slug: slug.value.trim(),
				kind: kind.value,
				status: status.value,
				summary: summary.value,
				description: description.value,
				categoryIds: categoryBoxes.filter((entry) => entry.box.checked).map((entry) => entry.id),
				brandId: brand.value || null,
				tags: entriesOf(tags.value, true),
				specs: specValues,
				...(has('variants') ? { options: axesOf() } : {}),
				variants,
				trackStock: trackStock.box.checked,
				...(has('grades_serials') ? { serialized: serialized.box.checked } : {}),
				...(kind.value === 'digital'
					? { digital: { licenceKeys: licenceKeys.box.checked, downloadLimit: Number(downloadLimit.value) || 0 } }
					: {}),
				...(kind.value === 'booking' ? { booking: { durationMinutes: Number(duration.value) } } : {}),
				seo: { title: seoTitle.value, description: seoDescription.value },
				...(has('returns') ? { returnDays: days[0], warrantyDays: days[1] } : {}),
			};
		};
		const save = kit.button(
			t('admin.save'),
			async () => {
				const body = bodyOf();
				if (!body) return kit.say(note, t('admin.checkNumbers'), true);
				const answer = await kit.call(
					isNew ? 'POST' : 'PATCH',
					isNew ? '/v1/admin/products' : `/v1/admin/products/${product.id}`,
					body,
				);
				if (!answer.ok) {
					kit.fail(note, answer);
					return answer;
				}
				changed = true;
				render(answer.data, t('admin.saved'));
				return answer;
			},
			{ primary: true },
		);
		const ai =
			!isNew && has('ai_copy')
				? kit.button(t('catalogAdmin.aiCopy'), async () => {
						kit.say(note, t('catalogAdmin.aiWorking'));
						const answer = await kit.call('POST', `/v1/admin/products/${product.id}/ai-copy`, { fields: [...AI_FIELDS] });
						if (!answer.ok) {
							kit.fail(note, answer);
							return answer;
						}
						const got = answer.data.suggestions ?? {};
						/** @type {Array<[string, HTMLInputElement | HTMLTextAreaElement]>} */
						const targets = [
							['summary', summary],
							['description', description],
							['seoTitle', seoTitle],
							['seoDescription', seoDescription],
						];
						for (const [key, control] of targets) if (typeof got[key] === 'string') control.value = got[key];
						kit.say(note, t('catalogAdmin.aiFilled'));
						return answer;
					})
				: null;
		const remove = isNew
			? null
			: kit.confirmButton(t('admin.delete'), t('admin.confirmDelete'), async () => {
					const answer = await kit.call('DELETE', `/v1/admin/products/${product.id}`);
					if (!answer.ok) {
						kit.fail(note, answer);
						return answer;
					}
					done(true);
					return answer;
				});

		kit.put(box, [
			h('div', { class: 'head' }, [
				kit.text('h3', {}, isNew ? t('catalogAdmin.newProduct') : t('admin.editing', { name: product.name })),
				kit.button(t('admin.back'), () => done(changed)),
			]),
			h('div', { class: 'fields' }, [
				kit.field(t('catalogAdmin.name'), name),
				kit.field(t('catalogAdmin.slug'), slug),
				kit.field(t('catalogAdmin.kind'), kind),
				kit.field(t('admin.status'), status),
				kit.field(t('catalogAdmin.brand'), brand),
				kit.field(t('catalogAdmin.tags'), tags),
			]),
			kit.field(t('catalogAdmin.summary'), summary),
			kit.field(t('catalogAdmin.description'), description),
			categoryBoxes.length > 0
				? kit.group(
						t('catalogAdmin.categories'),
						categoryBoxes.map((entry) => entry.node),
					)
				: null,
			specs.length > 0
				? kit.group(t('catalogAdmin.specs'), [
						h(
							'div',
							{ class: 'fields' },
							specs.map(({ attribute, control }) =>
								kit.field(attribute.unit ? `${attribute.name} (${attribute.unit})` : attribute.name, control),
							),
						),
					])
				: null,
			has('variants')
				? kit.group(t('catalogAdmin.options'), [
						...axes.map((axis, index) =>
							h('div', { class: 'row' }, [
								kit.field(t('catalogAdmin.optionName', { number: index + 1 }), axis.name),
								kit.field(t('catalogAdmin.optionValues', { number: index + 1 }), axis.values),
							]),
						),
						makeVariants,
					])
				: null,
			kit.group(has('variants') ? t('catalogAdmin.variants') : t('catalogAdmin.priceAndStock'), [variantsBox]),
			h('div', { class: 'fields' }, [trackStock.node, has('grades_serials') ? serialized.node : null]),
			digitalGroup,
			bookingGroup,
			kit.group(t('catalogAdmin.seo'), [
				kit.field(t('catalogAdmin.seoTitle'), seoTitle),
				kit.field(t('catalogAdmin.seoDescription'), seoDescription),
			]),
			has('returns')
				? h('div', { class: 'fields' }, [
						kit.field(t('catalogAdmin.returnDays'), returnDays),
						kit.field(t('catalogAdmin.warrantyDays'), warrantyDays),
					])
				: null,
			h('div', { class: 'actions' }, [save, ai, remove]),
			note,
			isNew ? null : imagesOf(kit, product),
			isNew || !product.trackStock
				? null
				: stockOf(kit, product, locations, (next) => render(next, t('catalogAdmin.stockSaved'))),
			!isNew && product.kind === 'digital' && has('digital_goods') ? digitalOf(kit, product) : null,
		]);
		kit.say(note, message);
	};

	if (id === null) render(blank());
	else
		void kit.call('GET', `/v1/admin/products/${id}`).then((answer) => {
			if (answer.ok) render(answer.data);
			else {
				kit.fail(line, answer);
				box.append(kit.button(t('admin.back'), () => done(false)));
			}
		});
	return box;
};

/**
 * Grades of the website, when the widget settings carry them (`settings.catalog.grades: [{ key, label }]`).
 * @param {Kit} kit
 * @returns {Array<{ key: string, label: string }>}
 */
const gradesOf = (kit) => {
	const list = kit.settings.catalog?.grades;
	return Array.isArray(list) ? list : [];
};

/**
 * A saved variant's stock for people (per location with multi-location stock).
 * @param {Kit} kit @param {any} variant @param {Array<{ id: string, name: string }>} locations
 */
const stockText = (kit, variant, locations) => {
	const at = Object.entries(variant.locations ?? {});
	if (at.length === 0) return String(variant.stock ?? 0);
	const names = new Map(locations.map((location) => [location.id, location.name]));
	return at
		.map(([key, units]) => kit.t('catalogAdmin.unitsAt', { units: Number(units), location: names.get(key) ?? key }))
		.join(', ');
};

/**
 * Images of a saved product: thumbnails with alternative text, move earlier or later, remove, and upload more.
 * @param {Kit} kit @param {any} product
 */
const imagesOf = (kit, product) => {
	const { t, h } = kit;
	const note = kit.status();
	const shown = h('div', { class: 'thumbs' });
	/** @type {Array<{ key: string, url: string | null, alt: HTMLInputElement }>} */
	let media = [];
	/** @param {any[]} files */
	const take = (files) => {
		media = files.map((file) => ({
			key: file.key,
			url: file.url ?? null,
			alt: kit.input(file.alt ?? '', { maxlength: '200' }),
		}));
		draw();
	};
	const draw = () =>
		shown.replaceChildren(
			...media.map((file, index) =>
				h('figure', {}, [
					file.url ? kit.h('img', { src: file.url, alt: file.alt.value }) : null,
					kit.field(t('catalogAdmin.altText', { number: index + 1 }), file.alt),
					h('div', { class: 'actions' }, [
						index > 0
							? kit.button(t('catalogAdmin.moveEarlier'), () => {
									media.splice(index - 1, 0, ...media.splice(index, 1));
									draw();
								})
							: null,
						index < media.length - 1
							? kit.button(t('catalogAdmin.moveLater'), () => {
									media.splice(index + 1, 0, ...media.splice(index, 1));
									draw();
								})
							: null,
						kit.confirmButton(t('admin.remove'), t('admin.confirmRemove'), async () => {
							const answer = await kit.call(
								'DELETE',
								`/v1/admin/products/${product.id}/media?key=${encodeURIComponent(file.key)}`,
							);
							if (!answer.ok) return kit.fail(note, answer);
							take(answer.data.media);
							return answer;
						}),
					]),
				]),
			),
		);
	take(product.media ?? []);
	const arrange = kit.button(t('catalogAdmin.saveImages'), async () => {
		const answer = await kit.call('PUT', `/v1/admin/products/${product.id}/media`, {
			items: media.map((file) => ({ key: file.key, alt: file.alt.value })),
		});
		if (!answer.ok) return kit.fail(note, answer);
		take(answer.data.media);
		kit.say(note, t('admin.saved'));
		return answer;
	});
	const picker = kit.input('', { type: 'file', accept: IMAGE_ACCEPT, multiple: '' });
	picker.addEventListener('change', async () => {
		for (const file of [...(picker.files ?? [])]) {
			kit.say(note, t('admin.uploading'));
			const asked = await kit.call('POST', '/v1/admin/catalog/uploads', {
				for: 'product',
				id: product.id,
				type: file.type,
				size: file.size,
			});
			if (!asked.ok) return kit.fail(note, asked);
			if (!(await kit.upload(asked.data.upload, file))) return kit.say(note, t('admin.uploadFailed'), true);
			const added = await kit.call('POST', `/v1/admin/products/${product.id}/media`, { key: asked.data.key, alt: '' });
			if (!added.ok) return kit.fail(note, added);
			take(added.data.media);
		}
		picker.value = '';
		kit.say(note, t('admin.saved'));
	});
	return kit.group(t('catalogAdmin.images'), [shown, arrange, kit.field(t('catalogAdmin.addImages'), picker), note]);
};

/**
 * Change the stock of a saved product's variant: add or take units, or set the count (at a location with
 * multi-location stock).
 * @param {Kit} kit @param {any} product @param {Array<{ id: string, name: string }>} locations
 * @param {(product: any) => void} changed
 */
const stockOf = (kit, product, locations, changed) => {
	const { t, h } = kit;
	const note = kit.status();
	const variant = kit.select(
		product.variants.map((/** @type {any} */ item) => ({ value: item.id, label: variantLabel(kit, item) })),
	);
	const location = kit.select(locations.map((item) => ({ value: item.id, label: item.name })));
	const mode = kit.select([
		{ value: 'adjust', label: t('catalogAdmin.adjustBy') },
		{ value: 'set', label: t('catalogAdmin.setTo') },
	]);
	const units = kit.input('', { type: 'number', step: '1' });
	const apply = kit.button(t('catalogAdmin.changeStock'), async () => {
		const value = wholeOf(units.value);
		if (value === null || Number.isNaN(value)) return kit.say(note, t('admin.checkNumbers'), true);
		const answer = await kit.call('POST', `/v1/admin/products/${product.id}/stock`, {
			changes: [
				{
					variantId: variant.value,
					[mode.value]: value,
					...(kit.has('multi_location') ? { locationId: location.value } : {}),
				},
			],
		});
		if (!answer.ok) return kit.fail(note, answer);
		changed(answer.data);
		return answer;
	});
	return kit.group(t('catalogAdmin.stockChange'), [
		h('div', { class: 'fields' }, [
			kit.field(t('catalogAdmin.variant'), variant),
			kit.has('multi_location') ? kit.field(t('catalogAdmin.location'), location) : null,
			kit.field(t('catalogAdmin.how'), mode),
			kit.field(t('catalogAdmin.units'), units),
		]),
		apply,
		note,
	]);
};

/**
 * Licence keys (one per line) and downloadable files of a saved digital product.
 * @param {Kit} kit @param {any} product
 */
const digitalOf = (kit, product) => {
	const { t, h } = kit;
	const note = kit.status();
	const keys = kit.area('', { rows: '4' });
	const files = h('ul', { class: 'rows' });
	/** @param {{ name: string, size: number }} file */
	const listed = (file) =>
		kit.text('li', {}, t('catalogAdmin.fileLine', { name: file.name, size: Math.ceil(file.size / 1024) }));
	files.append(
		...(product.digital?.files ?? []).map((/** @type {any} */ file) =>
			listed({ name: file.alt || file.key.split('/').pop(), size: file.size }),
		),
	);
	const addKeys = kit.button(t('catalogAdmin.addLicences'), async () => {
		const answer = await kit.call('POST', `/v1/admin/products/${product.id}/licences`, { keys: entriesOf(keys.value) });
		if (!answer.ok) return kit.fail(note, answer);
		keys.value = '';
		kit.say(note, t('catalogAdmin.licencesAdded', { added: answer.data.added, available: answer.data.available }));
		return answer;
	});
	const picker = kit.input('', { type: 'file' });
	picker.addEventListener('change', async () => {
		const file = picker.files?.[0];
		if (!file) return;
		kit.say(note, t('admin.uploading'));
		const asked = await kit.call('POST', `/v1/admin/products/${product.id}/files`, {
			name: safeFileName(file.name) ?? 'file',
			type: file.type || 'application/octet-stream',
			size: file.size,
		});
		if (!asked.ok) return kit.fail(note, asked);
		if (!(await kit.upload(asked.data.upload, file))) return kit.say(note, t('admin.uploadFailed'), true);
		files.append(listed(asked.data.file));
		picker.value = '';
		kit.say(note, t('catalogAdmin.fileAdded', { name: asked.data.file.name }));
	});
	return kit.group(t('catalogAdmin.digitalDelivery'), [
		kit.field(t('catalogAdmin.licencesOnePerLine'), keys),
		addKeys,
		files,
		kit.field(t('catalogAdmin.addFile'), picker),
		note,
	]);
};
