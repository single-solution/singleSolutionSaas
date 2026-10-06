/**
 * Variants and stock service: variant create / patch / delete on the item document, stock adjustments, atomic stock
 * reservations (ported oversell guard: every line is checked and taken under compare-and-set; when one line cannot be
 * taken, the lines already taken are given back), and the order consumers (`order.placed@1` takes stock once per
 * order — or converts the order's reservation —, `order.cancelled@1` gives it back, `order.refunded@1` gives refunded
 * lines back). Every quantity change publishes `inventory.changed@1`, every price change `price.changed@1`.
 * A held reservation past its `expiresAt` is expired at read time and released on access: when it is read or replayed,
 * before a new reservation or an order takes stock, before a stock adjustment, and by the dashboard's "Process due
 * changes" (no timer ever runs).
 */
import { EVENT_TYPES, inventoryData, priceChanges, stockChanges } from '../core/events.js';
import { canTake, checkVariantSet, validateStockLines, validateVariant } from '../core/variants.js';
import { cleanText, isId, isObject, issue } from '../core/text.js';
import { entry, fail, invalid, mutateItem, updatedEntry } from './catalog.js';
import { optionPools, skuConflicts } from './items.js';

/** @typedef {import('./catalog.js').Site} Site */
/** @typedef {import('./catalog.js').Deps} Deps */
/** @typedef {import('./catalog.js').Failure} Failure */

const REASON = /^[a-z][a-z0-9_.:-]{0,63}$/;
/** Expired reservations released before stock is taken or adjusted (the rest on the next such request or by the dashboard). */
const EXPIRE_ON_ACCESS = 20;

/**
 * Stock lines grouped per item (insertion order).
 * @template {{ itemId: string }} L
 * @param {readonly L[]} lines
 * @returns {Map<string, L[]>}
 */
export const groupBy = (lines) => {
	/** @type {Map<string, L[]>} */
	const out = new Map();
	for (const line of lines) out.set(line.itemId, [...(out.get(line.itemId) ?? []), line]);
	return out;
};

/**
 * Outbox entries of a variant-list change: price and stock events, and `item.updated@1` with `variants`.
 * @param {Site} site
 * @param {Record<string, any>} current
 * @param {Array<Record<string, any>>} variants the new list
 * @param {{ reason: string, key: string }} options
 */
export const variantEntries = (site, current, variants, { reason, key }) => {
	const version = (current.version ?? 0) + 1;
	return [
		...priceChanges({
			itemId: current.id,
			before: current.variants ?? [],
			after: variants,
			currency: site.settings.currencyOf(current),
			reason,
		}).map((change) => entry(EVENT_TYPES.price, `price:${change.variantId}:${version}`, change.data)),
		...stockChanges({ itemId: current.id, before: current.variants ?? [], after: variants, reason }).map((change) =>
			entry(EVENT_TYPES.inventory, `inventory:${change.variantId}:${key}:${version}`, change.data),
		),
		...updatedEntry(current, ['variants']),
	];
};

/**
 * @param {Deps} deps
 */
export const createVariantsService = (deps) => {
	/**
	 * Rules of the whole set after a change.
	 * @param {Site} site
	 * @param {Record<string, any>} item
	 * @param {Array<Record<string, any>>} variants
	 * @param {import('../core/attributes.js').Attribute[]} attributes
	 */
	const setProblems = async (site, item, variants, attributes) => [
		...checkVariantSet(/** @type {any} */ (variants), {
			optionKeys: item.options ?? [],
			optionPool: item.optionPool ?? {},
			poolsOn: site.settings.variants.option_pools,
			attributeOptions: optionPools(attributes),
			uniqueness: site.settings.variants.uniqueness,
			maxVariants: site.settings.variants.max_variants_per_item,
		}),
		...(await skuConflicts(site, item.id, variants)),
	];

	/**
	 * Add a variant to an item (id derived from the Idempotency-Key).
	 * @param {Site} site
	 * @param {unknown} body `{ itemId, ...variant }`
	 * @param {{ key: string }} options
	 */
	const create = async (site, body, { key }) => {
		if (!isObject(body)) return invalid([issue('', 'object_required')]);
		const { itemId, ...fields } = /** @type {Record<string, any>} */ (body);
		if (!isId(itemId)) return invalid([issue('/itemId', 'required')]);
		const id = `var_${deps.stableId(`${site.websiteId}|variant|${key}`)}`;
		return mutateItem(
			deps,
			site,
			() => site.repos.items.get(itemId),
			async (current, attributes) => {
				if (current.deletedAt) return fail('not_found', 'No such item.');
				if ((current.variants ?? []).some((/** @type {any} */ v) => v.id === id)) return null;
				const result = validateVariant(fields);
				if (!result.value) return invalid(result.problems);
				const variant = {
					...result.value,
					id,
					position: result.value.position || (current.variants ?? []).length,
					restockedAt: null,
				};
				const variants = [...(current.variants ?? []), variant];
				const problems = await setProblems(site, current, variants, attributes);
				if (problems.length > 0)
					return invalid(
						problems.map((p) =>
							p.path.startsWith(`/variants/${variants.length - 1}`)
								? { ...p, path: p.path.replace(/^\/variants\/\d+/, '') }
								: p,
						),
					);
				return {
					next: { ...current, variants },
					entries: variantEntries(site, current, variants, { reason: 'created', key }),
					result: id,
				};
			},
		);
	};

	/**
	 * Patch a variant (JSON Merge Patch).
	 * @param {Site} site
	 * @param {string} variantId
	 * @param {unknown} body
	 * @param {{ key: string }} options
	 */
	const update = async (site, variantId, body, { key }) => {
		if (!isObject(body)) return invalid([issue('', 'object_required')]);
		return mutateItem(
			deps,
			site,
			() => site.repos.items.byVariant(variantId),
			async (current, attributes) => {
				const index = (current.variants ?? []).findIndex((/** @type {any} */ v) => v.id === variantId);
				const before = current.variants[index];
				const result = validateVariant(body, { current: before });
				if (!result.value) return invalid(result.problems);
				const restocked = result.value.quantity > before.quantity ? new Date(deps.now()).toISOString() : before.restockedAt;
				const variants = current.variants.map((/** @type {any} */ v, /** @type {number} */ i) =>
					i === index ? { ...before, ...result.value, restockedAt: restocked } : v,
				);
				if (JSON.stringify(variants) === JSON.stringify(current.variants)) return null;
				const problems = await setProblems(site, current, variants, attributes);
				if (problems.length > 0) return invalid(problems);
				return {
					next: { ...current, variants },
					entries: variantEntries(site, current, variants, { reason: 'updated', key }),
				};
			},
		);
	};

	/**
	 * Remove a variant from its item.
	 * @param {Site} site
	 * @param {string} variantId
	 */
	const remove = async (site, variantId) =>
		mutateItem(
			deps,
			site,
			() => site.repos.items.byVariant(variantId),
			(current) => {
				const variants = (current.variants ?? []).filter((/** @type {any} */ v) => v.id !== variantId);
				const media = (current.media ?? []).map((/** @type {any} */ m) => ({
					...m,
					variantIds: m.variantIds.filter((/** @type {string} */ id) => id !== variantId),
				}));
				return { next: { ...current, variants, media }, entries: updatedEntry(current, ['variants']) };
			},
		);

	/**
	 * Apply stock deltas to the variants of one item (compare-and-set). With `guard`, every line must be takeable.
	 * @param {Site} site
	 * @param {string} itemId
	 * @param {Array<{ variantId: string, delta: number }>} lines
	 * @param {{ guard: boolean, reason: string, key: string }} options
	 */
	const applyStock = (site, itemId, lines, { guard, reason, key }) =>
		mutateItem(
			deps,
			site,
			() => site.repos.items.get(itemId),
			(current) => {
				const variants = (current.variants ?? []).map((/** @type {any} */ variant) => {
					const delta = lines.filter((l) => l.variantId === variant.id).reduce((sum, l) => sum + l.delta, 0);
					return delta === 0
						? variant
						: {
								...variant,
								quantity: variant.quantity + delta,
								...(delta > 0 ? { restockedAt: new Date(deps.now()).toISOString() } : {}),
							};
				});
				if (guard)
					for (const line of lines) {
						const variant = (current.variants ?? []).find((/** @type {any} */ v) => v.id === line.variantId);
						if (!variant || (line.delta < 0 && !canTake(variant, -line.delta, site.settings.stock)))
							return fail('insufficient_stock', 'Not enough stock.', [
								issue(`/lines/${line.variantId}`, 'insufficient_stock'),
							]);
					}
				const version = (current.version ?? 0) + 1;
				const entries = stockChanges({ itemId, before: current.variants ?? [], after: variants, reason }).map((change) =>
					entry(EVENT_TYPES.inventory, `inventory:${change.variantId}:${key}`, change.data),
				);
				if (entries.length === 0) return null;
				return {
					next: { ...current, variants },
					entries: [
						...entries,
						...updatedEntry(current, ['variants']).map((e) => ({ ...e, key: `item.updated:${itemId}:${version}` })),
					],
				};
			},
		);

	/**
	 * Adjust or set a variant's stock (`POST /v1/variants/{id}/stock`).
	 * @param {Site} site
	 * @param {string} variantId
	 * @param {unknown} body `{ delta } | { quantity }`, optional `reason`, optional `expectedQuantity`
	 * @param {{ key: string }} options
	 */
	const adjust = async (site, variantId, body, { key }) => {
		if (!isObject(body)) return invalid([issue('', 'object_required')]);
		const input = /** @type {Record<string, any>} */ (body);
		const hasDelta = Object.hasOwn(input, 'delta');
		const hasQuantity = Object.hasOwn(input, 'quantity');
		if (hasDelta === hasQuantity) return invalid([issue('/delta', 'delta_or_quantity')]);
		const value = hasDelta ? input.delta : input.quantity;
		if (!Number.isSafeInteger(value) || Math.abs(value) > 1_000_000_000)
			return invalid([issue(hasDelta ? '/delta' : '/quantity', 'quantity_invalid')]);
		const reason = input.reason === undefined ? 'adjustment' : input.reason;
		if (typeof reason !== 'string' || !REASON.test(reason)) return invalid([issue('/reason', 'reason_invalid')]);
		await expire(site, EXPIRE_ON_ACCESS);
		const item = await site.repos.items.byVariant(variantId);
		if (!item) return fail('not_found', 'No such variant.');
		const variant = item.variants.find((/** @type {any} */ v) => v.id === variantId);
		if (input.expectedQuantity !== undefined && input.expectedQuantity !== variant.quantity)
			return fail('version_mismatch', `The stock is ${variant.quantity} now.`);
		const delta = hasDelta ? value : value - variant.quantity;
		const result = await applyStock(site, item.id, [{ variantId, delta }], { guard: false, reason, key: `adjust:${key}` });
		if (!result.ok) return result;
		return {
			ok: /** @type {const} */ (true),
			item: result.item,
			variant: result.item.variants.find((/** @type {any} */ v) => v.id === variantId),
		};
	};

	/**
	 * Resolve stock lines to `{ itemId, variantId }` (by variant id or SKU).
	 * @param {Site} site
	 * @param {Array<{ variantId?: string | null, sku?: string | null, itemId?: string | null, quantity: number }>} lines
	 */
	const resolveLines = async (site, lines) => {
		/** @type {Array<{ itemId: string, variantId: string, quantity: number }>} */
		const out = [];
		/** @type {number[]} */
		const missing = [];
		for (const [index, line] of lines.entries()) {
			const item = line.variantId
				? await site.repos.items.byVariant(line.variantId)
				: line.sku
					? await site.repos.items.bySku(line.sku)
					: line.itemId
						? await site.repos.items.get(line.itemId)
						: null;
			const variant = item?.variants?.find((/** @type {any} */ v) =>
				line.variantId ? v.id === line.variantId : line.sku ? v.sku === line.sku : (item?.variants?.length ?? 0) === 1,
			);
			if (!item || !variant || item.deletedAt) missing.push(index);
			else out.push({ itemId: item.id, variantId: variant.id, quantity: line.quantity });
		}
		return { lines: out, missing };
	};

	/**
	 * Take stock for lines grouped per item; on a failure give back what was taken.
	 * @param {Site} site
	 * @param {Array<{ itemId: string, variantId: string, quantity: number }>} lines
	 * @param {{ guard: boolean, reason: string, key: string }} options
	 * @returns {Promise<{ ok: true } | Failure>}
	 */
	const take = async (site, lines, { guard, reason, key }) => {
		const byItem = groupBy(lines);
		/** @type {string[]} */
		const taken = [];
		for (const [itemId, group] of byItem) {
			const result = await applyStock(
				site,
				itemId,
				group.map((l) => ({ variantId: l.variantId, delta: -l.quantity })),
				{ guard, reason, key: `${key}:take` },
			);
			if (!result.ok) {
				for (const done of taken)
					await applyStock(
						site,
						done,
						(byItem.get(done) ?? []).map((l) => ({ variantId: l.variantId, delta: l.quantity })),
						{
							guard: false,
							reason: 'rollback',
							key: `${key}:rollback`,
						},
					);
				return result;
			}
			taken.push(itemId);
		}
		return { ok: /** @type {const} */ (true) };
	};

	/**
	 * Give stock back.
	 * @param {Site} site
	 * @param {Array<{ itemId: string, variantId: string, quantity: number }>} lines
	 * @param {{ reason: string, key: string }} options
	 */
	const giveBack = async (site, lines, { reason, key }) => {
		for (const [itemId, group] of groupBy(lines))
			await applyStock(
				site,
				itemId,
				group.map((l) => ({ variantId: l.variantId, delta: l.quantity })),
				{ guard: false, reason, key },
			);
	};

	/** @param {Record<string, any>} move */
	const moveView = (move) => ({
		id: move.id,
		kind: move.kind,
		status: move.status,
		orderId: move.orderId ?? null,
		lines: move.lines,
		expiresAt: move.expiresAt instanceof Date ? move.expiresAt.toISOString() : (move.expiresAt ?? null),
		createdAt: move.createdAt instanceof Date ? move.createdAt.toISOString() : (move.createdAt ?? null),
	});

	/**
	 * Reserve stock atomically for a checkout (`POST /v1/stock-reservations`).
	 * @param {Site} site
	 * @param {unknown} body `{ lines: [{ variantId | sku, quantity }], orderId? }`
	 * @param {{ key: string }} options
	 */
	const reserve = async (site, body, { key }) => {
		if (!isObject(body)) return invalid([issue('', 'object_required')]);
		const input = /** @type {Record<string, any>} */ (body);
		const checked = validateStockLines(input.lines, site.settings.variants.max_lines_per_reservation);
		const orderId = input.orderId === undefined ? null : input.orderId;
		if (orderId !== null && !isId(orderId)) checked.problems.push(issue('/orderId', 'id_invalid'));
		if (checked.problems.length > 0) return invalid(checked.problems);
		const id = `res_${deps.stableId(`${site.websiteId}|reservation|${key}`)}`;
		const existing = await site.repos.moves.get(id);
		if (existing) return { ok: /** @type {const} */ (true), reservation: await current(site, existing), created: false };
		if (orderId && (await site.repos.moves.byOrder(orderId))) return fail('conflict', 'This order already has stock taken.');
		const resolved = await resolveLines(site, checked.lines);
		if (resolved.missing.length > 0)
			return invalid(resolved.missing.map((index) => issue(`/lines/${index}`, 'variant_unknown')));
		// stock held by reservations that already expired is given back first (release on access)
		await expire(site, EXPIRE_ON_ACCESS);
		const taken = await take(site, resolved.lines, { guard: true, reason: 'reservation', key: id });
		if (!taken.ok) return taken;
		const move = {
			id,
			kind: 'reservation',
			status: 'held',
			...(orderId ? { orderId } : {}),
			lines: resolved.lines,
			expiresAt: new Date(deps.now() + site.settings.variants.reservation_ttl_minutes * 60_000),
		};
		if (!(await site.repos.moves.insert(move))) {
			await giveBack(site, resolved.lines, { reason: 'rollback', key: `${id}:dup` });
			return fail('conflict', 'This order already has stock taken.');
		}
		return {
			ok: /** @type {const} */ (true),
			reservation: moveView({ ...move, createdAt: new Date(deps.now()) }),
			created: true,
		};
	};

	/**
	 * Release a held reservation (`DELETE /v1/stock-reservations/{id}`) or expire it.
	 * @param {Site} site
	 * @param {string} id
	 * @param {{ status?: 'released' | 'expired' }} [options]
	 */
	const release = async (site, id, { status = 'released' } = {}) => {
		const move = await site.repos.moves.get(id);
		if (!move || move.kind !== 'reservation') return fail('not_found', 'No such reservation.');
		if (move.status !== 'held') return { ok: /** @type {const} */ (true), reservation: moveView(move) };
		return { ok: /** @type {const} */ (true), reservation: await settle(site, move, status) };
	};

	/**
	 * End a held reservation (compare-and-set) and give its stock back.
	 * @param {Site} site
	 * @param {Record<string, any>} move
	 * @param {'released' | 'expired'} status
	 */
	const settle = async (site, move, status) => {
		if (await site.repos.moves.transition(move.id, 'held', { status }))
			await giveBack(site, move.lines, {
				reason: status === 'expired' ? 'reservation_expired' : 'reservation_released',
				key: `${move.id}:release`,
			});
		return moveView({ ...move, status });
	};

	/**
	 * The view of a stored reservation as of now: a held reservation past `expiresAt` is expired, and is released on
	 * access (its stock given back).
	 * @param {Site} site
	 * @param {Record<string, any>} move
	 */
	const current = async (site, move) => {
		if (move.status !== 'held' || new Date(move.expiresAt).getTime() > deps.now()) return moveView(move);
		return settle(site, move, 'expired');
	};

	/** @param {Site} site @param {string} id */
	const getReservation = async (site, id) => {
		const move = await site.repos.moves.get(id);
		return move && move.kind === 'reservation' ? current(site, move) : null;
	};

	/**
	 * Order lines of an order event as stock lines.
	 * @param {unknown} lines
	 */
	const orderLines = (lines) =>
		(Array.isArray(lines) ? lines : [])
			.filter((l) => isObject(l) && Number.isSafeInteger(l.quantity) && l.quantity > 0)
			.slice(0, 500)
			.map((l) => ({
				variantId: isId(l.variantId) ? l.variantId : null,
				sku: cleanText(l.sku, 100),
				itemId: isId(l.itemId) ? l.itemId : null,
				quantity: l.quantity,
			}));

	/**
	 * `order.placed@1`: take the order's stock once (or convert its reservation).
	 * @param {Site} site
	 * @param {Record<string, any>} data
	 */
	const onOrderPlaced = async (site, data) => {
		if (!site.settings.variants.decrement_on_order || !isId(data.orderId)) return { applied: false };
		const existing = await site.repos.moves.byOrder(data.orderId);
		if (existing) {
			if (existing.kind === 'reservation' && existing.status === 'held')
				await site.repos.moves.transition(existing.id, 'held', { status: 'converted' });
			return { applied: false };
		}
		const resolved = await resolveLines(site, /** @type {any} */ (orderLines(data.lines)));
		if (resolved.lines.length === 0) return { applied: false };
		await expire(site, EXPIRE_ON_ACCESS);
		const id = `ord_${deps.stableId(`${site.websiteId}|order|${data.orderId}`)}`;
		if (
			!(await site.repos.moves.insert({ id, kind: 'order', status: 'applied', orderId: data.orderId, lines: resolved.lines }))
		)
			return { applied: false };
		await take(site, resolved.lines, { guard: false, reason: 'order', key: id });
		return { applied: true };
	};

	/**
	 * `order.cancelled@1`: give the order's stock back.
	 * @param {Site} site
	 * @param {Record<string, any>} data
	 */
	const onOrderCancelled = async (site, data) => {
		if (!site.settings.variants.restock_on_cancel || !isId(data.orderId)) return { applied: false };
		const move = await site.repos.moves.byOrder(data.orderId);
		if (!move) return { applied: false };
		for (const from of ['held', 'converted', 'applied'])
			if (move.status === from && (await site.repos.moves.transition(move.id, from, { status: 'released' }))) {
				await giveBack(site, move.lines, { reason: 'order_cancelled', key: `${move.id}:cancel` });
				return { applied: true };
			}
		return { applied: false };
	};

	/**
	 * `order.refunded@1`: give refunded lines back (once per refund event).
	 * @param {Site} site
	 * @param {Record<string, any>} data
	 * @param {string} eventId
	 */
	const onOrderRefunded = async (site, data, eventId) => {
		if (!site.settings.variants.restock_on_refund || !isId(data.orderId)) return { applied: false };
		const move = await site.repos.moves.byOrder(data.orderId);
		if (!move || move.status === 'released') return { applied: false };
		const resolved = await resolveLines(site, /** @type {any} */ (orderLines(data.lines)));
		if (resolved.lines.length === 0 || !(await site.repos.moves.addRefund(move.id, eventId))) return { applied: false };
		await giveBack(site, resolved.lines, { reason: 'order_refunded', key: `${move.id}:refund:${eventId}` });
		return { applied: true };
	};

	/**
	 * Release expired reservations of the website, oldest first (on access and from the dashboard).
	 * @param {Site} site
	 * @param {number} limit
	 */
	const expire = async (site, limit) => {
		const due = await site.repos.moves.expired(new Date(deps.now()), limit);
		for (const move of due) await release(site, move.id, { status: 'expired' });
		return due.length;
	};

	return Object.freeze({
		create,
		update,
		remove,
		adjust,
		reserve,
		release,
		getReservation,
		onOrderPlaced,
		onOrderCancelled,
		onOrderRefunded,
		expire,
		inventoryData,
	});
};

/** @typedef {ReturnType<typeof createVariantsService>} VariantsService */
