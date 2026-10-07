/**
 * The money function (pure, PLAN 0.5.1–0.5.7). Every list, total, merchant page and check uses it, so their numbers
 * always match.
 *
 * {@link replay} walks a merchant's time from `from` to `to` in order, hour by hour across all their websites:
 *
 * - A product on a website charges while its status is active or grace; a switched-on feature is charged once per UTC
 *   clock hour in which it was on at any instant while charging, at the price in force at the first such instant, from
 *   that instant (the current hour is in the balance at once). Hours are never split or given back; switching a feature
 *   back on in the same hour never charges it again.
 * - A grace period starts at the first instant at which balance ≤ 0 and daily spend > 0, unless one is running or the
 *   merchant is stopped (or suspended: it then starts on resume). It ends `graceDays` later (the setting at its start);
 *   then the merchant is stopped and no hour starting at or after the end is charged.
 * - A receipt that brings the balance above 0 ends a grace period or a stop at once; one that leaves it ≤ 0 changes
 *   nothing.
 *
 * Events before `from` only rebuild the state (price lists, products, switches, suspension); receipts before `from` are
 * already in the opening `balance`. All amounts are integer millicredits.
 * @module
 */

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/**
 * @typedef {{ type: 'prices', at: number, appId: string, features: { key: string, name: string, price: number }[] }} PricesEvent
 * @typedef {{ type: 'switches', at: number, websiteId: string, appId: string, on: string[] }} SwitchesEvent
 * @typedef {{ type: 'added' | 'removed', at: number, websiteId: string, appId: string }} ProductEvent
 * @typedef {{ type: 'suspended' | 'resumed', at: number }} MerchantEvent
 * @typedef {{ type: 'receipt', at: number, amount: number }} ReceiptEvent
 * @typedef {PricesEvent | SwitchesEvent | ProductEvent | MerchantEvent | ReceiptEvent} MoneyEvent
 * @typedef {{ graceStart: number | null, graceEnd: number | null, stoppedAt: number | null }} Phase
 * @typedef {{ at: number, hour: number, websiteId: string, appId: string, feature: string, amount: number }} Charge
 * @typedef {{ type: 'grace_started', at: number, graceEnd: number } | { type: 'stopped' | 'restored', at: number }} Transition
 * @typedef {{ websiteId: string, appId: string, added: boolean, on: string[], hourlyCost: number }} ProductState
 * @typedef {'active' | 'low_balance' | 'grace' | 'stopped'} BillingState
 * @typedef {BillingState | 'suspended'} MerchantStatus
 * @typedef {'active' | 'grace' | 'stopped' | 'suspended' | 'removed'} ProductStatus
 */

/** No grace period, not stopped. */
export const OPEN_PHASE = Object.freeze({ graceStart: null, graceEnd: null, stoppedAt: null });

/** @param {number} ms */
export const floorHour = (ms) => Math.floor(ms / HOUR_MS) * HOUR_MS;
/** @param {number} ms */
export const floorDay = (ms) => Math.floor(ms / DAY_MS) * DAY_MS;
/** @param {number} ms */
export const floorMonth = (ms) => {
	const d = new Date(ms);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};
/**
 * UTC day of an instant, `YYYY-MM-DD`.
 * @param {number} ms
 */
export const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

const CREDITS = new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 3 });

/**
 * Credits as shown in e-mails (0.5.1): up to 3 decimals, trailing zeros dropped, a minus sign when negative.
 * @param {number} millicredits
 */
export const creditsText = (millicredits) =>
	`${CREDITS.format(millicredits / 1000)} ${Math.abs(millicredits) === 1000 ? 'credit' : 'credits'}`;

/**
 * An instant as shown in e-mails: `2026-10-08 14:30 UTC`.
 * @param {number} ms
 */
export const instantText = (ms) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** @param {string} websiteId @param {string} appId */
const pairKey = (websiteId, appId) => `${websiteId}\u0000${appId}`;

/**
 * Replay a merchant's money from `from` to `to`.
 * @param {{ from: number, to: number, cut?: number | null, balance: number, phase?: Phase, events: readonly MoneyEvent[],
 *   graceDays: number, graceEnds?: Readonly<Record<string, number>> }} input `cut` (an hour boundary in `[from, to]`)
 *   asks for the state just before it (the snapshot a check stores with its settled days); `graceEnds` maps the start
 *   instant of a grace period already recorded to its end, so a later Settings change never moves it.
 */
export const replay = ({ from, to, cut = null, balance, phase = OPEN_PHASE, events, graceDays, graceEnds = {} }) => {
	const sorted = events
		.map((event, index) => ({ event, index }))
		.sort((a, b) => a.event.at - b.event.at || a.index - b.index)
		.map((x) => x.event);
	/** @type {Map<string, Map<string, number>>} */
	const prices = new Map();
	/** @type {Map<string, { websiteId: string, appId: string, added: boolean, on: Set<string> }>} */
	const products = new Map();
	let suspended = false;
	let money = balance;
	let { graceStart, graceEnd, stoppedAt } = phase;
	/** @type {Charge[]} */
	const charges = [];
	/** @type {Transition[]} */
	const transitions = [];
	/** @type {Set<string>} */
	let charged = new Set();
	let chargedHour = Number.NaN;
	/** @type {{ balance: number, phase: Phase } | null} */
	let snapshot = null;

	/** @param {string} appId @param {string} key */
	const priceOf = (appId, key) => prices.get(appId)?.get(key) ?? 0;
	/** @param {{ appId: string, added: boolean, on: Set<string> }} p */
	const hourlyOf = (p) => (p.added ? [...p.on].reduce((sum, key) => sum + priceOf(p.appId, key), 0) : 0);
	const dailySpend = () => 24 * [...products.values()].reduce((sum, p) => sum + hourlyOf(p), 0);
	const phaseNow = () => ({ graceStart, graceEnd, stoppedAt });

	/** @param {MoneyEvent} event @param {boolean} live */
	const apply = (event, live) => {
		switch (event.type) {
			case 'prices':
				prices.set(event.appId, new Map(event.features.map((f) => [f.key, f.price])));
				return;
			case 'added':
			case 'removed': {
				const key = pairKey(event.websiteId, event.appId);
				const was = products.get(key);
				// re-adding a removed product resets its switches to all off (0.5.9)
				if (event.type === 'added')
					products.set(key, { websiteId: event.websiteId, appId: event.appId, added: true, on: new Set() });
				else if (was) was.added = false;
				return;
			}
			case 'switches': {
				const product = products.get(pairKey(event.websiteId, event.appId));
				if (product) product.on = new Set(event.on);
				return;
			}
			case 'suspended':
				suspended = true;
				return;
			case 'resumed':
				suspended = false;
				return;
			case 'receipt':
				if (!live) return;
				money += event.amount;
				if (money > 0 && (graceEnd !== null || stoppedAt !== null)) {
					graceStart = null;
					graceEnd = null;
					stoppedAt = null;
					transitions.push({ type: 'restored', at: event.at });
				}
				return;
			default:
				return;
		}
	};

	/** @param {number} t */
	const stopIfGraceOver = (t) => {
		if (graceEnd === null || t < graceEnd) return;
		stoppedAt = graceEnd;
		transitions.push({ type: 'stopped', at: graceEnd });
		graceStart = null;
		graceEnd = null;
	};

	let i = 0;
	while (i < sorted.length && /** @type {MoneyEvent} */ (sorted[i]).at < from)
		apply(/** @type {MoneyEvent} */ (sorted[i++]), false);

	const end = Math.max(from, to);
	for (let t = from; ;) {
		if (cut !== null && snapshot === null && t >= cut) snapshot = { balance: money, phase: phaseNow() };
		while (i < sorted.length && /** @type {MoneyEvent} */ (sorted[i]).at <= t)
			apply(/** @type {MoneyEvent} */ (sorted[i++]), true);
		stopIfGraceOver(t);
		const hour = floorHour(t);
		if (hour !== chargedHour) {
			charged = new Set();
			chargedHour = hour;
		}
		if (!suspended && stoppedAt === null)
			for (const p of products.values()) {
				if (!p.added) continue;
				for (const feature of [...p.on].sort()) {
					const key = `${pairKey(p.websiteId, p.appId)}\u0000${feature}`;
					if (charged.has(key)) continue;
					charged.add(key);
					const amount = priceOf(p.appId, feature);
					money -= amount;
					charges.push({ at: t, hour, websiteId: p.websiteId, appId: p.appId, feature, amount });
				}
			}
		if (graceEnd === null && stoppedAt === null && !suspended && money <= 0 && dailySpend() > 0) {
			graceStart = t;
			graceEnd = graceEnds[String(t)] ?? t + graceDays * DAY_MS;
			transitions.push({ type: 'grace_started', at: t, graceEnd });
			stopIfGraceOver(t);
		}
		let next = hour + HOUR_MS;
		if (i < sorted.length && /** @type {MoneyEvent} */ (sorted[i]).at < next) next = /** @type {MoneyEvent} */ (sorted[i]).at;
		if (graceEnd !== null && graceEnd > t && graceEnd < next) next = graceEnd;
		if (next > end) break;
		t = next;
	}
	if (cut !== null && snapshot === null) snapshot = { balance: money, phase: phaseNow() };

	return {
		balance: money,
		phase: phaseNow(),
		suspended,
		dailySpend: dailySpend(),
		charges,
		transitions,
		snapshot,
		/** @type {ProductState[]} */
		products: [...products.values()].map((p) => ({
			websiteId: p.websiteId,
			appId: p.appId,
			added: p.added,
			on: [...p.on].sort(),
			hourlyCost: hourlyOf(p),
		})),
	};
};

/**
 * Low balance: daily spend > 0 and 0 < balance < threshold days × daily spend (exact values).
 * @param {{ balance: number, dailySpend: number, lowBalanceDays: number }} input
 */
export const isLowBalance = ({ balance, dailySpend, lowBalanceDays }) =>
	dailySpend > 0 && balance > 0 && balance < lowBalanceDays * dailySpend;

/**
 * Billing state (the merchant status without suspension), first match wins: stopped › grace › low balance › active.
 * @param {{ phase: Phase, balance: number, dailySpend: number, lowBalanceDays: number }} input
 * @returns {BillingState}
 */
export const billingStateOf = ({ phase, balance, dailySpend, lowBalanceDays }) => {
	if (phase.stoppedAt !== null) return 'stopped';
	if (phase.graceEnd !== null) return 'grace';
	return isLowBalance({ balance, dailySpend, lowBalanceDays }) ? 'low_balance' : 'active';
};

/**
 * Merchant status (0.5.5): suspended › stopped › grace › low balance › active.
 * @param {{ suspended: boolean, billingState: BillingState }} input
 * @returns {MerchantStatus}
 */
export const merchantStatusOf = ({ suspended, billingState }) => (suspended ? 'suspended' : billingState);

/**
 * Product-on-website status (0.5.5): removed › suspended › stopped › grace › active (low balance counts as active).
 * @param {{ added: boolean, merchantStatus: MerchantStatus }} input
 * @returns {ProductStatus}
 */
export const productStatusOf = ({ added, merchantStatus }) => {
	if (!added) return 'removed';
	return merchantStatus === 'low_balance' ? 'active' : merchantStatus;
};

/**
 * Whole days left at the current daily spend (rounded down); null when daily spend is 0.
 * @param {{ balance: number, dailySpend: number }} input
 * @returns {number | null}
 */
export const daysLeftOf = ({ balance, dailySpend }) => (dailySpend > 0 ? Math.max(0, Math.floor(balance / dailySpend)) : null);

/**
 * Group charges per website × product × UTC day × feature: hours charged and credits.
 * @param {readonly Charge[]} charges
 * @returns {{ day: string, websiteId: string, appId: string, feature: string, hours: number, amount: number }[]}
 */
export const usageRows = (charges) => {
	/** @type {Map<string, { day: string, websiteId: string, appId: string, feature: string, hours: number, amount: number }>} */
	const rows = new Map();
	for (const c of charges) {
		const day = dayOf(c.hour);
		const key = `${day}\u0000${pairKey(c.websiteId, c.appId)}\u0000${c.feature}`;
		const row = rows.get(key) ?? { day, websiteId: c.websiteId, appId: c.appId, feature: c.feature, hours: 0, amount: 0 };
		row.hours += 1;
		row.amount += c.amount;
		rows.set(key, row);
	}
	return [...rows.values()].sort(
		(a, b) =>
			a.day.localeCompare(b.day) ||
			a.websiteId.localeCompare(b.websiteId) ||
			a.appId.localeCompare(b.appId) ||
			a.feature.localeCompare(b.feature),
	);
};

/**
 * Day charges (0.5.7 b): one per website × product × UTC day with per-feature lines; days with 0 credits are left out.
 * @param {readonly Charge[]} charges
 * @returns {{ day: string, websiteId: string, appId: string, amount: number,
 *   lines: { feature: string, hours: number, amount: number }[] }[]}
 */
export const dayCharges = (charges) => {
	/** @type {Map<string, { day: string, websiteId: string, appId: string, amount: number, lines: { feature: string, hours: number, amount: number }[] }>} */
	const days = new Map();
	for (const row of usageRows(charges)) {
		const key = `${row.day}\u0000${pairKey(row.websiteId, row.appId)}`;
		const day = days.get(key) ?? { day: row.day, websiteId: row.websiteId, appId: row.appId, amount: 0, lines: [] };
		day.amount += row.amount;
		day.lines.push({ feature: row.feature, hours: row.hours, amount: row.amount });
		days.set(key, day);
	}
	return [...days.values()].filter((d) => d.amount > 0);
};
