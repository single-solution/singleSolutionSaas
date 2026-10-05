/**
 * Order placement — `POST /v1/orders` with an `Idempotency-Key` (port of the proven ibrahimMobiles placement, made
 * generic):
 *
 * - **Never trust client prices.** Lines are re-priced from the item records, totals recomputed by the same quote as
 *   `POST /v1/quotes`; `expectedTotal` only tells the client its numbers are stale (409 `total_changed`).
 * - **Idempotent.** The order id derives from (website, key), and a unique index on the hashed key closes the race of
 *   two parallel submissions: the loser answers the winner's order. Calls to other products reuse derived keys.
 * - **Atomic and race-free stock.** Conditional decrements and the order insert run in one transaction of the
 *   merchant's database. A database without transactions (no replica set) runs the same steps in sequence and gives
 *   back exactly the steps that completed when a later one fails.
 * - **Compensated reservations elsewhere.** Coupon codes are reserved, points redeemed, deals committed (and Catalog
 *   stock reserved when it is the stock source) before the local transaction; any failure releases what was taken.
 * - **Holds expire.** Unpaid / unconfirmed orders carry `expiresAt` (jobs/ cancels them and gives everything back).
 * - **Safety** (lesson A12): blocklist, open-order cap counting cash-on-delivery orders, COD caps and confirmation.
 */
import { createHash } from 'node:crypto';
import { encodeBase32 } from '@ss/contracts';
import { validateForm } from '../core/form.js';
import { customerRef, eventLines, orderNumber, orderView, validatePlacement } from '../core/orders.js';
import { UNCONFIRMED, startOf } from '../core/payments.js';
import { consentsOf, identityRequired, missingConsents } from '../core/policies.js';
import { eventAmounts, linesAfterDeals } from '../core/pricing.js';
import { isTransactionUnsupported, isDuplicateKey } from '../adapters/db.js';

/** @typedef {import('./context.js').Site} Site */
/** @typedef {import('./context.js').Checkout} Checkout */
/** @typedef {import('./carts.js').Requester} Requester */
/**
 * @typedef {{ ok: true, order: Record<string, any>, token: string | null, replayed: boolean }
 *   | { ok: false, code: string, detail?: string, errors?: Array<{ path: string, code: string }>, extensions?: Record<string, unknown> }} PlaceResult
 */

/** A business-rule refusal raised inside the local transaction (aborts it). */
const refusal = (/** @type {string} */ code, /** @type {Record<string, unknown>} */ extra = {}) =>
	Object.assign(new Error(code), { refusal: code, extra });

/**
 * @param {Checkout} checkout
 * @param {{ items: import('./items.js').ItemsService, carts: import('./carts.js').CartsService, pricing: import('./pricing.js').Pricing }} services
 */
export const createPlacement = (checkout, { items, carts, pricing }) => {
	const { app, integrations, product } = checkout;

	/**
	 * Local part: take tracked stock and insert the order — one transaction, or compensated steps.
	 * @param {Site} site
	 * @param {Record<string, any>} order
	 * @param {Array<{ itemId: string, variantId: string, quantity: number }>} stockLines
	 */
	const commitLocal = async (site, order, stockLines) => {
		const { repos } = site;
		const untracked = site.settings.place.untracked_stock;
		/** @param {any} [session] */
		const takeAll = async (session) => {
			/** @type {typeof stockLines} */
			const taken = [];
			for (const line of stockLines) {
				// serial on purpose: each decrement is conditional and the steps that completed must be known
				const outcome = await repos.items.take(line, session);
				if (outcome === 'insufficient' || (outcome === 'untracked' && untracked === 'refuse')) {
					if (!session) for (const done of taken) await repos.items.give(done);
					throw refusal(outcome === 'untracked' ? 'untracked_stock' : 'insufficient_stock', {
						itemId: line.itemId,
						variantId: line.variantId,
					});
				}
				if (outcome === 'taken') taken.push(line);
			}
			return taken;
		};
		try {
			await repos.transaction(async (session) => {
				await takeAll(session);
				await repos.orders.insert(order, session);
			});
			return { mode: 'transaction' };
		} catch (error) {
			if (!isTransactionUnsupported(error)) throw error;
		}
		// standalone server: the same steps in sequence, compensating exactly what completed
		const taken = await takeAll();
		try {
			await repos.orders.insert(order);
		} catch (error) {
			for (const done of taken) await repos.items.give(done);
			throw error;
		}
		return { mode: 'sequential' };
	};

	/**
	 * Place an order.
	 * @param {Site} site
	 * @param {unknown} body
	 * @param {{ who: Requester, idempotencyKey: string, identityToken?: string | null }} request
	 * @returns {Promise<PlaceResult>}
	 */
	const place = async (site, body, { who, idempotencyKey }) => {
		const { settings, repos } = site;
		if (!settings.currency) return { ok: false, code: 'currency_not_configured' };
		const checked = validatePlacement(body, {
			maxLines: settings.cart.max_lines,
			maxQuantity: settings.cart.max_quantity_per_line,
			maxCodes: settings.enabled('offer_apply') ? settings.offers.max_codes : 0,
			serverKey: who.kind === 'sk',
		});
		if (!checked.input) return { ok: false, code: 'validation_failed', errors: checked.problems };
		const input = checked.input;
		const keyHash = app.hash(`${site.websiteId}|${idempotencyKey}`);
		const orderId = `ord_${encodeBase32(createHash('sha256').update(keyHash).digest().subarray(0, 16))}`;
		const replay = await repos.orders.byIdempotency(keyHash);
		if (replay) return { ok: true, order: replay, token: null, replayed: true };

		// ── lines: from the cart or the request, re-priced from the item records ────────────────────────────
		/** @type {Record<string, any> | null} */
		let cart = null;
		/** @type {Array<{ itemId: string, variantId: string | null, quantity: number }>} */
		let wants;
		if (input.cartId) {
			const loaded = await carts.load(site, input.cartId, who);
			if (!loaded.ok) return { ok: false, code: loaded.code };
			cart = loaded.cart;
			if (cart.lines.length === 0) return { ok: false, code: 'cart_empty' };
			wants = cart.lines.map((/** @type {any} */ line) => ({
				itemId: line.itemId,
				variantId: line.variantId,
				quantity: line.quantity,
			}));
		} else wants = /** @type {NonNullable<typeof input.lines>} */ (input.lines);
		const priced = await items.price(site, wants);
		const failed = priced.map((result, index) => ({ result, index })).filter(({ result }) => !result.ok);
		if (failed.length > 0)
			return {
				ok: false,
				code: 'cart_unavailable_lines',
				errors: failed.map(({ result, index }) => ({
					path: cart ? `/lines/${cart.lines[index].lineId}` : `/lines/${index}`,
					code: /** @type {{ reason: string }} */ (result).reason,
				})),
			};
		const lines = priced.map((result, index) => {
			const line = /** @type {{ ok: true, line: import('../core/items.js').PricedLine }} */ (result).line;
			const cap = line.available === null ? settings.cart.max_quantity_per_line : line.available;
			return { ...line, lineId: cart ? cart.lines[index].lineId : `l${index + 1}`, quantity: line.quantity, cap };
		});
		const short = lines.filter((line) => line.quantity > line.cap);
		if (short.length > 0 && settings.place.stock_source === 'checkout')
			return {
				ok: false,
				code: 'insufficient_stock',
				errors: short.map((line) => ({ path: `/lines/${line.lineId}`, code: 'insufficient_stock' })),
			};

		// ── form, consents, customer, blocklist ────────────────────────────────────────────────────────────
		const t = checkout.translator(settings.language);
		const form = validateForm(settings.form, body, { t, needsShipping: lines.some((line) => line.requiresShipping) });
		if (form.problems.length > 0) return { ok: false, code: 'validation_failed', errors: form.problems };
		if (settings.enabled('policies_notice')) {
			const missing = missingConsents(settings.policies, input.consents);
			if (missing.length > 0)
				return {
					ok: false,
					code: 'consent_required',
					errors: missing.map((key) => ({ path: `/consents/${key}`, code: 'required' })),
				};
		}
		const contact = /** @type {Record<string, any>} */ (form.values.contact);
		const subject = who.kind === 'sk' ? (input.customer?.subject ?? null) : who.subject;
		const customer = {
			subject,
			email:
				(typeof contact.email === 'string' ? contact.email : null) ??
				(who.kind === 'sk' ? input.customer?.email : who.email) ??
				null,
			phone:
				(typeof contact.phone === 'string' ? contact.phone : null) ??
				(who.kind === 'sk' ? input.customer?.phone : who.phone) ??
				null,
			name: typeof contact.name === 'string' ? contact.name : null,
		};
		const blockKeys = [
			...(customer.subject ? [{ kind: 'subject', value: customer.subject }] : []),
			...(customer.email ? [{ kind: 'email', value: customer.email.toLowerCase() }] : []),
			...(customer.phone ? [{ kind: 'phone', value: customer.phone }] : []),
		];
		if (await repos.blocks.matches(blockKeys)) return { ok: false, code: 'blocked' };

		// ── totals (the same quote the checkout showed) ─────────────────────────────────────────────────────
		const q = await pricing.quote(site, {
			lines,
			codes: input.codes,
			loyaltyPoints: input.loyaltyPoints,
			deliveryMethod: form.values.delivery?.key ?? null,
			paymentMethod: input.paymentMethod,
			country: form.values.country,
			subject,
			cartId: cart?.id ?? null,
			idempotencyKey: keyHash,
		});
		if (q.rejected.length > 0)
			return {
				ok: false,
				code: 'offer_unavailable',
				errors: q.rejected.map((entry) => ({ path: `/codes/${entry.code}`, code: entry.reason })),
			};
		if (input.loyaltyPoints > 0 && q.loyalty.refused)
			return {
				ok: false,
				code: q.loyalty.refused === 'identity_required' ? 'identity_required' : 'points_unavailable',
				detail: q.loyalty.refused,
			};
		const option = q.options.find((entry) => entry.key === input.paymentMethod);
		if (!option || !option.available)
			return {
				ok: false,
				code: 'payment_unavailable',
				errors: [{ path: '/paymentMethod', code: option?.reason ?? 'not_offered' }],
			};
		if (
			settings.enabled('signin_gate') &&
			!subject &&
			identityRequired(settings.gate, { paymentMethod: input.paymentMethod, total: q.totals.total })
		)
			return { ok: false, code: 'identity_required' };
		const mustMatch = settings.place.require_expected_total || input.expectedTotal !== null;
		if (mustMatch && input.expectedTotal !== q.totals.total)
			return { ok: false, code: 'total_changed', extensions: { totals: q.totals } };
		if (settings.enabled('payment_manual') && settings.manual.max_open_orders > 0) {
			const open = await repos.orders.countOpen(customer, UNCONFIRMED);
			if (open >= settings.manual.max_open_orders) return { ok: false, code: 'open_orders_limit' };
		}

		// ── the order document ─────────────────────────────────────────────────────────────────────────────
		const now = app.now();
		const placedAt = new Date(now);
		const start = startOf(input.paymentMethod, {
			manual: settings.manual,
			gatewayHoldMinutes: settings.gateway.hold_minutes,
			total: q.totals.total,
			now,
		});
		const number = orderNumber(await repos.counters.next('order'), {
			prefix: settings.place.number_prefix,
			padding: settings.place.number_padding,
		});
		const token = `oat_${encodeBase32(app.randomBytes(20))}`;
		const stockSource = settings.place.stock_source;
		/** @type {Record<string, any>} */
		const order = {
			id: orderId,
			number,
			status: start.status,
			idempotencyKey: keyHash,
			accessTokenHash: app.hash(token),
			placedAt,
			expiresAt: start.expiresAt === null ? null : new Date(start.expiresAt),
			currency: q.currency,
			customerId: subject,
			customer,
			contact,
			address: form.values.address,
			custom: form.values.custom,
			country: form.values.country,
			delivery: form.values.delivery,
			pickupLocation: form.values.pickupLocation,
			payment: {
				method: input.paymentMethod,
				kind: option.kind,
				status: 'unpaid',
				advance: start.advance,
				dueNow: start.dueNow,
				dueLater: start.dueLater,
				reference: null,
			},
			lines: lines.map((line) =>
				Object.fromEntries(Object.entries(line).filter(([name]) => name !== 'cap' && name !== 'available')),
			),
			totals: q.totals,
			offers: {
				deals:
					q.deals && q.deals.discount + q.deals.shippingDiscount > 0
						? { quoteId: q.deals.quoteId, deals: q.deals.deals }
						: null,
				coupons: null,
				loyalty: null,
			},
			stock: { source: stockSource, state: stockSource === 'none' ? 'none' : 'reserved', reservationId: null },
			consents: settings.enabled('policies_notice')
				? consentsOf(settings.policies, input.consents, placedAt.toISOString())
				: [],
			note: input.note,
			cartId: cart?.id ?? null,
			payments: [],
			refunds: [],
			proofs: [],
			timeline: [
				{ status: start.status, at: placedAt.toISOString(), actor: { type: who.kind === 'sk' ? 'merchant' : 'customer' } },
			],
		};

		// ── reservations in the other products (compensated on failure) ────────────────────────────────────
		const conns = await checkout.connectionsFor(site);
		/** @type {Array<() => Promise<unknown>>} */
		const undo = [];
		const rollback = async () => {
			for (const step of undo.reverse()) await step();
		};
		if (q.coupons && q.coupons.applied.length > 0 && conns.coupons) {
			const couponLines = linesAfterDeals(lines, q.deals);
			const reserved = await integrations.coupons.reserve(
				conns.coupons,
				{
					codes: q.coupons.applied.map((a) => a.code),
					cart: {
						currency: q.currency,
						lines: couponLines.map((line) => ({
							lineId: line.lineId,
							itemId: line.itemId,
							variantId: line.variantId,
							quantity: line.quantity,
							unitAmount: line.unitAmount,
						})),
						shipping: q.totals.shipping,
						...(subject ? { customer: { id: subject.slice(0, 128) } } : {}),
					},
					orderId,
					reference: orderId,
				},
				`${keyHash}:coupons`,
			);
			if (!reserved.ok)
				return {
					ok: false,
					code: reserved.reason === 'refused' ? 'offer_unavailable' : 'integration_unavailable',
					detail: reserved.code,
				};
			order.offers.coupons = { reservationId: reserved.json?.id ?? null, codes: q.coupons.applied.map((a) => a.code) };
			const reservationId = String(reserved.json?.id ?? '');
			undo.push(() => integrations.coupons.release(conns.coupons, reservationId, `${keyHash}:coupons-release`));
		}
		if (q.loyalty.points > 0 && conns.loyalty && subject) {
			const redeemed = await integrations.loyalty.redeem(
				conns.loyalty,
				{
					customerId: subject.slice(0, 128),
					points: q.loyalty.points,
					amount: q.totals.subtotal - q.totals.itemDiscount - q.totals.couponDiscount,
					currency: q.currency,
					orderId,
					reference: orderId,
				},
				`${keyHash}:loyalty`,
			);
			if (!redeemed.ok) {
				await rollback();
				return {
					ok: false,
					code: redeemed.reason === 'refused' ? 'points_unavailable' : 'integration_unavailable',
					detail: redeemed.code,
				};
			}
			const redemptionId = String(redeemed.json?.id ?? '');
			order.offers.loyalty = { redemptionId, points: q.loyalty.points, value: q.loyalty.value };
			undo.push(() => integrations.loyalty.release(conns.loyalty, redemptionId, `${keyHash}:loyalty-release`));
		}
		if (order.offers.deals?.quoteId && conns.deals) {
			const quoteId = order.offers.deals.quoteId;
			const committed = await integrations.deals.commit(
				conns.deals,
				quoteId,
				{ orderId, ...(subject ? { customerId: subject.slice(0, 128) } : {}) },
				`${keyHash}:deals`,
			);
			if (!committed.ok) {
				await rollback();
				return {
					ok: false,
					code: committed.reason === 'refused' ? 'offer_unavailable' : 'integration_unavailable',
					detail: committed.code,
				};
			}
			undo.push(() => integrations.deals.release(conns.deals, quoteId, `${keyHash}:deals-release`));
		}
		if (stockSource === 'catalog') {
			const reserved = await integrations.catalog.reserve(
				conns.catalog,
				{ lines: lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity })), orderId },
				`${keyHash}:stock`,
			);
			if (!reserved.ok) {
				await rollback();
				return {
					ok: false,
					code: reserved.reason === 'refused' ? 'insufficient_stock' : 'integration_unavailable',
					detail: reserved.code,
				};
			}
			order.stock.reservationId = String(reserved.json?.id ?? '');
			const reservationId = order.stock.reservationId;
			undo.push(() => integrations.catalog.release(conns.catalog, reservationId));
		}

		// ── local transaction ────────────────────────────────────────────────────────────────────────────────
		try {
			await commitLocal(
				site,
				order,
				stockSource === 'checkout'
					? lines.map((line) => ({ itemId: line.itemId, variantId: line.variantId, quantity: line.quantity }))
					: [],
			);
		} catch (error) {
			if (isDuplicateKey(error)) {
				// a parallel submission with the same key won: its reservations are the same (derived keys), keep them
				const winner = await repos.orders.byIdempotency(keyHash);
				return winner
					? { ok: true, order: winner, token: null, replayed: true }
					: { ok: false, code: 'placement_in_progress' };
			}
			await rollback();
			const code = /** @type {any} */ (error)?.refusal;
			if (typeof code === 'string')
				return { ok: false, code, errors: [{ path: `/lines/${/** @type {any} */ (error).extra?.itemId ?? ''}`, code }] };
			throw error;
		}

		// ── after the order exists (best effort) ─────────────────────────────────────────────────────────────
		if (order.offers.coupons?.reservationId && conns.coupons)
			await integrations.coupons.redeem(
				conns.coupons,
				order.offers.coupons.reservationId,
				orderId,
				`${keyHash}:coupons-redeem`,
			);
		if (cart) await repos.carts.setStatus(cart.id, 'converted', { orderId, expireAt: null });
		if (input.saveAddress && subject && form.values.address && settings.form.save_addresses)
			await repos.addresses.save(
				subject,
				{ id: app.hash(JSON.stringify(form.values.address)).slice(0, 24), address: form.values.address },
				settings.form.max_saved_addresses,
			);
		const ref = customerRef(customer);
		await checkout.publish(
			site,
			'order.placed@1',
			{
				orderId,
				number,
				...(ref ? { customer: ref } : {}),
				currency: q.currency,
				lines: eventLines(order.lines),
				amounts: eventAmounts(q.totals),
			},
			`${orderId}:placed`,
		);
		await product.usage.record({ websiteId: site.websiteId, unit: 'order', quantity: 1, idempotencyKey: `${orderId}:order` });
		return { ok: true, order, token, replayed: false };
	};

	return Object.freeze({ place, commitLocal });
};

/**
 * Placement response: the order view plus its access token (for guests: success page, proofs, cancel).
 * @param {PlaceResult & { ok: true }} result
 */
export const placedView = (result) => ({
	...orderView(result.order),
	...(result.token ? { accessToken: result.token } : {}),
	replayed: result.replayed,
});
