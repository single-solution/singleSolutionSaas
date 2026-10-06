/**
 * Credits (staff only), balance, statements, the live meter and spend policies. Balance, meter and statement reads
 * settle the merchant's due hours first (settlement on read, F.19: there is no cron), so a read never lags the ledger
 * by more than the current hour.
 * @module
 */
import { createId } from '@ss/contracts';
import { hoursRemaining, projectedMonth } from '@ss/entitlements';
import { problem } from '../../../infra/http.js';
import { CHARGE_TYPES, LEDGER_TYPES } from '../core/ledger.js';
import { checkCreditOperation, checkSpendPolicy } from '../core/validate.js';
import { runsNextHour } from '../core/subscription.js';

/** @typedef {import('../../../infra/modules.js').ModuleContext} ModuleContext */
/** @typedef {import('../repo.js').CommerceRepo} CommerceRepo */
/** @typedef {import('./deps.js').Deps} Deps */
/** @typedef {import('./ledger.js').Ledger} Ledger */
/** @typedef {import('./settlement.js').Settlement} Settlement */
/** @typedef {import('./subscriptions.js').Caller} Caller */
/** @typedef {Record<string, any>} Doc */

/** Time budget of the settlement on read (balance, meter, statement, product document and usage calls). */
export const LAZY_SETTLEMENT_BUDGET_MS = 2_000;

/**
 * Public view of a ledger entry.
 * @param {Doc} e
 */
export const entryView = (e) => ({
	entryId: e._id,
	seq: e.seq,
	type: e.type,
	amountMillicredits: e.amount,
	at: new Date(e.at).toISOString(),
	periodKey: e.periodKey ?? null,
	periodStart: e.periodStart ? new Date(e.periodStart).toISOString() : null,
	subscriptionId: e.subscriptionId ?? null,
	websiteId: e.websiteId ?? null,
	appId: e.appId ?? null,
	reference: e.reference ?? null,
	note: e.note ?? null,
	details: e.details ?? null,
	hash: e.hash,
});

/**
 * @param {Doc} p
 */
const policyView = (p) => ({
	policyId: p._id,
	merchantId: p.merchantId,
	scope: p.scope,
	websiteId: p.websiteId ?? null,
	window: p.window,
	limitMillicredits: p.limit,
	timeZone: p.timeZone,
});

/**
 * @param {{ ctx: ModuleContext, repo: CommerceRepo, deps: Deps, ledger: Ledger, settlement: Settlement }} input
 */
export const createMoney = ({ ctx, repo, deps, ledger, settlement }) => {
	/**
	 * Settlement on read: settle this merchant's complete hours up to now (idempotent per `periodKey`), then evaluate
	 * its low-balance and spend-limit holds, bounded by {@link LAZY_SETTLEMENT_BUDGET_MS} and `MAX_HOURS_PER_PASS` per
	 * subscription. A failure never fails the read; the next read continues where this one stopped.
	 * @param {string} merchantId
	 */
	const settleDue = async (merchantId) => {
		try {
			await settlement.runSettlement({ merchantId, deadline: ctx.now() + LAZY_SETTLEMENT_BUDGET_MS, marginMs: 0 });
		} catch (error) {
			ctx.logger.warn('lazy settlement failed', { merchantId, error });
		}
	};

	/** @param {Caller} caller */
	const assertStaff = (caller) => {
		const actor = /** @type {any} */ (caller.actor);
		if (!actor || (actor.type !== 'system' && !(actor.type === 'staff' && ctx.rbac.can(actor, 'platform.credits.adjust'))))
			throw problem('forbidden', 'Only staff can move credits.');
	};

	/**
	 * @param {'credit' | 'adjustment' | 'refund'} kind
	 * @param {{ merchantId: string, amountMillicredits: number, reference: string, note: string } & Caller} input
	 */
	const staffEntry = async (kind, { merchantId, amountMillicredits, reference, note, ...caller }) => {
		assertStaff(caller);
		const checked = checkCreditOperation(kind, { amountMillicredits, reference, note });
		if (!checked.ok) throw problem('validation_failed', 'The credit operation is invalid.', { errors: checked.errors });
		await deps.getMerchant(merchantId);
		const type = kind === 'credit' ? 'deposit' : kind;
		const amount = kind === 'refund' ? -checked.value.amountMillicredits : checked.value.amountMillicredits;
		const entryKey = `${type}:${checked.value.reference}`;
		const result = await ledger.append(
			merchantId,
			[
				{
					type,
					amount,
					entryKey,
					reference: checked.value.reference,
					note: checked.value.note,
					actor: /** @type {any} */ (caller.actor),
				},
			],
			{
				guard: (account) => {
					if (kind === 'refund' && account.balance < checked.value.amountMillicredits)
						throw problem('conflict', 'A refund cannot exceed the current balance.');
				},
			},
		);
		const [entry] = result.appended;
		if (!entry) {
			const existing = await ledger.byKey(merchantId, entryKey);
			if (!existing || existing.amount !== amount)
				throw problem('conflict', 'This reference was already used with a different amount.');
			return { entry: entryView(existing), balanceMillicredits: await ledger.balance(merchantId), duplicate: true };
		}
		await ctx.audit.record({
			actor: /** @type {any} */ (caller.actor),
			action: `credits.${kind === 'credit' ? 'added' : kind === 'adjustment' ? 'adjusted' : 'refunded'}`,
			target: { type: 'merchant', id: merchantId, merchantId },
			after: {
				amountMillicredits: amount,
				reference: checked.value.reference,
				entryId: entry._id,
				balanceMillicredits: result.balance,
			},
			requestId: caller.requestId ?? null,
			ip: caller.ip ?? null,
			reason: checked.value.note,
		});
		await settlement.applyBalanceRules(merchantId);
		return { entry: entryView(entry), balanceMillicredits: result.balance, duplicate: false };
	};

	/**
	 * Live meter: burn per hour now, hours remaining, month to date and projection.
	 * @param {string} merchantId
	 */
	const meter = async (merchantId) => {
		await settleDue(merchantId);
		const now = ctx.now();
		const balance = await ledger.balance(merchantId);
		const subs = await repo.subscriptionsOfMerchant(merchantId, { live: true });
		const lines = [];
		for (const sub of subs)
			lines.push({
				subscriptionId: sub._id,
				websiteId: sub.websiteId,
				appId: sub.appId,
				status: sub.status,
				running: runsNextHour(sub),
				burnRatePerHour: await settlement.burnOf(sub, now),
			});
		const burnRatePerHour = lines.reduce((s, l) => s + l.burnRatePerHour, 0);
		const d = new Date(now);
		const monthStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
		const monthToDate =
			-(await ledger.sum(merchantId, { type: { $in: [...CHARGE_TYPES] }, periodStart: { $gte: monthStart } })) || 0;
		const projection = projectedMonth({ monthToDate, burnRatePerHour, now });
		return {
			merchantId,
			at: d.toISOString(),
			balanceMillicredits: balance,
			burnRatePerHour,
			hoursRemaining: hoursRemaining({ balance, burnRatePerHour }),
			monthToDate,
			projectedMonth: projection.projectedTotal,
			periodEnd: projection.periodEnd,
			subscriptions: lines,
		};
	};

	/**
	 * Statement of `[from, to)`: entries, totals per type and (merchant-wide only) opening/closing balances.
	 * @param {string} merchantId
	 * @param {{ from: number, to: number, websiteId?: string | null }} range
	 */
	const statement = async (merchantId, { from, to, websiteId = null }) => {
		await settleDue(merchantId);
		const entries = await ledger.entries(merchantId, { from, to, websiteId, limit: 20_000 });
		/** @type {Record<string, number>} */
		const totals = Object.fromEntries(LEDGER_TYPES.map((t) => [t, 0]));
		for (const e of entries) totals[e.type] = (totals[e.type] ?? 0) + e.amount;
		const net = entries.reduce((s, e) => s + e.amount, 0);
		const opening = websiteId ? null : await ledger.sum(merchantId, { at: { $lt: new Date(from) } });
		return {
			merchantId,
			websiteId,
			from: new Date(from).toISOString(),
			to: new Date(to).toISOString(),
			openingBalanceMillicredits: opening,
			closingBalanceMillicredits: opening === null ? null : opening + net,
			netMillicredits: net,
			totals,
			entries: entries.map(entryView),
		};
	};

	/**
	 * @param {string} merchantId @param {unknown} input @param {Caller} caller
	 */
	const createPolicy = async (merchantId, input, caller) => {
		const checked = checkSpendPolicy(input);
		if (!checked.ok) throw problem('validation_failed', 'The spend policy is invalid.', { errors: checked.errors });
		const value = checked.value;
		if (value.websiteId) {
			const website = await deps.getWebsite(value.websiteId);
			if (website.merchantId !== merchantId) throw problem('not_found', 'No such website.');
		}
		const doc = {
			_id: createId('spc', { randomBytes: ctx.randomBytes }),
			scope: value.scope,
			websiteId: value.websiteId,
			window: value.window,
			limit: value.limit,
			timeZone: value.timeZone,
		};
		try {
			await repo.policyOps(merchantId).insertOne(doc);
		} catch (error) {
			if (repo.isDuplicateKey(error)) throw problem('conflict', 'A cap for this scope and window already exists.');
			throw error;
		}
		await auditPolicy(caller, merchantId, 'spend_policy.created', null, doc);
		await settlement.evaluateSpend(merchantId);
		return policyView({ ...doc, merchantId });
	};

	/**
	 * @param {Caller} caller @param {string} merchantId @param {string} action @param {unknown} before @param {unknown} after
	 */
	const auditPolicy = (caller, merchantId, action, before, after) =>
		ctx.audit.record({
			actor: /** @type {any} */ (caller.actor),
			action,
			target: { type: 'spend_policy', id: String(/** @type {any} */ (after ?? before)?._id), merchantId },
			before,
			after,
			requestId: caller.requestId ?? null,
			ip: caller.ip ?? null,
		});

	/**
	 * Change a cap's limit / time zone.
	 * @param {string} merchantId @param {string} policyId @param {unknown} input @param {Caller} caller
	 */
	const updatePolicy = async (merchantId, policyId, input, caller) => {
		const ops = repo.policyOps(merchantId);
		const before = await ops.findOne({ merchantId, _id: policyId });
		if (!before) throw problem('not_found', 'No such spend policy.');
		const checked = checkSpendPolicy({
			scope: before.scope,
			window: before.window,
			...(before.websiteId ? { websiteId: before.websiteId } : {}),
			...(typeof input === 'object' && input !== null ? input : {}),
		});
		if (!checked.ok) throw problem('validation_failed', 'The spend policy is invalid.', { errors: checked.errors });
		if (
			checked.value.scope !== before.scope ||
			checked.value.window !== before.window ||
			checked.value.websiteId !== (before.websiteId ?? null)
		)
			throw problem('validation_failed', 'Only limit and timeZone can change.', {
				errors: [{ path: '', message: 'scope, websiteId and window are fixed' }],
			});
		const after = await ops.findOneAndUpdate(
			{ merchantId, _id: policyId },
			{ $set: { limit: checked.value.limit, timeZone: checked.value.timeZone } },
			{ returnDocument: 'after' },
		);
		await auditPolicy(caller, merchantId, 'spend_policy.updated', before, after);
		await settlement.evaluateSpend(merchantId);
		return policyView(/** @type {Doc} */ (after));
	};

	/**
	 * @param {string} merchantId @param {string} policyId @param {Caller} caller
	 */
	const deletePolicy = async (merchantId, policyId, caller) => {
		const ops = repo.policyOps(merchantId);
		const before = await ops.findOne({ merchantId, _id: policyId });
		if (!before) throw problem('not_found', 'No such spend policy.');
		await ops.deleteOne({ merchantId, _id: policyId });
		await auditPolicy(caller, merchantId, 'spend_policy.deleted', before, null);
		await settlement.evaluateSpend(merchantId);
	};

	return Object.freeze({
		settleDue,
		/** @param {Parameters<typeof staffEntry>[1]} input */
		addCredits: (input) => staffEntry('credit', input),
		/** @param {Parameters<typeof staffEntry>[1]} input */
		adjust: (input) => staffEntry('adjustment', input),
		/** @param {Parameters<typeof staffEntry>[1]} input */
		refund: (input) => staffEntry('refund', input),
		/** @param {string} merchantId */
		balance: async (merchantId) => {
			await settleDue(merchantId);
			return { merchantId, balanceMillicredits: await ledger.balance(merchantId), at: new Date(ctx.now()).toISOString() };
		},
		statement,
		meter,
		/** @param {string} merchantId */
		listPolicies: async (merchantId) => (await repo.policiesOf(merchantId)).map(policyView),
		createPolicy,
		updatePolicy,
		deletePolicy,
	});
};
/** @typedef {ReturnType<typeof createMoney>} Money */
