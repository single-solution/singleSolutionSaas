/**
 * Ledger service (review A22): payments and refunds as append-only entries on the order, each guarded inside the
 * write — a payment never exceeds the balance due (unless overpayments are allowed), a refund never exceeds what is
 * still held, and two staff refunding at once can never pay out more than was received. Each entry publishes its
 * catalogued event (`order.paid@1`, `order.refunded@1` with the refunded lines, so stock and points follow). Once paid,
 * an order may confirm itself; once refunds cover everything received, it may move to the refunded status — both
 * only when the matrix lets the system make that move.
 */
import { confirmMoveOf, isPayOnDelivery, transitionOf } from '../core/lifecycle.js';
import { summarize, validateEntry } from '../core/ledger.js';
import { customerRef } from '../core/orders.js';
import { fail, invalid } from './context.js';

/**
 * @param {import('./context.js').Deps} deps
 * @param {import('./outbox.js').Outbox} outbox
 * @param {import('./lifecycle.js').Lifecycle} lifecycle
 */
export const createLedger = (deps, outbox, lifecycle) => {
	/**
	 * Confirm an order whose payments now cover what is due (the total, or the pay-on-delivery advance).
	 * @param {import('./context.js').Site} site
	 * @param {Record<string, any>} order
	 */
	const maybeConfirm = async (site, order) => {
		const { matrix, lifecycle: config } = site.settings;
		if (!config.confirm_on_payment || order.risk?.review === 'pending' || order.risk?.review === 'held') return order;
		const money = summarize(order);
		const due = isPayOnDelivery(matrix, order) ? Math.min(order.risk?.advance ?? 0, money.total) : money.total;
		if (money.netPaid < due || !confirmMoveOf(matrix, order.status)) return order;
		const moved = await lifecycle.move(site, order, matrix.initial.paid, { actor: { type: 'system', id: 'ledger' } });
		return moved.ok ? moved.order : order;
	};

	/**
	 * Record a payment.
	 * @param {import('./context.js').Site} site
	 * @param {string} id
	 * @param {unknown} input
	 * @param {import('./context.js').Actor} actor
	 * @param {{ entryId?: string, publish?: boolean }} [options] consumed events pass their own entry id and do not republish
	 */
	const pay = async (site, id, input, actor, { entryId, publish = true } = {}) => {
		const order = await site.repos.orders.get(id);
		if (!order) return fail('not_found', 'No such order.');
		const checked = validateEntry(input, 'payment', { methods: site.settings.methods, lines: order.lines });
		if (!checked.ok) return invalid(checked.errors);
		const entry = {
			id: entryId ?? deps.newId('pay'),
			amount: checked.value.amount,
			method: checked.value.method,
			reference: checked.value.reference,
			proofUrl: checked.value.proofUrl,
			note: checked.value.note,
			actor,
			at: checked.value.at ?? new Date(deps.now()),
		};
		if ((order.payments ?? []).some((/** @type {any} */ p) => p.id === entry.id))
			return { ok: true, order, entry, duplicate: true };
		const max = site.settings.ledger.max_entries_per_order;
		const pending = publish
			? [
					{
						key: `order.paid:${entry.id}`,
						kind: 'event',
						type: 'order.paid@1',
						data: {
							orderId: order.id,
							amount: { amount: entry.amount, currency: order.currency },
							method: entry.method,
							...(entry.reference ? { reference: entry.reference } : {}),
						},
					},
				]
			: [];
		const changed = await site.repos.orders.change(
			id,
			{
				'payments.id': { $ne: entry.id },
				$expr: {
					$and: [
						{ $lt: [{ $add: [{ $size: { $ifNull: ['$payments', []] } }, { $size: { $ifNull: ['$refunds', []] } }] }, max] },
						...(site.settings.ledger.allow_overpayment
							? []
							: [
									{
										$lte: [
											{ $add: [{ $ifNull: ['$paid', 0] }, entry.amount] },
											{ $add: ['$amounts.total', { $ifNull: ['$refunded', 0] }] },
										],
									},
								]),
					],
				},
			},
			{
				$inc: { paid: entry.amount, version: 1 },
				$push: { payments: entry, pending: { $each: pending } },
				$set: { pendingAt: new Date(deps.now()) },
			},
		);
		if (!changed) {
			const current = await site.repos.orders.get(id);
			if (current && (current.payments ?? []).some((/** @type {any} */ p) => p.id === entry.id))
				return { ok: true, order: current, entry, duplicate: true };
			if (current && (current.payments ?? []).length + (current.refunds ?? []).length >= max)
				return fail('ledger_full', 'The order has too many ledger entries.');
			return fail('overpayment', 'The payment is larger than the balance due.');
		}
		await outbox.flush(site, changed);
		await deps
			.audit({
				websiteId: site.websiteId,
				actor,
				action: 'order.payment_recorded',
				target: { orderId: id },
				after: { amount: entry.amount, method: entry.method },
			})
			.catch(() => undefined);
		const confirmed = await maybeConfirm(site, changed);
		return { ok: true, order: confirmed, entry, duplicate: false };
	};

	/**
	 * Record a refund (optionally with the refunded lines, so stock can follow).
	 * @param {import('./context.js').Site} site
	 * @param {string} id
	 * @param {unknown} input
	 * @param {import('./context.js').Actor} actor
	 * @param {{ entryId?: string, publish?: boolean }} [options] consumed events pass their own entry id and do not republish
	 */
	const refund = async (site, id, input, actor, { entryId, publish = true } = {}) => {
		const order = await site.repos.orders.get(id);
		if (!order) return fail('not_found', 'No such order.');
		const checked = validateEntry(input, 'refund', { methods: site.settings.methods, lines: order.lines });
		if (!checked.ok) return invalid(checked.errors);
		if (entryId && (order.refunds ?? []).some((/** @type {any} */ r) => r.id === entryId))
			return {
				ok: true,
				order,
				entry: (order.refunds ?? []).find((/** @type {any} */ r) => r.id === entryId),
				duplicate: true,
			};
		const held = summarize(order).refundable;
		if (checked.value.amount > held) return fail('refund_exceeds_paid', 'The refund is larger than what is held.');
		if (!site.settings.ledger.allow_partial_refunds && checked.value.amount !== held)
			return fail('partial_refund_disabled', 'Refunds must return everything held.');
		const entry = {
			id: entryId ?? deps.newId('rfd'),
			amount: checked.value.amount,
			method: checked.value.method,
			reference: checked.value.reference,
			proofUrl: checked.value.proofUrl,
			note: checked.value.note,
			lines: checked.value.lines,
			actor,
			at: checked.value.at ?? new Date(deps.now()),
		};
		const ref = customerRef(order);
		const refundedLines = checked.value.lines
			.map((part) => {
				const line = order.lines.find((/** @type {any} */ l) => l.id === part.lineId);
				const itemId = line?.itemId ?? line?.sku;
				return itemId
					? {
							itemId,
							...(line.variantId ? { variantId: line.variantId } : {}),
							...(line.sku ? { sku: line.sku } : {}),
							title: line.title,
							quantity: part.quantity,
							unitAmount: line.unitAmount,
							totalAmount: line.unitAmount * part.quantity,
						}
					: null;
			})
			.filter(Boolean);
		const max = site.settings.ledger.max_entries_per_order;
		const changed = await site.repos.orders.change(
			id,
			{
				'refunds.id': { $ne: entry.id },
				$expr: {
					$and: [
						{ $gte: [{ $subtract: [{ $ifNull: ['$paid', 0] }, { $ifNull: ['$refunded', 0] }] }, entry.amount] },
						{ $lt: [{ $add: [{ $size: { $ifNull: ['$payments', []] } }, { $size: { $ifNull: ['$refunds', []] } }] }, max] },
					],
				},
			},
			{
				$inc: { refunded: entry.amount, version: 1 },
				$push: {
					refunds: entry,
					pending: {
						$each: publish
							? [
									{
										key: `order.refunded:${entry.id}`,
										kind: 'event',
										type: 'order.refunded@1',
										data: {
											orderId: order.id,
											amount: { amount: entry.amount, currency: order.currency },
											...(entry.note ? { reason: entry.note } : {}),
											number: String(order.number).slice(0, 64),
											...(ref?.customerId ? { customerId: ref.customerId } : {}),
											...(ref ? { customer: ref } : {}),
											...(refundedLines.length > 0 ? { lines: refundedLines } : {}),
										},
									},
								]
							: [],
					},
				},
				$set: { pendingAt: new Date(deps.now()) },
			},
		);
		if (!changed) {
			const current = await site.repos.orders.get(id);
			if (current && (current.payments ?? []).length + (current.refunds ?? []).length >= max)
				return fail('ledger_full', 'The order has too many ledger entries.');
			return fail('refund_exceeds_paid', 'The refund is larger than what is held.');
		}
		await outbox.flush(site, changed);
		await deps
			.audit({
				websiteId: site.websiteId,
				actor,
				action: 'order.refund_recorded',
				target: { orderId: id },
				after: { amount: entry.amount, method: entry.method },
			})
			.catch(() => undefined);
		const money = summarize(changed);
		const target = site.settings.ledger.refunded_status;
		const move = target ? transitionOf(site.settings.matrix, changed.status, target) : null;
		if (money.refundState === 'full' && move && move.actors.includes('system')) {
			const moved = await lifecycle.move(site, changed, target, { actor: { type: 'system', id: 'ledger' } });
			if (moved.ok) return { ok: true, order: moved.order, entry };
		}
		return { ok: true, order: changed, entry };
	};

	/**
	 * Ledger entries across orders for reconciliation.
	 * @param {import('./context.js').Site} site
	 * @param {Record<string, string | undefined>} query `from`, `to` (ISO), `kind`, `method`, `limit`
	 */
	const entries = async (site, query) => {
		const date = (/** @type {string | undefined} */ value) => {
			if (!value) return null;
			const parsed = new Date(value);
			return Number.isNaN(parsed.getTime()) ? undefined : parsed;
		};
		const from = date(query.from);
		const to = date(query.to);
		if (from === undefined || to === undefined) return invalid([{ path: '/from', code: 'date_invalid' }]);
		const kind = query.kind === 'payment' || query.kind === 'refund' ? query.kind : null;
		const limit = Math.min(500, Math.max(1, Number.parseInt(query.limit ?? '100', 10) || 100));
		const rows = await site.repos.orders.ledger({ from, to, kind, method: query.method ?? null, limit });
		/** @type {Record<string, { payments: number, refunds: number, net: number }>} */
		const totals = {};
		for (const row of rows) {
			const sums = (totals[row.currency] ??= { payments: 0, refunds: 0, net: 0 });
			if (row.entry.kind === 'payment') sums.payments += row.entry.amount;
			else sums.refunds += row.entry.amount;
			sums.net = sums.payments - sums.refunds;
		}
		return {
			ok: true,
			items: rows.map((/** @type {any} */ row) => ({
				orderId: row.orderId,
				number: row.number,
				currency: row.currency,
				kind: row.entry.kind,
				id: row.entry.id,
				amount: row.entry.amount,
				method: row.entry.method,
				reference: row.entry.reference ?? null,
				at: new Date(row.entry.at).toISOString(),
				actor: row.entry.actor ?? null,
			})),
			totals,
		};
	};

	return Object.freeze({ pay, refund, entries, maybeConfirm });
};

/** @typedef {ReturnType<typeof createLedger>} Ledger */
