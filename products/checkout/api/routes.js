/**
 * Route table: app-kit's standard resources (entitlement, config, events, strings, health, the .well-known endpoints,
 * /sso), the Mode C API of every element, the payment webhook and the dashboard API (SSO sessions). Every product
 * route is gated by its element: a disabled element answers 403 element_disabled in every mode. Routes that place
 * orders or move money declare `idempotent: true` (app-kit refuses a repeated Idempotency-Key with 409
 * duplicate_request); placement also requires the key. Handlers are thin — rules live in core/, orchestration in the
 * services.
 */
import { created, defineRoute, ok, paginate, problem, standardRoutes } from '@ss/app-kit';
import { cartView } from '../core/cart.js';
import { resolveForm, validateForm } from '../core/form.js';
import { validateItem } from '../core/items.js';
import { TRANSITIONS, customerMayCancel } from '../core/orders.js';
import { identityRequired, policiesView, signinLink } from '../core/policies.js';
import { cleanText, isId, isObject } from '../core/text.js';
import { createCartsService } from './carts.js';
import { createCheckout } from './context.js';
import { DASHBOARD_WRITE_ROLES } from './dashboard.js';
import { createEventHandlers } from './events.js';
import { createItemsService } from './items.js';
import { createLines } from './lines.js';
import { createOrdersService } from './orders.js';
import { createPaymentsService } from './payments.js';
import { createPlacement, placedView } from './placement.js';
import { createPricing, quoteView } from './pricing.js';
import { sessionView } from './session.js';

/** @typedef {import('./context.js').Site} Site */

/**
 * The application: context + services (shared by the routes, the event consumers and the dashboard).
 * @param {import('../adapters/platform.js').CheckoutApp} app
 */
export const createApplication = (app) => {
	const checkout = createCheckout(app);
	const items = createItemsService(checkout);
	const carts = createCartsService(checkout, items);
	const pricing = createPricing(checkout);
	const orders = createOrdersService(checkout);
	const placement = createPlacement(checkout, { items, carts, pricing, releaseExpired: orders.expire });
	const payments = createPaymentsService(checkout, orders);
	const lines = createLines({ items, carts });
	return { ...checkout, items, carts, pricing, orders, placement, payments, lines };
};

/** @typedef {ReturnType<typeof createApplication>} Application */

/** Readable message of a problem code. @param {string} code */
const message = (code) => code.replace(/_/g, ' ');

/**
 * A service failure → RFC 9457 problem.
 * @param {{ code: string, detail?: string, errors?: Array<{ path: string, code: string }>, extensions?: Record<string, unknown> }} failure
 */
export const fail = ({ code, detail, errors, extensions }) =>
	problem(code, detail ? `${message(code)} (${detail})` : message(code), {
		...(errors
			? { errors: errors.map((entry) => ({ path: entry.path, code: entry.code, message: message(entry.code) })) }
			: {}),
		...(extensions ? { extensions } : {}),
	});

/**
 * Who is asking. Browser keys: the verified identity (`SS-Identity`), never the body. Server keys: the merchant.
 * @param {any} ctx
 * @returns {import('./carts.js').Requester}
 */
export const requesterOf = (ctx) => {
	if (ctx.session) return { kind: 'session', subject: null, email: null, phone: null };
	if (ctx.website?.kind === 'sk') return { kind: 'sk', subject: null, email: null, phone: null };
	return {
		kind: 'pk',
		subject: ctx.identity?.subject ?? null,
		email: ctx.identity?.email ?? null,
		phone: ctx.identity?.phone ?? null,
	};
};

/**
 * Who sends the request, for scoping client-chosen keys: the customer subject, the dashboard session subject, else the
 * website key (kind + id).
 * @param {any} ctx
 */
export const callerOf = (ctx) =>
	ctx.identity?.subject
		? `customer:${ctx.identity.subject}`
		: ctx.session
			? `session:${ctx.session.subject}`
			: `${ctx.website?.kind ?? 'none'}:${ctx.website?.keyId ?? 'none'}`;

/**
 * @param {Application} application
 */
export const buildRoutes = (application) => {
	const { app, product, carts, pricing, orders, placement, payments, lines, siteOf } = application;
	/** @param {any} ctx */
	const site = (ctx) => siteOf(ctx.websiteId, ctx.entitlement.doc);
	/**
	 * Route auth for an element: browser and server keys (identity optional), or server keys only.
	 * @param {string} element
	 * @param {{ sk?: boolean, identity?: 'optional' | 'required' }} [options]
	 */
	const website = (element, { sk = false, identity = 'optional' } = {}) => ({
		auth: /** @type {const} */ ('website'),
		element,
		...(sk ? { keyKind: /** @type {const} */ ('sk') } : { identity: identity }),
	});
	/** @param {any} ctx */
	const page = (ctx) => paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url });
	/** @param {any} result */
	const cartReply = (result) => (result.ok ? ok(result.view) : fail(result));
	/** @param {any} ctx */
	const shopperKey = (ctx) => ctx.identity?.subject ?? ctx.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'anonymous';

	return [
		...standardRoutes(product),
		defineRoute({ method: 'GET', path: '/v1/session', auth: 'launch', handler: (ctx) => ok(sessionView(ctx.session)) }),

		// ── cart ─────────────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/carts',
			...website('cart', { sk: true }),
			handler: async (ctx) => {
				const p = page(ctx);
				const s = await site(ctx);
				const list = await s.repos.carts.list({
					after: typeof p.after === 'string' ? p.after : null,
					fetchLimit: p.fetchLimit,
				});
				// the merchant's server reading carts is what marks the due ones abandoned (no timer)
				const current = await Promise.all(list.map((/** @type {any} */ cart) => orders.abandonIfDue(s, cart)));
				return p.respond(
					current.map((cart) => cartView(/** @type {any} */ (cart))),
					(/** @type {{ id: string }} */ cart) => cart.id,
				);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/carts',
			...website('cart'),
			handler: async (ctx) => {
				const result = await carts.create(await site(ctx), ctx.body, requesterOf(ctx));
				return result.ok ? created(result.view, { location: `/v1/carts/${result.view.id}` }) : fail(result);
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/carts/:id',
			...website('cart'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const who = requesterOf(ctx);
				const loaded = await carts.load(s, ctx.params.id, who, { open: false });
				if (!loaded.ok) return fail(loaded);
				// a server-key read marks a due cart abandoned; a shopper reading it is back, so it is not reported
				const cart = who.kind === 'sk' ? await orders.abandonIfDue(s, loaded.cart) : loaded.cart;
				return ok(cartView(/** @type {any} */ (cart)));
			},
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/carts/:id',
			...website('cart'),
			handler: async (ctx) => cartReply(await carts.patch(await site(ctx), ctx.params.id, ctx.body, requesterOf(ctx))),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/carts/:id/lines',
			...website('cart'),
			handler: async (ctx) => cartReply(await carts.add(await site(ctx), ctx.params.id, ctx.body, requesterOf(ctx))),
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/carts/:id/lines/:lineId',
			...website('cart'),
			handler: async (ctx) =>
				cartReply(await carts.update(await site(ctx), ctx.params.id, ctx.params.lineId, ctx.body, requesterOf(ctx))),
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/carts/:id/lines/:lineId',
			...website('cart'),
			handler: async (ctx) =>
				cartReply(await carts.update(await site(ctx), ctx.params.id, ctx.params.lineId, { quantity: 0 }, requesterOf(ctx))),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/carts/:id/reconcile',
			...website('cart'),
			handler: async (ctx) => cartReply(await carts.reconcile(await site(ctx), ctx.params.id, requesterOf(ctx))),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/carts/:id/merge',
			...website('cart', { identity: 'required' }),
			handler: async (ctx) => {
				const s = await site(ctx);
				if (!s.settings.cart.guest_merge) return problem('forbidden', 'Guest carts are not merged on this website.');
				return cartReply(await carts.merge(s, ctx.params.id, requesterOf(ctx)));
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/items',
			...website('cart', { sk: true }),
			handler: async (ctx) => {
				const p = page(ctx);
				const list = await (
					await site(ctx)
				).repos.items.list({ after: typeof p.after === 'string' ? p.after : null, fetchLimit: p.fetchLimit });
				return p.respond(list, (/** @type {{ itemId: string }} */ item) => item.itemId);
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/items/:itemId',
			...website('cart'),
			handler: async (ctx) => {
				const item = await (await site(ctx)).repos.items.get(ctx.params.itemId);
				if (!item) return problem('not_found', 'No such item.');
				return ok(
					ctx.website.kind === 'sk'
						? item
						: {
								...item,
								variants: item.variants.map((/** @type {any} */ v) => ({
									...v,
									available: undefined,
									inStock: v.available === null || v.available > 0,
								})),
							},
				);
			},
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/items/:itemId',
			...website('cart', { sk: true }),
			handler: async (ctx) => {
				const checked = validateItem(ctx.params.itemId, ctx.body);
				if (!checked.ok) return fail({ code: 'validation_failed', errors: checked.problems });
				await (await site(ctx)).repos.items.put(checked.item);
				return ok(checked.item);
			},
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/items/:itemId',
			...website('cart', { sk: true }),
			handler: async (ctx) =>
				(await (await site(ctx)).repos.items.remove(ctx.params.itemId))
					? ok({ itemId: ctx.params.itemId, deleted: true })
					: problem('not_found', 'No such item.'),
		}),

		// ── checkout_form ────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/checkout-form',
			...website('checkout_form'),
			handler: async (ctx) => {
				const s = await site(ctx);
				return ok(
					resolveForm(s.settings.form, { country: ctx.query.country, t: application.translator(s.settings.language) }),
				);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/checkout-form:validate',
			...website('checkout_form'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const result = validateForm(s.settings.form, ctx.body, {
					t: application.translator(s.settings.language),
					needsShipping: !isObject(ctx.body) || ctx.body.needsShipping !== false,
				});
				return ok({
					valid: result.problems.length === 0,
					errors: result.problems.map((entry) => ({ ...entry, message: message(entry.code) })),
					values: result.values,
				});
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/addresses',
			...website('checkout_form'),
			handler: async (ctx) => {
				const who = requesterOf(ctx);
				const subject = who.kind === 'sk' ? cleanText(ctx.query.customerId, 255) : who.subject;
				if (who.kind === 'pk' && !subject) return problem('identity_required', 'Sign in to see saved addresses.');
				const list = subject ? await (await site(ctx)).repos.addresses.list(subject) : [];
				return ok({
					items: list.map((/** @type {any} */ entry) => ({ id: entry.id, address: entry.address, usedAt: entry.usedAt })),
				});
			},
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/addresses/:id',
			...website('checkout_form', { identity: 'required' }),
			handler: async (ctx) =>
				(await (await site(ctx)).repos.addresses.remove(/** @type {string} */ (ctx.identity?.subject), ctx.params.id))
					? ok({ id: ctx.params.id, deleted: true })
					: problem('not_found', 'No such address.'),
		}),

		// ── place_order ──────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'POST',
			path: '/v1/quotes',
			...website('place_order'),
			handler: async (ctx) => {
				const s = await site(ctx);
				if (!s.settings.currency) return fail({ code: 'currency_not_configured' });
				const who = requesterOf(ctx);
				const body = isObject(ctx.body) ? ctx.body : {};
				const priced = await lines(s, body, who);
				if (!priced.ok) return fail(priced);
				const codes = Array.isArray(body.codes)
					? body.codes.filter(
							(/** @type {unknown} */ c) => typeof c === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(c),
						)
					: [];
				const q = await pricing.quote(s, {
					lines: priced.lines,
					codes: s.settings.enabled('offer_apply') ? codes.slice(0, s.settings.offers.max_codes) : [],
					loyaltyPoints: Number.isSafeInteger(body.loyaltyPoints) && body.loyaltyPoints > 0 ? body.loyaltyPoints : 0,
					deliveryMethod: typeof body.deliveryMethod === 'string' ? body.deliveryMethod : null,
					paymentMethod: typeof body.paymentMethod === 'string' ? body.paymentMethod : null,
					country: typeof body.country === 'string' ? body.country : null,
					subject: who.subject,
					cartId: priced.cartId,
				});
				return ok(quoteView(q));
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/orders',
			...website('place_order'),
			rateLimit: {
				limit: async (ctx) =>
					ctx.website?.kind === 'pk' ? (await site(ctx)).settings.place.orders_per_hour : Number.POSITIVE_INFINITY,
				windowMs: 3_600_000,
				key: shopperKey,
			},
			idempotent: true,
			handler: async (ctx) => {
				if (!ctx.idempotencyKey)
					return problem('idempotency_key_required', 'Send an Idempotency-Key header (one per order submission).');
				const result = await placement.place(await site(ctx), ctx.body, {
					who: requesterOf(ctx),
					caller: callerOf(ctx),
					idempotencyKey: ctx.idempotencyKey,
				});
				if (!result.ok) return fail(result);
				return created(placedView(result), { location: `/v1/orders/${result.order.id}` });
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/orders',
			...website('place_order', { sk: true }),
			handler: async (ctx) => {
				const p = page(ctx);
				const s = await site(ctx);
				const list = await s.repos.orders.list({
					after: Array.isArray(p.after) ? /** @type {[string, string]} */ (p.after) : null,
					fetchLimit: p.fetchLimit,
					status: typeof ctx.query.status === 'string' ? ctx.query.status : null,
					subject: cleanText(ctx.query.customerId, 255),
				});
				const who = requesterOf(ctx);
				const current = await Promise.all(list.map((/** @type {any} */ order) => orders.expireIfDue(s, order)));
				return p.respond(
					current.map((order) => orders.view(s, order, who)),
					(/** @type {{ placedAt: string, id: string }} */ order) => [order.placedAt, order.id],
				);
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/orders/:id',
			...website('place_order'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const who = requesterOf(ctx);
				const order = await orders.access(s, ctx.params.id, who);
				return order ? ok(orders.view(s, order, who)) : fail({ code: 'order_not_found' });
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/orders/:id/view',
			...website('place_order'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const who = requesterOf(ctx);
				const order = await orders.access(s, ctx.params.id, who, ctx.body?.token);
				return order ? ok(orders.view(s, order, who)) : fail({ code: 'order_not_found' });
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/orders/:id/cancel',
			...website('place_order'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const who = requesterOf(ctx);
				const order = await orders.access(s, ctx.params.id, who, ctx.body?.token);
				if (!order) return fail({ code: 'order_not_found' });
				const byShopper = who.kind === 'pk';
				if (
					byShopper
						? !customerMayCancel(order, s.settings.place.customer_cancellable)
						: !TRANSITIONS.cancel.includes(order.status)
				)
					return fail({ code: 'order_state' });
				const reason = cleanText(ctx.body?.reason, 200) ?? (byShopper ? 'customer_cancelled' : 'merchant_cancelled');
				const moved = await orders.cancel(s, order, {
					reason,
					actor: byShopper ? { type: 'customer' } : { type: 'merchant', id: ctx.website?.keyId ?? null },
					publish: true,
					...(byShopper ? { from: TRANSITIONS.expire } : {}),
				});
				return moved ? ok(orders.view(s, moved, who)) : fail({ code: 'order_state' });
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/orders/:id/confirm',
			...website('place_order', { sk: true }),
			handler: async (ctx) => {
				const s = await site(ctx);
				const order = await s.repos.orders.get(ctx.params.id);
				if (!order) return fail({ code: 'order_not_found' });
				const moved = await orders.confirm(s, order, {
					actor: { type: 'merchant', id: ctx.website?.keyId ?? null },
					by: 'merchant',
				});
				return moved ? ok(orders.view(s, moved, requesterOf(ctx))) : fail({ code: 'order_state' });
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/orders/:id/payments',
			...website('place_order', { sk: true }),
			idempotent: true,
			handler: async (ctx) => {
				const s = await site(ctx);
				const body = isObject(ctx.body) ? ctx.body : {};
				if (!Number.isSafeInteger(body.amount) || body.amount <= 0)
					return fail({ code: 'validation_failed', errors: [{ path: '/amount', code: 'amount_invalid' }] });
				const order = await s.repos.orders.get(ctx.params.id);
				if (!order) return fail({ code: 'order_not_found' });
				const moved = await orders.recordPayment(s, order, {
					amount: body.amount,
					method: cleanText(body.method, 64) ?? order.payment.method,
					reference: cleanText(body.reference, 200),
					actor: { type: 'merchant', id: ctx.website?.keyId ?? null },
					publish: true,
				});
				return moved ? ok(orders.view(s, moved, requesterOf(ctx))) : fail({ code: 'order_state' });
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/blocks',
			...website('place_order', { sk: true }),
			handler: async (ctx) => {
				const p = page(ctx);
				const list = await (
					await site(ctx)
				).repos.blocks.list({ after: typeof p.after === 'string' ? p.after : null, fetchLimit: p.fetchLimit });
				return p.respond(list, (/** @type {{ id: string }} */ block) => block.id);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/blocks',
			...website('place_order', { sk: true }),
			handler: async (ctx) => {
				const body = isObject(ctx.body) ? ctx.body : {};
				const kind = body.kind;
				const raw = cleanText(body.value, 320);
				if (!['subject', 'email', 'phone'].includes(kind) || !raw)
					return fail({ code: 'validation_failed', errors: [{ path: kind ? '/value' : '/kind', code: 'invalid' }] });
				const block = {
					id: app.randomId('blk'),
					kind,
					value: kind === 'email' ? raw.toLowerCase() : raw,
					note: cleanText(body.note, 200),
				};
				const s = await site(ctx);
				if (!(await s.repos.blocks.insert(block))) return problem('conflict', 'Already blocked.');
				await product.audit.record({
					websiteId: s.websiteId,
					actor: { type: 'api', id: ctx.website?.keyId },
					action: 'checkout.block_added',
					target: { blockId: block.id, kind },
				});
				return created(block, { location: `/v1/blocks/${block.id}` });
			},
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/blocks/:id',
			...website('place_order', { sk: true }),
			handler: async (ctx) =>
				(await (await site(ctx)).repos.blocks.remove(ctx.params.id))
					? ok({ id: ctx.params.id, deleted: true })
					: problem('not_found', 'No such entry.'),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/integrations',
			...website('place_order', { sk: true }),
			handler: async (ctx) => ok(await application.integrationStatus(await site(ctx))),
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/integrations/key',
			...website('place_order', { sk: true }),
			handler: async (ctx) => {
				const key = typeof ctx.body?.key === 'string' ? ctx.body.key.trim() : '';
				if (!/^sk_[A-Za-z0-9_.-]{10,4000}$/.test(key))
					return fail({ code: 'validation_failed', errors: [{ path: '/key', code: 'server_key_required' }] });
				const s = await site(ctx);
				await application.setIntegrationKey(s, key);
				await product.audit.record({
					websiteId: s.websiteId,
					actor: { type: 'api', id: ctx.website?.keyId },
					action: 'checkout.integration_key_set',
				});
				return ok(await application.integrationStatus(s));
			},
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/integrations/key',
			...website('place_order', { sk: true }),
			handler: async (ctx) => {
				const s = await site(ctx);
				await application.setIntegrationKey(s, null);
				return ok(await application.integrationStatus(s));
			},
		}),

		// ── payment_manual / payment_proofs / payment_gateway ────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/payment-methods',
			...website('payment_manual'),
			handler: async (ctx) => ok(payments.methods(await site(ctx))),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/payment-proofs',
			...website('payment_proofs'),
			handler: async (ctx) => {
				const result = await payments.startProof(await site(ctx), isObject(ctx.body) ? ctx.body : {}, requesterOf(ctx));
				return result.ok ? created(result.value) : fail(/** @type {any} */ (result));
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/payment-proofs/:id/complete',
			...website('payment_proofs'),
			handler: async (ctx) => {
				const result = await payments.completeProof(
					await site(ctx),
					ctx.params.id,
					isObject(ctx.body) ? ctx.body : {},
					requesterOf(ctx),
				);
				return result.ok ? ok(result.value) : fail(/** @type {any} */ (result));
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/payment-proofs/:id',
			...website('payment_proofs', { sk: true }),
			handler: async (ctx) => {
				const link = isId(ctx.query.orderId)
					? await payments.proofLink(await site(ctx), ctx.query.orderId, ctx.params.id)
					: null;
				return link ? ok(link) : problem('not_found', 'No such proof.');
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/payments',
			...website('payment_gateway'),
			idempotent: true,
			handler: async (ctx) => {
				const result = await payments.startPayment(await site(ctx), isObject(ctx.body) ? ctx.body : {}, requesterOf(ctx), {
					domain: String(ctx.website.domain ?? '').toLowerCase(),
					allowSubdomains: ctx.website.allowSubdomains === true,
				});
				return result.ok ? created(result.value) : fail(/** @type {any} */ (result));
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/payments/:id/refresh',
			...website('payment_gateway'),
			handler: async (ctx) => {
				const result = await payments.refreshPayment(
					await site(ctx),
					ctx.params.id,
					isObject(ctx.body) ? ctx.body : {},
					requesterOf(ctx),
				);
				return result.ok ? ok(result.value) : fail(/** @type {any} */ (result));
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/webhooks/payments/:websiteId',
			auth: 'none',
			rawBody: true,
			maxBodyBytes: 65_536,
			handler: async (ctx) => {
				const s = await application.siteFor(ctx.params.websiteId, 'payment_gateway');
				if (!s) return problem('not_found', 'Unknown website.');
				const result = await payments.webhook(s, { headers: ctx.headers, rawBody: String(ctx.rawBody ?? '') });
				return result.ok ? ok(result.value) : problem('unauthorized', 'Invalid webhook signature.');
			},
		}),

		// ── offer_apply / loyalty_redeem ─────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/offers',
			...website('offer_apply'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const status = await application.integrationStatus(s);
				return ok({
					coupons: status.coupons && status.key !== null,
					deals: status.deals && status.key !== null,
					maxCodes: s.settings.offers.max_codes,
				});
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/offers:check',
			...website('offer_apply'),
			handler: async (ctx) => {
				const s = await site(ctx);
				if (!s.settings.currency) return fail({ code: 'currency_not_configured' });
				const body = isObject(ctx.body) ? ctx.body : {};
				const who = requesterOf(ctx);
				const priced = await lines(s, body, who);
				if (!priced.ok) return fail(priced);
				const codes = Array.isArray(body.codes)
					? body.codes.filter((/** @type {unknown} */ c) => typeof c === 'string').slice(0, s.settings.offers.max_codes)
					: [];
				const q = await pricing.quote(s, {
					lines: priced.lines,
					codes,
					loyaltyPoints: 0,
					deliveryMethod: null,
					paymentMethod: null,
					country: null,
					subject: who.subject,
					cartId: priced.cartId,
				});
				const view = quoteView(q);
				return ok({ totals: view.totals, deals: view.deals, codes: view.codes, warnings: view.warnings });
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/loyalty',
			...website('loyalty_redeem'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const status = await application.integrationStatus(s);
				return ok({ connected: status.loyalty && status.key !== null, signedIn: Boolean(ctx.identity?.subject) });
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/loyalty:quote',
			...website('loyalty_redeem'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const who = requesterOf(ctx);
				const subject = who.kind === 'sk' ? cleanText(ctx.body?.customerId, 255) : who.subject;
				if (!subject) return problem('identity_required', 'Sign in to use points.');
				const priced = await lines(s, ctx.body, who);
				if (!priced.ok) return fail(priced);
				const q = await pricing.quote(s, {
					lines: priced.lines,
					codes: [],
					loyaltyPoints: 0,
					deliveryMethod: null,
					paymentMethod: null,
					country: null,
					subject,
					cartId: priced.cartId,
				});
				const conns = await application.connectionsFor(s);
				if (!conns.loyalty) return fail({ code: 'integration_unavailable', detail: 'loyalty' });
				const merchandise = q.totals.subtotal - q.totals.itemDiscount - q.totals.couponDiscount;
				const result = await application.integrations.loyalty.quote(conns.loyalty, {
					customerId: subject.slice(0, 128),
					amount: merchandise,
					currency: q.currency,
					discount: 0,
				});
				if (!result.ok) return fail({ code: 'integration_unavailable', detail: 'loyalty' });
				const quote = result.json ?? {};
				return ok({
					allowed: quote.allowed === true,
					reason: quote.reason ?? null,
					balance: quote.balance ?? 0,
					minPoints: quote.minPoints ?? 0,
					maxPoints: quote.maxPoints ?? 0,
					maxValue: Math.min(quote.maxValue ?? 0, Math.floor((merchandise * s.settings.loyalty.max_share_bp) / 10_000)),
					pointValue: quote.pointValue ?? null,
					currency: q.currency,
				});
			},
		}),

		// ── success_page / policies_notice / signin_gate ─────────────────────────────────────────────────────
		defineRoute({
			method: 'POST',
			path: '/v1/success-views',
			...website('success_page'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const who = requesterOf(ctx);
				const order = await orders.access(s, ctx.body?.orderId, who, ctx.body?.token);
				return order ? ok(orders.success(s, order, who)) : fail({ code: 'order_not_found' });
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/success-views/:orderId',
			...website('success_page'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const who = requesterOf(ctx);
				const order = await orders.access(s, ctx.params.orderId, who);
				return order ? ok(orders.success(s, order, who)) : fail({ code: 'order_not_found' });
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/policies',
			...website('policies_notice'),
			handler: async (ctx) => {
				const s = await site(ctx);
				return ok({ items: policiesView(s.settings.policies, application.translator(s.settings.language)) });
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/signin-gate',
			...website('signin_gate'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const total = Number(ctx.query.total);
				const required = identityRequired(s.settings.gate, {
					paymentMethod: typeof ctx.query.paymentMethod === 'string' ? ctx.query.paymentMethod : null,
					total: Number.isSafeInteger(total) ? total : null,
				});
				return ok({
					policy: s.settings.gate.required,
					required,
					signedIn: Boolean(ctx.identity?.subject),
					signinUrl: signinLink(s.settings.gate, ctx.query.return),
				});
			},
		}),

		// ── dashboard (SSO session) ──────────────────────────────────────────────────────────────────────────
		...dashboardRoutes(application),
	];
};

/** Orders and carts handled per "Process expired now" press (press again while `more`). */
export const EXPIRY_RUN_LIMIT = 100;

/**
 * Dashboard actions (launch sessions; merchant and staff roles may write).
 * @param {Application} application
 */
const dashboardRoutes = (application) => {
	const { orders, payments, siteOf } = application;
	/** @param {any} ctx */
	const site = (ctx) => siteOf(ctx.websiteId, ctx.entitlement.doc);
	/** @param {any} ctx */
	const actorOf = (ctx) => {
		const view = sessionView(ctx.session);
		return { type: view.kind === 'admin' ? 'staff' : 'merchant', id: view.user ?? 'unknown' };
	};
	const write = { auth: /** @type {const} */ ('launch'), element: 'place_order', roles: [...DASHBOARD_WRITE_ROLES] };
	/**
	 * @param {any} ctx
	 * @param {(s: Site, order: Record<string, any>) => Promise<Record<string, any> | null>} run
	 */
	const onOrder = async (ctx, run) => {
		if (!ctx.websiteId || !ctx.entitlement) return problem('bad_request', 'Open the dashboard for a website.');
		const s = await site(ctx);
		const order = await s.repos.orders.get(ctx.params.id);
		if (!order) return fail({ code: 'order_not_found' });
		const moved = await run(s, order);
		return moved
			? ok(orders.view(s, moved, { kind: 'session', subject: null, email: null, phone: null }))
			: fail({ code: 'order_state' });
	};
	return [
		defineRoute({
			method: 'POST',
			path: '/v1/dashboard/orders/:id/confirm',
			...write,
			handler: (ctx) => onOrder(ctx, (s, order) => orders.confirm(s, order, { actor: actorOf(ctx), by: 'merchant' })),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/dashboard/orders/:id/cancel',
			...write,
			handler: (ctx) =>
				onOrder(ctx, (s, order) =>
					orders.cancel(s, order, {
						reason: cleanText(ctx.body?.reason, 200) ?? 'merchant_cancelled',
						actor: actorOf(ctx),
						publish: true,
					}),
				),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/dashboard/orders/:id/payments',
			...write,
			idempotent: true,
			handler: (ctx) =>
				onOrder(ctx, (s, order) =>
					Number.isSafeInteger(ctx.body?.amount) && ctx.body.amount > 0
						? orders.recordPayment(s, order, {
								amount: ctx.body.amount,
								method: cleanText(ctx.body?.method, 64) ?? order.payment.method,
								reference: cleanText(ctx.body?.reference, 200),
								actor: actorOf(ctx),
								publish: true,
							})
						: Promise.resolve(null),
				),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/dashboard/expiry:run',
			...write,
			handler: async (ctx) => {
				if (!ctx.websiteId || !ctx.entitlement) return problem('bad_request', 'Open the dashboard for a website.');
				const s = await site(ctx);
				const expired = await orders.expire(s, { limit: EXPIRY_RUN_LIMIT });
				const abandoned = await orders.abandon(s, { limit: EXPIRY_RUN_LIMIT });
				return ok({ expired, abandoned, more: expired === EXPIRY_RUN_LIMIT || abandoned === EXPIRY_RUN_LIMIT });
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/dashboard/orders/:id/proofs/:proofId',
			auth: 'launch',
			element: 'payment_proofs',
			handler: async (ctx) => {
				if (!ctx.websiteId || !ctx.entitlement) return problem('bad_request', 'Open the dashboard for a website.');
				const link = await payments.proofLink(await site(ctx), ctx.params.id, ctx.params.proofId);
				return link ? ok(link) : problem('not_found', 'No such proof.');
			},
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/dashboard/integration-key',
			...write,
			handler: async (ctx) => {
				if (!ctx.websiteId || !ctx.entitlement) return problem('bad_request', 'Open the dashboard for a website.');
				const key = typeof ctx.body?.key === 'string' ? ctx.body.key.trim() : '';
				const s = await site(ctx);
				if (key === '') await application.setIntegrationKey(s, null);
				else if (/^sk_[A-Za-z0-9_.-]{10,4000}$/.test(key)) await application.setIntegrationKey(s, key);
				else return fail({ code: 'validation_failed', errors: [{ path: '/key', code: 'server_key_required' }] });
				await application.product.audit.record({
					websiteId: s.websiteId,
					actor: actorOf(ctx),
					action: key === '' ? 'checkout.integration_key_removed' : 'checkout.integration_key_set',
				});
				return ok(await application.integrationStatus(s));
			},
		}),
	];
};

/**
 * Register the event consumers (app-kit dedupes deliveries on the event id).
 * @param {Application} application
 */
export const wireEvents = (application) => {
	for (const [type, handler] of Object.entries(createEventHandlers(application))) application.product.events.on(type, handler);
	return application;
};
