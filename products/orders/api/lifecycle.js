/**
 * Lifecycle service: status moves (the matrix check, an atomic compare-and-set claim on the order's version, the
 * timeline entry, the outbox entries, the return-to-origin count), customer cancellation, fulfilment and serials
 * updates, the review decision and auto-expiry. Every writer — dashboard, API, bulk, CSV import, expiry, consumed
 * events, the ledger — goes through `move`, so a bulk run can never do what a single change would refuse.
 */
import { checkMove, customerCancelMove, expiryOf, statusOf } from '../core/lifecycle.js';
import { applyFulfilment } from '../core/fulfilment.js';
import { applySerials, missingSerials } from '../core/serials.js';
import { customerKeys } from '../core/orders.js';
import { cleanText, isKey } from '../core/text.js';
import { fail, invalid } from './context.js';
import { moveEntries } from './outbox.js';

/**
 * The `orders.serials_recorded@1` outbox entry of a serials update: every serial of the order with its line's item,
 * in the shape After-sales reads (`{ orderId, serials: [{ serial, itemId, variantId? }] }`).
 * @param {Record<string, any>} order
 * @param {Array<Record<string, any>>} lines
 * @param {number} version
 */
export const serialsEntry = (order, lines, version) => ({
	key: `serials:${order.id}:${version}`,
	kind: 'event',
	type: 'orders.serials_recorded@1',
	data: {
		orderId: order.id,
		number: String(order.number).slice(0, 64),
		serials: lines
			.flatMap((line) =>
				(line.serials ?? []).map((/** @type {string} */ serial) => ({
					serial,
					lineId: line.id,
					...((line.itemId ?? line.sku) ? { itemId: String(line.itemId ?? line.sku).slice(0, 128) } : {}),
					...(line.variantId ? { variantId: line.variantId } : {}),
					...(line.sku ? { sku: String(line.sku).slice(0, 100) } : {}),
				})),
			)
			.slice(0, 1000),
	},
});

/**
 * @param {import('./context.js').Deps} deps
 * @param {import('./outbox.js').Outbox} outbox
 */
export const createLifecycle = (deps, outbox) => {
	/**
	 * @param {import('./context.js').Site} site
	 * @param {Record<string, any>} order
	 * @param {string | null} reason
	 */
	const moveContext = (site, order, reason) => ({
		missingSerials: site.settings.enabled('serials') ? missingSerials(order.lines ?? [], site.settings.serials) : [],
		hasTracking: Boolean(order.fulfilment?.trackingNumber),
		hasDispatchVideo: Boolean(order.fulfilment?.dispatchVideoUrl),
		money: { total: order.amounts.total, paid: order.paid ?? 0, refunded: order.refunded ?? 0 },
		reason,
	});

	/**
	 * Count a return to origin once per order on every customer key of the order.
	 * @param {import('./context.js').Site} site
	 * @param {Record<string, any>} order
	 */
	const countRto = async (site, order) => {
		const claimed = await site.repos.orders.change(
			order.id,
			{ 'risk.rtoCounted': { $ne: true } },
			{ $set: { 'risk.rtoCounted': true } },
		);
		if (!claimed) return;
		for (const key of order.customerKeys ?? []) await site.repos.profiles.addRto(key);
	};

	/**
	 * Move an order to a status.
	 * @param {import('./context.js').Site} site
	 * @param {string | Record<string, any>} orderOrId
	 * @param {string} to
	 * @param {{ actor: import('./context.js').Actor, reason?: unknown, note?: unknown, expect?: { expiresAt?: Date }, catalogued?: boolean }} options
	 *   `catalogued: false` skips the catalogued order event (the move mirrors one another product already published)
	 * @returns {Promise<{ ok: true, order: Record<string, any> } | import('./context.js').Failure>}
	 */
	const move = async (
		site,
		orderOrId,
		to,
		{ actor, reason: rawReason = null, note: rawNote = null, expect, catalogued = true },
	) => {
		const order = typeof orderOrId === 'string' ? await site.repos.orders.get(orderOrId) : orderOrId;
		if (!order) return fail('not_found', 'No such order.');
		if (typeof to !== 'string' || !isKey(to)) return invalid([{ path: '/status', code: 'status_invalid' }]);
		const reason = rawReason === null || rawReason === undefined || rawReason === '' ? null : String(rawReason);
		if (reason !== null && !isKey(reason)) return invalid([{ path: '/reason', code: 'reason_invalid' }]);
		const note = rawNote === null || rawNote === undefined ? null : cleanText(rawNote, 500, { multiline: true });
		if (rawNote !== null && rawNote !== undefined && note === null) return invalid([{ path: '/note', code: 'text_invalid' }]);
		const { matrix } = site.settings;
		const check = checkMove(matrix, order, to, actor.type, moveContext(site, order, reason));
		if (!check.ok) return fail(check.code, check.detail);
		const now = deps.now();
		const expiry = expiryOf(matrix, to, now);
		const seq = (order.version ?? 1) + 1;
		const after = { ...order, status: to };
		const entries = moveEntries(site, after, {
			from: order.status,
			to,
			actor: actor.type,
			reason,
			publish: catalogued ? check.transition.publish : 'none',
			seq,
		});
		const timeline = {
			status: to,
			at: new Date(now),
			actor,
			...(note ? { note } : {}),
			...(reason ? { reason } : {}),
		};
		const changed = await site.repos.orders.change(
			order.id,
			{
				status: order.status,
				version: order.version ?? 1,
				...(expect?.expiresAt ? { expiresAt: { $lte: expect.expiresAt } } : {}),
			},
			{
				$set: {
					status: to,
					statusChangedAt: new Date(now),
					expiresAt: expiry ? expiry.at : null,
					version: seq,
					pendingAt: new Date(now),
					...(reason && check.transition.requires.includes('return_reason') ? { returnReason: reason } : {}),
				},
				$push: {
					timeline: { $each: [timeline], $slice: -site.settings.lifecycle.max_timeline_entries },
					pending: { $each: entries },
				},
			},
		);
		if (!changed) return fail('order_changed', 'The order changed meanwhile; read it again.');
		if (
			reason &&
			check.transition.requires.includes('return_reason') &&
			site.settings.enabled('risk') &&
			site.settings.risk.rto_reasons.includes(reason)
		)
			await countRto(site, changed);
		await outbox.flush(site, changed);
		await deps
			.audit({
				websiteId: site.websiteId,
				actor: { type: actor.type === 'api' ? 'api' : actor.type, id: actor.id ?? undefined },
				action: 'order.status_changed',
				target: { orderId: order.id },
				before: { status: order.status },
				after: { status: to },
			})
			.catch(() => undefined);
		return { ok: true, order: changed };
	};

	/**
	 * Whether an order belongs to a verified customer identity (subject, else the e-mail or phone it asserts).
	 * @param {import('./context.js').Site} site
	 * @param {Record<string, any>} order
	 * @param {{ subject: string, email?: string | null, phone?: string | null }} identity
	 */
	const belongs = (site, order, identity) => {
		if (order.customerSubject && order.customerSubject === identity.subject) return true;
		if (order.customerId && order.customerId === identity.subject) return true;
		const keys = customerKeys(
			{ email: identity.email?.toLowerCase() ?? null, phone: identity.phone ?? null },
			site.settings.risk.phone_match_digits,
		).map((key) => deps.hashKey(site.websiteId, key));
		return keys.some((key) => (order.customerKeys ?? []).includes(key));
	};

	/**
	 * The filter of a customer's orders.
	 * @param {import('./context.js').Site} site
	 * @param {{ subject: string, email?: string | null, phone?: string | null }} identity
	 */
	const customerFilter = (site, identity) => {
		const keys = customerKeys(
			{ email: identity.email?.toLowerCase() ?? null, phone: identity.phone ?? null },
			site.settings.risk.phone_match_digits,
		).map((key) => deps.hashKey(site.websiteId, key));
		return {
			$or: [
				{ customerSubject: identity.subject },
				{ customerId: identity.subject },
				...(keys.length > 0 ? [{ customerKeys: { $in: keys } }] : []),
			],
		};
	};

	/**
	 * Whether the customer may cancel now.
	 * @param {import('./context.js').Site} site
	 * @param {Record<string, any>} order
	 */
	const cancelMoveFor = (site, order) =>
		customerCancelMove(site.settings.matrix, order, {
			now: deps.now(),
			windowMinutes: site.settings.lifecycle.customer_cancel_window_minutes,
		});

	/**
	 * Customer cancellation (pk_ + verified identity).
	 * @param {import('./context.js').Site} site
	 * @param {Record<string, any>} order
	 * @param {{ subject: string }} identity
	 */
	const cancelByCustomer = async (site, order, identity) => {
		const transition = cancelMoveFor(site, order);
		if (!transition) return fail('not_cancellable', 'This order can no longer be cancelled here.');
		return move(site, order, transition.to, { actor: { type: 'customer', id: identity.subject.slice(0, 128) } });
	};

	/**
	 * Update fulfilment (carrier, service level, tracking number, dispatch video, ETA, note).
	 * @param {import('./context.js').Site} site
	 * @param {string} id
	 * @param {unknown} patch
	 * @param {import('./context.js').Actor} actor
	 */
	const fulfil = async (site, id, patch, actor) => {
		const order = await site.repos.orders.get(id);
		if (!order) return fail('not_found', 'No such order.');
		if (statusOf(site.settings.matrix, order.status)?.terminal) return fail('order_closed', 'The order is closed.');
		const { fulfilment } = site.settings;
		const result = applyFulfilment(order.fulfilment, patch, {
			carriers: site.settings.carriers,
			allowOther: fulfilment.allow_other_carrier,
			dispatchVideo: fulfilment.dispatch_video,
			maxNote: fulfilment.max_note_length,
		});
		if (!result.ok) return invalid(result.errors);
		const changed = await site.repos.orders.change(
			id,
			{ version: order.version ?? 1 },
			{ $set: { fulfilment: result.value, version: (order.version ?? 1) + 1 } },
		);
		if (!changed) return fail('order_changed', 'The order changed meanwhile; read it again.');
		await deps
			.audit({
				websiteId: site.websiteId,
				actor,
				action: 'order.fulfilment_updated',
				target: { orderId: id },
				after: { changed: result.changed },
			})
			.catch(() => undefined);
		return { ok: true, order: changed };
	};

	/**
	 * Set serials per line (validated by the rules, unique per order or website).
	 * @param {import('./context.js').Site} site
	 * @param {string} id
	 * @param {unknown} patch
	 * @param {import('./context.js').Actor} actor
	 */
	const setSerials = async (site, id, patch, actor) => {
		const order = await site.repos.orders.get(id);
		if (!order) return fail('not_found', 'No such order.');
		if (statusOf(site.settings.matrix, order.status)?.terminal) return fail('order_closed', 'The order is closed.');
		const result = applySerials(patch, order.lines, site.settings.serialRules);
		if (!result.ok) return invalid(result.errors);
		if (site.settings.serials.unique_scope === 'website') {
			const before = new Set(order.lines.flatMap((/** @type {any} */ line) => line.serials ?? []));
			for (const serial of Object.values(result.serials).flat()) {
				if (before.has(serial)) continue;
				const holders = (await site.repos.orders.holdersOf(serial, id)).filter(
					(/** @type {any} */ holder) => !statusOf(site.settings.matrix, holder.status)?.terminal,
				);
				if (holders.length > 0) return fail('serial_taken', `${serial} is on order ${holders[0].number}.`);
			}
		}
		const lines = order.lines.map((/** @type {any} */ line) => ({ ...line, serials: result.serials[line.id] ?? [] }));
		const version = (order.version ?? 1) + 1;
		const changed = await site.repos.orders.change(
			id,
			{ version: order.version ?? 1 },
			{
				$set: { lines, version, pendingAt: new Date(deps.now()) },
				$push: { pending: serialsEntry(order, lines, version) },
			},
		);
		if (!changed) return fail('order_changed', 'The order changed meanwhile; read it again.');
		await outbox.flush(site, changed);
		await deps
			.audit({ websiteId: site.websiteId, actor, action: 'order.serials_updated', target: { orderId: id } })
			.catch(() => undefined);
		return { ok: true, order: changed };
	};

	/**
	 * The review decision on a flagged order (`clear` releases it, `hold` keeps it out of automatic confirmation).
	 * @param {import('./context.js').Site} site
	 * @param {string} id
	 * @param {unknown} body
	 * @param {import('./context.js').Actor} actor
	 */
	const review = async (site, id, body, actor) => {
		const decision = /** @type {any} */ (body)?.decision;
		if (decision !== 'clear' && decision !== 'hold') return invalid([{ path: '/decision', code: 'decision_invalid' }]);
		const note = cleanText(/** @type {any} */ (body)?.note, 500);
		const order = await site.repos.orders.get(id);
		if (!order) return fail('not_found', 'No such order.');
		const changed = await site.repos.orders.change(
			id,
			{ version: order.version ?? 1 },
			{
				$set: {
					'risk.review': decision === 'clear' ? 'cleared' : 'held',
					'risk.reviewedAt': new Date(deps.now()),
					'risk.reviewedBy': actor,
					...(note ? { 'risk.reviewNote': note } : {}),
					version: (order.version ?? 1) + 1,
				},
			},
		);
		if (!changed) return fail('order_changed', 'The order changed meanwhile; read it again.');
		await deps
			.audit({ websiteId: site.websiteId, actor, action: `order.review_${decision}`, target: { orderId: id } })
			.catch(() => undefined);
		return { ok: true, order: changed };
	};

	/**
	 * Expire one order whose status expired at `now`: move it where its status expires to, or — when that move no
	 * longer applies (the matrix changed) — clear its expiry so it is not picked again.
	 * @param {import('./context.js').Site} site
	 * @param {Record<string, any>} order
	 * @param {Date} now
	 * @returns {Promise<'expired' | 'cleared' | 'changed'>} `changed`: the order changed meanwhile (left as it is)
	 */
	const expireOne = async (site, order, now) => {
		const def = statusOf(site.settings.matrix, order.status);
		const result = def
			? await move(site, order, def.expireTo, {
					actor: { type: 'system', id: 'expiry' },
					reason: 'expired',
					expect: { expiresAt: now },
				})
			: null;
		if (result?.ok) return 'expired';
		if (result && result.reason === 'order_changed') return 'changed';
		await site.repos.orders.change(order.id, { version: order.version ?? 1 }, { $set: { expiresAt: null } });
		return 'cleared';
	};

	/**
	 * Move the website's orders whose status expired, bounded (the dashboard's "Process due now"; reads expire the
	 * orders they return).
	 * @param {import('./context.js').Site} site
	 * @param {number} limit
	 */
	const expireDue = async (site, limit) => {
		let expired = 0;
		const now = new Date(deps.now());
		for (const order of await site.repos.orders.dueExpiry(now, limit))
			if ((await expireOne(site, order, now)) === 'expired') expired += 1;
		return expired;
	};

	/**
	 * Expire on read: when the order's status has expired, apply the expiry now (before anyone sees or changes the
	 * order). Resolves true when the order was due (read it again).
	 * @param {import('./context.js').Site} site
	 * @param {Record<string, any>} order
	 */
	const expireIfDue = async (site, order) => {
		const now = deps.now();
		if (!order.expiresAt || new Date(order.expiresAt).getTime() > now) return false;
		await expireOne(site, order, new Date(now));
		return true;
	};

	return Object.freeze({
		move,
		belongs,
		customerFilter,
		cancelMoveFor,
		cancelByCustomer,
		fulfil,
		setSerials,
		review,
		expireDue,
		expireIfDue,
	});
};

/** @typedef {ReturnType<typeof createLifecycle>} Lifecycle */

/**
 * The orders repository of a site with due work applied on read (nothing runs on a timer): every order returned by
 * `get`, `byNumber`, `page` and `many` is passed to `settle` first (expiry, left-behind outbox entries) and read again
 * when it changed, so nobody sees or acts on an expired status. A single order read (`get`, `byNumber`) is also passed
 * to `touch` (its due message retries).
 * @template {{ get: (id: string) => Promise<any>, byNumber: (number: string) => Promise<any>,
 *   page: (filter: Record<string, unknown>, page: { after: unknown, limit: number }) => Promise<any[]>,
 *   many: (ids: string[]) => Promise<any[]> }} R
 * @param {R} orders
 * @param {{ settle: (order: Record<string, any>) => Promise<boolean>, touch?: (order: Record<string, any>) => Promise<unknown> }} work
 * @returns {R}
 */
export const settlingOnRead = (orders, { settle, touch = async () => undefined }) => {
	/** @param {any} order */
	const settled = async (order) => (order && (await settle(order)) ? orders.get(order.id) : order);
	/** @param {any} order */
	const touched = async (order) => {
		const current = await settled(order);
		if (current) await touch(current);
		return current;
	};
	return Object.freeze({
		...orders,
		get: async (/** @type {string} */ id) => touched(await orders.get(id)),
		byNumber: async (/** @type {string} */ number) => touched(await orders.byNumber(number)),
		page: async (/** @type {Record<string, unknown>} */ filter, /** @type {{ after: unknown, limit: number }} */ page) =>
			Promise.all((await orders.page(filter, page)).map(settled)),
		many: async (/** @type {string[]} */ ids) => Promise.all((await orders.many(ids)).map(settled)),
	});
};
