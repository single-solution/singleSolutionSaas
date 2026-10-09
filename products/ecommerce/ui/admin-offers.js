/**
 * Coupons, deals and bundles in the promotions admin widget (PLAN 0.8.8 Promotions): each a list with search, an
 * active filter and Load more, and an editor; coupons also come in batches of random codes (downloadable as CSV).
 * Scopes are picked by product, category and brand (search; typed ids when the ticket cannot read the catalog).
 * Amounts are typed as decimals of the shop currency, percentages as numbers, times in the browser's time zone.
 * @module
 */
import { toCsv } from '../core/csv.js';
import { entriesOf, fromLocal, localInput, query, wholeOf } from './admin-kit.js';

/** @typedef {import('./admin-kit.js').Kit} Kit */
/** @typedef {ReturnType<typeof import('./admin-taxonomy.js').createSearches>} Searches */
/** @typedef {{ productIds: string[], categoryIds: string[], brandIds: string[] }} Scope */

/** The fields an editor part gives: its nodes and its values (null when a number is not valid). */
/** @typedef {{ nodes: Array<Node | null>, values: () => Record<string, unknown> | null }} Part */

const EMPTY_SCOPE = Object.freeze({ productIds: [], categoryIds: [], brandIds: [] });

/**
 * Scope pickers: products, categories and brands (empty = everything).
 * @param {Kit} kit @param {Searches} searches @param {Map<string, string>} names @param {string} legend
 * @param {Scope | null | undefined} scope
 */
const scopeOf = (kit, searches, names, legend, scope) => {
	const { t } = kit;
	const value = scope ?? EMPTY_SCOPE;
	const products = kit.picker({ label: t('promotionsAdmin.products'), ids: value.productIds, names, search: searches.products });
	const categories = kit.picker({
		label: t('promotionsAdmin.categories'),
		ids: value.categoryIds,
		names,
		search: searches.categories,
	});
	const brands = kit.picker({ label: t('promotionsAdmin.brands'), ids: value.brandIds, names, search: searches.brands });
	return {
		node: kit.group(legend, [
			kit.text('p', { class: 'muted' }, t('promotionsAdmin.scopeHint')),
			products.node,
			categories.node,
			brands.node,
		]),
		value: () => ({ productIds: products.value(), categoryIds: categories.value(), brandIds: brands.value() }),
	};
};

/**
 * Start and end times, total uses and active, which every offer has.
 * @param {Kit} kit @param {any} offer
 * @returns {Part}
 */
const commonOf = (kit, offer) => {
	const { t } = kit;
	const startsAt = kit.input(localInput(offer.startsAt), { type: 'datetime-local' });
	const endsAt = kit.input(localInput(offer.endsAt), { type: 'datetime-local' });
	const limit = kit.input(offer.limit ?? '', { type: 'number', min: '1', step: '1' });
	const active = kit.check(t('promotionsAdmin.active'), offer.active !== false);
	return {
		nodes: [
			kit.h('div', { class: 'fields' }, [
				kit.field(t('promotionsAdmin.startsAt'), startsAt),
				kit.field(t('promotionsAdmin.endsAt'), endsAt),
				kit.field(t('promotionsAdmin.limit'), limit),
			]),
			active.node,
		],
		values: () => {
			const uses = wholeOf(limit.value);
			if (Number.isNaN(uses)) return null;
			return { startsAt: fromLocal(startsAt.value), endsAt: fromLocal(endsAt.value), limit: uses, active: active.box.checked };
		},
	};
};

/** Coupon types. */
const COUPON_TYPES = Object.freeze(['percent', 'fixed', 'free_delivery']);

/**
 * A coupon's fields (with or without its code: batches draw codes).
 * @param {Kit} kit @param {Searches} searches @param {Map<string, string>} names @param {any} coupon @param {boolean} withCode
 * @returns {Part}
 */
const couponFields = (kit, searches, names, coupon, withCode) => {
	const { t, h } = kit;
	const code = kit.input(coupon.code ?? '', { maxlength: '40', autocapitalize: 'characters' });
	const type = kit.select(
		COUPON_TYPES.map((key) => ({ value: key, label: t(`promotionsAdmin.couponType.${key}`) })),
		coupon.type ?? 'percent',
	);
	const percent = kit.input(coupon.type === 'percent' ? String(coupon.value) : '', {
		type: 'number',
		min: '0',
		max: '100',
		step: 'any',
	});
	const fixed = kit.input(coupon.type === 'fixed' ? kit.decimal(coupon.value) : '', { inputmode: 'decimal' });
	const maxDiscount = kit.input(kit.decimal(coupon.maxDiscount), { inputmode: 'decimal' });
	const minSubtotal = kit.input(coupon.minSubtotal ? kit.decimal(coupon.minSubtotal) : '', { inputmode: 'decimal' });
	const perCustomer = kit.input(coupon.perCustomer ?? '', { type: 'number', min: '1', step: '1' });
	const firstOrder = kit.check(t('promotionsAdmin.firstOrderOnly'), coupon.firstOrderOnly === true);
	const percentField = kit.field(t('promotionsAdmin.percentOff'), percent);
	const fixedField = kit.field(t('promotionsAdmin.amountOff', { currency: kit.currency }), fixed);
	const maxField = kit.field(t('promotionsAdmin.maxDiscount', { currency: kit.currency }), maxDiscount);
	const show = () => {
		percentField.hidden = type.value !== 'percent';
		maxField.hidden = type.value !== 'percent';
		fixedField.hidden = type.value !== 'fixed';
	};
	type.addEventListener('change', show);
	show();
	const scope = scopeOf(kit, searches, names, t('promotionsAdmin.scope'), coupon.scope);
	const common = commonOf(kit, coupon);
	return {
		nodes: [
			h('div', { class: 'fields' }, [
				withCode ? kit.field(t('promotionsAdmin.code'), code) : null,
				kit.field(t('promotionsAdmin.type'), type),
				percentField,
				fixedField,
				maxField,
				kit.field(t('promotionsAdmin.minSubtotal', { currency: kit.currency }), minSubtotal),
				kit.field(t('promotionsAdmin.perCustomer'), perCustomer),
			]),
			firstOrder.node,
			scope.node,
			...common.nodes,
		],
		values: () => {
			const rest = common.values();
			const cap = kit.amount(maxDiscount.value);
			const minimum = kit.amount(minSubtotal.value);
			const each = wholeOf(perCustomer.value);
			const value = type.value === 'percent' ? Number(percent.value) : type.value === 'fixed' ? kit.amount(fixed.value) : 0;
			if (!rest || [cap, minimum, each, value].some((n) => Number.isNaN(n))) return null;
			return {
				...(withCode ? { code: code.value.trim() } : {}),
				type: type.value,
				value,
				maxDiscount: type.value === 'percent' ? cap || null : null,
				minSubtotal: minimum ?? 0,
				perCustomer: each,
				firstOrderOnly: firstOrder.box.checked,
				scope: scope.value(),
				...rest,
			};
		},
	};
};

/**
 * A deal's fields.
 * @param {Kit} kit @param {Searches} searches @param {Map<string, string>} names @param {any} deal
 * @returns {Part}
 */
const dealFields = (kit, searches, names, deal) => {
	const { t, h } = kit;
	const name = kit.input(deal.name ?? '', { maxlength: '120' });
	const description = kit.area(deal.description ?? '', { maxlength: '500' });
	const type = kit.select(
		['percent', 'fixed'].map((key) => ({ value: key, label: t(`promotionsAdmin.dealType.${key}`) })),
		deal.type ?? 'percent',
	);
	const value = kit.input(deal.type === 'fixed' ? kit.decimal(deal.value) : (deal.value ?? ''), { inputmode: 'decimal' });
	const priority = kit.input(String(deal.priority ?? 0), { type: 'number', step: '1' });
	const scope = scopeOf(kit, searches, names, t('promotionsAdmin.scope'), deal.scope);
	const common = commonOf(kit, deal);
	return {
		nodes: [
			h('div', { class: 'fields' }, [
				kit.field(t('promotionsAdmin.name'), name),
				kit.field(t('promotionsAdmin.type'), type),
				kit.field(t('promotionsAdmin.dealValue', { currency: kit.currency }), value),
				kit.field(t('promotionsAdmin.priority'), priority),
			]),
			kit.field(t('promotionsAdmin.description'), description),
			scope.node,
			...common.nodes,
		],
		values: () => {
			const rest = common.values();
			const amount = type.value === 'fixed' ? kit.amount(value.value) : Number(value.value);
			const rank = wholeOf(priority.value);
			if (!rest || Number.isNaN(amount) || Number.isNaN(rank)) return null;
			return {
				name: name.value,
				description: description.value,
				type: type.value,
				value: amount,
				priority: rank ?? 0,
				scope: scope.value(),
				...rest,
			};
		},
	};
};

/**
 * The products of a bundle with their quantities: find a product, add it, change its quantity or remove it.
 * @param {Kit} kit @param {Searches} searches @param {Array<{ productId: string, quantity: number }>} items
 * @param {Map<string, string>} names
 */
const itemsOf = (kit, searches, items, names) => {
	const { t, h } = kit;
	/** @type {Array<{ productId: string, quantity: HTMLInputElement }>} */
	let rows = [];
	const list = h('div');
	/** @param {string} productId @param {number} quantity */
	const add = (productId, quantity) => {
		if (!productId || rows.some((row) => row.productId === productId)) return;
		rows.push({
			productId,
			quantity: kit.input(String(quantity), {
				type: 'number',
				min: '1',
				max: '100',
				step: '1',
				'aria-label': t('promotionsAdmin.quantityOf', { name: names.get(productId) ?? productId }),
			}),
		});
		draw();
	};
	const draw = () =>
		list.replaceChildren(
			kit.table(
				[t('promotionsAdmin.product'), t('promotionsAdmin.quantity'), ''],
				rows.map((row) => [
					names.get(row.productId) ?? row.productId,
					row.quantity,
					kit.button(t('admin.remove'), () => {
						rows = rows.filter((other) => other !== row);
						draw();
					}),
				]),
			),
		);
	for (const item of items) add(item.productId, item.quantity);
	draw();
	const box = kit.input('', { type: 'search', placeholder: t('admin.searchToAdd') });
	const results = h('ul', { class: 'chips' });
	const find = kit.button(t('admin.find'), async () => {
		const found = await searches.products(box.value.trim());
		if (found === null) {
			add(box.value.trim(), 1);
			return;
		}
		results.replaceChildren(
			...found.map((item) =>
				h('li', {}, [
					kit.button(item.label, () => {
						names.set(item.id, item.label);
						add(item.id, 1);
					}),
				]),
			),
		);
	});
	return {
		node: kit.group(t('promotionsAdmin.bundleItems'), [
			list,
			h('div', { class: 'row inline' }, [kit.field(t('admin.search'), box), find]),
			results,
		]),
		value: () => rows.map((row) => ({ productId: row.productId, quantity: Number(row.quantity.value) || 1 })),
	};
};

/**
 * A bundle's fields: the products together for a price or a percentage off, or buy X get Y.
 * @param {Kit} kit @param {Searches} searches @param {Map<string, string>} names @param {any} bundle
 * @returns {Part}
 */
const bundleFields = (kit, searches, names, bundle) => {
	const { t, h } = kit;
	const name = kit.input(bundle.name ?? '', { maxlength: '120' });
	const type = kit.select(
		['bundle', 'buy_x_get_y'].map((key) => ({ value: key, label: t(`promotionsAdmin.bundleType.${key}`) })),
		bundle.type ?? 'bundle',
	);
	const items = itemsOf(kit, searches, bundle.items ?? [], names);
	const price = kit.input(kit.decimal(bundle.price), { inputmode: 'decimal' });
	const percent = kit.input(bundle.type === 'bundle' && bundle.value ? String(bundle.value) : '', {
		type: 'number',
		min: '0',
		max: '100',
		step: 'any',
	});
	const getPercent = kit.input(bundle.type === 'buy_x_get_y' ? String(bundle.value) : '100', {
		type: 'number',
		min: '0',
		max: '100',
		step: 'any',
	});
	const buy = kit.input(String(bundle.buy || 1), { type: 'number', min: '1', max: '100', step: '1' });
	const get = kit.input(String(bundle.get || 1), { type: 'number', min: '1', max: '100', step: '1' });
	const scope = scopeOf(kit, searches, names, t('promotionsAdmin.buyScope'), bundle.scope);
	const getScope = scopeOf(kit, searches, names, t('promotionsAdmin.getScope'), bundle.getScope);
	const bundlePart = h('div', {}, [
		items.node,
		h('div', { class: 'fields' }, [
			kit.field(t('promotionsAdmin.bundlePrice', { currency: kit.currency }), price),
			kit.field(t('promotionsAdmin.percentOff'), percent),
		]),
		kit.text('p', { class: 'muted' }, t('promotionsAdmin.bundleHint')),
	]);
	const buyPart = h('div', {}, [
		h('div', { class: 'fields' }, [
			kit.field(t('promotionsAdmin.buy'), buy),
			kit.field(t('promotionsAdmin.get'), get),
			kit.field(t('promotionsAdmin.getPercent'), getPercent),
		]),
		scope.node,
		getScope.node,
	]);
	const show = () => {
		bundlePart.hidden = type.value !== 'bundle';
		buyPart.hidden = type.value === 'bundle';
	};
	type.addEventListener('change', show);
	show();
	const common = commonOf(kit, bundle);
	return {
		nodes: [
			h('div', { class: 'fields' }, [kit.field(t('promotionsAdmin.name'), name), kit.field(t('promotionsAdmin.type'), type)]),
			bundlePart,
			buyPart,
			...common.nodes,
		],
		values: () => {
			const rest = common.values();
			if (!rest) return null;
			if (type.value === 'bundle') {
				const fixed = kit.amount(price.value);
				if (Number.isNaN(fixed)) return null;
				return {
					name: name.value,
					type: 'bundle',
					items: items.value(),
					price: fixed || null,
					...(fixed ? {} : { value: Number(percent.value) }),
					...rest,
				};
			}
			return {
				name: name.value,
				type: 'buy_x_get_y',
				buy: Number(buy.value),
				get: Number(get.value),
				scope: scope.value(),
				getScope: getScope.value(),
				value: getPercent.value.trim() === '' ? 100 : Number(getPercent.value),
				...rest,
			};
		},
	};
};

/**
 * How each kind of offer is listed and edited.
 * @type {Record<'coupons' | 'deals' | 'bundles', { label: (kit: Kit, item: any) => string, meta: (kit: Kit, item: any) => string,
 *   fields: (kit: Kit, searches: Searches, names: Map<string, string>, item: any) => Part }>}
 */
const KINDS = {
	coupons: {
		label: (_kit, item) => item.code,
		meta: (kit, item) =>
			[
				item.type === 'percent'
					? kit.t('promotionsAdmin.percentText', { value: item.value })
					: item.type === 'fixed'
						? kit.money(item.value)
						: kit.t('promotionsAdmin.couponType.free_delivery'),
				kit.t('promotionsAdmin.usedText', { used: item.used, limit: item.limit ?? '∞' }),
				item.active ? kit.t('promotionsAdmin.active') : kit.t('promotionsAdmin.inactive'),
			].join(' · '),
		fields: (kit, searches, names, item) => couponFields(kit, searches, names, item, true),
	},
	deals: {
		label: (_kit, item) => item.name,
		meta: (kit, item) =>
			[
				item.type === 'percent' ? kit.t('promotionsAdmin.percentText', { value: item.value }) : kit.money(item.value),
				kit.t('promotionsAdmin.usedText', { used: item.used, limit: item.limit ?? '∞' }),
				item.active ? kit.t('promotionsAdmin.active') : kit.t('promotionsAdmin.inactive'),
			].join(' · '),
		fields: dealFields,
	},
	bundles: {
		label: (_kit, item) => item.name,
		meta: (kit, item) =>
			[
				kit.t(`promotionsAdmin.bundleType.${item.type}`),
				kit.t('promotionsAdmin.usedText', { used: item.used, limit: item.limit ?? '∞' }),
				item.active ? kit.t('promotionsAdmin.active') : kit.t('promotionsAdmin.inactive'),
			].join(' · '),
		fields: bundleFields,
	},
};

/**
 * A section of offers: list, filters, editor (and batches for coupons).
 * @param {Kit} kit @param {HTMLElement} panel @param {Searches} searches @param {'coupons' | 'deals' | 'bundles'} kind
 */
export const offersTab = (kit, panel, searches, kind) => {
	const { t, h } = kit;
	const spec = KINDS[kind];
	const path = `/v1/admin/${kind}`;
	const line = kit.status();
	const listView = h('div');
	const editorView = h('div');
	/** @type {Map<string, string>} */
	const names = new Map();
	const known = searches.names().then((found) => {
		for (const [id, name] of found) names.set(id, name);
	});
	const search = kit.input('', { type: 'search' });
	const active = kit.select([
		{ value: '', label: t('admin.all') },
		{ value: 'true', label: t('promotionsAdmin.active') },
		{ value: 'false', label: t('promotionsAdmin.inactive') },
	]);
	/** @param {any} item */
	const rowOf = (item) =>
		h('li', {}, [
			h('div', { class: 'what' }, [
				h('strong', {}, [spec.label(kit, item)]),
				kit.text('span', { class: 'meta' }, spec.meta(kit, item)),
			]),
			kit.button(t('admin.edit'), () => edit(item)),
		]);
	const pages = kit.pager({
		path: (cursor) => `${path}${query({ q: search.value.trim(), active: active.value, cursor })}`,
		row: rowOf,
		line,
		empty: t(`promotionsAdmin.empty.${kind}`),
	});
	const back = async (/** @type {boolean} */ changed) => {
		editorView.replaceChildren();
		listView.hidden = false;
		if (changed) await pages.load(true);
	};

	/** @param {any} item null = new */
	const edit = async (item) => {
		await known;
		const note = kit.status();
		const part = spec.fields(kit, searches, names, item ?? {});
		const save = kit.button(
			t('admin.save'),
			async () => {
				const body = part.values();
				if (!body) return kit.say(note, t('admin.checkNumbers'), true);
				const answer = await kit.call(item ? 'PATCH' : 'POST', item ? `${path}/${item.id}` : path, body);
				if (!answer.ok) {
					kit.fail(note, answer);
					return answer;
				}
				await back(true);
				kit.say(line, t('admin.saved'));
				return answer;
			},
			{ primary: true },
		);
		const remove = item
			? kit.confirmButton(t('admin.delete'), t('admin.confirmDelete'), async () => {
					const answer = await kit.call('DELETE', `${path}/${item.id}`);
					if (!answer.ok) {
						kit.fail(note, answer);
						return answer;
					}
					await back(true);
					kit.say(line, t('admin.deleted'));
					return answer;
				})
			: null;
		listView.hidden = true;
		kit.put(editorView, [
			h('div', { class: 'head' }, [
				kit.text('h3', {}, item ? t('admin.editing', { name: spec.label(kit, item) }) : t(`promotionsAdmin.new.${kind}`)),
				kit.button(t('admin.back'), () => back(false)),
			]),
			...part.nodes,
			h('div', { class: 'actions' }, [save, remove]),
			note,
		]);
	};

	const filters = h('form', { class: 'row inline' }, [
		kit.field(t('admin.search'), search),
		kit.field(t('promotionsAdmin.activeFilter'), active),
		kit.text('button', { type: 'submit', class: 'secondary' }, t('admin.searchButton')),
	]);
	filters.addEventListener('submit', (event) => {
		event.preventDefault();
		void pages.load(true);
	});
	active.addEventListener('change', () => void pages.load(true));
	kit.put(listView, [
		h('div', { class: 'head' }, [
			kit.button(t(`promotionsAdmin.new.${kind}`), () => edit(null), { primary: true }),
			kind === 'coupons' ? kit.button(t('promotionsAdmin.batch'), () => batch()) : null,
		]),
		filters,
		line,
		pages.node,
	]);

	/** Generate many coupons with random codes. */
	const batch = async () => {
		await known;
		const note = kit.status();
		const codes = h('div');
		const prefix = kit.input('', { maxlength: '30' });
		const count = kit.input('10', { type: 'number', min: '1', max: '500', step: '1' });
		const part = couponFields(kit, searches, names, {}, false);
		const make = kit.button(
			t('promotionsAdmin.generate'),
			async () => {
				const coupon = part.values();
				if (!coupon) return kit.say(note, t('admin.checkNumbers'), true);
				const answer = await kit.call('POST', `${path}/batch`, {
					prefix: prefix.value.trim(),
					count: Number(count.value),
					coupon,
				});
				if (!answer.ok) {
					kit.fail(note, answer);
					return answer;
				}
				/** @type {string[]} */
				const made = answer.data.codes ?? [];
				kit.say(note, t('promotionsAdmin.generated', { count: answer.data.created }));
				codes.replaceChildren(
					kit.text('p', {}, made.join(', ')),
					kit.button(t('promotionsAdmin.downloadCodes'), () =>
						kit.save(
							'coupon-codes.csv',
							toCsv(
								[t('promotionsAdmin.code')],
								made.map((code) => [code]),
							),
						),
					),
				);
				return answer;
			},
			{ primary: true },
		);
		listView.hidden = true;
		kit.put(editorView, [
			h('div', { class: 'head' }, [
				kit.text('h3', {}, t('promotionsAdmin.batch')),
				kit.button(t('admin.back'), () => back(true)),
			]),
			h('div', { class: 'fields' }, [
				kit.field(t('promotionsAdmin.prefix'), prefix),
				kit.field(t('promotionsAdmin.count'), count),
			]),
			...part.nodes,
			make,
			note,
			codes,
		]);
	};

	panel.append(listView, editorView);
	void pages.load(true);
};

/**
 * The loyalty section: look up a shopper's account by Accounts user id, see the balance, lots and history, and add or
 * take points with a note.
 * @param {Kit} kit @param {HTMLElement} panel
 */
export const loyaltyTab = (kit, panel) => {
	const { t, h } = kit;
	const line = kit.status();
	const userId = kit.input('', { maxlength: '128' });
	const account = h('div');

	/** @param {any} data @param {string} [message] */
	const render = (data, message = '') => {
		const note = kit.status();
		const points = kit.input('', { type: 'number', step: '1' });
		const reason = kit.input('', { maxlength: '200' });
		const adjust = kit.button(t('promotionsAdmin.adjust'), async () => {
			const value = wholeOf(points.value);
			if (value === null || Number.isNaN(value) || value === 0) return kit.say(note, t('admin.checkNumbers'), true);
			const answer = await kit.call('POST', `/v1/admin/loyalty/accounts/${encodeURIComponent(data.userId)}/adjust`, {
				points: value,
				note: reason.value,
			});
			if (!answer.ok) {
				kit.fail(note, answer);
				return answer;
			}
			render(answer.data, t('promotionsAdmin.adjusted'));
			return answer;
		});
		kit.put(account, [
			kit.text('p', { class: 'amount' }, t('promotionsAdmin.balance', { points: data.balance, value: kit.money(data.value) })),
			...(data.expiringSoon ?? []).map((/** @type {any} */ soon) =>
				kit.text(
					'p',
					{ class: 'muted' },
					t('promotionsAdmin.expiring', { points: soon.points, when: kit.when(soon.expiresAt) }),
				),
			),
			kit.group(t('promotionsAdmin.adjustTitle'), [
				h('div', { class: 'fields' }, [
					kit.field(t('promotionsAdmin.points'), points),
					kit.field(t('promotionsAdmin.note'), reason),
				]),
				adjust,
				note,
			]),
			kit.group(t('promotionsAdmin.history'), [
				kit.table(
					[t('promotionsAdmin.when'), t('promotionsAdmin.what'), t('promotionsAdmin.points'), t('promotionsAdmin.note')],
					(data.history ?? []).map((/** @type {any} */ entry) => [
						kit.when(entry.at),
						t(`promotionsAdmin.pointsKind.${entry.kind}`),
						String(entry.points),
						entry.note,
					]),
				),
			]),
			kit.group(t('promotionsAdmin.lots'), [
				kit.table(
					[
						t('promotionsAdmin.earnedAt'),
						t('promotionsAdmin.points'),
						t('promotionsAdmin.left'),
						t('promotionsAdmin.expiresAt'),
					],
					(data.lots ?? []).map((/** @type {any} */ lot) => [
						kit.when(lot.earnedAt),
						String(lot.points),
						String(lot.left),
						kit.when(lot.expiresAt),
					]),
				),
			]),
		]);
		kit.say(note, message);
	};

	const form = h('form', { class: 'row inline' }, [
		kit.field(t('promotionsAdmin.userId'), userId),
		kit.text('button', { type: 'submit' }, t('promotionsAdmin.lookUp')),
	]);
	form.addEventListener('submit', async (event) => {
		event.preventDefault();
		const id = entriesOf(userId.value)[0] ?? '';
		account.replaceChildren();
		if (!id) return;
		const answer = await kit.call('GET', `/v1/admin/loyalty/accounts/${encodeURIComponent(id)}`);
		if (!answer.ok) return kit.fail(line, answer);
		kit.say(line, '');
		render(answer.data);
	});
	panel.append(kit.text('p', { class: 'muted' }, t('promotionsAdmin.loyaltyHint')), form, line, account);
};
