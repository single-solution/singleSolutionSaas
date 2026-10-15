/**
 * Credits and billing (PLAN 0.5): the money histories, the check, receipts and the money views.
 *
 * - **Histories** (0.5.7 a), stamped with Portal time: accepted price lists per product (price reports and connect
 *   answers), feature reports and status changes per merchant (product added or removed, merchant suspended or
 *   resumed, grace started, stopped).
 * - **Check** (0.5.7): replays the time since the merchant was last settled with the pure money function, from the
 *   balance at that point (receipts before it and day charges of the days before it, so days a crashed or overlapping
 *   check already wrote are never counted twice), writes the day charges of complete UTC days, records grace starts
 *   and stops once (and tells the merchant's products, `status.changed`), caches the balance and billing state, and
 *   sends a billing email when the merchant enters a state (an atomic compare-and-set on the stored state, so two
 *   checks send one email). The day charges, grace starts and stops and the billing state commit in one transaction.
 *   It reads from the settled point on only: the products and suspension stored there, the history from a day before
 *   it, the price lists then in force, and the ledger entries from it on beside the account's cached balance. It runs
 *   when a product fetches a status and when a Portal page shows a merchant; nothing is scheduled. It never waits more
 *   than a second for a ledger another write holds: it then answers live and writes nothing.
 * - **Receipts** (0.5.8): the only way credits are added; never edited, voided or reversed. A receipt that ends grace
 *   or a stop restarts the merchant's products (`status.changed`).
 * @module
 */
import { createId } from '@ss/contracts';
import { isProblem, problem } from '../../../infra/http.js';
import { afterResponse, memoize } from '../../../infra/request-scope.js';
import { sha256Hex } from '@ss/protocol';
import {
	OPEN_PHASE,
	billingStateOf,
	creditsText,
	dayCharges,
	dayOf,
	daysLeftOf,
	floorDay,
	floorMonth,
	instantText,
	isLowBalance,
	merchantStatusOf,
	productStatusOf,
	replay,
	usageRows,
} from '../core/money.js';

/** @typedef {import('../../../infra/modules.js').ModuleContext} ModuleContext */
/** @typedef {import('../repo.js').CommerceRepo} CommerceRepo */
/** @typedef {import('./deps.js').Deps} Deps */
/** @typedef {import('./ledger.js').Ledger} Ledger */
/** @typedef {import('../core/money.js').MoneyEvent} MoneyEvent */
/** @typedef {import('../core/money.js').Phase} Phase */
/** @typedef {import('../core/money.js').BillingState} BillingState */
/** @typedef {import('../core/money.js').HeldState} HeldState */
/** @typedef {Record<string, any>} Doc */
/** @typedef {{ type: string, id: string, name?: string | null }} Actor */
/** @typedef {{ actor: Actor, requestId?: string | null, ip?: string | null }} Caller */
/** @typedef {import('mongodb').ClientSession} Session */

const SYSTEM_ACTOR = Object.freeze({ type: 'system', id: 'commerce' });
/**
 * History read again before the settled point: an entry is stamped when its request starts and written moments later,
 * so one can land after a check settled past its time; it still applies from there.
 */
const REREAD_MS = 86_400_000;
/** How long a check waits while another write holds the ledger; then it answers live and leaves the writing to it. */
const CHECK_WAIT_MS = 1000;

/** Billing states that send an email when entered, and their template. */
const STATE_MAILS = Object.freeze({ low_balance: 'low_balance', grace: 'grace_started', stopped: 'products_stopped' });
/** Merchants shown per admin list (lists are paged at 50, PLAN 0.6). */
const PAGE = 50;
const KEY = /^[a-z][a-z0-9_]{0,63}$/;

/** @param {unknown} value */
const ms = (value) => (value instanceof Date ? value.getTime() : typeof value === 'number' ? value : null);
/** @param {number | null} value */
const date = (value) => (value === null ? null : new Date(value));
/** @param {number | null} value */
const iso = (value) => (value === null ? null : new Date(value).toISOString());
/** A check that lost the compare-and-set on the billing state: thrown to abort its writes. */
const lost = () => Object.assign(new Error('another check settled first'), { code: 'billing/lost' });
/** @param {unknown} error */
const isLost = (error) => error instanceof Error && /** @type {any} */ (error).code === 'billing/lost';
/** @param {Doc | null | undefined} stored @returns {Phase} */
const phaseOf = (stored) =>
	stored
		? { graceStart: ms(stored.graceStart), graceEnd: ms(stored.graceEnd), stoppedAt: ms(stored.stoppedAt) }
		: { ...OPEN_PHASE };
/** @param {Phase} phase */
const storedPhase = (phase) => ({
	graceStart: date(phase.graceStart),
	graceEnd: date(phase.graceEnd),
	stoppedAt: date(phase.stoppedAt),
});

/**
 * Every UTC day from `from` to `to` (inclusive).
 * @param {string} from @param {string} to
 */
const daysBetween = (from, to) => {
	const out = [];
	for (let t = Date.parse(from); t <= Date.parse(to); t += 86_400_000) out.push(dayOf(t));
	return out;
};

/**
 * @param {{ ctx: ModuleContext, repo: CommerceRepo, deps: Deps, ledger: Ledger,
 *   statusChanged: (merchantId: string) => Promise<unknown> }} input `statusChanged`: tell the products on the
 *   merchant's websites that their status changed
 */
export const createBilling = ({ ctx, repo, deps, ledger, statusChanged }) => {
	const rules = () => ctx.config.settings.billing;

	/**
	 * Send a Portal email right after the response; skipped without SMTP settings (PLAN 0.5.10).
	 * @param {{ to: string, template: string, data: Record<string, string> }} message
	 */
	const mail = async (message) => {
		if (ctx.mailer.available === false) return;
		const send = async () => {
			try {
				await ctx.mailer.send(message);
			} catch (error) {
				ctx.logger.warn('mail could not be sent', { template: message.template, error });
			}
		};
		if (!afterResponse(send)) await send();
	};

	// ------------------------------------------------------------------------------------------------ histories

	/**
	 * Store an accepted price list of a product (one hourly price per feature in millicredits, never negative); it
	 * applies from now on. The version must be higher than the last accepted one (409 `conflict`).
	 * @param {{ productId: string, prices: import('@ss/contracts').PriceList }} input
	 * @returns {Promise<{ productId: string, version: number, at: string, features: Doc[], previous: Doc | null }>}
	 */
	const recordPriceList = async ({ productId, prices }) => {
		const valid =
			Number.isSafeInteger(prices?.version) &&
			prices.version >= 1 &&
			Array.isArray(prices.features) &&
			prices.features.every(
				(f) => KEY.test(f?.key) && Number.isSafeInteger(f.millicreditsPerHour) && f.millicreditsPerHour >= 0,
			) &&
			new Set(prices.features.map((f) => f.key)).size === prices.features.length;
		if (!valid) throw problem('validation_failed', 'The price list is invalid.');
		const previous = await repo.lastPriceList(productId);
		if (previous && prices.version <= previous.version)
			throw problem('conflict', `Price list ${prices.version} is not higher than ${previous.version}.`);
		const doc = {
			productId,
			version: prices.version,
			at: new Date(ctx.now()),
			features: prices.features.map((f) => ({
				key: f.key,
				name: f.name,
				description: f.description,
				dependsOn: [...f.dependsOn],
				price: f.millicreditsPerHour,
			})),
		};
		try {
			await repo.insertPriceList(doc);
		} catch (error) {
			if (repo.isDuplicateKey(error)) throw problem('conflict', `Price list ${prices.version} was already accepted.`);
			throw error;
		}
		return { productId, version: doc.version, at: doc.at.toISOString(), features: doc.features, previous };
	};

	/**
	 * A product added to or removed from a website; `session`: written in the caller's transaction, with the product's
	 * own state.
	 * @param {'added' | 'removed'} kind
	 * @returns {(input: { merchantId: string, websiteId: string, productId: string }, session?: Session) => Promise<void>}
	 */
	const productChange =
		(kind) =>
		async ({ merchantId, websiteId, productId }, session) => {
			await repo.appendHistory(merchantId, { kind, at: new Date(ctx.now()), websiteId, productId }, session);
		};

	/**
	 * Store the last accepted feature report of a product on a website: the keys of its switched-on features
	 * (`session`: in the caller's transaction).
	 * @param {{ merchantId: string, websiteId: string, productId: string, on: readonly string[] }} input
	 * @param {Session} [session]
	 */
	const recordSwitches = async ({ merchantId, websiteId, productId, on }, session) => {
		if (!Array.isArray(on) || !on.every((key) => KEY.test(key)))
			throw problem('validation_failed', 'The feature report is invalid.');
		await repo.appendHistory(
			merchantId,
			{ kind: 'switches', at: new Date(ctx.now()), websiteId, productId, on: [...new Set(on)].sort() },
			session,
		);
	};

	/**
	 * Merchant suspended or resumed (identity hook): suspended hours are never charged, and this history alone decides
	 * whether the merchant's products are suspended. Repeating it writes nothing when the history already ends in that
	 * status, so a repeated suspend or resume repairs a lost entry.
	 * @param {string} merchantId @param {'active' | 'suspended'} status
	 * @returns {Promise<boolean>} whether an entry was written
	 */
	const recordMerchantStatus = async (merchantId, status) => {
		const kind = status === 'suspended' ? 'suspended' : 'resumed';
		const last = await repo.lastHistory(merchantId, ['suspended', 'resumed']);
		if ((last?.kind ?? 'resumed') === kind) return false;
		return repo.appendHistory(merchantId, { kind, at: new Date(ctx.now()) });
	};

	// ------------------------------------------------------------------------------------------------ the check

	/**
	 * Inputs of the money function for a merchant up to `now`: with the state stored at the settled point (`held`),
	 * only the history from a day before it on and the price lists in force then; else the whole history.
	 * @param {string} merchantId @param {number} now @param {{ from: number, held: HeldState } | null} settled
	 */
	const inputsOf = async (merchantId, now, settled) => {
		const since = settled ? new Date(settled.from - REREAD_MS) : null;
		const history = await repo.historyOf(merchantId, new Date(now), since);
		const productIds = [
			...new Set([
				...(settled?.held.products ?? []).map((p) => p.productId),
				...history.filter((h) => typeof h.productId === 'string').map((h) => String(h.productId)),
			]),
		];
		const lists = await repo.priceListsOf(productIds, new Date(now), since);
		/** @type {MoneyEvent[]} */
		const events = lists.map((l) => ({ type: 'prices', at: l.at.getTime(), productId: l.productId, features: l.features }));
		/** @type {Record<string, number>} */
		const graceEnds = {};
		for (const h of history) {
			const at = h.at.getTime();
			if (h.kind === 'added' || h.kind === 'removed')
				events.push({ type: h.kind, at, websiteId: h.websiteId, productId: h.productId });
			else if (h.kind === 'switches')
				events.push({ type: 'switches', at, websiteId: h.websiteId, productId: h.productId, on: h.on });
			else if (h.kind === 'suspended' || h.kind === 'resumed') events.push({ type: h.kind, at });
			else if (h.kind === 'grace_started') graceEnds[String(at)] = h.graceEnd.getTime();
		}
		const earliest = history.length > 0 ? /** @type {Doc} */ (history[0]).at.getTime() : null;
		return { events, graceEnds, earliest };
	};

	/**
	 * The balance at `from` and the receipts from it on, read from the settled point on only: the account's cached
	 * balance (every entry up to its `seq`) and the entries after it (a crashed writer's), less the receipts from `from`
	 * on and the day charges of the days from it on. Those are replayed, whether or not a crashed or overlapping check
	 * already wrote them, so no day is counted twice.
	 * @param {string} merchantId @param {number} from
	 */
	const openingOf = async (merchantId, from) => {
		const account = await repo.accountOps(merchantId).findOne({ merchantId, _id: merchantId });
		const seq = Number(account?.seq ?? 0);
		const day = dayOf(from);
		const entries = await repo
			.ledgerOf(merchantId)
			.find({
				merchantId,
				$or: [
					{ seq: { $gt: seq } },
					{ type: 'receipt', at: { $gte: new Date(from) } },
					{ type: 'day_charge', day: { $gte: day } },
				],
			})
			.sort({ seq: 1 })
			.toArray();
		/** @param {Doc} e */
		const replayed = (e) => (e.type === 'receipt' ? e.at.getTime() >= from : e.day >= day);
		let opening = Number(account?.balance ?? 0);
		for (const e of entries) opening += (e.seq > seq ? e.amount : 0) - (replayed(e) ? e.amount : 0);
		return { opening, receipts: entries.filter((e) => e.type === 'receipt' && replayed(e)) };
	};

	/**
	 * Run the check for one merchant (PLAN 0.5.7) and return the live money state. Independent reads run together; a
	 * console page render checks each merchant once however many of its reads need it (`memoize`).
	 * @param {string} merchantId
	 */
	const check = (merchantId) => memoize(`check|${merchantId}`, () => runCheck(merchantId));

	/**
	 * Write what a check found: its day charges, the grace starts and stops it recorded (once each) and the billing
	 * state (a compare-and-set on the state the check read) commit together or not at all, so a crash never leaves
	 * days charged with the settled point behind them. A check that lost the compare-and-set writes nothing: the check
	 * that won settled the same days. Nor does a check that finds the ledger held longer than `CHECK_WAIT_MS` by another
	 * write (it answers live, so a status fetch never waits long; the next check writes what is left).
	 * @param {string} merchantId
	 * @param {{ drafts: import('../core/ledger.js').EntryDraft[], marks: Doc[], expect: Doc | null, next: Doc }} input
	 * @returns {Promise<{ saved: boolean, marked: boolean }>} `marked`: a grace start or stop was recorded now
	 */
	const settle = async (merchantId, { drafts, marks, expect, next }) => {
		if (drafts.length === 0 && marks.length === 0)
			return { saved: await repo.updateBilling(merchantId, expect, next), marked: false };
		let marked = false;
		/** @param {Session} session */
		const alongside = async (session) => {
			marked = false;
			for (const mark of marks) marked = (await repo.appendHistory(merchantId, mark, session)) || marked;
			if (!(await repo.updateBilling(merchantId, expect, next, session))) throw lost();
		};
		try {
			if (drafts.length > 0) await ledger.append(merchantId, drafts, { alongside, waitMs: CHECK_WAIT_MS });
			else await ctx.withTransaction(alongside);
			return { saved: true, marked };
		} catch (error) {
			if (isLost(error) || (isProblem(error) && /** @type {any} */ (error).code === 'unavailable'))
				return { saved: false, marked: false };
			throw error;
		}
	};

	/** @param {string} merchantId */
	const runCheck = async (merchantId) => {
		const now = ctx.now();
		const stored = await repo.billingOf(merchantId);
		const settledAt = stored?.settledThrough instanceof Date ? stored.settledThrough.getTime() : null;
		/** @type {HeldState | null} the products and suspension at the settled point (none in a doc from before it was kept) */
		const held =
			settledAt !== null && Array.isArray(stored?.held?.products)
				? { suspended: stored?.held.suspended === true, products: stored?.held.products }
				: null;
		const [{ events, graceEnds, earliest }, settledOpening] = await Promise.all([
			inputsOf(merchantId, now, settledAt !== null && held ? { from: settledAt, held } : null),
			settledAt === null ? null : openingOf(merchantId, settledAt),
		]);
		const from = settledAt ?? floorDay(earliest ?? now);
		const { opening, receipts } = settledOpening ?? (await openingOf(merchantId, from));
		// grace and a stop only hold while the balance is ≤ 0: a stored one with credits left was written by a check
		// that miscounted, and is dropped
		const kept = phaseOf(stored?.phase);
		const dropped = opening > 0 && (kept.graceEnd !== null || kept.stoppedAt !== null);
		const cut = floorDay(now);
		const run = replay({
			from,
			to: now,
			cut,
			balance: opening,
			phase: dropped ? { ...OPEN_PHASE } : kept,
			...(held ? { state: held } : {}),
			events: [
				...events,
				...receipts.map((r) => /** @type {MoneyEvent} */ ({ type: 'receipt', at: r.at.getTime(), amount: r.amount })),
			],
			graceDays: rules().graceDays,
			graceEnds,
		});

		// day charges of complete UTC days, written once each, in order
		const drafts = dayCharges(run.charges.filter((c) => c.hour < cut)).map((d) => ({
			type: /** @type {const} */ ('day_charge'),
			amount: -d.amount,
			entryKey: `day:${d.websiteId}:${d.productId}:${d.day}`,
			day: d.day,
			websiteId: d.websiteId,
			productId: d.productId,
			actor: SYSTEM_ACTOR,
			details: { lines: d.lines },
		}));
		const marks = run.transitions.flatMap((t) =>
			t.type === 'grace_started'
				? [
						{
							kind: 'grace_started',
							at: new Date(t.at),
							graceEnd: new Date(t.graceEnd),
							key: `${merchantId}:grace_started:${t.at}`,
						},
					]
				: t.type === 'stopped'
					? [{ kind: 'stopped', at: new Date(t.at), key: `${merchantId}:stopped:${t.at}` }]
					: [],
		);
		const lowBalanceDays = rules().lowBalanceDays;
		const state = billingStateOf({ phase: run.phase, balance: run.balance, dailySpend: run.dailySpend, lowBalanceDays });
		const snapshot = /** @type {import('../core/money.js').Snapshot} */ (run.snapshot);
		const { saved, marked } = await settle(merchantId, {
			drafts,
			marks,
			expect: stored ? { settledThrough: stored.settledThrough, state: stored.state } : null,
			next: {
				settledThrough: new Date(Math.max(cut, from)),
				phase: storedPhase(snapshot.phase),
				held: { suspended: snapshot.suspended, products: snapshot.products },
				state,
				balance: run.balance,
				dailySpend: run.dailySpend,
				checkedAt: new Date(now),
			},
		});
		// grace started, products stopped or a miscounted stop dropped: the check that records it tells the products
		// (PLAN 0.4.12)
		if (marked || (saved && dropped)) await statusChanged(merchantId);
		const previous = stored?.state ?? 'active';
		if (saved && state !== previous && state in STATE_MAILS) await billingMail(merchantId, state, run);
		return { merchantId, now, cut, run, state };
	};

	/**
	 * The email of a billing state entered (to the merchant and every Owner and Finance admin).
	 * @param {string} merchantId @param {BillingState} state @param {ReturnType<typeof replay>} run
	 */
	const billingMail = async (merchantId, state, run) => {
		const template = STATE_MAILS[/** @type {keyof typeof STATE_MAILS} */ (state)];
		const contacts = await deps.billingContacts(merchantId);
		const days = daysLeftOf(run);
		/** @type {Record<string, string>} */
		const data = {
			merchantName: contacts.merchantName,
			balance: creditsText(run.balance),
			daysLeft: days === null ? 'some time' : days < 1 ? 'less than 1 day' : `${days} ${days === 1 ? 'day' : 'days'}`,
			...(run.phase.graceEnd !== null ? { stopAt: instantText(run.phase.graceEnd) } : {}),
			...(run.phase.stoppedAt !== null ? { stoppedAt: instantText(run.phase.stoppedAt) } : {}),
		};
		const to = [...new Set([contacts.merchantEmail, ...contacts.adminEmails].filter((e) => typeof e === 'string'))];
		for (const address of to) await mail({ to: /** @type {string} */ (address), template, data });
	};

	// ------------------------------------------------------------------------------------------------ views

	/**
	 * Credits charged in the current UTC month, today included.
	 * @param {Awaited<ReturnType<typeof check>>} checked
	 * @param {{ productId?: string | null }} [filter]
	 */
	const spentThisMonth = async ({ merchantId, now, cut, run }, { productId = null } = {}) => {
		const written = await ledger.sum(merchantId, {
			type: 'day_charge',
			day: { $gte: dayOf(floorMonth(now)) },
			...(productId ? { productId } : {}),
		});
		const today = run.charges
			.filter((c) => c.hour >= cut && (!productId || c.productId === productId))
			.reduce((s, c) => s + c.amount, 0);
		return -written + today;
	};

	/**
	 * Check a merchant and work out its status (0.5.5). Suspension comes from the money history only, the same one
	 * that stops the charging, so a product never refuses calls for hours that are still charged (or the reverse).
	 * @param {string} merchantId
	 */
	const statusOf = async (merchantId) => {
		const checked = await check(merchantId);
		const status = merchantStatusOf({ suspended: checked.run.suspended, billingState: checked.state });
		return { checked, status };
	};

	/**
	 * The money summary of a merchant after a check: status, balance, daily spend, days left, grace and stop times,
	 * spent this month and every product on a website with its status and cost.
	 * @param {string} merchantId
	 */
	const summary = async (merchantId) => {
		const { checked, status } = await statusOf(merchantId);
		const { run } = checked;
		return {
			merchantId,
			status,
			balance: run.balance,
			dailySpend: run.dailySpend,
			daysLeft: daysLeftOf(run),
			lowBalance: isLowBalance({ ...run, lowBalanceDays: rules().lowBalanceDays }),
			graceEnd: iso(run.phase.graceEnd),
			stoppedAt: iso(run.phase.stoppedAt),
			spentThisMonth: await spentThisMonth(checked),
			products: run.products
				.filter((p) => p.added)
				.map((p) => ({
					websiteId: p.websiteId,
					productId: p.productId,
					status: productStatusOf({ added: true, merchantStatus: status }),
					featuresOn: p.on,
					hourlyCost: p.hourlyCost,
					dailyCost: 24 * p.hourlyCost,
				})),
		};
	};

	/**
	 * Feature names per product (0.5.11): the name in the current price list, else in the last one that had it.
	 * @param {readonly Doc[]} lists ascending by time
	 */
	const featureNames = (lists) => {
		/** @type {Map<string, Map<string, string>>} */
		const names = new Map();
		for (const list of lists) {
			const own = names.get(list.productId) ?? new Map();
			for (const f of list.features) own.set(f.key, f.name);
			names.set(list.productId, own);
		}
		return names;
	};

	/**
	 * Labels of the products and websites in rows (removed websites keep their id when they cannot be read).
	 * @param {readonly { websiteId: string, productId: string }[]} rows
	 */
	const labels = async (rows) => {
		/** @type {Map<string, string>} */
		const products = new Map();
		/** @type {Map<string, string>} */
		const domains = new Map();
		for (const productId of new Set(rows.map((r) => r.productId))) products.set(productId, await deps.productName(productId));
		for (const websiteId of new Set(rows.map((r) => r.websiteId))) {
			const website = await Promise.resolve(deps.getWebsite(websiteId)).catch(() => null);
			domains.set(websiteId, String(website?.domain ?? websiteId));
		}
		return { products, domains };
	};

	/**
	 * Usage (0.5.11): one row per product × website × UTC day × feature with hours charged and credits (today's rows
	 * are live), and the daily totals for a chart.
	 * @param {string} merchantId
	 * @param {{ from: string, to: string, websiteId?: string | null }} range UTC days, inclusive
	 */
	const usage = async (merchantId, { from, to, websiteId = null }) => {
		const checked = await check(merchantId);
		const written = await repo
			.ledgerOf(merchantId)
			.find({ merchantId, type: 'day_charge', day: { $gte: from, $lte: to }, ...(websiteId ? { websiteId } : {}) })
			.sort({ day: 1, seq: 1 })
			.toArray();
		const rows = written.flatMap((e) =>
			(e.details?.lines ?? []).map((/** @type {{ feature: string, hours: number, amount: number }} */ line) => ({
				day: e.day,
				websiteId: e.websiteId,
				productId: e.productId,
				feature: line.feature,
				hours: line.hours,
				amount: line.amount,
			})),
		);
		const today = dayOf(checked.cut);
		if (today >= from && today <= to)
			rows.push(
				...usageRows(checked.run.charges.filter((c) => c.hour >= checked.cut && (!websiteId || c.websiteId === websiteId))),
			);
		const names = featureNames(await repo.priceListsOf([...new Set(rows.map((r) => r.productId))], new Date(checked.now)));
		const { products, domains } = await labels(rows);
		/** @type {Map<string, number>} */
		const perDay = new Map();
		for (const row of rows) perDay.set(row.day, (perDay.get(row.day) ?? 0) + row.amount);
		return {
			from,
			to,
			total: rows.reduce((s, r) => s + r.amount, 0),
			days: daysBetween(from, to).map((day) => ({ day, amount: perDay.get(day) ?? 0 })),
			rows: rows.map((r) => ({
				...r,
				product: products.get(r.productId) ?? r.productId,
				domain: domains.get(r.websiteId) ?? r.websiteId,
				featureName: names.get(r.productId)?.get(r.feature) ?? r.feature,
			})),
		};
	};

	/**
	 * A receipt as shown; the amount paid only to admins (0.5.8).
	 * @param {Doc} e @param {boolean} forAdmin @param {Map<string, { name: string, deleted: boolean }>} [names]
	 */
	const receiptView = (e, forAdmin, names) => ({
		receiptId: e._id,
		merchantId: e.merchantId,
		...(names ? { merchantName: names.get(e.merchantId)?.name ?? null } : {}),
		at: e.at.toISOString(),
		credits: e.amount,
		method: e.details?.method ?? null,
		reference: e.reference ?? null,
		...(forAdmin ? { amountPaid: e.details?.amountPaid ?? null } : {}),
	});

	/**
	 * A merchant's receipts, newest first.
	 * @param {string} merchantId @param {{ forAdmin: boolean }} viewer
	 */
	const receiptsOf = async (merchantId, { forAdmin }) =>
		(await repo.ledgerOf(merchantId).find({ merchantId, type: 'receipt' }).sort({ seq: -1 }).limit(500).toArray()).map((e) =>
			receiptView(e, forAdmin),
		);

	/**
	 * A merchant's day charges, newest first (admin Credits tab).
	 * @param {string} merchantId
	 */
	const dayChargesOf = async (merchantId) => {
		const entries = await repo
			.ledgerOf(merchantId)
			.find({ merchantId, type: 'day_charge' })
			.sort({ day: -1, seq: -1 })
			.limit(400)
			.toArray();
		const { products, domains } = await labels(/** @type {any} */ (entries));
		return entries.map((e) => ({
			day: e.day,
			websiteId: e.websiteId,
			domain: domains.get(e.websiteId) ?? e.websiteId,
			productId: e.productId,
			product: products.get(e.productId) ?? e.productId,
			credits: -e.amount,
			lines: e.details?.lines ?? [],
		}));
	};

	/**
	 * Add credits as a receipt (Owner and Finance). The merchant is checked first, so the receipt pays the debt from
	 * an up-to-date balance; a receipt that brings it above 0 ends grace or a stop at once.
	 *
	 * The request's `Idempotency-Key` names the receipt (`entryKey`, unique per merchant), so a repeat of a request the
	 * Portal saved, even one whose answer was lost, returns the saved receipt and adds nothing (receipts are never
	 * voided, 0.5.8). Once the receipt is saved, nothing after it (summary, notices, Activity, email) can fail the
	 * request: a failure there is logged.
	 * @param {{ merchantId: string, amount: number, amountPaid: string, method: string, reference: string | null,
	 *   idempotencyKey?: string | null } & Caller} input
	 */
	const addReceipt = async ({
		merchantId,
		amount,
		amountPaid,
		method,
		reference,
		idempotencyKey = null,
		actor,
		requestId = null,
		ip = null,
	}) => {
		const merchant = await deps.getMerchant(merchantId);
		const before = await check(merchantId);
		const entryKey = idempotencyKey
			? `receipt:key:${sha256Hex(`${actor.type}:${actor.id}\n${idempotencyKey}`)}`
			: `receipt:${createId('rct', { randomBytes: ctx.randomBytes })}`;
		const { appended } = await ledger.append(merchantId, [
			{
				type: 'receipt',
				amount,
				entryKey,
				reference,
				actor: { type: actor.type, id: actor.id },
				details: { amountPaid, method },
			},
		]);
		const entry = /** @type {Doc} */ (appended[0] ?? (await repo.ledgerOf(merchantId).findOne({ merchantId, entryKey })));
		const same =
			entry.amount === amount &&
			entry.reference === (reference ?? null) &&
			entry.details?.amountPaid === amountPaid &&
			entry.details?.method === method;
		if (!same) throw problem('idempotency_conflict', 'This Idempotency-Key was used for another receipt.');
		/**
		 * @template T
		 * @param {string} step @param {() => Promise<T>} run @returns {Promise<T | null>}
		 */
		const afterSaving = async (step, run) => {
			try {
				return await run();
			} catch (error) {
				ctx.logger.warn('receipt saved; a later step failed', { merchantId, step, error });
				return null;
			}
		};
		const after = await afterSaving('summary', () => summary(merchantId));
		// a repeat: the receipt was saved, told and logged by the first request
		if (appended.length === 0) return { receipt: receiptView(entry, true), summary: after };
		// credits that end grace or a stop restart the products at once (PLAN 0.5.6)
		if ((before.state === 'grace' || before.state === 'stopped') && after?.status !== 'grace' && after?.status !== 'stopped')
			await afterSaving('status.changed', () => statusChanged(merchantId));
		await afterSaving('activity', () =>
			ctx.audit.record({
				actor: /** @type {any} */ (actor),
				action: 'credits.added',
				target: { type: 'merchant', id: merchantId, merchantId },
				after: { credits: amount, method, reference },
				requestId,
				ip,
			}),
		);
		await afterSaving('mail', async () => {
			const contacts = await deps.billingContacts(merchantId);
			if (contacts.merchantEmail && after)
				await mail({
					to: contacts.merchantEmail,
					template: 'credits_added',
					data: { merchantName: merchant.name, credits: creditsText(amount), balance: creditsText(after.balance) },
				});
		});
		return { receipt: receiptView(entry, true), summary: after };
	};

	// ------------------------------------------------------------------------------------------------ admin lists

	/**
	 * Summaries of the merchants on an admin page (each one checked; at most one page).
	 * @param {readonly string[]} merchantIds
	 */
	const summaries = async (merchantIds) => {
		const out = [];
		for (const merchantId of [...new Set(merchantIds)].slice(0, PAGE)) {
			const s = await summary(merchantId);
			out.push({
				merchantId,
				status: s.status,
				balance: s.balance,
				dailySpend: s.dailySpend,
				daysLeft: s.daysLeft,
				graceEnd: s.graceEnd,
				stoppedAt: s.stoppedAt,
			});
		}
		return out;
	};

	/** Merchants that need attention (low balance, in grace or stopped), checked now. */
	const attention = async () => {
		const stored = await repo.billingInStates(['low_balance', 'grace', 'stopped'], PAGE);
		const ids = stored.map((s) => String(s._id));
		const names = await deps.merchantNames(ids);
		const out = [];
		for (const s of await summaries(ids)) {
			const name = names.get(s.merchantId);
			if (name?.deleted) continue;
			if (s.status === 'low_balance' || s.status === 'grace' || s.status === 'stopped')
				out.push({ ...s, merchantName: name?.name ?? null });
		}
		return out;
	};

	/**
	 * All receipts, newest first (Credits and billing), filtered by merchant, UTC days and method.
	 * @param {{ from: string, to: string, merchantId?: string | null, method?: string | null }} query
	 */
	const allReceipts = async ({ from, to, merchantId = null, method = null }) => {
		const entries = await repo
			.allLedgers()
			.find({
				type: 'receipt',
				at: { $gte: new Date(Date.parse(from)), $lt: new Date(Date.parse(to) + 86_400_000) },
				...(merchantId ? { merchantId } : {}),
				...(method ? { 'details.method': method } : {}),
			})
			.sort({ at: -1 })
			.limit(500)
			.toArray();
		const names = await deps.merchantNames(entries.map((e) => String(e.merchantId)));
		return entries.map((e) => receiptView(e, true, names));
	};

	/** Credits every receipt added in the current UTC month (the admin Overview), summed in the database. */
	const creditsAddedThisMonth = async () => {
		const [row] = await repo
			.allLedgers()
			.aggregate([
				{ $match: { type: 'receipt', at: { $gte: new Date(floorMonth(ctx.now())) } } },
				{ $group: { _id: null, credits: { $sum: '$amount' } } },
			])
			.toArray();
		return Number(row?.credits ?? 0);
	};

	/**
	 * Written day charges grouped by day, merchant or product over UTC days (Credits and billing).
	 * @param {{ from: string, to: string, by: 'day' | 'merchant' | 'product' }} query
	 */
	const charges = async ({ from, to, by }) => {
		const field = by === 'day' ? '$day' : by === 'merchant' ? '$merchantId' : '$productId';
		const rows = await repo
			.allLedgers()
			.aggregate([
				{ $match: { type: 'day_charge', day: { $gte: from, $lte: to } } },
				{ $group: { _id: field, amount: { $sum: '$amount' } } },
				{ $sort: { _id: 1 } },
			])
			.toArray();
		const keys = rows.map((r) => String(r._id));
		/** @type {Map<string, string>} */
		const label = new Map();
		if (by === 'merchant')
			for (const [id, name] of await deps.merchantNames(keys))
				label.set(id, `${name.name}${name.deleted ? ' (deleted)' : ''}`);
		if (by === 'product') for (const productId of keys) label.set(productId, await deps.productName(productId));
		return {
			from,
			to,
			by,
			rows: rows.map((r) => ({
				key: String(r._id),
				label: label.get(String(r._id)) ?? String(r._id),
				credits: -Number(r.amount),
			})),
		};
	};

	return Object.freeze({
		recordPriceList,
		recordProductAdded: productChange('added'),
		recordProductRemoved: productChange('removed'),
		recordSwitches,
		recordMerchantStatus,
		check,
		statusOf,
		summary,
		usage,
		receiptsOf,
		dayChargesOf,
		addReceipt,
		summaries,
		attention,
		allReceipts,
		creditsAddedThisMonth,
		charges,
		spentThisMonth,
	});
};
/** @typedef {ReturnType<typeof createBilling>} Billing */
