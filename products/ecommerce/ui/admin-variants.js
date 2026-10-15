/**
 * The variant parts of the product editor (PLAN 0.8.8 Items; PLAN 0.8.10 E6, E7, E9, E12): the option axes (up to 6,
 * with Make variants from the options), the attribute setup (values, own values and the default per attribute) with
 * Generate (every missing combination, `POST …/variants/generate { price, stock }`), and the variants table: variant
 * attribute values (several where the attribute takes several), SKU, price, was price, cost, stock (per location with
 * multi-location stock) for new variants, GTIN and MPN, grade, warranty days, the package (weight and size), on sale,
 * sold out and the variant's photos. The product's item type (dynamic model §1) decides the columns: variant fields
 * and more than one variant (`variants`), the grade (`grades`; only the grades for the type are offered), warranty days
 * (`warranty`) and the package (`parcel`).
 * @module
 */
import { gtinOf } from '../core/fields.js';
import { typeTakes } from '../core/item-types.js';
import { quantityLabel, quantityText, toThousandths } from '../core/measure.js';
import { entriesOf, wholeOf } from './admin-kit.js';
import { choicesOf } from './admin-attributes.js';
import { checkGroup } from './admin-fields.js';
import { variantPhotosDialog } from './admin-media.js';
import { fieldsOf } from './admin-screen.js';
import { variantLabel } from './admin-taxonomy.js';

/** @typedef {import('./admin-kit.js').Kit} Kit */
/** @typedef {import('./admin-taxonomy.js').Lookups} Lookups */
/** @typedef {import('./admin-taxonomy.js').Named} Named */
/** @typedef {import('./admin-media.js').Photo} Photo */
/** @typedef {{ name: string, values: string[] }} Axis */

/** At most this many option axes (E7). */
const MAX_AXES = 6;

/**
 * Every combination of option values (`[{ Color: 'Red', Size: 'S' }, …]`).
 * @param {Axis[]} axes
 * @returns {Array<Record<string, string>>}
 */
export const combinations = (axes) =>
	axes.reduce(
		/** @param {Array<Record<string, string>>} out */
		(out, axis) => out.flatMap((combo) => axis.values.map((value) => ({ ...combo, [axis.name]: value }))),
		[{}],
	);

/**
 * The option axes: a name and its values per axis, up to 6 (one empty row to add another).
 * @param {Kit} kit @param {Axis[]} options @param {() => void} make Make variants from the options
 */
export const optionsEditor = (kit, options, make) => {
	const { t, h } = kit;
	const rows = h('div');
	/** @param {Axis} axis */
	const entry = (axis) => ({ name: kit.input(axis.name, { maxlength: '40' }), values: kit.input(axis.values.join(', ')) });
	const axes = options.map(entry);
	if (axes.length < MAX_AXES) axes.push(entry({ name: '', values: [] }));
	const draw = () =>
		rows.replaceChildren(
			...axes.map((axis, index) =>
				h('div', { class: 'row' }, [
					kit.field(t('catalogAdmin.optionName', { number: index + 1 }), axis.name),
					kit.field(t('catalogAdmin.optionValues', { number: index + 1 }), axis.values),
				]),
			),
		);
	const add = kit.button(t('catalogAdmin.addOption'), () => {
		axes.push(entry({ name: '', values: [] }));
		add.hidden = axes.length >= MAX_AXES;
		draw();
	});
	add.hidden = axes.length >= MAX_AXES;
	draw();
	return {
		node: kit.group(t('catalogAdmin.options'), [
			rows,
			h('div', { class: 'actions' }, [add, kit.button(t('catalogAdmin.makeVariants'), make)]),
		]),
		/** @returns {Axis[]} */
		value: () =>
			axes
				.map((axis) => ({ name: axis.name.value.trim(), values: entriesOf(axis.values.value, true) }))
				.filter((axis) => axis.name && axis.values.length > 0),
	};
};

/**
 * @typedef {{ attributeId: string, values: Array<string | number>, customValues: string[],
 *   defaultValue: string | number | null }} SetupEntry
 */

/**
 * The attribute setup (E7): per attribute the values the product uses (the generator makes variants of them), its own
 * extra values and the value picked first; attributes are added from a select and removed.
 * @param {Kit} kit @param {SetupEntry[]} setup @param {Named[]} attributes @param {Array<HTMLElement | null>} actions
 */
export const setupEditor = (kit, setup, attributes, actions) => {
	const { t, h } = kit;
	const rows = h('div');
	/**
	 * @typedef {{ attribute: Named, values: () => Array<string | number>, custom: HTMLInputElement,
	 *   fallback: HTMLInputElement, node: HTMLElement }} Entry
	 */
	/** @type {Entry[]} */
	let entries = [];
	/** @param {SetupEntry} given @returns {Entry | null} */
	const make = (given) => {
		const attribute = attributes.find((item) => item.id === given.attributeId);
		if (!attribute) return null;
		/** @type {() => Array<string | number>} */
		let values;
		/** @type {HTMLElement} */
		let control;
		if (attribute.type === 'choice') {
			const group = checkGroup(kit, t('catalogAdmin.setupValues'), choicesOf(attribute), given.values.map(String));
			values = group.value;
			control = group.node;
		} else {
			const input = kit.input(given.values.join(', '));
			values = () => entriesOf(input.value, true).map((value) => (attribute.type === 'number' ? Number(value) : value));
			control = kit.field(t('catalogAdmin.setupValuesTyped'), input);
		}
		const custom = kit.input(given.customValues.join(', '));
		const fallback = kit.input(given.defaultValue === null ? '' : String(given.defaultValue));
		/** @type {Entry} */
		const entry = { attribute, values, custom, fallback, node: h('div') };
		entry.node = kit.group(attribute.name, [
			control,
			fieldsOf(kit, [kit.field(t('catalogAdmin.setupCustom'), custom), kit.field(t('catalogAdmin.setupDefault'), fallback)]),
			kit.button(
				t('admin.remove'),
				() => {
					entries = entries.filter((other) => other !== entry);
					draw();
				},
				{ attributes: { 'aria-label': t('admin.removeItem', { name: attribute.name }) } },
			),
		]);
		return entry;
	};
	const picker = kit.select([]);
	const draw = () => {
		rows.replaceChildren(...entries.map((entry) => entry.node));
		const used = new Set(entries.map((entry) => entry.attribute.id));
		picker.replaceChildren(
			kit.text('option', { value: '' }, t('catalogAdmin.pickAttribute')),
			...attributes
				.filter((attribute) => !used.has(attribute.id))
				.map((attribute) => kit.text('option', { value: attribute.id }, attribute.name)),
		);
	};
	const add = kit.button(t('catalogAdmin.setUpAttribute'), () => {
		const entry = picker.value ? make({ attributeId: picker.value, values: [], customValues: [], defaultValue: null }) : null;
		if (entry) entries.push(entry);
		draw();
	});
	entries = /** @type {Entry[]} */ (setup.map(make).filter(Boolean));
	draw();
	return {
		node: kit.group(t('catalogAdmin.attributeSetup'), [
			kit.text('p', { class: 'muted' }, t('catalogAdmin.attributeSetupNote')),
			rows,
			h('div', { class: 'row inline' }, [kit.field(t('catalogAdmin.addAttribute'), picker), add]),
			h('div', { class: 'actions' }, actions),
		]),
		/** @returns {SetupEntry[]} */
		value: () =>
			entries.map((entry) => {
				const typed = entry.fallback.value.trim();
				return {
					attributeId: entry.attribute.id,
					values: entry.values(),
					customValues: entriesOf(entry.custom.value, true),
					defaultValue: typed === '' ? null : entry.attribute.type === 'number' ? Number(typed) : typed,
				};
			}),
		/** The product's own values of an attribute. @param {string} id */
		customOf: (id) => {
			const found = entries.find((entry) => entry.attribute.id === id);
			return found ? entriesOf(found.custom.value, true) : [];
		},
	};
};

/**
 * The generator dialog (E7): the price and stock of the new variants (an item sold in a unit of its own: in its
 * unit); `before` runs first (the editor saves the product), `done` gets the product and how many variants were added.
 * @param {Kit} kit
 * @param {{ productId: string, before?: () => Promise<string | null>, done: (product: any, added: number) => unknown,
 *   measure?: { unit: string } | null }} options
 */
export const generateDialog = (kit, { productId, before, done, measure = null }) => {
	const { t } = kit;
	const price = kit.input('', { inputmode: 'decimal' });
	const stock = measure
		? kit.input('0', { inputmode: 'decimal', 'aria-label': t('catalogAdmin.stockIn', { unit: measure.unit }) })
		: kit.input('0', { type: 'number', min: '0', step: '1' });
	kit.dialog({
		title: t('catalogAdmin.generateTitle'),
		body: [
			kit.text('p', {}, t(before ? 'catalogAdmin.generateSavesFirst' : 'catalogAdmin.generateNote')),
			fieldsOf(kit, [
				kit.field(t('catalogAdmin.generatePrice'), price),
				kit.has('multi_location') ? null : kit.field(t('catalogAdmin.generateStock'), stock),
			]),
		],
		submitLabel: t('catalogAdmin.generate'),
		onSubmit: async () => {
			const amount = kit.amount(price.value);
			const units = stockAmount(stock.value, measure);
			if (Number.isNaN(amount) || Number.isNaN(units) || (units ?? 0) < 0) return t('admin.checkNumbers');
			const failed = before ? await before() : null;
			if (failed) return failed;
			const answer = await kit.call('POST', `/v1/admin/products/${productId}/variants/generate`, {
				price: amount,
				...(kit.has('multi_location') ? {} : { stock: units ?? 0 }),
			});
			if (!answer.ok) return kit.reason(answer);
			await done(answer.data.product, answer.data.added);
			return null;
		},
	});
};

/**
 * @typedef {object} VariantRow
 * @property {any} variant
 * @property {HTMLInputElement} sku
 * @property {HTMLInputElement} gtin
 * @property {HTMLInputElement} mpn
 * @property {HTMLInputElement} price
 * @property {HTMLInputElement} was
 * @property {HTMLInputElement} cost
 * @property {HTMLInputElement | null} stock
 * @property {Map<string, HTMLInputElement>} locations
 * @property {HTMLInputElement | HTMLSelectElement} grade
 * @property {HTMLInputElement} warranty
 * @property {Record<'weightG' | 'lengthMm' | 'widthMm' | 'heightMm', HTMLInputElement>} parcel
 * @property {HTMLInputElement} active
 * @property {HTMLInputElement} soldOut
 * @property {Map<string, { control: HTMLElement, read: () => unknown }>} attributes
 * @property {Photo[]} media
 */

/** The parts of a package, in the order they are typed. */
const PARCEL_PARTS = Object.freeze(/** @type {const} */ (['weightG', 'lengthMm', 'widthMm', 'heightMm']));

/**
 * The variants table of the product editor. `type()`: the product's item type as the form stands (its elements decide
 * the columns).
 * @param {Kit} kit
 * @param {{ product: any, lookups: Lookups, customOf: (id: string) => string[], axes: () => Axis[],
 *   photos: () => Photo[], uploaded: (media: Photo[]) => void, type: () => import('../core/item-types.js').ItemType }} options
 */
export const variantsEditor = (kit, { product, lookups, customOf, axes, photos, uploaded, type }) => {
	const { t, h, has } = kit;
	const { locations } = lookups.state;
	const grades = lookups.grades();
	/** @type {any[]} */
	const start = product.variants;
	const every = has('variants')
		? lookups.state.attributes.filter(
				(attribute) =>
					attribute.on === 'variant' &&
					(attribute.active !== false || start.some((variant) => variant.attributes?.[attribute.id] !== undefined)),
			)
		: [];
	// what the type has (with today's features: a built-in type has every part)
	const many = () => has('variants') && type().elements.variants;
	const gradesOn = () => has('grades_serials') && type().elements.grades;
	const warrantyOn = () => type().elements.warranty;
	// sold in a unit of its own: stock is typed in its unit (thousandths in the API)
	const measureOf = () => type().elements.measure ?? null;
	const parcelOn = () => has('delivery_zones') && type().elements.parcel;
	/** The variant fields shown: those of the type. */
	const attributesOf = () => (many() ? every.filter((attribute) => typeTakes(type(), attribute.id)) : []);
	const box = h('div');

	/**
	 * A control for a variant attribute's value (several where the attribute takes several).
	 * @param {Named} attribute @param {unknown} value @param {string} aria
	 */
	const attributeControl = (attribute, value, aria) => {
		if (attribute.type === 'choice') {
			const known = choicesOf(attribute);
			const choices = [
				...known,
				...customOf(attribute.id)
					.filter((own) => !known.some((choice) => choice.value === own))
					.map((own) => ({ value: own, label: own })),
			];
			const wanted = Array.isArray(value) ? value.map(String) : value === undefined || value === null ? [] : [String(value)];
			if (attribute.multiple) {
				const select = kit.select(choices, '', { multiple: '', 'aria-label': aria });
				for (const option of [...select.options]) option.selected = wanted.includes(option.value);
				return {
					control: select,
					read: () => {
						const picked = [...select.selectedOptions].map((option) => option.value);
						return picked.length === 0 ? null : picked;
					},
				};
			}
			const select = kit.select([{ value: '', label: t('catalogAdmin.notSet') }, ...choices], wanted[0] ?? '', {
				'aria-label': aria,
			});
			return { control: select, read: () => select.value || null };
		}
		if (attribute.type === 'number') {
			const input = kit.input(typeof value === 'number' ? value : '', {
				type: 'number',
				step: Number(attribute.decimals ?? 2) === 0 ? '1' : 'any',
				'aria-label': aria,
			});
			return { control: input, read: () => (input.value.trim() === '' ? null : Number(input.value)) };
		}
		if (attribute.type === 'date') {
			const input = kit.input(typeof value === 'string' ? value : '', { type: 'date', 'aria-label': aria });
			return { control: input, read: () => input.value || null };
		}
		const input = kit.input(Array.isArray(value) ? value.join(', ') : String(value ?? ''), { 'aria-label': aria });
		return {
			control: input,
			read: () => {
				if (!attribute.multiple) return input.value.trim() || null;
				const list = entriesOf(input.value, true);
				return list.length === 0 ? null : list;
			},
		};
	};

	/** @param {any} variant @returns {VariantRow} */
	const rowFor = (variant) => {
		const label = variantLabel(kit, variant);
		/** @param {string} key */
		const aria = (key) => t(key, { variant: label });
		/** @param {boolean} on @param {string} key */
		const toggle = (on, key) => {
			const { box: node } = kit.check('', on);
			node.setAttribute('aria-label', aria(key));
			return node;
		};
		return {
			variant,
			sku: kit.input(variant.sku, { maxlength: '64', 'aria-label': aria('catalogAdmin.skuOf') }),
			gtin: kit.input(variant.gtin ?? '', {
				inputmode: 'numeric',
				maxlength: '20',
				'aria-label': aria('catalogAdmin.gtinOf'),
			}),
			mpn: kit.input(variant.mpn ?? '', { maxlength: '70', 'aria-label': aria('catalogAdmin.mpnOf') }),
			price: kit.input(kit.decimal(variant.price), { inputmode: 'decimal', 'aria-label': aria('catalogAdmin.priceOf') }),
			was: kit.input(kit.decimal(variant.compareAtPrice), { inputmode: 'decimal', 'aria-label': aria('catalogAdmin.wasOf') }),
			cost: kit.input(kit.decimal(variant.cost), { inputmode: 'decimal', 'aria-label': aria('catalogAdmin.costOf') }),
			stock:
				!variant.id && !has('multi_location')
					? kit.input(stockInput(variant.stock, measureOf()), {
							inputmode: 'decimal',
							'aria-label': aria('catalogAdmin.stockOf'),
						})
					: null,
			locations: new Map(
				has('multi_location') && !variant.id
					? locations.map((location) => [
							location.id,
							kit.input(String(variant.locations[location.id] ?? 0), {
								type: 'number',
								min: '0',
								step: '1',
								'aria-label': t('catalogAdmin.stockAt', { location: location.name }),
							}),
						])
					: [],
			),
			grade:
				grades.length > 0
					? kit.select(
							[
								{ value: '', label: t('catalogAdmin.noGrade') },
								...grades.map((grade) => ({ value: grade.key, label: grade.label })),
							],
							variant.grade ?? '',
							{ 'aria-label': aria('catalogAdmin.gradeOf') },
						)
					: kit.input(variant.grade ?? '', { 'aria-label': aria('catalogAdmin.gradeOf') }),
			warranty: kit.input(variant.warrantyDays ?? '', {
				type: 'number',
				min: '0',
				step: '1',
				'aria-label': aria('catalogAdmin.warrantyOf'),
			}),
			parcel: /** @type {VariantRow['parcel']} */ (
				Object.fromEntries(
					PARCEL_PARTS.map((part) => [
						part,
						kit.input(variant.parcel?.[part] ?? '', {
							type: 'number',
							min: '1',
							step: '1',
							placeholder: t(`catalogAdmin.parcel.${part}`),
							'aria-label': t(`catalogAdmin.parcelOf.${part}`, { variant: label }),
						}),
					]),
				)
			),
			active: toggle(variant.active !== false, 'catalogAdmin.activeOf'),
			soldOut: toggle(variant.soldOut === true, 'catalogAdmin.soldOutOf'),
			attributes: new Map(
				every.map((attribute) => [
					attribute.id,
					attributeControl(
						attribute,
						variant.attributes?.[attribute.id],
						t('catalogAdmin.attributeOf', { attribute: attribute.name, variant: label }),
					),
				]),
			),
			media: [...(variant.media ?? [])],
		};
	};

	/** @type {VariantRow[]} */
	let rows = start.map(rowFor);

	/** @param {VariantRow} entry */
	const photosButton = (entry) =>
		kit.button(
			t('catalogAdmin.photosCount', { count: entry.media.length }),
			() =>
				variantPhotosDialog(kit, {
					productId: product.id,
					name: variantLabel(kit, entry.variant),
					photos: photos(),
					picked: entry.media,
					uploaded,
					chosen: (picked) => {
						entry.media.splice(0, entry.media.length, ...picked);
						draw();
					},
				}),
			{ attributes: { 'aria-label': t('catalogAdmin.photosOfVariant', { variant: variantLabel(kit, entry.variant) }) } },
		);

	const draw = () => {
		const names = axes().map((axis) => axis.name);
		// the grades of the type (a grade set per item type): the others stay on the variants that have them
		const typeKey = type().key;
		for (const entry of rows)
			for (const option of 'options' in entry.grade ? entry.grade.options : []) {
				const grade = grades.find((candidate) => candidate.key === option.value);
				option.disabled = Boolean(grade?.typeKeys?.length) && !grade?.typeKeys?.includes(typeKey) && !option.selected;
			}
		const attributes = attributesOf();
		const removable = many() && rows.length > 1;
		box.replaceChildren(
			kit.table(
				[
					...(many() ? [t('catalogAdmin.variant')] : []),
					...attributes.map((attribute) => attribute.name),
					t('catalogAdmin.sku'),
					t('catalogAdmin.gtin'),
					t('catalogAdmin.mpn'),
					t('catalogAdmin.price'),
					t('catalogAdmin.wasPrice'),
					t('catalogAdmin.cost'),
					t('catalogAdmin.stock'),
					...(gradesOn() ? [t('catalogAdmin.grade')] : []),
					...(warrantyOn() ? [t('catalogAdmin.warrantyShort')] : []),
					...(parcelOn() ? [t('catalogAdmin.parcel')] : []),
					t('catalogAdmin.active'),
					t('catalogAdmin.soldOut'),
					...(product.id && has('variants') ? [t('catalogAdmin.photos')] : []),
					...(removable ? [''] : []),
				],
				rows.map((entry) => [
					...(many()
						? [
								names.map((axis) => entry.variant.options[axis] ?? '').join(' / ') ||
									Object.values(entry.variant.options).join(' / ') ||
									'—',
							]
						: []),
					...attributes.map((attribute) => entry.attributes.get(attribute.id)?.control ?? null),
					entry.sku,
					entry.gtin,
					entry.mpn,
					entry.price,
					entry.was,
					entry.cost,
					entry.stock ??
						(entry.locations.size > 0
							? h('div', {}, [...entry.locations.values()])
							: kit.text('span', {}, stockText(kit, entry.variant, locations, measureOf()))),
					...(gradesOn() ? [entry.grade] : []),
					...(warrantyOn() ? [entry.warranty] : []),
					...(parcelOn()
						? [
								h(
									'div',
									{ class: 'row' },
									PARCEL_PARTS.map((part) => entry.parcel[part]),
								),
							]
						: []),
					entry.active,
					entry.soldOut,
					...(product.id && has('variants') ? [photosButton(entry)] : []),
					...(removable
						? [
								kit.button(t('admin.remove'), () => {
									rows = rows.filter((other) => other !== entry);
									draw();
								}),
							]
						: []),
				]),
			),
			...(many()
				? [
						kit.button(t('catalogAdmin.addVariant'), () => {
							rows.push(rowFor(blankVariant()));
							draw();
						}),
					]
				: []),
		);
	};
	draw();

	return {
		node: box,
		draw,
		/** Rows for every combination of the option axes (rows that match one are kept). @param {Axis[]} next */
		makeFrom: (next) => {
			const key = (/** @type {Record<string, string>} */ options) => JSON.stringify(Object.entries(options).sort());
			const known = new Map(rows.map((entry) => [key(entry.variant.options), entry]));
			rows = combinations(next).map((options) => known.get(key(options)) ?? rowFor({ ...blankVariant(), options }));
			draw();
		},
		/**
		 * The variants to send, or null when an amount or number is wrong.
		 * @returns {any[] | null}
		 */
		value: () => {
			let bad = false;
			/** @param {HTMLInputElement} input @param {boolean} required */
			const priceOf = (input, required) => {
				const value = kit.amount(input.value);
				if (Number.isNaN(value) || (required && value === null)) bad = true;
				return Number.isNaN(value) ? null : value;
			};
			const attributes = attributesOf();
			const variants = rows.map((entry) => {
				const values = Object.fromEntries(
					attributes
						.map((attribute) => [attribute.id, entry.attributes.get(attribute.id)?.read() ?? null])
						.filter(([, value]) => value !== null),
				);
				const warranty = wholeOf(entry.warranty.value);
				if (Number.isNaN(warranty)) bad = true;
				const parcel = Object.fromEntries(PARCEL_PARTS.map((part) => [part, wholeOf(entry.parcel[part].value)]));
				if (Object.values(parcel).some((part) => Number.isNaN(part))) bad = true;
				// a GTIN ends in its check digit: a mistyped barcode number is caught before saving
				const gtin = entry.gtin.value.trim() ? gtinOf(entry.gtin.value) : '';
				entry.gtin.toggleAttribute('aria-invalid', gtin === null);
				if (gtin === null) bad = true;
				return {
					...(entry.variant.id ? { id: entry.variant.id } : {}),
					sku: entry.sku.value.trim(),
					gtin: gtin ?? '',
					mpn: entry.mpn.value.trim(),
					options: has('variants') && Object.keys(values).length === 0 ? entry.variant.options : {},
					...(attributes.length > 0 ? { attributes: values } : {}),
					price: priceOf(entry.price, true),
					compareAtPrice: priceOf(entry.was, false),
					cost: priceOf(entry.cost, false),
					active: entry.active.checked,
					soldOut: entry.soldOut.checked,
					...(warrantyOn() ? { warrantyDays: Number.isNaN(warranty) ? null : warranty } : {}),
					...(gradesOn() ? { grade: entry.grade.value.trim() || null } : {}),
					...(parcelOn() ? { parcel: Object.values(parcel).every((part) => part === null) ? null : parcel } : {}),
					...(product.id
						? {
								media: entry.media.map((photo) => ({
									key: photo.key,
									alt: photo.alt,
									...(photo.width ? { width: photo.width, height: photo.height } : {}),
								})),
							}
						: {}),
					...(entry.variant.id
						? {}
						: entry.locations.size > 0
							? {
									locations: Object.fromEntries(
										[...entry.locations].map(([id, input]) => [id, Number(input.value) || 0]),
									),
								}
							: { stock: Math.max(0, stockAmount(entry.stock?.value ?? '', measureOf()) || 0) }),
				};
			});
			return bad ? null : variants;
		},
	};
};

/** A new variant's fields. */
export const blankVariant = () => ({
	sku: '',
	options: {},
	price: 0,
	compareAtPrice: null,
	cost: null,
	stock: 0,
	locations: {},
	grade: null,
	active: true,
	soldOut: false,
	warrantyDays: null,
	attributes: {},
	media: [],
});

/**
 * A saved variant's stock for people (per location with multi-location stock); an item sold by length, weight or
 * volume in its unit (`2.5 m`; stock counts thousandths of it).
 * @param {Kit} kit @param {any} variant @param {Array<{ id: string, name: string }>} locations
 * @param {{ unit: string } | null} [measure] the product's measure (none: pieces)
 */
export const stockText = (kit, variant, locations, measure = null) => {
	const at = Object.entries(variant.locations);
	if (at.length === 0) return quantityLabel(Number(variant.stock), measure);
	const names = new Map(locations.map((location) => [location.id, location.name]));
	return at
		.map(([key, units]) =>
			kit.t('catalogAdmin.unitsAt', { units: quantityLabel(Number(units), measure), location: names.get(key) ?? key }),
		)
		.join(', ');
};

/**
 * Stock as staff type it: whole pieces, or for an item sold in a unit of its own an amount of its unit such
 * as 2.5 (sent as thousandths); a leading minus adjusts down. null when empty, NaN when not such a number.
 * @param {string} text @param {{ unit: string } | null} [measure]
 * @returns {number | null}
 */
export const stockAmount = (text, measure = null) => {
	if (!measure) return wholeOf(text);
	const value = text.trim();
	if (value === '') return null;
	const negative = value.startsWith('-');
	const amount = value.replace(/^-/, '') === '0' ? 0 : toThousandths(value.replace(/^-/, ''));
	return amount === null ? Number.NaN : negative ? -amount : amount;
};

/**
 * A stock amount as an input shows it: pieces, or units of a measured item.
 * @param {number} value @param {{ unit: string } | null} [measure]
 */
export const stockInput = (value, measure = null) => (measure ? quantityText(value, measure) : String(value));
