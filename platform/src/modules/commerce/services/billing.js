/**
 * Credits and billing (PLAN 0.5): the money histories, the check, receipts and the money views.
 *
 * - **Histories** (0.5.7 a), stamped with Portal time: price lists per product, feature reports and status changes per
 *   merchant. Step 5 of the build order fills them from product reports; until then they are written through
 *   `recordPriceList`, `recordProductAdded` / `recordProductRemoved` and `recordSwitches` (tests) and by merchant
 *   suspension and resumption.
 * - **Check** (0.5.7): replays the time since the merchant was last settled with the pure money function, writes the
 *   day charges of complete UTC days, records grace starts and stops once, caches the balance and billing state, and
 *   sends a billing e-mail when the merchant enters a state (an atomic compare-and-set on the stored state, so two checks
 *   send one e-mail). It runs when a Portal page shows a merchant; nothing is scheduled.
 * - **Receipts** (0.5.8): the only way credits are added; never edited, voided or reversed.
 * @module
 */
import { createId } from '@ss/contracts';
import { problem } from '../../../infra/http.js';
import { afterResponse } from '../../../infra/request-scope.js';
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
/** @typedef {Record<string, any>} Doc */
/** @typedef {{ type: string, id: string, name?: string | null }} Actor */
/** @typedef {{ actor: Actor, requestId?: string | null, ip?: string | null }} Caller */

export const SYSTEM_ACTOR = Object.freeze({ type: 'system', id: 'commerce' });

/** Billing states that send an e-mail when entered, and their template. */
const STATE_MAILS = Object.freeze({ low_balance: 'low_balance', grace: 'grace_started', stopped: 'products_stopped' });
/** Merchants shown per admin list (lists are paged at 50, PLAN 0.6). */
export const PAGE = 50;
const KEY = /^[a-z][a-z0-9_]{0,63}$/;

/** @param {unknown} value */
const ms = (value) => (value instanceof Date ? value.getTime() : typeof value === 'number' ? value : null);
/** @param {number | null} value */
const date = (value) => (value === null ? null : new Date(value));
/** @param {number | null} value */
const iso = (value) => (value === null ? null : new Date(value).toISOString());
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
 * @param {{ ctx: ModuleContext, repo: CommerceRepo, deps: Deps, ledger: Ledger }} input
 */
export const createBilling = ({ ctx, repo, deps, ledger }) => {
	const rules = () => ctx.config.settings.billing;

	/**
	 * Send a Portal e-mail right after the response; skipped without SMTP settings (PLAN 0.5.10).
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
	 * Store a product's price list (one hourly price per feature, never negative); it applies from now on.
	 * @param {{ appId: string, features: readonly { key: string, name: string, price: number }[] }} input
	 */
	const recordPriceList = async ({ appId, features }) => {
		const valid =
			Array.isArray(features) &&
			features.every(
				(f) =>
					KEY.test(f?.key) &&
					typeof f.name === 'string' &&
					f.name.length > 0 &&
					f.name.length <= 120 &&
					Number.isSafeInteger(f.price) &&
					f.price >= 0,
			) &&
			new Set(features.map((f) => f.key)).size === features.length;
		if (!valid) throw problem('validation_failed', 'The price list is invalid.');
		const doc = {
			appId,
			at: new Date(ctx.now()),
			features: features.map((f) => ({ key: f.key, name: f.name, price: f.price })),
		};
		await repo.insertPriceList(doc);
		return { appId, at: doc.at.toISOString(), features: doc.features };
	};

	/**
	 * @param {'added' | 'removed'} kind
	 * @returns {(input: { merchantId: string, websiteId: string, appId: string }) => Promise<void>}
	 */
	const productChange =
		(kind) =>
		async ({ merchantId, websiteId, appId }) => {
			await repo.appendHistory(merchantId, { kind, at: new Date(ctx.now()), websiteId, appId });
		};

	/**
	 * Store the last accepted feature report of a product on a website: the keys of its switched-on features.
	 * @param {{ merchantId: string, websiteId: string, appId: string, on: readonly string[] }} input
	 */
	const recordSwitches = async ({ merchantId, websiteId, appId, on }) => {
		if (!Array.isArray(on) || !on.every((key) => KEY.test(key)))
			throw problem('validation_failed', 'The feature report is invalid.');
		await repo.appendHistory(merchantId, {
			kind: 'switches',
			at: new Date(ctx.now()),
			websiteId,
			appId,
			on: [...new Set(on)].sort(),
		});
	};

	/**
	 * Merchant suspended or resumed (identity hook): suspended hours are never charged.
	 * @param {string} merchantId @param {'active' | 'suspended'} status
	 */
	const recordMerchantStatus = (merchantId, status) =>
		repo.appendHistory(merchantId, { kind: status === 'suspended' ? 'suspended' : 'resumed', at: new Date(ctx.now()) });

	// ------------------------------------------------------------------------------------------------ the check

	/**
	 * Inputs of the money function for a merchant up to `now`.
	 * @param {string} merchantId @param {number} now
	 */
	const inputsOf = async (merchantId, now) => {
		const history = await repo.historyOf(merchantId, new Date(now));
		const appIds = [...new Set(history.filter((h) => typeof h.appId === 'string').map((h) => String(h.appId)))];
		const lists = await repo.priceListsOf(appIds, new Date(now));
		/** @type {MoneyEvent[]} */
		const events = lists.map((l) => ({ type: 'prices', at: l.at.getTime(), appId: l.appId, features: l.features }));
		/** @type {Record<string, number>} */
		const graceEnds = {};
		for (const h of history) {
			const at = h.at.getTime();
			if (h.kind === 'added' || h.kind === 'removed')
				events.push({ type: h.kind, at, websiteId: h.websiteId, appId: h.appId });
			else if (h.kind === 'switches') events.push({ type: 'switches', at, websiteId: h.websiteId, appId: h.appId, on: h.on });
			else if (h.kind === 'suspended' || h.kind === 'resumed') events.push({ type: h.kind, at });
			else if (h.kind === 'grace_started') graceEnds[String(at)] = h.graceEnd.getTime();
		}
		const earliest = history.length > 0 ? /** @type {Doc} */ (history[0]).at.getTime() : null;
		return { events, graceEnds, earliest, lists };
	};

	/**
	 * Run the check for one merchant (PLAN 0.5.7) and return the live money state.
	 * @param {string} merchantId
	 */
	const check = async (merchantId) => {
		const now = ctx.now();
		const stored = await repo.billingOf(merchantId);
		const { events, graceEnds, earliest, lists } = await inputsOf(merchantId, now);
		const from = stored?.settledThrough ? stored.settledThrough.getTime() : floorDay(earliest ?? now);
		const receipts = await repo
			.ledgerOf(merchantId)
			.find({ merchantId, type: 'receipt', at: { $gte: new Date(from) } })
			.sort({ seq: 1 })
			.toArray();
		const opening = await ledger.sum(merchantId, {
			$or: [{ type: 'day_charge' }, { type: 'receipt', at: { $lt: new Date(from) } }],
		});
		const cut = floorDay(now);
		const run = replay({
			from,
			to: now,
			cut,
			balance: opening,
			phase: phaseOf(stored?.phase),
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
			entryKey: `day:${d.websiteId}:${d.appId}:${d.day}`,
			day: d.day,
			websiteId: d.websiteId,
			appId: d.appId,
			actor: SYSTEM_ACTOR,
			details: { lines: d.lines },
		}));
		if (drafts.length > 0) await ledger.append(merchantId, drafts);
		for (const t of run.transitions) {
			if (t.type === 'grace_started')
				await repo.appendHistory(merchantId, {
					kind: 'grace_started',
					at: new Date(t.at),
					graceEnd: new Date(t.graceEnd),
					key: `${merchantId}:grace_started:${t.at}`,
				});
			else if (t.type === 'stopped')
				await repo.appendHistory(merchantId, { kind: 'stopped', at: new Date(t.at), key: `${merchantId}:stopped:${t.at}` });
		}

		const lowBalanceDays = rules().lowBalanceDays;
		const state = billingStateOf({ phase: run.phase, balance: run.balance, dailySpend: run.dailySpend, lowBalanceDays });
		const snapshot = /** @type {{ balance: number, phase: Phase }} */ (run.snapshot);
		const saved = await repo.updateBilling(
			merchantId,
			stored ? { settledThrough: stored.settledThrough, state: stored.state } : null,
			{
				settledThrough: new Date(Math.max(cut, from)),
				phase: storedPhase(snapshot.phase),
				state,
				balance: run.balance,
				dailySpend: run.dailySpend,
				checkedAt: new Date(now),
			},
		);
		const previous = stored?.state ?? 'active';
		if (saved && state !== previous && state in STATE_MAILS) await billingMail(merchantId, state, run);
		return { merchantId, now, cut, run, state, lists };
	};

	/**
	 * The e-mail of a billing state entered (to the merchant and every Owner and Finance admin).
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

	/** @param {string} merchantId */
	const suspendedNow = async (merchantId) => {
		try {
			return (await deps.getMerchant(merchantId)).status === 'suspended';
		} catch {
			return false;
		}
	};

	/**
	 * Credits charged in the current UTC month, today included.
	 * @param {Awaited<ReturnType<typeof check>>} checked
	 * @param {{ appId?: string | null }} [filter]
	 */
	const spentThisMonth = async ({ merchantId, now, cut, run }, { appId = null } = {}) => {
		const written = await ledger.sum(merchantId, {
			type: 'day_charge',
			day: { $gte: dayOf(floorMonth(now)) },
			...(appId ? { appId } : {}),
		});
		const today = run.charges.filter((c) => c.hour >= cut && (!appId || c.appId === appId)).reduce((s, c) => s + c.amount, 0);
		return -written + today;
	};

	/**
	 * The money summary of a merchant after a check: status, balance, daily spend, days left, grace and stop times,
	 * spent this month and every product on a website with its status and cost.
	 * @param {string} merchantId
	 */
	const summary = async (merchantId) => {
		const checked = await check(merchantId);
		const { run, state } = checked;
		const status = merchantStatusOf({ suspended: run.suspended || (await suspendedNow(merchantId)), billingState: state });
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
					appId: p.appId,
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
			const own = names.get(list.appId) ?? new Map();
			for (const f of list.features) own.set(f.key, f.name);
			names.set(list.appId, own);
		}
		return names;
	};

	/**
	 * Labels of the products and websites in rows (removed websites keep their id when they cannot be read).
	 * @param {readonly { websiteId: string, appId: string }[]} rows
	 */
	const labels = async (rows) => {
		/** @type {Map<string, string>} */
		const products = new Map();
		/** @type {Map<string, string>} */
		const domains = new Map();
		for (const appId of new Set(rows.map((r) => r.appId))) {
			const app = await Promise.resolve(deps.getApp(appId)).catch(() => null);
			products.set(appId, String(app?.name ?? app?.slug ?? appId));
		}
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
				appId: e.appId,
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
		const names = featureNames(checked.lists);
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
				product: products.get(r.appId) ?? r.appId,
				domain: domains.get(r.websiteId) ?? r.websiteId,
				featureName: names.get(r.appId)?.get(r.feature) ?? r.feature,
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
			appId: e.appId,
			product: products.get(e.appId) ?? e.appId,
			credits: -e.amount,
			lines: e.details?.lines ?? [],
		}));
	};

	/**
	 * Add credits as a receipt (Owner and Finance). The merchant is checked first, so the receipt pays the debt from
	 * an up-to-date balance; a receipt that brings it above 0 ends grace or a stop at once.
	 * @param {{ merchantId: string, amount: number, amountPaid: string, method: string, reference: string | null } & Caller} input
	 */
	const addReceipt = async ({ merchantId, amount, amountPaid, method, reference, actor, requestId = null, ip = null }) => {
		const merchant = await deps.getMerchant(merchantId);
		await check(merchantId);
		const { appended } = await ledger.append(merchantId, [
			{
				type: 'receipt',
				amount,
				entryKey: `receipt:${createId('rct', { randomBytes: ctx.randomBytes })}`,
				reference,
				actor: { type: actor.type, id: actor.id },
				details: { amountPaid, method },
			},
		]);
		const entry = /** @type {Doc} */ (appended[0]);
		const after = await summary(merchantId);
		await ctx.audit.record({
			actor: /** @type {any} */ (actor),
			action: 'credits.added',
			target: { type: 'merchant', id: merchantId, merchantId },
			after: { credits: amount, method, reference },
			requestId,
			ip,
		});
		const contacts = await deps.billingContacts(merchantId);
		if (contacts.merchantEmail)
			await mail({
				to: contacts.merchantEmail,
				template: 'credits_added',
				data: { merchantName: merchant.name, credits: creditsText(amount), balance: creditsText(after.balance) },
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

	/**
	 * Written day charges grouped by day, merchant or product over UTC days (Credits and billing).
	 * @param {{ from: string, to: string, by: 'day' | 'merchant' | 'product' }} query
	 */
	const charges = async ({ from, to, by }) => {
		const field = by === 'day' ? '$day' : by === 'merchant' ? '$merchantId' : '$appId';
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
		if (by === 'product')
			for (const appId of keys) {
				const app = await Promise.resolve(deps.getApp(appId)).catch(() => null);
				label.set(appId, String(app?.name ?? app?.slug ?? appId));
			}
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
		summary,
		usage,
		receiptsOf,
		dayChargesOf,
		addReceipt,
		summaries,
		attention,
		allReceipts,
		charges,
		spentThisMonth,
	});
};
/** @typedef {ReturnType<typeof createBilling>} Billing */
