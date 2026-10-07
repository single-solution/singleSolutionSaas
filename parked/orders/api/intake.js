/**
 * Intake: every new order — from an external checkout through the inbound API (our schema or a mapping), from the
 * Checkout product's `order.placed@1`, from the dashboard — is validated, checked by the risk rules, given its first
 * status (paid → confirmed; pay on delivery without an advance → the confirmation step; else unpaid), numbered and
 * stored once per external id. Orders from outside our Checkout publish `order.placed@1` so stock, loyalty and the
 * other products react to them too. Every order received is metered (`order`).
 */
import { initialStatus, isPayOnDelivery, openStatuses, expiryOf } from '../core/lifecycle.js';
import { applyMapping } from '../core/mapping.js';
import { customerKeys, eventContext, formatNumber, validateOrder } from '../core/orders.js';
import { evaluateRisk } from '../core/risk.js';
import { emptyFulfilment } from '../core/fulfilment.js';
import { fail, invalid } from './context.js';

/**
 * @param {import('./context.js').Deps} deps
 * @param {import('./outbox.js').Outbox} outbox
 */
export const createIntake = (deps, outbox) => {
	/**
	 * Risk of a new order (no flags when the risk element is off).
	 * @param {import('./context.js').Site} site
	 * @param {{ total: number, currency: string, cod: boolean, keys: string[] }} input
	 */
	const riskOf = async (site, { total, currency, cod, keys }) => {
		if (!site.settings.enabled('risk'))
			return { flags: [], decision: /** @type {const} */ ('accept'), advance: 0, rtoCount: 0 };
		const [profiles, openCount] = await Promise.all([
			site.repos.profiles.byKeys(keys),
			site.repos.orders.countOpen(keys, openStatuses(site.settings.matrix), new Date(deps.now())),
		]);
		return evaluateRisk({ total, currency, cod, profiles, openCount }, site.settings.risk);
	};

	/**
	 * Take in an order.
	 * @param {import('./context.js').Site} site
	 * @param {unknown} input canonical order (or the payload of a mapping)
	 * @param {{ source: 'checkout' | 'api' | 'import' | 'dashboard', actor: import('./context.js').Actor, mapping?: string | null }} options
	 * @returns {Promise<{ ok: true, order: Record<string, any>, duplicate: boolean } | import('./context.js').Failure>}
	 */
	const take = async (site, input, { source, actor, mapping = null }) => {
		const { settings } = site;
		let canonical = input;
		/** @type {string | null} */
		let sourceLabel = null;
		if (mapping) {
			const found = settings.mappings.find((m) => m.key === mapping);
			if (!found) return fail('mapping_unknown', `No mapping '${mapping}'.`);
			const mapped = applyMapping(input, found);
			if (!mapped.ok) return invalid(mapped.errors);
			canonical = mapped.input;
			sourceLabel = found.sourceLabel ?? found.key;
		}
		// only placements from the Checkout product name their own order id; others get ours
		const raw = source === 'checkout' ? canonical : { .../** @type {any} */ (canonical ?? {}), id: undefined };
		const checked = validateOrder(raw, { maxLines: settings.lifecycle.max_lines, defaultCurrency: settings.currency });
		if (!checked.ok) return invalid(checked.errors);
		const draft = checked.draft;
		if (draft.externalId) {
			const existing = await site.repos.orders.byExternal(source, draft.externalId);
			if (existing) return { ok: true, order: existing, duplicate: true };
		}
		if (draft.id) {
			const existing = await site.repos.orders.get(draft.id);
			if (existing) return { ok: true, order: existing, duplicate: true };
		}
		const keys = customerKeys(draft.customer, settings.risk.phone_match_digits).map((key) => deps.hashKey(site.websiteId, key));
		const cod = isPayOnDelivery(settings.matrix, { payment: draft.payment });
		const risk = await riskOf(site, { total: draft.amounts.total, currency: draft.currency, cod, keys });
		// a placement that already happened (our Checkout) is never refused: it is held for review instead
		if (risk.decision === 'reject' && source !== 'checkout')
			return fail('risk_rejected', 'The order was refused by the risk rules.', { extensions: { flags: risk.flags } });
		const paid = Math.min(draft.payment.paidAmount, Number.MAX_SAFE_INTEGER);
		const status = initialStatus(settings.matrix, {
			paidInFull: paid >= draft.amounts.total,
			cod,
			advanceDue: Math.max(0, risk.advance - paid),
		});
		const now = deps.now();
		const id = draft.id ?? deps.newId('ord');
		const number =
			draft.number ??
			formatNumber(
				settings.lifecycle.number_prefix,
				await site.repos.counters.next('order'),
				settings.lifecycle.number_padding,
			);
		const expiry = expiryOf(settings.matrix, status, now);
		const payment =
			paid > 0
				? {
						id: deps.stableId('pay', `${site.websiteId}|intake|${id}`),
						amount: paid,
						method: draft.payment.method ?? 'other',
						reference: draft.payment.reference,
						proofUrl: null,
						note: null,
						actor: { type: 'system', id: `intake:${source}` },
						at: new Date(now),
					}
				: null;
		const context = eventContext({ ...draft, id, number });
		const pending = [
			...(source !== 'checkout' && settings.inbound.publish_placed && context.lines
				? [{ key: `order.placed:${id}`, kind: 'event', type: 'order.placed@1', data: { orderId: id, ...context } }]
				: []),
			...(payment && source !== 'checkout'
				? [
						{
							key: `order.paid:${payment.id}`,
							kind: 'event',
							type: 'order.paid@1',
							data: {
								orderId: id,
								amount: { amount: payment.amount, currency: draft.currency },
								method: payment.method,
								...(payment.reference ? { reference: payment.reference } : {}),
							},
						},
					]
				: []),
			{ key: `notify:${id}:placed`, kind: 'notify', status: 'placed', reason: null },
		];
		const doc = {
			...draft,
			id,
			number,
			source,
			sourceLabel,
			status,
			placedAt: draft.placedAt ?? new Date(now),
			statusChangedAt: new Date(now),
			expiresAt: expiry ? expiry.at : null,
			customerId: draft.customer.customerId,
			customerSubject: draft.customer.subject,
			customerEmail: draft.customer.email,
			customerPhone: draft.customer.phone,
			customerKeys: keys,
			paid,
			refunded: 0,
			payments: payment ? [payment] : [],
			refunds: [],
			timeline: [{ status, at: new Date(now), actor }],
			fulfilment: emptyFulfilment(),
			risk: {
				flags: risk.flags,
				decision: risk.decision,
				review: risk.decision === 'accept' ? 'none' : 'pending',
				advance: risk.advance,
				rtoCount: risk.rtoCount,
				rtoCounted: false,
			},
			returnReason: null,
			invoiceNumber: null,
			notes: { customer: draft.notes.customer, internal: null },
			version: 1,
			pending,
			pendingAt: new Date(now),
		};
		const inserted = await site.repos.orders.insert(doc);
		if (!inserted.ok) {
			if (inserted.duplicate === 'number') return fail('duplicate_order', `Order number ${number} exists already.`);
			const existing =
				(draft.externalId ? await site.repos.orders.byExternal(source, draft.externalId) : null) ??
				(await site.repos.orders.get(id));
			if (existing) return { ok: true, order: existing, duplicate: true };
			return fail('conflict', 'The order could not be stored.');
		}
		await Promise.resolve(
			deps.usage({ websiteId: site.websiteId, unit: 'order', quantity: 1, idempotencyKey: `order:${id}` }),
		).catch(() => undefined);
		await outbox.flush(site, doc);
		await deps
			.audit({
				websiteId: site.websiteId,
				actor,
				action: 'order.received',
				target: { orderId: id },
				after: { source, status },
			})
			.catch(() => undefined);
		return { ok: true, order: (await site.repos.orders.get(id)) ?? doc, duplicate: false };
	};

	/**
	 * A pre-checkout risk check (no order is stored).
	 * @param {import('./context.js').Site} site
	 * @param {unknown} body `{ customer, currency, total, payment: { method, cod } }`
	 */
	const check = async (site, body) => {
		const input = /** @type {any} */ (body ?? {});
		const checked = validateOrder(
			{ ...input, lines: [{ title: 'check', quantity: 1, unitAmount: 0 }], amounts: { total: input.total } },
			{ maxLines: 1, defaultCurrency: site.settings.currency },
		);
		if (!checked.ok) return invalid(checked.errors.filter((e) => !e.path.startsWith('/lines')));
		const keys = customerKeys(checked.draft.customer, site.settings.risk.phone_match_digits).map((key) =>
			deps.hashKey(site.websiteId, key),
		);
		const cod = isPayOnDelivery(site.settings.matrix, { payment: checked.draft.payment });
		const risk = await riskOf(site, { total: checked.draft.amounts.total, currency: checked.draft.currency, cod, keys });
		return {
			ok: true,
			result: { decision: risk.decision, flags: risk.flags, advance: risk.advance, currency: checked.draft.currency },
		};
	};

	return Object.freeze({ take, check });
};

/** @typedef {ReturnType<typeof createIntake>} Intake */
