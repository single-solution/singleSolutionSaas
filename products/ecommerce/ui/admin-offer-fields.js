/**
 * The editor fields of coupons, deals and bundles in the promotions admin widget (PLAN 0.8.8 Promotions): each kind's
 * fields with their values (null when a number is not valid). Scopes are picked by product, category and brand
 * (search; typed ids when the ticket cannot read the catalog). Amounts are typed as decimals of the shop currency,
 * percentages as numbers, times in the browser's time zone.
 * @module
 */
import { BUNDLE_TYPES, COUPON_TYPES, DEAL_TYPES } from '../core/model.js';
import { fromLocal, localInput, wholeOf } from './admin-kit.js';

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

/**
 * A coupon's fields (with or without its code: batches draw codes).
 * @param {Kit} kit @param {Searches} searches @param {Map<string, string>} names @param {any} coupon @param {boolean} withCode
 * @returns {Part}
 */
export const couponFields = (kit, searches, names, coupon, withCode) => {
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
export const dealFields = (kit, searches, names, deal) => {
	const { t, h } = kit;
	const name = kit.input(deal.name ?? '', { maxlength: '120' });
	const description = kit.area(deal.description ?? '', { maxlength: '500' });
	const type = kit.select(
		DEAL_TYPES.map((key) => ({ value: key, label: t(`promotionsAdmin.dealType.${key}`) })),
		deal.type ?? 'percent',
	);
	const value = kit.input(deal.type === 'fixed' ? kit.decimal(deal.value) : (deal.value ?? ''), { inputmode: 'decimal' });
	const priority = kit.input(String(deal.priority ?? 0), { type: 'number', step: '1' });
	const scope = scopeOf(kit, searches, names, t('promotionsAdmin.scope'), deal.scope);
	const common = commonOf(kit, deal);
	const valueField = kit.field(t('promotionsAdmin.dealValue', { currency: kit.currency }), value);
	// a free-delivery deal has no value
	const showValue = () => {
		valueField.hidden = type.value === 'free_delivery';
	};
	type.addEventListener('change', showValue);
	showValue();
	return {
		nodes: [
			h('div', { class: 'fields' }, [
				kit.field(t('promotionsAdmin.name'), name),
				kit.field(t('promotionsAdmin.type'), type),
				valueField,
				kit.field(t('promotionsAdmin.priority'), priority),
			]),
			kit.field(t('promotionsAdmin.description'), description),
			scope.node,
			...common.nodes,
		],
		values: () => {
			const rest = common.values();
			// a free-delivery deal has no value
			const amount =
				type.value === 'free_delivery' ? 0 : type.value === 'fixed' ? kit.amount(value.value) : Number(value.value);
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
export const bundleFields = (kit, searches, names, bundle) => {
	const { t, h } = kit;
	const name = kit.input(bundle.name ?? '', { maxlength: '120' });
	const type = kit.select(
		BUNDLE_TYPES.map((key) => ({ value: key, label: t(`promotionsAdmin.bundleType.${key}`) })),
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
