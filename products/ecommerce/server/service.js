/**
 * The shop's shared service: what every part (catalog, checkout and orders, promotions, returns, extras, SEO, the
 * Chat lookups) uses while serving a website — the website context (merchant database, switched-on features, settings,
 * business.json), the shopper's verified Accounts sign-in, staff actors and the activity log, messages through the
 * pasted Notifications token, payments through the pasted Payments token, and in-process hooks between the parts
 * (for example a catalog change tells the alerts). Nothing here calls the network except through the kit's
 * `callProduct` (pasted tokens only, PLAN 0.4.6).
 * @module
 */
import { actorOf, problem, zonedParts } from '@ss/app-kit';
import { createOrdersStore } from '../adapters/orders-store.js';
import { unitOf } from '../core/money.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */
/** @typedef {import('../core/model.js').OrderRecord} OrderRecord */

/** The header a signed-in shopper's Accounts sign-in comes in (the kit's CORS allows it). */
const SIGN_IN_HEADER = 'ss-sign-in';

/** Rate limits of the merchant's server and admin routes (code constants protecting our hosting). */
export const SERVER_LIMITS = Object.freeze([{ limit: 600, windowSeconds: 60, per: /** @type {const} */ ('website') }]);
/** Rate limits of visitor routes. */
export const VISITOR_LIMITS = Object.freeze([
	{ limit: 600, windowSeconds: 60, per: /** @type {const} */ ('website') },
	{ limit: 60, windowSeconds: 60, per: /** @type {const} */ ('visitor') },
]);
/** Rate limits of visitor routes that write (checkout, reviews, claims, alerts). */
export const VISITOR_WRITE_LIMITS = Object.freeze([
	{ limit: 120, windowSeconds: 60, per: /** @type {const} */ ('website') },
	{ limit: 10, windowSeconds: 60, per: /** @type {const} */ ('visitor') },
]);

/** The server token as an actor, when a call names no member of the staff (PLAN 0.8.10 K2). */
const SERVER_ACTOR = Object.freeze({ kind: 'server', id: 'server', name: 'Server' });

/** What the `SS-Actor-*` headers take (the kit's rules), so a refund asked of Payments names its staff member. */
const ACTOR_ID = /^[A-Za-z0-9_.:@-]{1,64}$/;
const MAX_ACTOR_NAME = 120;
const MAX_ACTOR_ROLE = 40;

/** @param {string} text */
const plainText = (text) => [...text].every((ch) => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f);

/**
 * The `SS-Actor-*` headers naming a member of the staff on a call to another product (K2), or none for the server or
 * a name the headers cannot carry.
 * @param {{ kind: string, id: string, name?: string, role?: string }} who
 * @returns {Record<string, string>}
 */
export const actorHeaders = (who) => {
	const name = who.name ?? '';
	if (who.kind === 'server' || !ACTOR_ID.test(who.id) || !name || name.length > MAX_ACTOR_NAME || !plainText(name)) return {};
	const role = who.role && who.role.length <= MAX_ACTOR_ROLE && plainText(who.role) ? who.role : '';
	return {
		'ss-actor-id': who.id,
		'ss-actor-name': encodeURIComponent(name),
		...(role ? { 'ss-actor-role': encodeURIComponent(role) } : {}),
	};
};

/**
 * A shopper: the Accounts user of a verified sign-in (PLAN 0.4.6), with their role (role pricing, loyalty roles) and
 * whether Accounts verified their phone (guest orders move to them, E21).
 * @typedef {{ id: string, name: string, email: string, phone: string, role?: string, phoneVerified?: boolean }} Shopper
 */

/**
 * The claims of a sign-in already verified (its middle part), or {}.
 * @param {string} token
 * @returns {Record<string, unknown>}
 */
const claimsOf = (token) => {
	try {
		const body = JSON.parse(Buffer.from(String(token.split('.')[1] ?? ''), 'base64url').toString('utf8'));
		return typeof body === 'object' && body !== null ? body : {};
	} catch {
		return {};
	}
};

/**
 * A website while serving one request. `values(feature)` and `data()` are read once per request.
 * @typedef {object} Site
 * @property {string} websiteId
 * @property {string | null} merchantId
 * @property {string} domain
 * @property {any} ctx the kit's request context
 * @property {string[]} on switched-on features
 * @property {(feature: string) => boolean} has whether a feature is on
 * @property {(feature: string) => Promise<Record<string, any>>} values a feature's resolved settings
 * @property {() => Promise<WebsiteData>} data the guarded merchant database
 * @property {() => ReturnType<Product['business']>} business business.json (defaults: name = the domain, time zone UTC)
 * @property {() => Promise<Record<string, string>>} texts the website's widget texts
 * @property {(name: string) => Promise<any[]>} list a list setting of the product database (`adapters/lists.js`)
 * @property {() => ReturnType<Product['format']>} format the Format and business time zone, with `money` and `date` for
 *   text the server makes (PLAN 0.8.10 K7, K8)
 * @property {string} currency the shop's currency (`catalog` setting)
 */

/**
 * @typedef {'products.changed' | 'order.placed' | 'order.moved' | 'order.paid' | 'order.proof_uploaded'
 *   | 'order.payment_recorded' | 'order.refunded' | 'return.requested' | 'return.status_changed' | 'review.submitted'} HookName
 *   `products.changed`: `{ productIds, before: Map<id, { price, inStock }> }` after catalog writes (alerts);
 *   `order.placed`: `{ order, statusLabel? }`; `order.moved`: `{ order, from, to, by?, reason? }` (the order after the
 *   move); `order.paid`: `{ order, entry }` (`entry` null when placed already paid); `order.proof_uploaded`:
 *   `{ order, reference }`; `order.payment_recorded`: `{ order, entry }` (E26); `order.refunded`: `{ order, amount, claimId }`;
 *   `return.requested`: `{ claim, order }` when a shopper makes a claim (E33, for E32's `return_requested`);
 *   `return.status_changed`: `{ claim, from, to }`; `review.submitted`: `{ review }` (E32)
 */

/** Work that runs on use (PLAN 0.8.1: no scheduled jobs) runs at most this often per website and instance. */
const ON_USE_EVERY_MS = 60_000;
/** Signed-in shoppers this instance made sure have a customer record (`customerRecords: sign_in`), at most this many. */
const MAX_KNOWN_SHOPPERS = 10_000;

/**
 * @param {Product} product
 */
export const createService = (product) => {
	const { now } = product;
	/** @type {Map<HookName, Array<(s: Site, payload: any) => Promise<void> | void>>} */
	const hooks = new Map();
	/** @type {Array<(s: Site) => Promise<void>>} */
	const onUse = [];
	/** @type {Map<string, number>} website id → last time the work on use ran */
	const lastUse = new Map();
	/** `<website id>|<user id>` of signed-in shoppers whose customer record this instance made sure of. @type {Set<string>} */
	const knownShoppers = new Set();

	/**
	 * Run the parts' work on use right after the answer (expired waiting orders, rechecks …), at most every
	 * {@link ON_USE_EVERY_MS} per website on this instance.
	 * @param {Site} s
	 */
	const scheduleUse = (s) => {
		if (onUse.length === 0 || typeof s.ctx.after !== 'function') return;
		const last = lastUse.get(s.websiteId) ?? -Infinity;
		if (now() - last < ON_USE_EVERY_MS) return;
		lastUse.set(s.websiteId, now());
		s.ctx.after(async () => {
			for (const work of onUse) {
				try {
					await work(s);
				} catch (error) {
					s.ctx.log?.warn?.('work on use failed', { code: /** @type {any} */ (error)?.code ?? 'error' });
				}
			}
		});
	};

	/**
	 * The website of a request (browser token, server token or ticket).
	 * @param {any} ctx
	 * @returns {Promise<Site>}
	 */
	const site = async (ctx) => {
		const websiteId = /** @type {string} */ (ctx.websiteId);
		const merchantId = ctx.merchantId ?? null;
		const on = await product.featuresOn(websiteId);
		/** @type {Map<string, Promise<Record<string, any>>>} */
		const values = new Map();
		/** @type {Promise<WebsiteData> | null} */
		let data = null;
		/** @type {Map<string, Promise<any[]>>} */
		const lists = new Map();
		/** @type {ReturnType<Product['format']> | null} */
		let formatted = null;
		const catalog = await product.settings.values(websiteId, 'catalog');
		/** @type {Site} */
		const s = {
			websiteId,
			merchantId,
			domain: ctx.status?.domain ?? '',
			ctx,
			on,
			has: (feature) => on.includes(feature),
			values: (feature) => {
				let found = values.get(feature);
				if (!found) {
					found = product.settings.values(websiteId, feature);
					values.set(feature, found);
				}
				return found;
			},
			data: () => {
				data ??= ctx.data ? ctx.data() : product.data.forWebsite(websiteId, merchantId ? { merchantId } : {});
				return /** @type {Promise<WebsiteData>} */ (data);
			},
			business: () => product.business(websiteId),
			texts: () => product.settings.texts(websiteId),
			list: (name) => {
				let found = lists.get(name);
				if (!found) {
					found = product.lists.get(websiteId, /** @type {any} */ (name));
					lists.set(name, found);
				}
				return found;
			},
			format: () => {
				formatted ??= product.format(websiteId);
				return formatted;
			},
			currency: typeof catalog.currency === 'string' && catalog.currency ? catalog.currency : 'USD',
		};
		scheduleUse(s);
		return s;
	};

	/**
	 * The shopper of a visitor request: the verified Accounts sign-in in `SS-Sign-In`, or null (none, invalid, expired
	 * or no Accounts token pasted).
	 * @param {Site} s
	 * @returns {Promise<Shopper | null>}
	 */
	const shopper = async (s) => {
		const token = s.ctx.headers?.get?.(SIGN_IN_HEADER);
		if (!token) return null;
		const verified = await product.accounts.verify({ websiteId: s.websiteId, token });
		if (!verified.ok) return null;
		const user = verified.user;
		/** @type {Shopper} */
		const found = {
			id: user.id,
			name: user.name ?? '',
			email: user.email ?? '',
			phone: user.phone ?? '',
			role: user.role ?? '',
			phoneVerified: Boolean(user.phone) && claimsOf(token).phone_verified === true,
		};
		recordShopper(s, found);
		return found;
	};

	/**
	 * With the `checkout` setting `customerRecords: sign_in`, a signed-in shopper gets their customer record (CU-2) right
	 * after the answer, the first time this instance sees them; their details are written only when it is made.
	 * @param {Site} s @param {Shopper} found
	 */
	const recordShopper = (s, found) => {
		const key = `${s.websiteId}|${found.id}`;
		if (knownShoppers.has(key) || typeof s.ctx.after !== 'function') return;
		s.ctx.after(async () => {
			if (!s.has('checkout') || (await s.values('checkout')).customerRecords !== 'sign_in') return;
			if (knownShoppers.size >= MAX_KNOWN_SHOPPERS) knownShoppers.clear();
			await createOrdersStore(await s.data()).ensureCustomer(
				{ userId: found.id, name: found.name, email: found.email, phone: found.phone },
				{ at: new Date(now()), refresh: false },
			);
			knownShoppers.add(key);
		});
	};

	/**
	 * An Accounts user of the website (`GET /v1/users/:id` through the pasted Accounts token): their name, contacts and
	 * when they joined; null when Accounts does not know them or cannot be asked.
	 * @param {Site} s @param {string} userId
	 * @returns {Promise<{ id: string, name: string, email: string, phone: string, createdAt: Date } | null>}
	 */
	const accountsUser = async (s, userId) => {
		const answer = await product
			.callProduct(s.websiteId, 'accounts', `/v1/users/${encodeURIComponent(userId)}`, { method: 'GET' })
			.catch(() => /** @type {const} */ ({ ok: false }));
		if (!answer.ok || answer.status !== 200 || typeof answer.body !== 'object' || answer.body === null) return null;
		const body = /** @type {Record<string, any>} */ (answer.body);
		if (body.id !== userId) return null;
		const joined = Date.parse(String(body.createdAt ?? ''));
		return {
			id: userId,
			name: typeof body.name === 'string' ? body.name : '',
			email: typeof body.email === 'string' ? body.email : '',
			phone: typeof body.phone === 'string' ? body.phone : '',
			createdAt: new Date(Number.isNaN(joined) ? now() : joined),
		};
	};

	/**
	 * What pricing needs of the website now: the whole unit amounts round to (Format's `wholeUnits`, E25) and the
	 * business time (weekday and minutes in the business.json time zone, K8) deal hours are judged by.
	 * @param {Site} s
	 * @returns {Promise<{ unit: number, weekday: number, minutes: number, timeZone: string }>}
	 */
	const pricing = async (s) => {
		const { format, timeZone } = await s.format();
		const parts = zonedParts(now(), timeZone || 'UTC');
		return {
			unit: unitOf(s.currency, format.wholeUnits === true),
			weekday: parts.weekday,
			minutes: parts.hour * 60 + parts.minute,
			timeZone: timeZone || 'UTC',
		};
	};

	/**
	 * The shopper, or 401 `sign_in_required`.
	 * @param {Site} s
	 * @returns {Promise<Shopper>}
	 */
	const requireShopper = async (s) => {
		const found = await shopper(s);
		if (!found) throw problem('sign_in_required', 'Sign in to continue.');
		return found;
	};

	/**
	 * The signed-in shopper's own Accounts profile (`GET /v1/me` with the forwarded sign-in, through the pasted
	 * Accounts token, K3): their name and default address's city and area. Null without a sign-in or when Accounts does
	 * not answer.
	 * @param {Site} s
	 * @returns {Promise<{ name: string, city: string, area: string } | null>}
	 */
	const accountProfile = async (s) => {
		const token = s.ctx.headers?.get?.(SIGN_IN_HEADER);
		if (!token) return null;
		const answer = await product
			.callProduct(s.websiteId, 'accounts', '/v1/me', { headers: { [SIGN_IN_HEADER]: token } })
			.catch(() => /** @type {const} */ ({ ok: false }));
		if (!answer.ok || answer.status !== 200 || typeof answer.body !== 'object' || answer.body === null) return null;
		const body = /** @type {Record<string, any>} */ (answer.body);
		const addresses = Array.isArray(body.addresses) ? body.addresses : [];
		const home = addresses.find((address) => address?.default === true) ?? addresses[0] ?? null;
		return {
			name: typeof body.name === 'string' ? body.name : '',
			city: typeof home?.city === 'string' ? home.city : '',
			area: typeof home?.area === 'string' ? home.area : '',
		};
	};

	/**
	 * Who acts (PLAN 0.8.10 K2): the member of the merchant's staff in the ticket, else the one a server-token call names
	 * in its `SS-Actor-*` headers (with their role), else the server.
	 * @param {any} ctx
	 * @returns {{ kind: string, id: string, name: string, role?: string, email?: string }}
	 */
	const actor = (ctx) =>
		/** @type {{ kind: string, id: string, name: string, role?: string, email?: string }} */ (actorOf(ctx, SERVER_ACTOR));

	/**
	 * Write an activity-log entry for what the merchant's staff or server did (copied to Accounts when its token is
	 * pasted, PLAN 0.4.11), with the target's `label` (an order number, a product name …) and a short plain-text
	 * `detail` (never message contents, secrets or addresses; K9).
	 * @param {any} ctx @param {string} action @param {string} target
	 * @param {{ label?: string, detail?: string }} [about]
	 */
	const log = (ctx, action, target, { label, detail } = {}) =>
		product.activity.record(
			{ websiteId: ctx.websiteId, merchantId: ctx.merchantId, after: ctx.after },
			{ actor: actor(ctx), action, target, ...(label ? { label } : {}), ...(detail ? { detail } : {}) },
		);

	/**
	 * A 422 `validation_failed` naming the field.
	 * @param {string} field @param {string} message @param {string} [code]
	 */
	const invalid = (field, message, code = 'invalid') =>
		problem('validation_failed', message, { errors: [{ path: `/${field}`, message, code }] });

	// ---------------------------------------------------------------------------------------------- notifications

	/**
	 * Send one template through Notifications (pasted token) on each given channel the recipient has an address for.
	 * Template keys start with `ecommerce.` (Notifications treats them as this product's events). Never throws.
	 * @param {Site} s
	 * @param {string} template e.g. `ecommerce.order_placed`
	 * @param {{ email?: string, phone?: string }} to
	 * @param {Record<string, string | number>} values each at most 1,000 characters
	 * @param {ReadonlyArray<'email' | 'sms' | 'whatsapp'>} channels
	 * @returns {Promise<'sent' | 'not_connected' | 'failed' | 'skipped'>}
	 */
	const notify = async (s, template, to, values, channels) => {
		const business = (await s.business()).name;
		/** @type {'sent' | 'not_connected' | 'failed' | 'skipped'} */
		let result = 'skipped';
		for (const channel of channels) {
			const address = channel === 'email' ? to.email : to.phone;
			if (!address) continue;
			const answer = await product
				.callProduct(s.websiteId, 'notifications', `/v1/messages/${channel}`, {
					method: 'POST',
					body: {
						template,
						to: channel === 'email' ? { email: address } : { phone: address },
						values: { ...values, business },
					},
				})
				.catch(() => /** @type {const} */ ({ ok: false, reason: 'failed' }));
			if (!answer.ok) {
				if (answer.reason === 'not_connected') return 'not_connected';
				result = 'failed';
				continue;
			}
			if (result !== 'failed') result = 'sent';
		}
		return result;
	};

	// --------------------------------------------------------------------------------------------------- payments

	/**
	 * One call to Payments with the pasted token; a refused or unreachable call is 503 `payments_unavailable`.
	 * @param {Site} s
	 * @param {string} method
	 * @param {string} path
	 * @param {unknown} [body]
	 * @param {Record<string, string>} [headers]
	 * @returns {Promise<any>} the answer's body
	 */
	const callPayments = async (s, method, path, body, headers) => {
		const answer = await product.callProduct(s.websiteId, 'payments', path, {
			method,
			...(body === undefined ? {} : { body }),
			...(headers ? { headers } : {}),
		});
		if (!answer.ok)
			throw problem(
				'payments_unavailable',
				answer.reason === 'not_connected' ? 'Payments not connected.' : 'Payments cannot be reached right now.',
			);
		if (answer.status >= 400) {
			const detail = typeof answer.body === 'object' && answer.body !== null ? /** @type {any} */ (answer.body).detail : '';
			throw problem('payments_refused', typeof detail === 'string' && detail ? detail : 'Payments refused the request.');
		}
		return answer.body;
	};

	const payments = Object.freeze({
		/**
		 * Start a payment (`POST /v1/payments`): the shopper pays on Payments' page (`checkoutUrl`).
		 * @param {Site} s
		 * @param {{ amount: number, currency: string, gateway?: string | null, description: string, reference: string,
		 *   customer: { id?: string, name?: string, email?: string, phone?: string }, metadata?: Record<string, string>,
		 *   returnUrl?: string | null, cancelUrl?: string | null, idempotencyKey: string }} input
		 * @returns {Promise<{ id: string, status: string, checkoutUrl: string }>}
		 */
		create: async (s, { idempotencyKey, ...input }) => {
			const body = await callPayments(s, 'POST', '/v1/payments', input, { 'idempotency-key': idempotencyKey });
			return { id: String(body.id), status: String(body.status), checkoutUrl: String(body.checkoutUrl ?? '') };
		},
		/**
		 * Whether Payments confirms the payment, server to server, for this website and exactly this amount (PLAN 0.3).
		 * @param {Site} s @param {string} paymentId @param {{ amount: number, currency: string }} expected
		 * @returns {Promise<{ verified: boolean, status: string, refunded: number }>}
		 */
		verify: async (s, paymentId, expected) => {
			const body = await callPayments(s, 'POST', `/v1/payments/${encodeURIComponent(paymentId)}/verify`, expected);
			return {
				verified: body.verified === true,
				status: String(body.payment?.status ?? ''),
				refunded: Number(body.payment?.refunded ?? 0),
			};
		},
		/**
		 * Refund (all or part) of a payment through Payments, naming the member of the staff who asked (K2).
		 * @param {Site} s @param {string} paymentId
		 * @param {{ amount: number, reason: string, idempotencyKey: string,
		 *   by: { kind: string, id: string, name?: string, role?: string } }} refund
		 * @returns {Promise<{ refundId: string, manual: boolean }>}
		 */
		refund: async (s, paymentId, { amount, reason, idempotencyKey, by }) => {
			const body = await callPayments(
				s,
				'POST',
				`/v1/payments/${encodeURIComponent(paymentId)}/refunds`,
				{ amount, reason },
				{ 'idempotency-key': idempotencyKey, ...actorHeaders(by) },
			);
			const refunds = Array.isArray(body.refunds) ? body.refunds : [];
			const last = refunds[refunds.length - 1] ?? {};
			return { refundId: String(last.id ?? ''), manual: last.manual === true };
		},
	});

	// ------------------------------------------------------------------------------------------------------ hooks

	/**
	 * Run something when another part of the shop does something (in process, same request).
	 * @param {HookName} name
	 * @param {(s: Site, payload: any) => Promise<void> | void} handler
	 */
	const on = (name, handler) => {
		hooks.set(name, [...(hooks.get(name) ?? []), handler]);
	};

	/**
	 * Tell the parts that registered for it; a failing handler never fails the request.
	 * @param {HookName} name @param {Site} s @param {unknown} payload
	 */
	const emit = async (name, s, payload) => {
		for (const handler of hooks.get(name) ?? []) {
			try {
				await handler(s, payload);
			} catch (error) {
				s.ctx.log?.warn?.('hook failed', { hook: name, code: /** @type {any} */ (error)?.code ?? 'error' });
			}
		}
	};

	/**
	 * Register work that runs on use for a website (right after a request, throttled).
	 * @param {(s: Site) => Promise<void>} work
	 */
	const whenUsed = (work) => {
		onUse.push(work);
	};

	return Object.freeze({
		now,
		site,
		whenUsed,
		shopper,
		requireShopper,
		accountProfile,
		accountsUser,
		pricing,
		actor,
		log,
		invalid,
		notify,
		payments,
		on,
		emit,
	});
};

/** @typedef {ReturnType<typeof createService>} Service */
