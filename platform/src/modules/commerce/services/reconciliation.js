/**
 * Nightly reconciliation (cron `reconciliation`), resumable across runs of the same UTC day:
 * 1. per subscription, the expected hourly buckets of the last {@link WINDOW_DAYS} days up to its cursor (recomputed
 *    with `planSettlement` from the immutable timeline, pauses and pins) against the ledger's settlement keys and
 *    amounts (`reconcile`), plus metered entries for hours that were not billable;
 * 2. per merchant, the hash chain and the cached balance against Σ ledger.
 * Every discrepancy becomes an alert record and an audit entry; each run chunk appends a report.
 * @module
 */
import { createId } from '@ss/contracts';
import { floorHour } from '@ss/entitlements';
import { hasFindings, reconcileWindow } from '../core/billing.js';
import { SYSTEM_ACTOR } from './subscriptions.js';

/** @typedef {import('../../../infra/modules.js').ModuleContext} ModuleContext */
/** @typedef {import('../repo.js').CommerceRepo} CommerceRepo */
/** @typedef {import('./ledger.js').Ledger} Ledger */
/** @typedef {import('./settlement.js').Settlement} Settlement */
/** @typedef {Record<string, any>} Doc */

export const WINDOW_DAYS = 35;
const DAY_MS = 86_400_000;
const BATCH = 100;
const STATE_ID = 'reconciliation';
const DEADLINE_MARGIN_MS = 5_000;

/**
 * @param {{ ctx: ModuleContext, repo: CommerceRepo, ledger: Ledger, settlement: Settlement }} input
 */
export const createReconciliation = ({ ctx, repo, ledger, settlement }) => {
	/**
	 * @param {string} kind @param {string} merchantId @param {string | null} subscriptionId @param {unknown} details
	 */
	const discrepancy = async (kind, merchantId, subscriptionId, details) => {
		await settlement.raiseAlert({ kind, merchantId, subscriptionId, details });
		await ctx.audit.record({
			actor: SYSTEM_ACTOR,
			action: `commerce.${kind}`,
			target: subscriptionId
				? { type: 'subscription', id: subscriptionId, merchantId }
				: { type: 'merchant', id: merchantId, merchantId },
			after: details,
			reason: 'reconciliation',
		});
	};

	/**
	 * Reconcile one subscription's recent window.
	 * @param {Doc} sub
	 */
	const reconcileSubscription = async (sub) => {
		const to = new Date(sub.settledThrough).getTime();
		const from = Math.max(floorHour(new Date(sub.startedAt).getTime()), to - WINDOW_DAYS * DAY_MS);
		if (from >= to) return null;
		const { plan } = await settlement.planFor(sub, from, to);
		const entries = await repo
			.ledgerOf(sub.merchantId)
			.find({ merchantId: sub.merchantId, subscriptionId: sub._id, periodStart: { $gte: new Date(from), $lt: new Date(to) } })
			.toArray();
		return reconcileWindow({
			buckets: plan.buckets,
			entries: entries.map((e) => ({ type: e.type, periodKey: e.periodKey ?? null, amount: e.amount })),
		});
	};

	/**
	 * @param {{ deadline?: number, signal?: AbortSignal }} [options]
	 */
	const runReconciliation = async ({ deadline = Number.POSITIVE_INFINITY, signal } = {}) => {
		const now = ctx.now();
		const runKey = new Date(now).toISOString().slice(0, 10);
		const timeUp = () => signal?.aborted === true || ctx.now() > deadline - DEADLINE_MARGIN_MS;
		const saved = await repo.getState(STATE_ID);
		// an unfinished run (cut by its deadline) continues where it stopped, even on a later day; a new run starts
		// once the last one is done and the day changed
		/** @type {{ runKey: string, phase: 'subscriptions' | 'merchants' | 'done', cursor: string | null }} */
		const state =
			saved && (saved.runKey === runKey || saved.phase !== 'done')
				? { runKey: String(saved.runKey), phase: saved.phase, cursor: saved.cursor ?? null }
				: { runKey, phase: 'subscriptions', cursor: null };
		const stats = {
			runKey: state.runKey,
			subscriptions: 0,
			merchants: 0,
			discrepancies: 0,
			complete: true,
			phase: state.phase,
		};
		/** @type {unknown[]} */
		const found = [];
		if (state.phase === 'done') return { ...stats, alreadyDone: true };

		while (state.phase === 'subscriptions') {
			if (timeUp()) break;
			const batch = await repo.subscriptionsAfter(state.cursor, BATCH);
			if (batch.length === 0) {
				state.phase = 'merchants';
				state.cursor = null;
				break;
			}
			for (const sub of batch) {
				if (timeUp()) break;
				try {
					const findings = await reconcileSubscription(sub);
					if (findings && hasFindings(findings)) {
						stats.discrepancies += 1;
						found.push({ subscriptionId: sub._id, merchantId: sub.merchantId, findings });
						await discrepancy('reconciliation_drift', sub.merchantId, sub._id, findings);
					}
				} catch (error) {
					stats.discrepancies += 1;
					await discrepancy('reconciliation_failed', sub.merchantId, sub._id, {
						message: String(/** @type {Error} */ (error)?.message ?? error),
					});
				}
				stats.subscriptions += 1;
				state.cursor = sub._id;
			}
			await repo.setState(STATE_ID, state);
		}

		while (state.phase === 'merchants') {
			if (timeUp()) break;
			const batch = await repo.accountsAfter(state.cursor, BATCH);
			if (batch.length === 0) {
				state.phase = 'done';
				state.cursor = null;
				break;
			}
			for (const account of batch) {
				if (timeUp()) break;
				const merchantId = String(account._id);
				const result = await ledger.verify(merchantId);
				if (!result.ok) {
					stats.discrepancies += 1;
					found.push({ merchantId, chain: result.problems });
					await discrepancy('ledger_verification_failed', merchantId, null, {
						problems: result.problems,
						balance: result.balance,
					});
				}
				stats.merchants += 1;
				state.cursor = merchantId;
			}
			await repo.setState(STATE_ID, state);
		}
		await repo.setState(STATE_ID, state);
		stats.phase = state.phase;
		stats.complete = state.phase === 'done';
		await repo.insertReport({
			_id: createId('rec', { randomBytes: ctx.randomBytes }),
			at: new Date(ctx.now()),
			runKey: state.runKey,
			phase: state.phase,
			subscriptions: stats.subscriptions,
			merchants: stats.merchants,
			discrepancies: found.slice(0, 500),
		});
		return stats;
	};

	return Object.freeze({ runReconciliation, reconcileSubscription });
};
/** @typedef {ReturnType<typeof createReconciliation>} Reconciliation */
