/**
 * The Deals application service: the only place that combines the pure core (engine, schedules, locks, validation)
 * with the merchant's repositories, metered usage, audit and product events. Routes, event consumers and the
 * dashboard call it; it never reads the environment and never talks HTTP.
 *
 * Exactly-once rules:
 * - a quote is stored once (app-kit refuses a repeated Idempotency-Key with 409 duplicate_request) and metered as
 *   `quote:<id>`;
 * - committing claims the quote for one order, counts each deal once per quote (`counted` on the quote survives a
 *   crash between counters) and inserts one application per quote and per order (unique indexes);
 * - releasing flips the application `committed → released` once before giving uses and stock back;
 * - events carry deterministic idempotency keys (`applied:<quoteId>`, `exhausted:<dealId>:<reason>`).
 */
import { dealInput, mergePatch, normaliseDeal } from '../core/deals.js';
import { evaluateCart, staticIneligibility } from '../core/evaluate.js';
import { applyLock, lockClaims } from '../core/locks.js';
import { dealCard, evaluateItem, sortCards } from '../core/offers.js';
import { scheduleState } from '../core/schedule.js';
import { catalogPrice, lineInScope, normaliseLine, scopeCatalogFilter } from '../core/scope.js';
import { MINUTE_MS, DAY_MS } from '../core/time.js';
import { catalogItem } from '../core/validate.js';
import { omit } from '../adapters/db.js';

/** @typedef {import('../core/deals.js').Deal} Deal */
/** @typedef {import('../core/evaluate.js').Customer} Customer */
/** @typedef {import('../adapters/db.js').Repositories} Repositories */
/**
 * @typedef {object} Site
 * @property {string} websiteId
 * @property {string | null} subscriptionId
 * @property {import('./settings.js').Settings} settings
 * @property {Repositories} repos
 */
/** @typedef {{ type: string, id?: string }} Actor */
/**
 * @typedef {({ ok: true } & Record<string, any>)
 *   | { ok: false, reason: string, detail?: string, dealId?: string, problems?: Array<{ path: string, code: string }> }} Outcome
 */

/** How long purged quotes stay after they expire (the TTL index removes them). */
const QUOTE_PURGE_AFTER_MS = DAY_MS;

/**
 * @param {{
 *   publish: (event: { websiteId: string, type: string, data: Record<string, unknown>, idempotencyKey: string }) => Promise<unknown>,
 *   recordUsage: (usage: { websiteId: string, subscriptionId?: string, unit: string, quantity: number, idempotencyKey: string }) => Promise<unknown>,
 *   audit: (entry: Record<string, unknown>) => Promise<unknown>,
 *   locks: import('../adapters/locks.js').LockTokens,
 *   newId: (prefix: string) => string,
 *   now: () => number,
 * }} deps
 */
export const createDealsService = ({ publish, recordUsage, audit, locks, newId, now }) => {
	/** @type {Map<string, { at: number, deals: Deal[] }>} */
	const cache = new Map();

	/**
	 * A stored deal as the engine sees it.
	 * @param {Site} site
	 * @param {Record<string, any>} doc
	 * @returns {Deal}
	 */
	const toDeal = (site, doc) =>
		normaliseDeal(doc, {
			id: doc.id,
			rules: site.settings.dealRules,
			defaults: site.settings.defaults,
			version: doc.version ?? 1,
		});

	/**
	 * Every non-archived deal (cached briefly per instance; writes on this instance refresh at once).
	 * @param {Site} site
	 * @returns {Promise<Deal[]>}
	 */
	const liveDeals = async (site) => {
		const ttl = site.settings.quote.deal_cache_seconds * 1000;
		const hit = cache.get(site.websiteId);
		if (hit && ttl > 0 && now() - hit.at < ttl) return hit.deals;
		const deals = (await site.repos.deals.live()).map((doc) => toDeal(site, /** @type {any} */ (doc)));
		cache.set(site.websiteId, { at: now(), deals });
		return deals;
	};
	/** @param {Site} site */
	const forget = (site) => cache.delete(site.websiteId);

	/**
	 * Committed usage the engine needs: counters of every deal with a limit, the customer's per-deal uses.
	 * @param {Site} site
	 * @param {Deal[]} deals
	 * @param {Customer} customer
	 */
	const usageFor = async (site, deals, customer) => {
		const limited = deals.filter((d) => d.limits.totalUses !== null || d.limits.stockUnits !== null).map((d) => d.id);
		const perCustomer = deals.filter((d) => d.limits.perCustomer !== null).map((d) => d.id);
		const [usage, customerUsage] = await Promise.all([
			site.repos.counters.forDeals(limited),
			customer.id ? site.repos.customerUsage.forCustomer(customer.id, perCustomer) : Promise.resolve({}),
		]);
		return { usage, customerUsage };
	};

	/**
	 * @param {Deal} deal
	 * @param {{ uses: number, units: number } | undefined} usage
	 * @param {Site} site
	 */
	const dealView = (deal, usage, site) => ({
		...deal,
		usage: { uses: usage?.uses ?? 0, units: usage?.units ?? 0 },
		state: scheduleView(deal, site),
	});
	/** @param {Deal} deal @param {Site} site */
	const scheduleView = (deal, site) => {
		const state = scheduleState(deal.schedule, now(), site.settings.timeZone);
		return {
			active: state.active && deal.status === 'active',
			phase: deal.status === 'active' ? state.phase : deal.status,
			activeUntil: state.activeUntil === null ? null : new Date(state.activeUntil).toISOString(),
			nextStart: state.nextStart === null ? null : new Date(state.nextStart).toISOString(),
			timeZone: state.timeZone,
		};
	};

	/**
	 * @param {Site} site
	 * @param {Actor} actor
	 * @param {string} action
	 * @param {string} target
	 * @param {unknown} [before]
	 * @param {unknown} [after]
	 */
	const auditDeal = (site, actor, action, target, before, after) =>
		audit({
			websiteId: site.websiteId,
			actor,
			action,
			target,
			...(before ? { before } : {}),
			...(after ? { after } : {}),
		}).catch(() => undefined);

	/** @param {Site} site @param {string} id */
	const getDeal = async (site, id) => {
		const doc = await site.repos.deals.get(id);
		if (!doc) return null;
		const deal = toDeal(site, doc);
		const usage = await site.repos.counters.forDeals([deal.id]);
		return dealView(deal, usage[deal.id], site);
	};

	// ── catalog ─────────────────────────────────────────────────────────────────────────────────────────
	/**
	 * Normalised lines: what the cart sent, completed from the synced catalog when enabled.
	 * @param {Site} site
	 * @param {Array<Record<string, any>>} raw
	 */
	const linesOf = async (site, raw) => {
		const catalog = site.settings.quote.catalog_lookup ? await site.repos.items.getMany(raw.map((l) => l.itemId)) : [];
		const byId = new Map(catalog.map((item) => [/** @type {any} */ (item).itemId, /** @type {any} */ (item)]));
		return raw.map((line, index) =>
			normaliseLine(/** @type {any} */ ({ quantity: 1, ...line }), index, byId.get(line.itemId) ?? null),
		);
	};

	/**
	 * Customer context of a request.
	 * @param {Site} site
	 * @param {{ keyKind: 'pk' | 'sk', identitySubject: string | null, body: Record<string, any> | undefined }} input
	 * @returns {Customer}
	 */
	const customerOf = (site, { keyKind, identitySubject, body }) => {
		const given = body && typeof body === 'object' ? body : {};
		const trusted = keyKind === 'sk' || site.settings.quote.trust_browser_customer === true;
		const id = keyKind === 'pk' ? identitySubject : typeof given.id === 'string' ? given.id : null;
		return {
			id,
			segments: trusted && Array.isArray(given.segments) ? given.segments : [],
			orders: trusted && Number.isSafeInteger(given.orders) ? given.orders : null,
			tags: trusted && Array.isArray(given.tags) ? given.tags : [],
		};
	};

	// ── quotes ──────────────────────────────────────────────────────────────────────────────────────────
	/**
	 * Quote a cart; stored for commit unless `preview` (dashboard simulator: nothing stored, nothing metered).
	 * @param {Site} site
	 * @param {Record<string, any>} body validated quote body
	 * @param {{ customer: Customer, preview?: boolean }} options
	 * @returns {Promise<Outcome>}
	 */
	const quote = async (site, body, { customer, preview = false }) => {
		const at = now();
		const lines = await linesOf(site, body.lines);
		let deals = await liveDeals(site);
		/** @type {Map<string, import('../core/evaluate.js').LockCandidate>} */
		const honoured = new Map();
		/** @type {Array<{ lineId: string, reason: string }>} */
		const stale = [];
		/** @type {Map<string, string>} tokens honoured, by line */
		const honouredTokens = new Map();
		if (site.settings.locks.enabled && Array.isArray(body.locks) && body.locks.length > 0) {
			const claims = body.locks.map((token) => ({ token, claims: locks.verify(token) })).filter((c) => c.claims !== null);
			for (const line of lines) {
				const match = claims.find((c) => c.claims?.i === line.itemId && c.claims?.vr === line.variantId);
				if (!match?.claims) continue;
				const result = applyLock(match.claims, {
					websiteId: site.websiteId,
					currency: body.currency,
					line,
					customerId: customer.id,
					now: at,
					policy: site.settings.locks.policy,
				});
				if (result.status === 'honoured') {
					honoured.set(line.lineId, result.candidate);
					honouredTokens.set(line.lineId, match.token);
				} else if (result.status === 'stale') {
					if (result.reason === 'expired' && site.settings.locks.policy.onExpired === 'reject')
						return { ok: false, reason: 'price_lock_expired', detail: `The price lock of line ${line.lineId} expired.` };
					stale.push({ lineId: line.lineId, reason: result.reason });
				} else stale.push({ lineId: line.lineId, reason: `mismatch_${result.reason}` });
			}
			// deals a lock froze may have been archived since: the engine still needs them to attribute the saving
			const known = new Set(deals.map((d) => d.id));
			const missing = [...new Set([...honoured.values()].flatMap((c) => c.dealIds))].filter((id) => !known.has(id));
			if (missing.length > 0)
				deals = [...deals, ...(await site.repos.deals.byIds(missing)).map((doc) => toDeal(site, /** @type {any} */ (doc)))];
		}
		const { usage, customerUsage } = await usageFor(site, deals, customer);
		const result = evaluateCart({
			cart: {
				currency: body.currency,
				lines,
				customer,
				paymentMethod: body.paymentMethod ?? null,
				deliveryMethod: body.deliveryMethod ?? null,
				shippingAmount: Number.isSafeInteger(body.shippingAmount) ? body.shippingAmount : null,
			},
			deals,
			usage,
			customerUsage,
			locks: honoured,
			settings: site.settings.engine,
			now: at,
		});
		const id = newId('qte');
		const expiresAt = new Date(at + site.settings.quote.quote_ttl_minutes * MINUTE_MS);
		// locks for the shown price: lines with item-level savings (cart deals depend on the whole cart)
		/** @type {Array<{ lineId: string, token: string, expiresAt: string }>} */
		const issued = [];
		if (site.settings.locks.enabled && site.settings.locks.issueOnQuote) {
			const classOf = new Map(deals.map((d) => [d.id, d.class]));
			const kindOf = new Map(deals.map((d) => [d.id, d.kind]));
			for (const line of result.lines) {
				const existing = honouredTokens.get(line.lineId);
				if (existing) {
					const claims = locks.verify(existing);
					issued.push({
						lineId: line.lineId,
						token: existing,
						expiresAt: new Date((claims?.exp ?? 0) * 1000).toISOString(),
					});
					continue;
				}
				const itemDeals = line.deals.filter((e) => ['item', 'flash'].includes(kindOf.get(e.dealId) ?? ''));
				if (line.itemDiscount <= 0 || itemDeals.length === 0) continue;
				const claims = lockClaims({
					websiteId: site.websiteId,
					currency: body.currency,
					itemId: line.itemId,
					variantId: line.variantId,
					unitAmount: line.unitAmount,
					unitPrice: Math.round((line.subtotal - line.itemDiscount) / line.quantity),
					units: line.quantity,
					dealIds: itemDeals.map((e) => e.dealId),
					classes: itemDeals.map((e) => classOf.get(e.dealId) ?? ''),
					customerId: site.settings.locks.bindToCustomer ? customer.id : null,
					ttlMinutes: site.settings.locks.ttlMinutes,
					now: at,
				});
				issued.push({ lineId: line.lineId, token: locks.sign(claims), expiresAt: new Date(claims.exp * 1000).toISOString() });
			}
		}
		const { ineligible, ...priced } = result;
		const view = {
			id,
			status: 'open',
			expiresAt: expiresAt.toISOString(),
			evaluatedAt: new Date(at).toISOString(),
			timeZone: site.settings.timeZone,
			...(body.cartId ? { cartId: body.cartId } : {}),
			customerId: customer.id,
			...priced,
			locks: issued,
			stale,
		};
		if (preview) return { ok: true, quote: { ...view, id: null, status: 'preview', ineligible } };
		const unitCost = new Map(lines.map((l) => [l.lineId, l.unitCost]));
		await site.repos.quotes.insert({
			...view,
			lines: priced.lines.map((l) => ({ ...l, unitCost: unitCost.get(l.lineId) ?? null })),
			customerId: customer.id,
			counted: [],
			expiresAt,
			purgeAt: new Date(expiresAt.getTime() + QUOTE_PURGE_AFTER_MS),
		});
		await recordUsage({
			websiteId: site.websiteId,
			...(site.subscriptionId ? { subscriptionId: site.subscriptionId } : {}),
			unit: 'quote',
			quantity: 1,
			idempotencyKey: `quote:${id}`,
		});
		return { ok: true, quote: view };
	};

	/** @param {Record<string, any>} doc stored quote */
	const quoteView = (doc) => {
		const rest = omit(doc, ['counted', 'purgeAt', 'orderId']);
		return { ...rest, expiresAt: doc.expiresAt instanceof Date ? doc.expiresAt.toISOString() : doc.expiresAt };
	};

	/** @param {Record<string, any>} app */
	const applicationView = (app) => ({
		quoteId: app.quoteId,
		orderId: app.orderId,
		status: app.status,
		customerId: app.customerId ?? null,
		currency: app.currency,
		subtotal: app.subtotal,
		discountTotal: app.discountTotal,
		total: app.total,
		freeShipping: app.freeShipping === true,
		deals: app.deals,
		committedAt: app.committedAt instanceof Date ? app.committedAt.toISOString() : app.committedAt,
		...(app.releasedAt ? { releasedAt: app.releasedAt instanceof Date ? app.releasedAt.toISOString() : app.releasedAt } : {}),
	});

	/**
	 * Undo counted deals (failed commit or release).
	 * @param {Site} site
	 * @param {Array<{ dealId: string, units: number }>} counted
	 * @param {string | null} customerId
	 * @param {Set<string>} perCustomer deals whose customer usage was counted
	 */
	const uncount = async (site, counted, customerId, perCustomer) => {
		for (const entry of counted) {
			await site.repos.counters.decrement(entry);
			if (customerId && perCustomer.has(entry.dealId))
				await site.repos.customerUsage.decrement({ dealId: entry.dealId, customerId });
		}
	};

	/**
	 * Commit a quote to an order: count uses, stock and per-customer usage (all or nothing), record the application,
	 * publish `deals.applied@1` (and `deals.exhausted@1` for deals that just ran out).
	 * @param {Site} site
	 * @param {string} quoteId
	 * @param {{ orderId: string, customerId?: string, expectedTotal?: number }} input
	 * @returns {Promise<Outcome>}
	 */
	const commit = async (site, quoteId, { orderId, customerId: givenCustomer, expectedTotal }) => {
		const existing = await site.repos.applications.byQuote(quoteId);
		if (existing) {
			if (existing.orderId === orderId && existing.status === 'committed')
				return { ok: true, application: applicationView(existing), replayed: true };
			return { ok: false, reason: 'quote_committed' };
		}
		const doc = await site.repos.quotes.get(quoteId);
		if (!doc) return { ok: false, reason: 'not_found' };
		if (doc.status === 'released') return { ok: false, reason: 'quote_committed' };
		const resuming = doc.status === 'committing' && doc.orderId === orderId;
		if (!resuming && new Date(doc.expiresAt).getTime() <= now()) return { ok: false, reason: 'quote_expired' };
		if (expectedTotal !== undefined && expectedTotal !== doc.total) return { ok: false, reason: 'total_mismatch' };
		if (!resuming && !(await site.repos.quotes.claim(quoteId, orderId))) return { ok: false, reason: 'quote_committed' };
		const customerId = doc.customerId ?? givenCustomer ?? null;
		const applied = /** @type {Array<{ dealId: string, kind: string, amount: number, units: number }>} */ (doc.deals ?? []);
		const stored = new Map(
			(await site.repos.deals.byIds(applied.map((a) => a.dealId))).map((d) => [
				/** @type {any} */ (d).id,
				toDeal(site, /** @type {any} */ (d)),
			]),
		);
		const already = new Set(/** @type {string[]} */ (doc.counted ?? []));
		/** @type {Array<{ dealId: string, units: number }>} */
		const counted = [];
		/** @type {Set<string>} */
		const perCustomer = new Set();
		/** @type {Array<{ deal: Deal, uses: number, units: number }>} */
		const reached = [];
		for (const entry of applied) {
			if (already.has(entry.dealId)) continue;
			const deal = stored.get(entry.dealId);
			const limits = deal?.limits ?? { totalUses: null, stockUnits: null, perCustomer: null };
			const increment = await site.repos.counters.increment({
				dealId: entry.dealId,
				units: entry.units,
				totalUses: limits.totalUses,
				stockUnits: limits.stockUnits,
			});
			if (!increment.ok) {
				await uncount(site, counted, customerId, perCustomer);
				await site.repos.quotes.setStatus(quoteId, 'open');
				return { ok: false, reason: 'deal_exhausted', dealId: entry.dealId };
			}
			counted.push({ dealId: entry.dealId, units: entry.units });
			if (limits.perCustomer !== null && customerId) {
				const allowed = await site.repos.customerUsage.increment({
					dealId: entry.dealId,
					customerId,
					limit: limits.perCustomer,
				});
				if (!allowed) {
					await uncount(site, counted, customerId, perCustomer);
					await site.repos.quotes.setStatus(quoteId, 'open');
					return { ok: false, reason: 'deal_exhausted', dealId: entry.dealId };
				}
				perCustomer.add(entry.dealId);
			}
			if (
				deal &&
				((limits.totalUses !== null && (increment.uses ?? 0) >= limits.totalUses) ||
					(limits.stockUnits !== null && (increment.units ?? 0) >= limits.stockUnits))
			)
				reached.push({ deal, uses: increment.uses ?? 0, units: increment.units ?? 0 });
		}
		const lines = /** @type {Array<Record<string, any>>} */ (doc.lines ?? []);
		const costKnown = lines.length > 0 && lines.every((l) => Number.isSafeInteger(l.unitCost));
		const application = {
			quoteId,
			orderId,
			customerId,
			currency: doc.currency,
			subtotal: doc.subtotal,
			discountTotal: doc.discountTotal,
			total: doc.total,
			freeShipping: doc.shipping?.free === true,
			deals: applied,
			lines: lines.map((l) => ({
				itemId: l.itemId,
				variantId: l.variantId,
				quantity: l.quantity,
				subtotal: l.subtotal,
				discount: l.discount,
				unitCost: l.unitCost ?? null,
			})),
			cost: costKnown ? lines.reduce((sum, l) => sum + l.unitCost * l.quantity, 0) : null,
			costKnown,
			status: 'committed',
			committedAt: new Date(now()),
		};
		if (!(await site.repos.applications.insert(application))) {
			await uncount(site, counted, customerId, perCustomer);
			await site.repos.quotes.setStatus(quoteId, 'open');
			return { ok: false, reason: 'conflict', detail: 'This order was already committed with another quote.' };
		}
		await site.repos.quotes.setStatus(quoteId, 'committed');
		await publish({
			websiteId: site.websiteId,
			type: 'deals.applied@1',
			idempotencyKey: `applied:${quoteId}`,
			data: {
				quoteId,
				orderId,
				...(customerId ? { customerId } : {}),
				currency: doc.currency,
				subtotal: doc.subtotal,
				discountTotal: doc.discountTotal,
				freeShipping: application.freeShipping,
				deals: applied.map((a) => ({ dealId: a.dealId, kind: a.kind, amount: a.amount, units: a.units })),
			},
		}).catch(() => undefined);
		for (const { deal, uses, units } of reached) {
			const reason = deal.limits.stockUnits !== null && units >= deal.limits.stockUnits ? 'stock_units' : 'total_uses';
			await publish({
				websiteId: site.websiteId,
				type: 'deals.exhausted@1',
				idempotencyKey: `exhausted:${deal.id}:${reason}`,
				data: { dealId: deal.id, kind: deal.kind, name: deal.name, reason, uses, units, orderId },
			}).catch(() => undefined);
		}
		return { ok: true, application: applicationView(application) };
	};

	/**
	 * Give a committed quote's uses and stock back (cancelled order).
	 * @param {Site} site
	 * @param {Record<string, any>} application
	 * @returns {Promise<Outcome>}
	 */
	const releaseApplication = async (site, application) => {
		if (!(await site.repos.applications.release(application.quoteId))) return { ok: false, reason: 'quote_not_committed' };
		const deals = /** @type {Array<{ dealId: string, units: number }>} */ (application.deals ?? []);
		const stored = new Map(
			(await site.repos.deals.byIds(deals.map((d) => d.dealId))).map((d) => [
				/** @type {any} */ (d).id,
				/** @type {any} */ (d),
			]),
		);
		const perCustomer = new Set(
			deals.filter((d) => Number.isSafeInteger(stored.get(d.dealId)?.limits?.perCustomer)).map((d) => d.dealId),
		);
		await uncount(
			site,
			deals.map((d) => ({ dealId: d.dealId, units: d.units })),
			application.customerId ?? null,
			perCustomer,
		);
		await site.repos.quotes.setStatus(application.quoteId, 'released');
		const updated = await site.repos.applications.byQuote(application.quoteId);
		return { ok: true, application: applicationView(updated ?? application) };
	};

	// ── item offers, locks, deals page ───────────────────────────────────────────────────────────────────
	/**
	 * Offers for items (badges, product pages); optionally with price locks.
	 * @param {Site} site
	 * @param {{ items: Array<Record<string, any>>, currency?: string, lock?: boolean }} body
	 * @param {{ customer: Customer, meter?: string | null, forceLock?: boolean }} options
	 */
	const offers = async (site, body, { customer, meter = null, forceLock = false }) => {
		const at = now();
		const deals = await liveDeals(site);
		const catalog = await site.repos.items.getMany(body.items.map((i) => i.itemId));
		const byId = new Map(catalog.map((item) => [/** @type {any} */ (item).itemId, /** @type {any} */ (item)]));
		const { usage, customerUsage } = await usageFor(site, deals, customer);
		/** @type {any[]} */
		const views = [];
		/** @type {Array<{ itemId: string, variantId: string | null, reason: string }>} */
		const missing = [];
		const lockThem = site.settings.locks.enabled && (forceLock || body.lock === true || site.settings.locks.issueOnOffers);
		for (const [index, ref] of body.items.entries()) {
			const item = byId.get(ref.itemId) ?? null;
			const variantId = typeof ref.variantId === 'string' ? ref.variantId : null;
			const currency = body.currency ?? item?.currency ?? null;
			if (!Number.isSafeInteger(ref.unitAmount) && catalogPrice(item, variantId) === null) {
				missing.push({ itemId: ref.itemId, variantId, reason: item ? 'unpriced' : 'unknown_item' });
				continue;
			}
			if (!currency) {
				missing.push({ itemId: ref.itemId, variantId, reason: 'currency_unknown' });
				continue;
			}
			if (!Number.isSafeInteger(ref.unitAmount) && item?.currency && body.currency && item.currency !== body.currency) {
				missing.push({ itemId: ref.itemId, variantId, reason: 'currency_mismatch' });
				continue;
			}
			const line = normaliseLine(/** @type {any} */ ({ quantity: 1, ...ref }), index, item);
			const offer = evaluateItem({
				line,
				currency,
				deals,
				usage,
				customerUsage,
				customer,
				settings: site.settings.engine,
				display: site.settings.display,
				now: at,
			});
			const { dealEntries, classes, ...view } = offer;
			/** @type {Record<string, any>} */
			const out = { ...view };
			if (lockThem && offer.discount > 0) {
				const claims = lockClaims({
					websiteId: site.websiteId,
					currency,
					itemId: line.itemId,
					variantId: line.variantId,
					unitAmount: line.unitAmount,
					unitPrice: offer.price,
					units: Math.max(line.quantity, site.settings.locks.maxUnits),
					dealIds: dealEntries.map((e) => e.dealId),
					classes,
					customerId: site.settings.locks.bindToCustomer ? customer.id : null,
					ttlMinutes: site.settings.locks.ttlMinutes,
					now: at,
				});
				out.lock = { token: locks.sign(claims), expiresAt: new Date(claims.exp * 1000).toISOString() };
			}
			views.push(out);
		}
		if (meter && body.items.length > 0)
			await recordUsage({
				websiteId: site.websiteId,
				...(site.subscriptionId ? { subscriptionId: site.subscriptionId } : {}),
				unit: 'quote',
				quantity: 1,
				idempotencyKey: `offers:${meter}`,
			});
		return { currency: views[0]?.currency ?? body.currency ?? null, items: views, missing };
	};

	/**
	 * Deals shown on the deals page (live, and upcoming when configured), sorted.
	 * @param {Site} site
	 */
	const pageDeals = async (site) => {
		const at = now();
		const config = site.settings.dealsPage;
		const kinds = new Set(/** @type {string[]} */ (config.include_kinds));
		const deals = (await liveDeals(site)).filter((d) => kinds.has(d.kind));
		const anonymous = { id: null, segments: [], orders: null, tags: [] };
		const { usage } = await usageFor(site, deals, anonymous);
		const ctx = { now: at, settings: site.settings.engine, usage, customerUsage: {}, customer: anonymous };
		const shown = deals.filter((d) => {
			const reason = staticIneligibility(d, { ...ctx, settings: { ...ctx.settings, anonymousLimited: 'allow' } });
			if (reason === null) return true;
			return (
				config.show_upcoming &&
				(reason === 'scheduled' || reason === 'outside_window') &&
				scheduleState(d.schedule, at, site.settings.timeZone).nextStart !== null
			);
		});
		const cards = shown.map((d) => ({
			...dealCard(d, { now: at, timeZone: site.settings.timeZone, usage }),
			createdAt: d.createdAt,
		}));
		return { deals: new Map(shown.map((d) => [d.id, d])), cards: sortCards(cards, config.sort), usage };
	};

	/**
	 * Catalog items of a deal, priced with today's deals.
	 * @param {Site} site
	 * @param {Deal} deal
	 * @param {{ after?: string | null, limit: number }} page
	 */
	const itemsOfDeal = async (site, deal, { after = null, limit }) => {
		/** @type {any[]} */
		const scopes =
			deal.kind === 'bundle'
				? deal.bundle?.type === 'mix_and_match'
					? [deal.bundle.scope]
					: (deal.bundle?.components ?? []).map((/** @type {any} */ c) => c.scope)
				: [deal.scope];
		const filter =
			scopes.length === 1
				? scopeCatalogFilter(scopes[0])
				: {
						$or: scopes
							.map((s) => scopeCatalogFilter(s))
							.map((f) => (Object.keys(f).length === 0 ? { itemId: { $exists: true } } : f)),
					};
		const docs = /** @type {any[]} */ (
			await site.repos.items.list({ after, fetchLimit: limit + 1, filter, inStock: site.settings.dealsPage.hide_out_of_stock })
		);
		const more = docs.length > limit;
		const page = docs.slice(0, limit);
		const priced = await offers(
			site,
			{ items: page.filter((d) => Number.isSafeInteger(d.price)).map((d) => ({ itemId: d.itemId })) },
			{ customer: { id: null, segments: [], orders: null, tags: [] } },
		);
		const offerOf = new Map(priced.items.map((o) => [o.itemId, o]));
		const items = page
			.map((d) => {
				const offer = offerOf.get(d.itemId);
				if (!offer) return null;
				const line = normaliseLine({ itemId: d.itemId, quantity: 1 }, 0, d);
				if (!scopes.some((s) => lineInScope(line, s, { now: now(), timeZone: site.settings.timeZone }))) return null;
				return {
					itemId: d.itemId,
					variantId: null,
					title: d.title,
					url: d.url,
					image: d.image,
					currency: offer.currency,
					unitAmount: offer.unitAmount,
					price: offer.price,
				};
			})
			.filter((x) => x !== null);
		return { items, more, last: page.at(-1)?.itemId ?? null };
	};

	/**
	 * The deals page: a page of deal cards with item previews.
	 * @param {Site} site
	 * @param {{ offset: number, limit: number }} page
	 */
	const dealsPage = async (site, { offset, limit }) => {
		const { deals, cards } = await pageDeals(site);
		const slice = cards.slice(offset, offset + limit);
		const perDeal = site.settings.dealsPage.items_per_deal;
		const items = await Promise.all(
			slice.map(async (card) => {
				const deal = /** @type {Deal} */ (deals.get(card.id));
				const preview =
					perDeal > 0 && deal.kind !== 'cart'
						? await itemsOfDeal(site, deal, { limit: perDeal })
						: { items: [], more: false };
				const rest = omit(card, ['createdAt']);
				return { ...rest, currency: preview.items[0]?.currency ?? null, items: preview.items, moreItems: preview.more };
			}),
		);
		return { items, total: cards.length };
	};

	/**
	 * More items of one deal on the deals page.
	 * @param {Site} site
	 * @param {string} dealId
	 * @param {{ after: string | null, limit: number }} page
	 */
	const dealItems = async (site, dealId, page) => {
		const { deals } = await pageDeals(site);
		const deal = deals.get(dealId);
		if (!deal) return null;
		return itemsOfDeal(site, deal, page);
	};

	// ── catalog sync and events ───────────────────────────────────────────────────────────────────────────
	/**
	 * @param {Site} site
	 * @param {Record<string, any>} item validated item
	 */
	const upsertItem = async (site, item) => {
		await site.repos.items.upsert(catalogItem(item));
		return site.repos.items.get(item.itemId);
	};

	/**
	 * Partial item data from an `item.*` event (only the fields it carries).
	 * @param {Site} site
	 * @param {Record<string, any>} data validated (itemId required)
	 */
	const mergeItem = async (site, data) => {
		const full = catalogItem(data);
		const fields = Object.fromEntries(Object.entries(full).filter(([key]) => key !== 'itemId' && data[key] !== undefined));
		await site.repos.items.merge(data.itemId, fields);
	};

	// ── reporting ─────────────────────────────────────────────────────────────────────────────────────────
	/**
	 * @param {Site} site
	 * @param {{ from: Date, to: Date, dealId?: string | null }} window
	 */
	const report = async (site, { from, to, dealId = null }) => {
		const { totals, byDeal } = await site.repos.applications.summary({ from, to, dealId });
		const names = new Map(
			(await site.repos.deals.byIds(byDeal.map((/** @type {any} */ d) => d._id))).map((d) => [
				/** @type {any} */ (d).id,
				/** @type {any} */ (d).name,
			]),
		);
		const orders = totals?.orders ?? 0;
		const withDeals = totals?.withDeals ?? 0;
		const without = orders - withDeals;
		const aovWith = withDeals > 0 ? Math.round((totals.subtotalWithDeals - 0) / withDeals) : null;
		const aovWithout = without > 0 ? Math.round((totals.subtotal - totals.subtotalWithDeals) / without) : null;
		const revenue = (totals?.subtotal ?? 0) - (totals?.discount ?? 0);
		const marginKnown = site.settings.reporting.include_margin && orders > 0 && totals.costKnown === orders;
		return {
			from: from.toISOString(),
			to: to.toISOString(),
			orders,
			ordersWithDeals: withDeals,
			subtotal: totals?.subtotal ?? 0,
			discountTotal: totals?.discount ?? 0,
			revenue,
			averageOrder: { withDeals: aovWith, withoutDeals: aovWithout },
			upliftPercent:
				aovWith !== null && aovWithout !== null && aovWithout > 0
					? Math.round(((aovWith - aovWithout) * 1000) / aovWithout) / 10
					: null,
			margin: marginKnown
				? {
						cost: totals.cost,
						gross: (totals.subtotal ?? 0) - totals.cost,
						afterDiscounts: revenue - totals.cost,
						discountShare:
							totals.subtotal - totals.cost > 0
								? Math.round((totals.discount * 1000) / (totals.subtotal - totals.cost)) / 10
								: null,
					}
				: null,
			deals: byDeal.map((/** @type {any} */ d) => ({
				dealId: d._id,
				name: names.get(d._id) ?? null,
				kind: d.kind,
				uses: d.uses,
				units: d.units,
				discount: d.discount,
				revenue: d.revenue,
			})),
		};
	};

	return Object.freeze({
		liveDeals,
		forget,
		toDeal,
		getDeal,
		dealView,
		usageFor,
		customerOf,
		/**
		 * @param {Site} site
		 * @param {{ after: string | null, fetchLimit: number, status?: string | null, kind?: string | null }} query
		 */
		listDeals: async (site, query) => {
			const docs = await site.repos.deals.list(query);
			const deals = docs.map((doc) => toDeal(site, /** @type {any} */ (doc)));
			const usage = await site.repos.counters.forDeals(deals.map((d) => d.id));
			return deals.map((deal) => dealView(deal, usage[deal.id], site));
		},
		/**
		 * @param {Site} site
		 * @param {Record<string, any>} input validated deal
		 * @param {Actor} actor
		 * @returns {Promise<Outcome>}
		 */
		createDeal: async (site, input, actor) => {
			const kind = /** @type {'item' | 'cart' | 'flash' | 'bundle'} */ (input.kind);
			if (!site.settings.dealRules.kinds[kind].enabled) return { ok: false, reason: 'kind_disabled' };
			if ((await site.repos.deals.countOpen(kind)) >= site.settings.maxActive[kind])
				return { ok: false, reason: 'deal_limit_reached' };
			const deal = normaliseDeal(input, { id: newId('dl'), rules: site.settings.dealRules, defaults: site.settings.defaults });
			await site.repos.deals.insert(omit(deal, ['createdAt', 'updatedAt']));
			forget(site);
			await auditDeal(site, actor, 'deal.created', deal.id, undefined, { kind: deal.kind, name: deal.name });
			return { ok: true, deal: await getDeal(site, deal.id) };
		},
		/**
		 * Merge-patch a deal (validated by the caller through `validate`).
		 * @param {Site} site
		 * @param {string} id
		 * @param {unknown} patch
		 * @param {Actor} actor
		 * @param {(input: Record<string, any>) => Array<{ path: string, code: string }>} validate
		 * @returns {Promise<Outcome>}
		 */
		updateDeal: async (site, id, patch, actor, validate) => {
			const doc = await site.repos.deals.get(id);
			if (!doc || doc.status === 'archived') return { ok: false, reason: 'not_found' };
			const current = toDeal(site, /** @type {any} */ (doc));
			const patched = mergePatch(dealInput(current), patch);
			if (patched.kind !== current.kind)
				return { ok: false, reason: 'validation_failed', problems: [{ path: '/kind', code: 'immutable' }] };
			const problems = validate(patched);
			if (problems.length > 0) return { ok: false, reason: 'validation_failed', problems };
			if (!site.settings.dealRules.kinds[current.kind].enabled) return { ok: false, reason: 'kind_disabled' };
			const next = normaliseDeal(patched, {
				id,
				rules: site.settings.dealRules,
				defaults: site.settings.defaults,
				version: current.version,
			});
			if (!(await site.repos.deals.replace(next))) return { ok: false, reason: 'conflict' };
			forget(site);
			await auditDeal(site, actor, 'deal.updated', id, dealInput(current), dealInput(next));
			return { ok: true, deal: await getDeal(site, id) };
		},
		/**
		 * Set a deal's status (pause, resume, archive = soft delete).
		 * @param {Site} site
		 * @param {string} id
		 * @param {'active' | 'paused' | 'archived'} status
		 * @param {Actor} actor
		 * @returns {Promise<Outcome>}
		 */
		setStatus: async (site, id, status, actor) => {
			const doc = await site.repos.deals.get(id);
			if (!doc || doc.status === 'archived') return { ok: false, reason: 'not_found' };
			const current = toDeal(site, /** @type {any} */ (doc));
			if (current.status === status) return { ok: true, deal: await getDeal(site, id) };
			if (!(await site.repos.deals.replace({ ...current, status }))) return { ok: false, reason: 'conflict' };
			forget(site);
			await auditDeal(site, actor, `deal.${status}`, id, { status: current.status }, { status });
			return { ok: true, deal: await getDeal(site, id) };
		},
		quote,
		/** @param {Site} site @param {string} id */
		getQuote: async (site, id) => {
			const doc = await site.repos.quotes.get(id);
			return doc ? quoteView(doc) : null;
		},
		commit,
		/**
		 * @param {Site} site
		 * @param {string} quoteId
		 * @returns {Promise<Outcome>}
		 */
		release: async (site, quoteId) => {
			const application = await site.repos.applications.byQuote(quoteId);
			if (!application)
				return { ok: false, reason: (await site.repos.quotes.get(quoteId)) ? 'quote_not_committed' : 'not_found' };
			return releaseApplication(site, application);
		},
		/**
		 * `order.cancelled@1`: release the order's deals (when configured).
		 * @param {Site} site
		 * @param {{ data: { orderId?: string } }} event
		 */
		orderCancelled: async (site, event) => {
			if (!site.settings.quote.release_on_cancel || typeof event.data?.orderId !== 'string') return;
			const application = await site.repos.applications.byOrder(event.data.orderId);
			if (application?.status === 'committed') await releaseApplication(site, application);
		},
		offers,
		dealsPage,
		dealItems,
		upsertItem,
		mergeItem,
		/** @param {Site} site @param {string} itemId */
		getItem: (site, itemId) => site.repos.items.get(itemId),
		/** @param {Site} site @param {string} itemId */
		removeItem: (site, itemId) => site.repos.items.remove(itemId),
		/**
		 * `price.changed@1`.
		 * @param {Site} site
		 * @param {{ data: { itemId: string, variantId?: string, price: { amount: number, currency: string } } }} event
		 */
		priceChanged: async (site, event) => {
			const { itemId, variantId, price } = event.data;
			await site.repos.items.setPrice({
				itemId,
				variantId: variantId ?? null,
				amount: price.amount,
				currency: price.currency,
			});
		},
		/**
		 * `inventory.changed@1`.
		 * @param {Site} site
		 * @param {{ data: { itemId: string, variantId?: string, locationId?: string, quantity: number } }} event
		 */
		inventoryChanged: async (site, event) => {
			const { itemId, variantId, locationId, quantity } = event.data;
			await site.repos.items.setStock({ itemId, variantId: variantId ?? null, locationId: locationId ?? null, quantity });
		},
		report,
		/**
		 * Dashboard KPIs.
		 * @param {Site} site
		 */
		overview: async (site) => {
			const deals = await liveDeals(site);
			const at = now();
			const states = deals.map((d) => ({ deal: d, state: scheduleState(d.schedule, at, site.settings.timeZone) }));
			const days = site.settings.reporting.window_days;
			const summary = await report(site, { from: new Date(at - days * DAY_MS), to: new Date(at + 1) });
			return {
				live: states.filter((s) => s.deal.status === 'active' && s.state.active).length,
				scheduled: states.filter((s) => s.deal.status === 'active' && !s.state.active && s.state.nextStart !== null).length,
				paused: deals.filter((d) => d.status === 'paused').length,
				openQuotes: await site.repos.quotes.countOpen(),
				windowDays: days,
				report: summary,
			};
		},
	});
};

/** @typedef {ReturnType<typeof createDealsService>} DealsService */
