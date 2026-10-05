/**
 * Display views (pure): what a product card, a product page or the deals page shows — badges, pills, strike-through
 * prices and countdowns (ported from ibrahimMobiles `offerDisplay.ts` / `getStorefrontItemOffers`, where cart-only
 * conditions never change the hinted price). Views carry structured labels (`reward`), never copy: the headless
 * cores turn them into text with the website's strings, locale and currency.
 * @module
 */
import { evaluateCart, hasCartConditions, rewardSummary, staticIneligibility } from './evaluate.js';
import { scheduleState } from './schedule.js';
import { lineInScope } from './scope.js';

/** @typedef {import('./deals.js').Deal} Deal */
/** @typedef {import('./evaluate.js').EngineSettings} EngineSettings */
/** @typedef {import('./evaluate.js').Customer} Customer */
/** @typedef {import('./evaluate.js').Usage} Usage */

/**
 * @typedef {object} DisplaySettings
 * @property {number} countdownWithinMs show a countdown when the deal ends within this (0 = never)
 * @property {boolean} showConditional pills for deals with cart conditions (payment method, minimum spend…)
 * @property {boolean} showBundles pills for bundles the item belongs to
 * @property {boolean} showCartDeals pills for cart deals ("free shipping over 50")
 * @property {number} maxPills
 */

/**
 * Units of stock a deal has left (null = not stock-limited).
 * @param {Deal} deal
 * @param {Usage} usage
 */
export const stockLeft = (deal, usage) =>
	deal.limits.stockUnits === null ? null : Math.max(0, deal.limits.stockUnits - (usage[deal.id]?.units ?? 0));

/**
 * A deal as a display card (deals page, pills).
 * @param {Deal} deal
 * @param {{ now: number, timeZone: string, usage: Usage }} options
 */
export const dealCard = (deal, { now, timeZone, usage }) => {
	const state = scheduleState(deal.schedule, now, timeZone);
	const c = deal.conditions;
	return {
		id: deal.id,
		kind: deal.kind,
		name: deal.name,
		description: deal.description,
		badge: deal.badge,
		reward: rewardSummary(deal.action, deal.bundle),
		priority: deal.priority,
		schedule: {
			active: state.active,
			phase: state.phase,
			activeUntil: state.activeUntil === null ? null : new Date(state.activeUntil).toISOString(),
			nextStart: state.nextStart === null ? null : new Date(state.nextStart).toISOString(),
			timeZone: state.timeZone,
			windows: Array.isArray(deal.schedule.windows) ? deal.schedule.windows : [],
		},
		stockLeft: stockLeft(deal, usage),
		conditions: {
			...(Number.isSafeInteger(c.minSubtotal) ? { minSubtotal: c.minSubtotal } : {}),
			...(Number.isSafeInteger(c.minQuantity) ? { minQuantity: c.minQuantity } : {}),
			...(Array.isArray(c.paymentMethods) && c.paymentMethods.length > 0 ? { paymentMethods: c.paymentMethods } : {}),
			...(Array.isArray(c.deliveryMethods) && c.deliveryMethods.length > 0 ? { deliveryMethods: c.deliveryMethods } : {}),
			...(c.newCustomersOnly === true ? { newCustomersOnly: true } : {}),
		},
	};
};

/** @typedef {ReturnType<typeof dealCard>} DealCard */

/** Deals page orders (`deals_page.sort`). */
export const SORTS = Object.freeze(/** @type {const} */ (['priority', 'ending_soon', 'newest']));

/**
 * Sort deal cards.
 * @param {Array<DealCard & { createdAt?: string }>} cards
 * @param {(typeof SORTS)[number]} sort
 */
export const sortCards = (cards, sort) =>
	[...cards].sort((a, b) => {
		if (sort === 'ending_soon') {
			const ea = a.schedule.activeUntil ?? '9999';
			const eb = b.schedule.activeUntil ?? '9999';
			if (ea !== eb) return ea < eb ? -1 : 1;
		} else if (sort === 'newest') {
			const ca = a.createdAt ?? '';
			const cb = b.createdAt ?? '';
			if (ca !== cb) return ca > cb ? -1 : 1;
		}
		return b.priority - a.priority || (a.id < b.id ? -1 : 1);
	});

/**
 * Offers on one item (product card / product page): the price after the item deals that apply unconditionally, the
 * primary badge, pills (applied, conditional, bundles, cart deals) and a countdown.
 * @param {{ line: import('./scope.js').Line, currency: string, deals: Deal[], usage: Usage,
 *   customerUsage: Record<string, number>, customer: Customer, settings: EngineSettings, display: DisplaySettings,
 *   now: number, locks?: Map<string, import('./evaluate.js').LockCandidate> }} input
 */
export const evaluateItem = ({ line, currency, deals, usage, customerUsage, customer, settings, display, now, locks }) => {
	const ctx = { now, settings, usage, customerUsage, customer };
	const scopeOptions = { context: { cart: { currency }, customer: { ...customer } }, now, timeZone: settings.timeZone };
	const open = deals.filter((d) => staticIneligibility(d, ctx) === null);
	const itemLevel = open.filter((d) => (d.kind === 'item' || d.kind === 'flash') && lineInScope(line, d.scope, scopeOptions));
	const unconditional = itemLevel.filter((d) => !hasCartConditions(d));
	const evaluated = evaluateCart({
		cart: { currency, lines: [line], customer, paymentMethod: null, deliveryMethod: null, shippingAmount: null },
		deals: unconditional,
		usage,
		customerUsage,
		...(locks ? { locks } : {}),
		settings,
		now,
	});
	const priced = /** @type {(typeof evaluated.lines)[number]} */ (evaluated.lines[0]);
	const appliedIds = new Set(evaluated.deals.map((d) => d.dealId));
	const byId = new Map(deals.map((d) => [d.id, d]));
	const cardOf = (/** @type {Deal} */ d) => dealCard(d, { now, timeZone: settings.timeZone, usage });
	const applied = evaluated.deals.map((a) => cardOf(/** @type {Deal} */ (byId.get(a.dealId))));
	const conditional = display.showConditional ? itemLevel.filter((d) => hasCartConditions(d)).map(cardOf) : [];
	const bundles = display.showBundles
		? open
				.filter((d) => d.kind === 'bundle')
				.filter((d) => {
					const scopes =
						d.bundle?.type === 'mix_and_match'
							? [d.bundle.scope]
							: (d.bundle?.components ?? []).map((/** @type {any} */ c) => c.scope);
					return scopes.some((/** @type {any} */ s) => lineInScope(line, s, scopeOptions));
				})
				.map(cardOf)
		: [];
	const cartDeals = display.showCartDeals
		? open.filter((d) => d.kind === 'cart' && lineInScope(line, d.scope, scopeOptions)).map(cardOf)
		: [];
	const pills = [
		...applied.map((card) => ({ ...pill(card), conditional: false })),
		...conditional.filter((card) => !appliedIds.has(card.id)).map((card) => ({ ...pill(card), conditional: true })),
		...bundles.map((card) => ({ ...pill(card), conditional: true })),
		...cartDeals.map((card) => ({ ...pill(card), conditional: true })),
	].slice(0, display.maxPills);
	const primary = applied[0] ?? null;
	const ending = applied
		.map((card) => card.schedule.activeUntil)
		.filter((/** @type {string | null} */ at) => at !== null && Date.parse(at) - now <= display.countdownWithinMs)
		.sort()[0];
	const unitPrice = Math.round(priced.total / priced.quantity);
	return {
		itemId: line.itemId,
		variantId: line.variantId,
		currency,
		quantity: line.quantity,
		unitAmount: line.unitAmount,
		price: unitPrice,
		total: priced.total,
		discount: priced.discount,
		percentOff: priced.subtotal > 0 ? Math.floor((100 * priced.discount) / priced.subtotal) : 0,
		locked: priced.locked,
		deals: applied,
		dealEntries: priced.deals,
		badge: primary
			? {
					dealId: primary.id,
					kind: primary.kind,
					label: primary.badge.label,
					tone: primary.badge.tone,
					reward: primary.reward,
				}
			: null,
		pills,
		countdown: display.countdownWithinMs > 0 && ending ? { endsAt: ending } : null,
		classes: evaluated.deals.map((d) => d.class),
	};
};

/**
 * @param {DealCard} card
 */
const pill = (card) => ({
	dealId: card.id,
	kind: card.kind,
	name: card.name,
	label: card.badge.label,
	tone: card.badge.tone,
	reward: card.reward,
	conditions: card.conditions,
});
