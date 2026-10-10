/**
 * Serial numbers in the catalog admin widget (feature `grades_serials`, PLAN 0.8.8 Grades and serials; E11) as a
 * list-and-detail screen: search (by the start of the serial) and filter by status, Load more, a detail per serial
 * (its product and variant, location and order), Mark faulty / Back in stock, Delete (not for sold units), and Add
 * serial numbers for a product variant (one per line, at a location with multi-location stock).
 * @module
 */
import { entriesOf, query } from './admin-kit.js';
import { createScreen, deleteEntry, detailHead, fieldsOf } from './admin-screen.js';
import { variantLabel } from './admin-taxonomy.js';

/** @typedef {import('./admin-kit.js').Kit} Kit */
/** @typedef {import('./admin-kit.js').Tone} Tone */
/** @typedef {import('./admin-taxonomy.js').Lookups} Lookups */
/**
 * @typedef {{ id: string, productId: string, variantId: string, serial: string, status: 'in_stock' | 'sold' | 'faulty',
 *   orderId: string | null, locationId?: string | null }} Serial
 */

/** Serial statuses and their status colours. */
const TONES = Object.freeze(/** @type {Record<string, Tone>} */ ({ in_stock: 'success', sold: 'neutral', faulty: 'danger' }));

/**
 * The serials section.
 * @param {Kit} kit @param {HTMLElement} panel @param {Lookups} lookups
 */
export const serialsTab = (kit, panel, lookups) => {
	const { t, h } = kit;
	const search = kit.input('', { type: 'search', placeholder: t('catalogAdmin.searchSerials') });
	const status = kit.select([
		{ value: '', label: t('admin.all') },
		...Object.keys(TONES).map((key) => ({ value: key, label: t(`catalogAdmin.serial.${key}`) })),
	]);
	/** @type {string | null} */
	let cursor = null;
	/** @type {Map<string, any>} products read for the details */
	const products = new Map();

	/** @param {boolean} fresh @param {string | null} [pick] @returns {Promise<unknown>} */
	const load = async (fresh, pick = null) => {
		const answer = await kit.call(
			'GET',
			`/v1/admin/serials${query({ q: search.value.trim(), status: status.value, limit: 50, cursor: fresh ? null : cursor })}`,
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
			const variant = (found.variants ?? []).find((/** @type {any} */ entry) => entry.id === serial.variantId);
			if (variant) variantName.replaceChildren(variantLabel(kit, variant));
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
				[t('catalogAdmin.product'), productName],
				[t('catalogAdmin.variant'), variantName],
				[t('catalogAdmin.location'), serial.locationId ? lookups.nameOf('locations', serial.locationId) : ''],
				[t('catalogAdmin.order'), serial.orderId ?? ''],
			]),
		];
	};

	/** Add serial numbers: find the product, pick the variant (and location), one serial per line. */
	const add = () => {
		const note = kit.status();
		const find = kit.input('', { type: 'search' });
		const product = kit.select([{ value: '', label: t('catalogAdmin.pickProduct') }]);
		const variant = kit.select([]);
		const location = kit.select([
			{ value: '', label: t('catalogAdmin.noLocation') },
			...lookups.state.locations.map((item) => ({ value: item.id, label: item.name })),
		]);
		const serials = kit.area('', { rows: '5' });
		const lookup = kit.button(t('admin.find'), async () => {
			const answer = await kit.call('GET', `/v1/admin/products${query({ q: find.value.trim(), limit: 20 })}`);
			if (!answer.ok) return kit.fail(note, answer);
			product.replaceChildren(
				kit.text('option', { value: '' }, t('catalogAdmin.pickProduct')),
				...(answer.data.items ?? []).map((/** @type {any} */ item) => kit.text('option', { value: item.id }, item.name)),
			);
			return answer;
		});
		product.addEventListener('change', async () => {
			variant.replaceChildren();
			if (!product.value) return;
			const found = await productOf(product.value);
			if (!found) return kit.say(note, t('catalogAdmin.productGone'), true);
			variant.append(
				...(found.variants ?? []).map((/** @type {any} */ entry) =>
					kit.text('option', { value: entry.id }, variantLabel(kit, entry)),
				),
			);
		});
		kit.dialog({
			title: t('catalogAdmin.addSerials'),
			body: [
				h('div', { class: 'row inline' }, [kit.field(t('catalogAdmin.findProduct'), find), lookup]),
				note,
				fieldsOf(kit, [
					kit.field(t('catalogAdmin.product'), product),
					kit.field(t('catalogAdmin.variant'), variant),
					kit.has('multi_location') ? kit.field(t('catalogAdmin.location'), location) : null,
				]),
				kit.field(t('catalogAdmin.serialsOnePerLine'), serials),
			],
			submitLabel: t('catalogAdmin.addSerials'),
			onSubmit: async () => {
				if (!product.value || !variant.value) return t('catalogAdmin.pickVariantFirst');
				const answer = await kit.call('POST', '/v1/admin/serials', {
					productId: product.value,
					variantId: variant.value,
					serials: entriesOf(serials.value, true),
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
	]);
	filters.addEventListener('submit', (event) => {
		event.preventDefault();
		void load(true);
	});
	status.addEventListener('change', () => void load(true));

	const screen = createScreen(kit, panel, {
		tools: [h('div', { class: 'tools' }, [filters, kit.button(t('catalogAdmin.addSerials'), add, { primary: true })])],
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
