/**
 * Units (serial numbers) in the catalog admin widget (feature `grades_serials`, PLAN 0.8.8 Condition grades and unit numbers; E11;
 * dynamic model §2) as a list-and-detail screen: search (by the start of the serial) and filter by status, Load more, a
 * detail per unit (its values by unit field, product and variant, location and order), Mark faulty / Back in stock,
 * Delete (not for sold units), and Add units for a product variant (of an item type that numbers its units): one unit
 * per line — its serial number, or with the type's unit fields its values in the fields' order separated by commas or
 * tabs (as pasted from a spreadsheet), each checked
 * against its field's format before sending — at a location with multi-location stock. A product's detail opens the
 * section filtered to that product (a removable chip, and a variant select).
 * @module
 */
import { checkFormat } from '../core/fields.js';
import { entriesOf, query } from './admin-kit.js';
import { createScreen, deleteEntry, detailHead, fieldsOf } from './admin-screen.js';
import { variantLabel } from './admin-taxonomy.js';
import { typeNamed, unitFieldsOfType } from './admin-types.js';

/** @typedef {import('./admin-kit.js').Kit} Kit */
/** @typedef {import('./admin-kit.js').Tone} Tone */
/** @typedef {import('./admin-taxonomy.js').Lookups} Lookups */
/**
 * @typedef {{ id: string, productId: string, variantId: string, serial: string, values?: Record<string, string[]>,
 *   status: 'in_stock' | 'sold' | 'faulty', orderId: string | null, locationId?: string | null }} Serial
 */

/** @typedef {{ id: string, name: string, variants: any[] }} SerialProduct the product the list is filtered to */

/**
 * The product filter of the serial numbers list, shared with the product detail (which sets it, then shows the
 * section); the section reloads when it changes.
 */
export const createSerialFilter = () => {
	/** @type {{ product: SerialProduct | null, listener: (() => void) | null }} */
	const state = { product: null, listener: null };
	return {
		get: () => state.product,
		/** @param {SerialProduct | null} product */
		set: (product) => {
			state.product = product;
			state.listener?.();
		},
		/** @param {() => void} listener */
		listen: (listener) => {
			state.listener = listener;
		},
	};
};

/** @typedef {ReturnType<typeof createSerialFilter>} SerialFilter */
/**
 * Links between the sections: show a product's serial numbers.
 * @typedef {{ serialsOf: (product: SerialProduct) => void, serialFilter: SerialFilter }} Links
 */

/** Serial statuses and their status colors. */
const TONES = Object.freeze(/** @type {Record<string, Tone>} */ ({ in_stock: 'success', sold: 'neutral', faulty: 'danger' }));

/**
 * The serials section.
 * @param {Kit} kit @param {HTMLElement} panel @param {Lookups} lookups @param {Links} links
 */
export const serialsTab = (kit, panel, lookups, links) => {
	const { t, h } = kit;
	const filter = links.serialFilter;
	const search = kit.input('', { type: 'search', placeholder: t('catalogAdmin.searchSerials') });
	const status = kit.select([
		{ value: '', label: t('admin.all') },
		...Object.keys(TONES).map((key) => ({ value: key, label: t(`catalogAdmin.serial.${key}`) })),
	]);
	/** @type {string | null} */
	let cursor = null;
	/** @type {Map<string, any>} products read for the details */
	const products = new Map();
	const chip = h('ul', { class: 'chips' });
	const variant = kit.select([]);
	const variantField = kit.field(t('catalogAdmin.variant'), variant);
	/** The product filter: its chip and its variants. */
	const drawFilter = () => {
		const product = filter.get();
		chip.hidden = !product;
		variantField.hidden = !product;
		if (!product) return chip.replaceChildren();
		products.set(product.id, product);
		chip.replaceChildren(
			h('li', {}, [
				t('catalogAdmin.productFilter', { name: product.name }),
				kit.button('×', () => filter.set(null), { attributes: { 'aria-label': t('catalogAdmin.removeProductFilter') } }),
			]),
		);
		return variant.replaceChildren(
			kit.text('option', { value: '' }, t('catalogAdmin.allVariants')),
			...product.variants.map((entry) => kit.text('option', { value: entry.id }, variantLabel(kit, entry))),
		);
	};

	/** @param {boolean} fresh @param {string | null} [pick] @returns {Promise<unknown>} */
	const load = async (fresh, pick = null) => {
		const answer = await kit.call(
			'GET',
			`/v1/admin/serials${query({
				q: search.value.trim(),
				status: status.value,
				productId: filter.get()?.id,
				variantId: filter.get() ? variant.value : '',
				limit: 50,
				cursor: fresh ? null : cursor,
			})}`,
		);
		if (!answer.ok) {
			more.hidden = true;
			return kit.fail(screen.line, answer);
		}
		cursor = answer.data.nextCursor ?? null;
		/** @type {Serial[]} */
		const items = answer.data.items ?? [];
		if (fresh) screen.set(items, pick);
		else screen.append(items);
		kit.say(screen.line, fresh && items.length === 0 ? t('catalogAdmin.noSerials') : '');
		more.hidden = !answer.data.hasMore;
		return answer;
	};
	const more = kit.button(t('admin.more'), () => load(false));
	more.hidden = true;

	/**
	 * The product of a serial (read once).
	 * @param {string} id
	 */
	const productOf = async (id) => {
		if (!products.has(id)) {
			const answer = await kit.call('GET', `/v1/admin/products/${id}`);
			products.set(id, answer.ok ? answer.data : null);
		}
		return products.get(id);
	};

	/** @param {Serial} serial */
	const detail = (serial) => {
		const note = kit.status();
		const productName = kit.text('span', {}, serial.productId);
		const variantName = kit.text('span', {}, serial.variantId);
		void productOf(serial.productId).then((found) => {
			if (!found) return;
			productName.replaceChildren(found.name);
			const sold = (found.variants ?? []).find((/** @type {any} */ entry) => entry.id === serial.variantId);
			if (sold) variantName.replaceChildren(variantLabel(kit, sold));
		});
		/** @param {'in_stock' | 'faulty'} to */
		const mark = (to) =>
			kit.button(
				t(to === 'faulty' ? 'catalogAdmin.markFaulty' : 'catalogAdmin.markInStock'),
				async () => {
					const answer = await kit.call('PATCH', `/v1/admin/serials/${serial.id}`, { status: to });
					if (!answer.ok) return kit.fail(note, answer);
					await load(true, serial.id);
					return answer;
				},
				{ primary: true },
			);
		return [
			detailHead(kit, {
				title: serial.serial,
				badges: [kit.badge(t(`catalogAdmin.serial.${serial.status}`), TONES[serial.status])],
				actions: [serial.status === 'in_stock' ? mark('faulty') : null, serial.status === 'faulty' ? mark('in_stock') : null],
				more: [
					serial.status === 'sold'
						? null
						: deleteEntry(kit, {
								name: serial.serial,
								path: `/v1/admin/serials/${serial.id}`,
								done: () => load(true),
							}),
				],
			}),
			note,
			kit.fieldGrid([
				// its numbers by unit field
				...Object.entries(serial.values ?? {}).map(
					([id, values]) => /** @type {[string, string]} */ ([lookups.nameOf('attributes', id), values.join(' / ')]),
				),
				[t('catalogAdmin.product'), productName],
				[t('catalogAdmin.variant'), variantName],
				[t('catalogAdmin.location'), serial.locationId ? lookups.nameOf('locations', serial.locationId) : ''],
				[t('catalogAdmin.order'), serial.orderId ?? ''],
			]),
		];
	};

	/**
	 * The unit fields of a product's units (its item type's) and the slots a line fills: each field once, or twice for a
	 * field that takes two values.
	 * @param {any} found the product
	 */
	const slotsOf = (found) => {
		const type = typeNamed(kit, found?.type?.key, String(found?.kind ?? 'physical'));
		return unitFieldsOfType(kit, type, lookups.state.attributes).flatMap((field) =>
			Array.from({ length: field.maxValues > 1 ? field.maxValues : 1 }, (_, value) => ({ field, value })),
		);
	};

	/**
	 * The units of the lines typed: a serial number per line, or with unit fields one unit per line, its values in the
	 * slots' order separated by commas or tabs; a value its field's format refuses names its line.
	 * @param {string} text @param {Array<{ field: any, value: number }>} slots
	 * @returns {{ ok: true, units: Array<string | { values: Record<string, string[]> }> } | { ok: false, error: string }}
	 */
	const unitsOf = (text, slots) => {
		if (slots.length === 0) return { ok: true, units: entriesOf(text, true) };
		/** @type {Array<{ values: Record<string, string[]> }>} */
		const units = [];
		const lines = text.split(/\r?\n/).map((line) => line.trim());
		for (const [index, line] of lines.entries()) {
			if (!line) continue;
			/** @type {Record<string, string[]>} */
			const values = {};
			const cells = line.split(/[,\t]/).map((cell) => cell.trim());
			for (const [slot, cell] of cells.entries()) {
				const place = slots[slot];
				if (!place || !cell) continue;
				const checked = place.field.format ? checkFormat(cell, place.field.format) : null;
				if (checked && !checked.ok)
					return {
						ok: false,
						error: `${t('catalogAdmin.unitLine', { line: index + 1 })} ${t('fields.notFormat', { value: cell, field: place.field.name })} ${t(`fields.problem.${checked.code}`)}`,
					};
				values[place.field.id] = [...(values[place.field.id] ?? []), checked ? checked.value : cell];
			}
			units.push({ values });
		}
		return { ok: true, units };
	};

	/** Add units: find the product, pick the variant (and location), one unit per line. */
	const add = () => {
		const note = kit.status();
		const find = kit.input('', { type: 'search' });
		const product = kit.select([{ value: '', label: t('catalogAdmin.pickProduct') }]);
		const pickVariant = kit.select([]);
		const location = kit.select([
			{ value: '', label: t('catalogAdmin.noLocation') },
			...lookups.state.locations.map((item) => ({ value: item.id, label: item.name })),
		]);
		const serials = kit.area('', { rows: '5' });
		const serialsLabel = kit.text('span', {}, t('catalogAdmin.serialsOnePerLine'));
		/** @type {Array<{ field: any, value: number }>} the slots of a line, by the picked product's unit fields */
		let slots = [];
		const filtered = filter.get();
		if (filtered) product.append(kit.text('option', { value: filtered.id }, filtered.name));
		const lookup = kit.button(t('admin.find'), async () => {
			const answer = await kit.call('GET', `/v1/admin/products${query({ q: find.value.trim(), limit: 20 })}`);
			if (!answer.ok) return kit.fail(note, answer);
			product.replaceChildren(
				kit.text('option', { value: '' }, t('catalogAdmin.pickProduct')),
				...(answer.data.items ?? []).map((/** @type {any} */ item) => kit.text('option', { value: item.id }, item.name)),
			);
			return answer;
		});
		const fill = async () => {
			pickVariant.replaceChildren();
			if (!product.value) return;
			const found = await productOf(product.value);
			if (!found) return kit.say(note, t('catalogAdmin.productGone'), true);
			slots = slotsOf(found);
			serialsLabel.replaceChildren(
				slots.length === 0
					? t('catalogAdmin.serialsOnePerLine')
					: t('catalogAdmin.unitsOnePerLine', {
							columns: slots
								.map(({ field, value }) =>
									value === 0 ? field.name : t('ordersAdmin.secondValue', { field: field.name }),
								)
								.join(', '),
						}),
			);
			pickVariant.append(
				...(found.variants ?? []).map((/** @type {any} */ entry) =>
					kit.text('option', { value: entry.id }, variantLabel(kit, entry)),
				),
			);
			if (filtered && product.value === filtered.id && variant.value) pickVariant.value = variant.value;
			return null;
		};
		product.addEventListener('change', () => void fill());
		if (filtered) {
			product.value = filtered.id;
			void fill();
		}
		kit.dialog({
			title: t('catalogAdmin.addSerials'),
			body: [
				h('div', { class: 'row inline' }, [kit.field(t('catalogAdmin.findProduct'), find), lookup]),
				note,
				fieldsOf(kit, [
					kit.field(t('catalogAdmin.product'), product),
					kit.field(t('catalogAdmin.variant'), pickVariant),
					kit.has('multi_location') ? kit.field(t('catalogAdmin.location'), location) : null,
				]),
				kit.field(t('catalogAdmin.serialsOnePerLine'), serials),
				h('p', { class: 'muted' }, [serialsLabel]),
			],
			submitLabel: t('catalogAdmin.addSerials'),
			onSubmit: async () => {
				if (!product.value || !pickVariant.value) return t('catalogAdmin.pickVariantFirst');
				const typed = unitsOf(serials.value, slots);
				if (!typed.ok) return typed.error;
				const answer = await kit.call('POST', '/v1/admin/serials', {
					productId: product.value,
					variantId: pickVariant.value,
					serials: typed.units,
					...(location.value ? { locationId: location.value } : {}),
				});
				if (!answer.ok) return kit.reason(answer);
				await load(true);
				kit.say(screen.line, t('catalogAdmin.serialsAdded', { count: answer.data.items.length }));
				return null;
			},
		});
	};

	const filters = h('form', { class: 'row inline' }, [
		kit.field(t('admin.search'), search),
		kit.field(t('admin.status'), status),
		variantField,
	]);
	filters.addEventListener('submit', (event) => {
		event.preventDefault();
		void load(true);
	});
	status.addEventListener('change', () => void load(true));
	variant.addEventListener('change', () => void load(true));
	filter.listen(() => {
		drawFilter();
		void load(true);
	});
	drawFilter();

	const screen = createScreen(kit, panel, {
		tools: [h('div', { class: 'tools' }, [filters, kit.button(t('catalogAdmin.addSerials'), add, { primary: true })]), chip],
		empty: t('catalogAdmin.noSerials'),
		idOf: (serial) => serial.id,
		row: (serial) => ({
			name: serial.serial,
			tone: TONES[serial.status],
			toneLabel: t(`catalogAdmin.serial.${serial.status}`),
			figure: t(`catalogAdmin.serial.${serial.status}`),
			meta: [serial.orderId ?? '', serial.locationId ? lookups.nameOf('locations', serial.locationId) : '']
				.filter(Boolean)
				.join(' · '),
		}),
		detail,
	});
	screen.tail.append(more);
	void load(true);
};
