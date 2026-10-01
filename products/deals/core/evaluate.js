/**
 * The deal engine (pure): evaluates a generic cart — or one item for display — against the website's deals, with the
 * stacking policy, usage and stock limits, and price locks. Ported and generalised from ibrahimMobiles
 * `offerEvaluator.ts` (line offers first, then a cart-wide offer when stacking allows): here item deals, bundles and
 * cart deals all compete under the same class policy and one of two strategies.
 *
 * Order of computation for a chosen selection:
 *   1. item level — per line, its item/flash deals in priority order (stacked deals compound on the remaining price),
 *      or the line's honoured price lock;
 *   2. bundles — on the unit prices left after item deals, each unit used once;
 *   3. cart deals — thresholds measured after item and bundle discounts (or before any, `threshold_basis`), discounts
 *      spread over the eligible lines (largest remainder), free shipping.
 *
 * Strategies: `best_for_customer` searches the compatible combinations (bounded by `stacking.search_limit` and
 * `max_deals_per_line`) for the largest saving; `priority` admits deals greedily by priority. Shared caps (deal stock
 * left, units per order) are allocated in cart line order. Every amount is integer minor units.
 * @module
 */
import { allocate, percentOf, roundAmount } from './money.js';
import { formInstances, instanceDiscount } from './bundles.js';
import { conditionMatches } from './rules.js';
import { scheduleState } from './schedule.js';
import { itemContext, lineInScope } from './scope.js';
import { classSetsCombine } from './stacking.js';

/** @typedef {import('./deals.js').Deal} Deal */
/** @typedef {import('./deals.js').Kind} Kind */
/** @typedef {import('./scope.js').Line} Line */
/** @typedef {import('./money.js').Rounding} Rounding */
/**
 * @typedef {object} EngineSettings
 * @property {string} timeZone website zone
 * @property {Rounding} rounding
 * @property {Record<Kind, boolean>} kinds which deal kinds are switched on
 * @property {import('./stacking.js').Policy} policy
 * @property {'best_for_customer' | 'priority'} strategy
 * @property {number} maxDealsPerLine
 * @property {number} searchLimit
 * @property {'after_item_discounts' | 'before_discounts'} thresholdBasis
 * @property {number} maxHints
 * @property {'exclude' | 'allow'} anonymousLimited per-customer-limited deals for unidentified shoppers
 * @property {boolean} preferLive a better live price beats a price lock
 * @property {number} maxBundleInstances
 */
/** @typedef {{ id: string | null, segments: string[], orders: number | null, tags: string[] }} Customer */
/** @typedef {Record<string, { uses: number, units: number }>} Usage */
/**
 * @typedef {object} LockCandidate an honoured price lock on one line (verified by the caller)
 * @property {true} lock
 * @property {string} id `lock:<lineId>`
 * @property {string} lineId
 * @property {number} unitPrice locked unit price
 * @property {number} maxUnits units the lock covers
 * @property {string[]} dealIds deals the lock froze
 * @property {string[]} classes their stacking classes
 * @property {number} priority always first
 */
/** @typedef {{ dealId: string, amount: number, units: number, locked?: boolean }} Entry */

/**
 * @typedef {object} EvaluateInput
 * @property {{ currency: string, lines: Line[], customer: Customer, paymentMethod: string | null,
 *   deliveryMethod: string | null, shippingAmount: number | null }} cart
 * @property {Deal[]} deals
 * @property {Usage} usage committed uses and units per deal
 * @property {Record<string, number>} customerUsage committed uses of this customer per deal
 * @property {Map<string, LockCandidate>} [locks] honoured locks by line id
 * @property {EngineSettings} settings
 * @property {number} now
 */

const KIND_ORDER = Object.freeze({ lock: 0, flash: 1, item: 2, bundle: 3, cart: 4 });

/**
 * Why a deal cannot apply at all right now (status, kind switch, schedule, limits, customer), else null.
 * @param {Deal} deal
 * @param {{ now: number, settings: EngineSettings, usage: Usage, customerUsage: Record<string, number>, customer: Customer }} ctx
 * @returns {string | null}
 */
export const staticIneligibility = (deal, { now, settings, usage, customerUsage, customer }) => {
	if (deal.status !== 'active') return 'inactive';
	if (!settings.kinds[deal.kind]) return 'kind_disabled';
	const state = scheduleState(deal.schedule, now, settings.timeZone);
	if (!state.active) return state.phase;
	const used = usage[deal.id] ?? { uses: 0, units: 0 };
	if (deal.limits.totalUses !== null && used.uses >= deal.limits.totalUses) return 'exhausted';
	if (deal.limits.stockUnits !== null && used.units >= deal.limits.stockUnits) return 'sold_out';
	if (deal.limits.perCustomer !== null) {
		if (!customer.id) {
			if (settings.anonymousLimited === 'exclude') return 'customer_required';
		} else if ((customerUsage[deal.id] ?? 0) >= deal.limits.perCustomer) return 'customer_limit';
	}
	const c = deal.conditions;
	if (c.newCustomersOnly === true && !(customer.orders === 0)) return 'new_customers_only';
	if (
		Array.isArray(c.customerSegments) &&
		c.customerSegments.length > 0 &&
		!c.customerSegments.some((s) => customer.segments.includes(s))
	)
		return 'segment';
	return null;
};

/**
 * True when a deal has conditions that need a real cart (shown as "conditional" on product pages).
 * @param {Deal} deal
 */
export const hasCartConditions = (deal) => {
	const c = deal.conditions;
	return Boolean(
		(Array.isArray(c.paymentMethods) && c.paymentMethods.length > 0) ||
		(Array.isArray(c.deliveryMethods) && c.deliveryMethods.length > 0) ||
		Number.isSafeInteger(c.minSubtotal) ||
		(typeof c.when === 'string' && c.when.trim()) ||
		(Number.isSafeInteger(c.minQuantity) && c.minQuantity > 1),
	);
};

/**
 * The rules@1 `cart` and `customer` views.
 * @param {EvaluateInput['cart']} cart
 */
const ruleContext = (cart) => ({
	cart: {
		currency: cart.currency,
		subtotal: cart.lines.reduce((sum, l) => sum + l.unitAmount * l.quantity, 0),
		quantity: cart.lines.reduce((sum, l) => sum + l.quantity, 0),
		lines: cart.lines.map(itemContext),
		paymentMethod: cart.paymentMethod,
		deliveryMethod: cart.deliveryMethod,
		shippingAmount: cart.shippingAmount,
	},
	customer: { ...cart.customer },
});

/**
 * Why a deal's cart-level conditions fail (payment, delivery, `when`; minimum subtotal for item deals), else null.
 * Cart deals measure their thresholds over their own eligible lines during pricing.
 * @param {Deal} deal
 * @param {ReturnType<typeof ruleContext>} context
 * @param {{ now: number, timeZone: string }} options
 */
const cartIneligibility = (deal, context, options) => {
	const c = deal.conditions;
	if (
		Array.isArray(c.paymentMethods) &&
		c.paymentMethods.length > 0 &&
		!c.paymentMethods.includes(context.cart.paymentMethod ?? '')
	)
		return 'payment_method';
	if (
		Array.isArray(c.deliveryMethods) &&
		c.deliveryMethods.length > 0 &&
		!c.deliveryMethods.includes(context.cart.deliveryMethod ?? '')
	)
		return 'delivery_method';
	if (deal.kind !== 'cart' && Number.isSafeInteger(c.minSubtotal) && context.cart.subtotal < c.minSubtotal)
		return 'min_subtotal';
	if (deal.kind === 'bundle' && Number.isSafeInteger(c.minQuantity) && context.cart.quantity < c.minQuantity)
		return 'min_quantity';
	if (typeof c.when === 'string' && c.when.trim() && !conditionMatches(c.when, context, options)) return 'condition';
	return null;
};

/**
 * @param {Deal | LockCandidate} x
 * @returns {string[]}
 */
const classesOf = (x) => ('lock' in x ? x.classes : [x.class]);

/**
 * Deterministic order: priority desc, then kind, then id.
 * @param {Deal | LockCandidate} a
 * @param {Deal | LockCandidate} b
 */
const byPriority = (a, b) => {
	const pa = a.priority;
	const pb = b.priority;
	if (pa !== pb) return pb - pa;
	const ka = KIND_ORDER['lock' in a ? 'lock' : a.kind];
	const kb = KIND_ORDER['lock' in b ? 'lock' : b.kind];
	return ka - kb || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
};

/**
 * Discount of an item-level deal on `n` units of a line whose current total is `amount`.
 * @param {Deal} deal
 * @param {{ amount: number, quantity: number, n: number, rounding: Rounding }} input
 * @returns {{ amount: number, units: number }}
 */
export const itemDealDiscount = (deal, { amount, quantity, n, rounding }) => {
	if (n <= 0 || amount <= 0) return { amount: 0, units: 0 };
	const unit = amount / quantity;
	const a = deal.action;
	/** @type {{ amount: number, units: number }} */
	let out;
	switch (a.type) {
		case 'percent':
			out = { amount: roundAmount(percentOf(unit * n, a.percent), rounding), units: n };
			break;
		case 'amount_off':
			out = { amount: Math.min(a.amount * n, Math.floor(unit * n)), units: n };
			break;
		case 'fixed_price':
			out = { amount: roundAmount(Math.max(0, unit * n - a.amount * n), rounding), units: n };
			break;
		case 'buy_x_get_y': {
			const groups = Math.floor(n / (a.buy + a.get));
			const free = groups * a.get;
			out = { amount: roundAmount(percentOf(unit * free, a.percent ?? 100), rounding), units: groups * (a.buy + a.get) };
			break;
		}
		default:
			out = { amount: 0, units: 0 };
	}
	return { amount: Math.min(out.amount, Math.floor(amount)), units: out.amount > 0 ? out.units : 0 };
};

/**
 * Evaluate a cart.
 * @param {EvaluateInput} input
 */
export const evaluateCart = ({ cart, deals, usage, customerUsage, locks = new Map(), settings, now }) => {
	const { policy, rounding } = settings;
	const timeZone = settings.timeZone;
	const context = ruleContext(cart);
	const scopeOptions = { context, now, timeZone };
	const lines = cart.lines;
	const lineById = new Map(lines.map((l) => [l.lineId, l]));
	const dealById = new Map(deals.map((d) => [d.id, d]));
	const kindById = new Map(deals.map((d) => [d.id, d.kind]));

	// ── candidates ─────────────────────────────────────────────────────────────────────────────────────
	/** @type {Record<string, string>} */
	const ineligible = {};
	const live = deals.filter((deal) => {
		const reason =
			staticIneligibility(deal, { now, settings, usage, customerUsage, customer: cart.customer }) ??
			cartIneligibility(deal, context, { now, timeZone });
		if (reason) ineligible[deal.id] = reason;
		return reason === null;
	});
	/** @type {Map<string, Deal[]>} item/flash deals per line */
	const itemCands = new Map(lines.map((l) => [l.lineId, /** @type {Deal[]} */ ([])]));
	/** @type {Map<string, Set<string>>} lines each deal touches */
	const touch = new Map();
	for (const deal of live) {
		if (deal.kind === 'item' || deal.kind === 'flash') {
			const minQuantity = Number.isSafeInteger(deal.conditions.minQuantity) ? deal.conditions.minQuantity : 1;
			const matched = lines.filter((l) => l.quantity >= minQuantity && lineInScope(l, deal.scope, scopeOptions));
			if (matched.length === 0) continue;
			touch.set(deal.id, new Set(matched.map((l) => l.lineId)));
			for (const l of matched) itemCands.get(l.lineId)?.push(deal);
		} else if (deal.kind === 'bundle') {
			const scopes =
				deal.bundle?.type === 'mix_and_match'
					? [deal.bundle.scope]
					: (deal.bundle?.components ?? []).map((/** @type {any} */ c) => c.scope);
			const matched = lines.filter((l) => scopes.some((/** @type {any} */ s) => lineInScope(l, s, scopeOptions)));
			if (matched.length > 0) touch.set(deal.id, new Set(matched.map((l) => l.lineId)));
		} else {
			const matched = lines.filter((l) => lineInScope(l, deal.scope, scopeOptions));
			if (matched.length > 0) touch.set(deal.id, new Set(matched.map((l) => l.lineId)));
		}
	}
	const groupCands = live.filter((d) => (d.kind === 'bundle' || d.kind === 'cart') && touch.has(d.id)).sort(byPriority);

	/** @param {Deal | LockCandidate} x @param {Deal | LockCandidate} y */
	const compatible = (x, y) => classSetsCombine(policy, classesOf(x), classesOf(y));
	/** @param {Deal} a @param {Deal} b */
	const overlap = (a, b) => {
		const ta = touch.get(a.id);
		const tb = touch.get(b.id);
		if (!ta || !tb) return false;
		for (const id of ta) if (tb.has(id)) return true;
		return false;
	};

	// ── pricing of one selection ─────────────────────────────────────────────────────────────────────────
	/**
	 * @param {{ perLine: Map<string, Array<Deal | LockCandidate>>, groups: Deal[] }} selection
	 */
	const price = ({ perLine, groups }) => {
		const state = lines.map((line) => ({
			line,
			amount: line.unitAmount * line.quantity,
			afterItems: 0,
			bundleUnits: 0,
			/** @type {Entry[]} */
			entries: [],
		}));
		const byLine = new Map(state.map((s) => [s.line.lineId, s]));
		/** @type {Map<string, number>} */
		const capLeft = new Map();
		/** @param {Deal} deal */
		const cap = (deal) => {
			if (!capLeft.has(deal.id)) {
				const stock = deal.limits.stockUnits === null ? Infinity : deal.limits.stockUnits - (usage[deal.id]?.units ?? 0);
				const perOrder = deal.limits.maxUnitsPerOrder ?? Infinity;
				capLeft.set(deal.id, Math.max(0, Math.min(stock, perOrder)));
			}
			return /** @type {number} */ (capLeft.get(deal.id));
		};
		/** @param {Deal} deal @param {number} units */
		const consume = (deal, units) => capLeft.set(deal.id, cap(deal) - units);
		/** @type {Map<string, { deal: Deal, amount: number, units: number, freeShipping: boolean }>} */
		const applied = new Map();
		/** @param {Deal} deal @param {number} amount @param {number} units @param {boolean} [freeShipping] */
		const record = (deal, amount, units, freeShipping = false) => {
			const prev = applied.get(deal.id);
			applied.set(deal.id, {
				deal,
				amount: (prev?.amount ?? 0) + amount,
				units: (prev?.units ?? 0) + units,
				freeShipping: (prev?.freeShipping ?? false) || freeShipping,
			});
		};
		/** @type {Set<string>} */
		const unmet = new Set();

		// 1. item level
		for (const s of state) {
			const chosen = [...(perLine.get(s.line.lineId) ?? [])].sort(byPriority);
			for (const d of chosen) {
				if ('lock' in d) {
					const n = Math.min(s.line.quantity, d.maxUnits);
					const amount = Math.min(Math.floor(s.amount), n * Math.max(0, s.line.unitAmount - d.unitPrice));
					if (amount <= 0) continue;
					s.amount -= amount;
					s.entries.push({ dealId: /** @type {string} */ (d.dealIds[0]), amount, units: n, locked: true });
					const deal = dealById.get(/** @type {string} */ (d.dealIds[0]));
					if (deal) record(deal, amount, n);
					continue;
				}
				const n = Math.min(s.line.quantity, cap(d));
				const result = itemDealDiscount(d, { amount: s.amount, quantity: s.line.quantity, n, rounding });
				if (result.amount <= 0) continue;
				consume(d, result.units);
				s.amount -= result.amount;
				s.entries.push({ dealId: d.id, amount: result.amount, units: result.units });
				record(d, result.amount, result.units);
			}
			s.afterItems = s.amount;
		}

		// 2. bundles
		for (const deal of groups.filter((g) => g.kind === 'bundle')) {
			const touched = touch.get(deal.id) ?? new Set();
			/** @param {any} scope */
			const poolsFor = (scope) =>
				state
					.filter((s) => touched.has(s.line.lineId) && lineInScope(s.line, scope, scopeOptions))
					.map((s) => ({
						lineId: s.line.lineId,
						unitPrice: s.amount / s.line.quantity,
						available: s.line.quantity - s.bundleUnits,
					}));
			const instances = formInstances(
				/** @type {any} */ (deal.bundle),
				poolsFor,
				Math.min(settings.maxBundleInstances, cap(deal)),
			);
			let total = 0;
			let units = 0;
			for (const instance of instances) {
				const discount = instanceDiscount(deal.action, instance.value, rounding);
				if (discount <= 0) continue;
				const shares = allocate(
					discount,
					instance.takes.map((t) => t.value),
				);
				instance.takes.forEach((t, index) => {
					const s = /** @type {(typeof state)[number]} */ (byLine.get(t.lineId));
					const share = Math.min(/** @type {number} */ (shares[index]), Math.floor(s.amount));
					s.amount -= share;
					s.bundleUnits += t.units;
					const existing = s.entries.find((e) => e.dealId === deal.id);
					if (existing) {
						existing.amount += share;
						existing.units += t.units;
					} else s.entries.push({ dealId: deal.id, amount: share, units: t.units });
					total += share;
					units += t.units;
				});
				consume(deal, 1);
			}
			if (total > 0) record(deal, total, units);
			else unmet.add(deal.id);
		}

		// 3. cart deals
		/** @type {Array<{ dealId: string, reason: string }>} */
		const thresholds = [];
		for (const deal of groups.filter((g) => g.kind === 'cart')) {
			const touched = touch.get(deal.id) ?? new Set();
			const eligible = state.filter((s) => touched.has(s.line.lineId));
			const measure = thresholdMeasure(eligible);
			const quantity = eligible.reduce((sum, s) => sum + s.line.quantity, 0);
			const c = deal.conditions;
			if (
				(Number.isSafeInteger(c.minSubtotal) && measure < c.minSubtotal) ||
				(Number.isSafeInteger(c.minQuantity) && quantity < c.minQuantity)
			) {
				unmet.add(deal.id);
				thresholds.push({ dealId: deal.id, reason: 'threshold' });
				continue;
			}
			const reward = cartReward(deal, { measure, quantity });
			if (!reward) {
				unmet.add(deal.id);
				continue;
			}
			const base = eligible.reduce((sum, s) => sum + s.amount, 0);
			let discount = 0;
			if (reward.percent !== undefined) discount = roundAmount(percentOf(base, reward.percent), rounding);
			else if (reward.amount !== undefined) discount = Math.min(reward.amount, base);
			if (Number.isSafeInteger(deal.action.maxDiscount)) discount = Math.min(discount, deal.action.maxDiscount);
			discount = Math.min(discount, base);
			if (discount <= 0 && !reward.freeShipping) {
				unmet.add(deal.id);
				continue;
			}
			if (discount > 0) {
				const shares = allocate(
					discount,
					eligible.map((s) => s.amount),
				);
				for (const [index, s] of eligible.entries()) {
					const share = /** @type {number} */ (shares[index]);
					if (share <= 0) continue;
					s.amount -= share;
					s.entries.push({ dealId: deal.id, amount: share, units: 0 });
				}
			}
			record(deal, discount, 0, reward.freeShipping === true);
		}

		const discountTotal = state.reduce((sum, s) => sum + s.entries.reduce((acc, e) => acc + e.amount, 0), 0);
		const freeShipping = [...applied.values()].some((a) => a.freeShipping);
		const shippingDiscount = freeShipping && cart.shippingAmount !== null ? cart.shippingAmount : 0;
		return { state, applied, unmet, discountTotal, freeShipping, shippingDiscount, score: discountTotal + shippingDiscount };
	};

	/**
	 * What a cart deal's minimum is measured against: the eligible lines before any discount, or after item and bundle
	 * discounts (`threshold_basis`) — never after other cart deals, so the order of cart deals does not matter.
	 * @param {Array<{ line: Line, afterItems: number, entries: Entry[] }>} eligible
	 */
	function thresholdMeasure(eligible) {
		if (settings.thresholdBasis === 'before_discounts')
			return eligible.reduce((sum, s) => sum + s.line.unitAmount * s.line.quantity, 0);
		return eligible.reduce(
			(sum, s) =>
				sum +
				s.afterItems -
				s.entries.filter((e) => kindById.get(e.dealId) === 'bundle').reduce((acc, e) => acc + e.amount, 0),
			0,
		);
	}

	// ── local (one line) search ─────────────────────────────────────────────────────────────────────────
	/** @type {Map<string, { deals: Deal[], amount: number }>} */
	const memo = new Map();
	/**
	 * Best compatible subset of item deals for one line, priced alone.
	 * @param {Line} line
	 * @param {Deal[]} candidates
	 */
	const bestLocal = (line, candidates) => {
		const sorted = [...candidates].sort(byPriority).slice(0, settings.searchLimit);
		const key = `${line.lineId}|${sorted.map((d) => d.id).join(',')}`;
		const hit = memo.get(key);
		if (hit) return hit;
		let best = { deals: /** @type {Deal[]} */ ([]), amount: 0, priority: 0 };
		const limit = 1 << sorted.length;
		for (let mask = 1; mask < limit; mask += 1) {
			const subset = sorted.filter((_, i) => (mask & (1 << i)) !== 0);
			if (subset.length > settings.maxDealsPerLine) continue;
			if (!subset.every((a, i) => subset.every((b, j) => i >= j || compatible(a, b)))) continue;
			let amount = line.unitAmount * line.quantity;
			let saved = 0;
			for (const d of subset) {
				const n = Math.min(
					line.quantity,
					d.limits.maxUnitsPerOrder ?? Infinity,
					d.limits.stockUnits === null ? Infinity : d.limits.stockUnits - (usage[d.id]?.units ?? 0),
				);
				const r = itemDealDiscount(d, { amount, quantity: line.quantity, n, rounding });
				amount -= r.amount;
				saved += r.amount;
			}
			const priority = subset.reduce((sum, d) => sum + d.priority, 0);
			if (
				saved > best.amount ||
				(saved === best.amount &&
					saved > 0 &&
					(priority > best.priority || (priority === best.priority && subset.length < best.deals.length)))
			)
				best = { deals: subset, amount: saved, priority };
		}
		const out = { deals: best.deals, amount: best.amount };
		memo.set(key, out);
		return out;
	};
	/** @param {LockCandidate} lock @param {Line} line */
	const lockSaving = (lock, line) => Math.min(line.quantity, lock.maxUnits) * Math.max(0, line.unitAmount - lock.unitPrice);

	// ── strategies ──────────────────────────────────────────────────────────────────────────────────────
	/** @param {Deal[]} groups */
	const groupsCompatible = (groups) =>
		groups.every((a, i) => groups.every((b, j) => i >= j || !overlap(a, b) || compatible(a, b)));

	const best = () => {
		const groups = groupCands.slice(0, settings.searchLimit);
		/** @type {ReturnType<typeof price> | null} */
		let winner = null;
		let winnerKey = '';
		const limit = 1 << groups.length;
		for (let mask = 0; mask < limit; mask += 1) {
			const chosen = groups.filter((_, i) => (mask & (1 << i)) !== 0);
			if (!groupsCompatible(chosen)) continue;
			/** @type {Map<string, Array<Deal | LockCandidate>>} */
			const perLine = new Map();
			let valid = true;
			for (const line of lines) {
				const touching = chosen.filter((g) => touch.get(g.id)?.has(line.lineId));
				const allowed = (itemCands.get(line.lineId) ?? []).filter((d) => touching.every((g) => compatible(d, g)));
				const local = bestLocal(line, allowed);
				const lock = locks.get(line.lineId);
				if (lock) {
					const lockFits = touching.every((g) => compatible(lock, g));
					if (!settings.preferLive) {
						if (!lockFits) {
							valid = false;
							break;
						}
						perLine.set(line.lineId, [lock]);
						continue;
					}
					if (lockFits && lockSaving(lock, line) >= local.amount) {
						perLine.set(line.lineId, [lock]);
						continue;
					}
				}
				perLine.set(line.lineId, local.deals);
			}
			if (!valid) continue;
			const result = price({ perLine, groups: chosen });
			const appliedIds = [...result.applied.keys()].sort();
			const priority = [...result.applied.values()].reduce((sum, a) => sum + a.deal.priority, 0);
			const key = appliedIds.join(',');
			if (
				!winner ||
				result.score > winner.score ||
				(result.score === winner.score &&
					// free shipping counts even when the cart did not say what shipping costs
					((result.freeShipping && !winner.freeShipping) ||
						(result.freeShipping === winner.freeShipping && priority > sumPriority(winner)) ||
						(result.freeShipping === winner.freeShipping &&
							priority === sumPriority(winner) &&
							(appliedIds.length < winner.applied.size ||
								(appliedIds.length === winner.applied.size && key < winnerKey)))))
			) {
				winner = result;
				winnerKey = key;
			}
		}
		return /** @type {ReturnType<typeof price>} */ (winner);
	};
	/** @param {ReturnType<typeof price>} result */
	const sumPriority = (result) => [...result.applied.values()].reduce((sum, a) => sum + a.deal.priority, 0);

	const byPriorityGreedy = () => {
		/** @type {Set<string>} */
		const excluded = new Set();
		// a better live price beats a lock (preferLive): decided per line before admission
		/** @type {Map<string, LockCandidate>} */
		const honoured = new Map();
		for (const [lineId, lock] of locks) {
			const line = /** @type {Line} */ (lineById.get(lineId));
			if (!settings.preferLive) honoured.set(lineId, lock);
			else {
				const greedy = greedyLine(itemCands.get(lineId) ?? []);
				const liveSaving = bestLocal(line, greedy).amount;
				if (lockSaving(lock, line) >= liveSaving) honoured.set(lineId, lock);
			}
		}
		for (let round = 0; round <= groupCands.length; round += 1) {
			/** @type {Map<string, Array<Deal | LockCandidate>>} */
			const perLine = new Map(lines.map((l) => [l.lineId, /** @type {Array<Deal | LockCandidate>} */ ([])]));
			for (const [lineId, lock] of honoured) perLine.set(lineId, [lock]);
			/** @type {Deal[]} */
			const groups = [];
			const ordered = [
				...live.filter((d) => (d.kind === 'item' || d.kind === 'flash') && touch.has(d.id)),
				...groupCands.filter((g) => !excluded.has(g.id)),
			].sort(byPriority);
			for (const deal of ordered) {
				const touched = /** @type {Set<string>} */ (touch.get(deal.id));
				if (deal.kind === 'item' || deal.kind === 'flash') {
					for (const lineId of touched) {
						if (honoured.has(lineId)) continue;
						const here = /** @type {Array<Deal | LockCandidate>} */ (perLine.get(lineId));
						if (here.length >= settings.maxDealsPerLine) continue;
						if (!here.every((d) => compatible(d, deal))) continue;
						if (!groups.every((g) => !touch.get(g.id)?.has(lineId) || compatible(g, deal))) continue;
						here.push(deal);
					}
					continue;
				}
				const clash = [...touched].some((lineId) => (perLine.get(lineId) ?? []).some((d) => !compatible(d, deal)));
				if (clash || !groups.every((g) => !overlap(g, deal) || compatible(g, deal))) continue;
				groups.push(deal);
			}
			const result = price({ perLine, groups });
			const unmet = groups.filter((g) => result.unmet.has(g.id));
			if (unmet.length === 0) return result;
			for (const g of unmet) excluded.add(g.id);
		}
		/* v8 ignore next -- each round excludes at least one group deal, so the loop always returns */
		return price({ perLine: new Map(), groups: [] });
	};
	/** Greedy compatible prefix of a line's candidates (priority order). @param {Deal[]} candidates */
	const greedyLine = (candidates) => {
		/** @type {Deal[]} */
		const out = [];
		for (const d of [...candidates].sort(byPriority)) {
			if (out.length >= settings.maxDealsPerLine) break;
			if (out.every((x) => compatible(x, d))) out.push(d);
		}
		return out;
	};

	const result = settings.strategy === 'priority' ? byPriorityGreedy() : best();

	// ── hints: cart deals a shopper can still reach ─────────────────────────────────────────────────────
	/** @type {Array<{ dealId: string, name: string, basis: 'subtotal' | 'quantity', remaining: number, reward: Record<string, unknown> }>} */
	const hints = [];
	for (const deal of live.filter((d) => d.kind === 'cart')) {
		const touched = touch.get(deal.id);
		if (!touched) continue;
		const eligible = result.state.filter((s) => touched.has(s.line.lineId));
		const measure = thresholdMeasure(eligible);
		const quantity = eligible.reduce((sum, s) => sum + s.line.quantity, 0);
		const c = deal.conditions;
		if (Number.isSafeInteger(c.minSubtotal) && measure < c.minSubtotal) {
			hints.push({
				dealId: deal.id,
				name: deal.name,
				basis: 'subtotal',
				remaining: c.minSubtotal - measure,
				reward: rewardSummary(deal.action),
			});
			continue;
		}
		if (Number.isSafeInteger(c.minQuantity) && quantity < c.minQuantity) {
			hints.push({
				dealId: deal.id,
				name: deal.name,
				basis: 'quantity',
				remaining: c.minQuantity - quantity,
				reward: rewardSummary(deal.action),
			});
			continue;
		}
		if (deal.action.type === 'tiered') {
			const value = deal.action.basis === 'quantity' ? quantity : measure;
			const next = /** @type {any[]} */ (deal.action.tiers).find((tier) => tier.min > value);
			if (next)
				hints.push({
					dealId: deal.id,
					name: deal.name,
					basis: deal.action.basis,
					remaining: next.min - value,
					reward: rewardSummary({ type: 'tier', ...next }),
				});
		}
	}
	hints.sort((a, b) => a.remaining - b.remaining || (a.dealId < b.dealId ? -1 : 1));

	const subtotal = lines.reduce((sum, l) => sum + l.unitAmount * l.quantity, 0);
	const appliedList = [...result.applied.values()]
		.filter((a) => a.amount > 0 || a.freeShipping)
		.sort((a, b) => byPriority(a.deal, b.deal))
		.map((a) => ({
			dealId: a.deal.id,
			kind: a.deal.kind,
			name: a.deal.name,
			class: a.deal.class,
			amount: a.amount,
			units: a.units,
			freeShipping: a.freeShipping,
			activeUntil: scheduleState(a.deal.schedule, now, timeZone).activeUntil,
		}));
	const shipping = cart.shippingAmount ?? 0;
	return {
		currency: cart.currency,
		lines: result.state.map((s) => ({
			lineId: s.line.lineId,
			itemId: s.line.itemId,
			variantId: s.line.variantId,
			quantity: s.line.quantity,
			unitAmount: s.line.unitAmount,
			subtotal: s.line.unitAmount * s.line.quantity,
			itemDiscount: s.line.unitAmount * s.line.quantity - s.afterItems,
			discount: s.line.unitAmount * s.line.quantity - s.amount,
			total: s.amount,
			deals: s.entries,
			locked: s.entries.some((e) => e.locked === true),
		})),
		deals: appliedList,
		subtotal,
		discountTotal: result.discountTotal,
		shipping: { amount: cart.shippingAmount, discount: result.shippingDiscount, free: result.freeShipping },
		total: subtotal - result.discountTotal + shipping - result.shippingDiscount,
		loyaltyAllowed: appliedList.every((a) => dealById.get(a.dealId)?.combinesWithLoyalty !== false),
		couponsAllowed: appliedList.every((a) => dealById.get(a.dealId)?.combinesWithCoupons !== false),
		hints: hints.slice(0, settings.maxHints),
		ineligible,
	};
};

/**
 * The reward a cart deal gives at a measure (tiered: the highest tier reached), else null.
 * @param {Deal} deal
 * @param {{ measure: number, quantity: number }} input
 * @returns {{ percent?: number, amount?: number, freeShipping?: boolean } | null}
 */
export const cartReward = (deal, { measure, quantity }) => {
	const a = deal.action;
	if (a.type === 'percent') return { percent: a.percent };
	if (a.type === 'amount_off') return { amount: a.amount };
	if (a.type === 'free_shipping') return { freeShipping: true };
	if (a.type === 'tiered') {
		const value = a.basis === 'quantity' ? quantity : measure;
		const reached = /** @type {any[]} */ (a.tiers).filter((tier) => tier.min <= value).pop();
		if (!reached) return null;
		return {
			...(reached.percent !== undefined ? { percent: reached.percent } : {}),
			...(reached.amount !== undefined ? { amount: reached.amount } : {}),
			...(reached.freeShipping ? { freeShipping: true } : {}),
		};
	}
	return null;
};

/**
 * Structured label of an action (headless/ui turn it into copy): `{ type, percent?, amount?, buy?, get?, quantity? }`.
 * @param {Record<string, any>} action
 * @param {Record<string, any> | null} [bundle]
 * @returns {Record<string, unknown>}
 */
export const rewardSummary = (action, bundle = null) => {
	/** @type {Record<string, unknown>} */
	const out = { type: action.type };
	for (const key of ['percent', 'amount', 'buy', 'get', 'freeShipping', 'min', 'basis'])
		if (action[key] !== undefined) out[key] = action[key];
	if (action.type === 'tiered' && Array.isArray(action.tiers)) {
		const top = action.tiers[action.tiers.length - 1];
		out.upTo = rewardSummary({ type: 'tier', ...top });
	}
	if (bundle) {
		out.bundle = bundle.type;
		if (bundle.type === 'mix_and_match') out.quantity = bundle.quantity;
		else out.components = (bundle.components ?? []).length;
	}
	return out;
};
