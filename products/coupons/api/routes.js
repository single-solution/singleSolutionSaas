/**
 * Route table: app-kit's standard resources (entitlement, config, events, strings, health, data export/anonymise,
 * the .well-known endpoints, /sso and — in development — the certification probes) plus the Coupons Mode C API, the
 * element-stub view of the apply box and the dashboard API (SSO sessions). The scheduled job's route lives in jobs/ and
 * is added by the composition root. Every product route is gated by its element: a disabled element answers
 * 403 element_disabled in every mode. POSTs that move state require an Idempotency-Key (app-kit stores and replays the
 * response); handlers are thin — validation and rules live in core/.
 */
import { createHash } from 'node:crypto';
import { created, defineRoute, ok, paginate, problem, standardRoutes } from '@ss/app-kit';
import { normaliseCart } from '../core/cart.js';
import { normaliseCode } from '../core/codes.js';
import { matchedLines } from '../core/conditions.js';
import { formatMoney } from '../core/money.js';
import { checkCondition, conditionMatches, ruleContext } from '../core/rules.js';
import {
	validateBlock,
	validateCodePatch,
	validateCoupon,
	validateEligibilityCheck,
	validateGenerate,
	validateQuote,
	validateRedeem,
	validateRelease,
	validateReservation,
	validateShareLink,
	validateValidation,
	idCheck,
} from '../core/validate.js';
import { codeView, couponView, reservationView } from '../core/views.js';
import { repositoriesFor } from '../adapters/repositories.js';
import { createEventHandlers } from './consumers.js';
import { DASHBOARD_WRITE_ROLES } from './dashboard.js';
import { createCouponsService } from './service.js';
import { sessionView } from './session.js';
import { settingsForDoc } from './settings.js';

/** @typedef {import('../adapters/platform.js').CouponsApp} CouponsApp */
/** @typedef {import('./service.js').Site} Site */

/** Messages of field problems (the code, readable). @param {string} code */
const message = (code) => code.replace(/_/g, ' ');

/**
 * Field problems → RFC 9457 `validation_failed`.
 * @param {Array<{ path: string, code: string }>} problems
 */
const invalid = (problems) =>
	problem('validation_failed', 'The request is not valid.', {
		errors: problems.map((p) => ({ path: p.path, code: p.code, message: message(p.code) })),
	});

/**
 * Map a service failure to a problem.
 * @param {{ reason: string, path?: string, problems?: Array<{ path: string, code: string }>, rejected?: Array<{ code: string, reason: string }> }} failure
 */
const failure = ({ reason, path, problems, rejected }) => {
	if (problems) return invalid(problems);
	if (reason === 'validation_failed' || reason.startsWith('pattern_') || reason === 'window_too_long')
		return invalid([{ path: path ?? '', code: reason === 'validation_failed' ? 'invalid' : reason }]);
	if (reason === 'conflict') return problem('conflict', 'The resource changed concurrently; retry the request.');
	if (reason === 'not_found') return problem('not_found', 'Not found.');
	if (rejected && rejected.length > 0)
		return problem(reason, message(reason), {
			errors: rejected.map((entry) => ({
				path: '/codes',
				code: entry.reason,
				message: `${entry.code}: ${message(entry.reason)}`,
			})),
		});
	return problem(reason, path ? `${message(reason)} (${path})` : message(reason));
};

/** @param {string | null | undefined} value */
const sha = (value) => (value ? createHash('sha256').update(value).digest('hex').slice(0, 32) : null);

/**
 * The application (service + site resolution) shared by the routes, the event consumers, the dashboard and the job.
 * @param {CouponsApp} app
 */
export const createCoupons = (app) => {
	const { product } = app;
	const repoFor = repositoriesFor(product, { now: app.now });
	const service = createCouponsService({
		publish: (event) => product.portal.publishEvent(event),
		recordUsage: (usage) => product.usage.record(usage),
		audit: (entry) => product.audit.record(entry),
		hash: app.hash,
		randomBytes: app.randomBytes,
		randomId: app.randomId,
		now: app.now,
	});
	/**
	 * @param {string} websiteId
	 * @param {any} doc
	 * @returns {Promise<Site>}
	 */
	const siteOf = async (websiteId, doc) => {
		await app.registry.remember(websiteId);
		return {
			websiteId,
			domain: String(doc.domain ?? ''),
			settings: settingsForDoc(product, doc),
			repos: await repoFor(websiteId, { merchantId: doc.merchantId, env: doc.env }),
		};
	};
	/**
	 * Site of a website from its entitlement (null without an active subscription or with `api` off — events and the
	 * job only touch reservations).
	 * @param {string} websiteId
	 * @returns {Promise<Site | null>}
	 */
	const siteFor = async (websiteId) => {
		const result = await product.entitlements.forWebsite(websiteId);
		if (!result.ok || !product.entitlements.can(result.doc, 'api')) return null;
		return siteOf(websiteId, result.doc);
	};
	return { app, product, service, siteOf, siteFor };
};

/** @typedef {ReturnType<typeof createCoupons>} Coupons */

/**
 * @param {Coupons} coupons
 */
export const buildRoutes = (coupons) => {
	const { app, product, service, siteOf } = coupons;
	/** @param {any} ctx */
	const site = (ctx) => siteOf(ctx.websiteId, ctx.entitlement.doc);
	/**
	 * Route auth for an element: server keys only, or browser keys too (the customer then comes from SS-Identity).
	 * @param {string} element
	 * @param {'sk' | null} [keyKind]
	 */
	const website = (element, keyKind = 'sk') => ({
		auth: /** @type {const} */ ('website'),
		element,
		...(keyKind ? { keyKind } : { identity: /** @type {const} */ ('optional') }),
	});
	/**
	 * Who is asking: browser keys → the verified identity (never the body), plus a hashed network address for
	 * velocity limits; server keys → the customer named in the cart.
	 * @param {any} ctx
	 * @returns {import('./service.js').Requester}
	 */
	const requesterOf = (ctx) =>
		ctx.website?.kind === 'pk'
			? {
					customerId: ctx.identity?.subject ?? null,
					identified: Boolean(ctx.identity?.subject),
					address: sha(ctx.headers.get('x-forwarded-for')?.split(',')[0]?.trim()),
				}
			: { identified: true, address: null };
	/** @param {Site} s */
	const cartRules = (s) => ({ maxLines: s.settings.api.max_lines_per_cart, maxCodes: s.settings.maxCodes });
	/** A code from a path segment, normalised like codes typed by customers. @param {Site} s @param {string} raw */
	const codeParam = (s, raw) => normaliseCode(raw, { caseSensitive: s.settings.codes.case_sensitive === true });
	/** @param {any} ctx */
	const page = (ctx) => paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url });
	/** @param {Record<string, any>} r */
	const redemptionCursor = (r) => `${r.redeemedAt}|${r.id}`;
	/** @param {any} ctx */
	const actorOf = (ctx) => ({ type: 'api', id: ctx.website?.keyId });
	/** @param {string} lang */
	const strings = (lang) => app.strings[lang] ?? app.strings.en ?? {};
	/**
	 * @param {Record<string, string>} catalog
	 * @param {string} key
	 * @param {Record<string, string>} [params]
	 */
	const t = (catalog, key, params = {}) =>
		(catalog[key] ?? key).replace(/\{([A-Za-z_]\w*)\}/g, (match, name) =>
			Object.hasOwn(params, name) ? String(params[name]) : match,
		);

	return [
		...standardRoutes(product),
		defineRoute({ method: 'GET', path: '/v1/session', auth: 'launch', handler: (ctx) => ok(sessionView(ctx.session)) }),

		// ── codes: coupons and their codes ──────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/coupons',
			...website('codes'),
			handler: async (ctx) => {
				const p = page(ctx);
				const s = await site(ctx);
				const status = typeof ctx.query.status === 'string' ? ctx.query.status : null;
				const items = await s.repos.coupons.list({
					after: typeof p.after === 'string' ? p.after : null,
					fetchLimit: p.fetchLimit,
					status,
				});
				return p.respond(
					items.map((/** @type {Record<string, any>} */ doc) => couponView(doc)),
					(/** @type {{ id: string }} */ coupon) => coupon.id,
				);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/coupons',
			...website('codes'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const problems = validateCoupon(ctx.body, s.settings.couponRules);
				if (problems.length > 0) return invalid(problems);
				const result = await service.createCoupon(s, ctx.body, actorOf(ctx));
				if (!result.ok) return failure(result);
				return created(
					{ ...couponView(result.coupon), generated: { count: result.codes.length, codes: result.codes.slice(0, 100) } },
					{ location: `/v1/coupons/${result.coupon.id}` },
				);
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/coupons/:id',
			...website('codes'),
			handler: async (ctx) => {
				const coupon = await service.coupon(await site(ctx), ctx.params.id);
				return coupon ? ok(coupon) : problem('not_found', 'No such coupon.');
			},
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/coupons/:id',
			...website('codes'),
			handler: async (ctx) => {
				const s = await site(ctx);
				if (ctx.body === null || typeof ctx.body !== 'object' || Array.isArray(ctx.body))
					return invalid([{ path: '', code: 'body_invalid' }]);
				const result = await service.updateCoupon(s, ctx.params.id, ctx.body, (merged) =>
					validateCoupon(merged, s.settings.couponRules, { mode: 'update' }),
				);
				return result.ok ? ok(couponView(result.coupon)) : failure(result);
			},
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/coupons/:id',
			...website('codes'),
			handler: async (ctx) => {
				const archived = await service.archive(await site(ctx), ctx.params.id);
				return archived ? ok(archived) : problem('not_found', 'No such coupon.');
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/coupons/:id/codes',
			...website('codes'),
			handler: async (ctx) => {
				const p = page(ctx);
				const s = await site(ctx);
				if (!(await s.repos.coupons.get(ctx.params.id))) return problem('not_found', 'No such coupon.');
				const items = await s.repos.codes.byCoupon(ctx.params.id, {
					after: typeof p.after === 'string' ? p.after : null,
					fetchLimit: p.fetchLimit,
				});
				return p.respond(
					items.map((/** @type {Record<string, any>} */ doc) => codeView(doc)),
					(/** @type {{ code: string }} */ code) => code.code,
				);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/coupons/:id/codes:generate',
			...website('codes'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const problems = validateGenerate(ctx.body, {
					maxCodesPerBatch: s.settings.codes.max_codes_per_batch,
					maxLength: s.settings.codes.max_code_length,
				});
				if (problems.length > 0) return invalid(problems);
				const result = await service.generateFor(s, ctx.params.id, ctx.body);
				if (!result.ok) return failure({ ...result, path: '/pattern' });
				return created({
					couponId: ctx.params.id,
					batchId: result.batchId,
					count: result.codes.length,
					codes: result.codes.slice(0, 100),
				});
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/codes/:code',
			...website('codes'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const doc = await s.repos.codes.get(codeParam(s, ctx.params.code));
				return doc ? ok(codeView(doc)) : problem('code_not_found', 'No such code.');
			},
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/codes/:code',
			...website('codes'),
			handler: async (ctx) => {
				const problems = validateCodePatch(ctx.body);
				if (problems.length > 0) return invalid(problems);
				const s = await site(ctx);
				const code = codeParam(s, ctx.params.code);
				if (!(await s.repos.codes.setStatus(code, ctx.body.status))) return problem('code_not_found', 'No such code.');
				return ok(codeView(/** @type {Record<string, any>} */ (await s.repos.codes.get(code))));
			},
		}),

		// ── eligibility ────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'POST',
			path: '/v1/eligibility:check',
			...website('eligibility'),
			idempotent: false,
			handler: async (ctx) => {
				const s = await site(ctx);
				const problems = validateEligibilityCheck(ctx.body, {
					maxLines: s.settings.api.max_lines_per_cart,
					maxConditions: s.settings.eligibility.max_conditions,
					maxRuleLength: s.settings.eligibility.max_rule_length,
				});
				if (problems.length > 0) return invalid(problems);
				const when = typeof ctx.body.when === 'string' ? ctx.body.when : '';
				const diagnostics = checkCondition(when);
				if (!ctx.body.cart) return ok({ rule: diagnostics, evaluation: null });
				const cart = normaliseCart(ctx.body.cart);
				const conditions = Array.isArray(ctx.body.conditions) ? ctx.body.conditions : [];
				const lines = matchedLines(conditions, cart);
				const rule = conditionMatches(when, ruleContext(cart, { id: 'cpn_check', code: 'CHECK' }), {
					now: app.now(),
					timeZone: s.settings.timeZone,
				});
				return ok({
					rule: diagnostics,
					evaluation: {
						eligible: lines.length > 0 && rule.matched,
						matchedLines: lines.map((line) => line.lineId),
						rule: rule.matched,
						ruleError: rule.error,
					},
				});
			},
		}),

		// ── limits: blocklist ──────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/blocks',
			...website('limits'),
			handler: async (ctx) => {
				const p = page(ctx);
				const items = await (
					await site(ctx)
				).repos.blocks.list({
					after: typeof p.after === 'string' ? p.after : null,
					fetchLimit: p.fetchLimit,
				});
				return p.respond(items, (/** @type {{ id: string }} */ block) => block.id);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/blocks',
			...website('limits'),
			handler: async (ctx) => {
				const problems = validateBlock(ctx.body);
				if (problems.length > 0) return invalid(problems);
				const s = await site(ctx);
				if ((await s.repos.blocks.count()) >= s.settings.limits.max_blocks)
					return problem('limit_reached', 'The blocklist is full.');
				const kind = ctx.body.kind;
				const raw = String(ctx.body.value).trim();
				const value =
					kind === 'email'
						? raw.toLowerCase()
						: kind === 'code' && !s.settings.codes.case_sensitive
							? raw.toUpperCase()
							: raw;
				const block = { id: app.randomId('blk'), kind, value, note: ctx.body.note ?? null };
				if (!(await s.repos.blocks.insert(block))) return problem('conflict', 'This entry is already blocked.');
				await product.audit.record({
					websiteId: s.websiteId,
					actor: actorOf(ctx),
					action: 'coupons.block_added',
					target: { blockId: block.id, kind },
				});
				return created(block, { location: `/v1/blocks/${block.id}` });
			},
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/blocks/:id',
			...website('limits'),
			handler: async (ctx) => {
				const removed = await (await site(ctx)).repos.blocks.remove(ctx.params.id, new Date(app.now()).toISOString());
				return removed ? ok({ id: ctx.params.id, deleted: true }) : problem('not_found', 'No such entry.');
			},
		}),

		// ── api: validations, quotes, reservations, redemptions ────────────────────────────────────────────
		defineRoute({
			method: 'POST',
			path: '/v1/validations',
			...website('api', null),
			idempotent: false,
			handler: async (ctx) => {
				const s = await site(ctx);
				const problems = validateValidation(ctx.body, cartRules(s));
				if (problems.length > 0) return invalid(problems);
				const result = await service.validate(s, ctx.body, requesterOf(ctx));
				return result.ok ? ok(result.result) : failure(result);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/quotes',
			...website('api', null),
			idempotent: false,
			handler: async (ctx) => {
				const s = await site(ctx);
				const problems = validateQuote(ctx.body, cartRules(s));
				if (problems.length > 0) return invalid(problems);
				const result = await service.quote(s, ctx.body, requesterOf(ctx));
				return result.ok ? ok(result.quote) : failure(result);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/reservations',
			...website('api'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const problems = validateReservation(ctx.body, cartRules(s));
				if (problems.length > 0) return invalid(problems);
				const result = await service.reserve(s, { ...ctx.body, key: ctx.idempotencyKey }, requesterOf(ctx));
				if (!result.ok) return failure(result);
				return created(reservationView(result.reservation), { location: `/v1/reservations/${result.reservation.id}` });
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/reservations/:id',
			...website('api'),
			handler: async (ctx) => {
				const reservation = await service.reservation(await site(ctx), ctx.params.id);
				return reservation ? ok(reservationView(reservation)) : problem('not_found', 'No such reservation.');
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/reservations/:id/redeem',
			...website('api'),
			handler: async (ctx) => {
				const problems = validateRedeem(ctx.body);
				if (problems.length > 0) return invalid(problems);
				const result = await service.redeem(await site(ctx), ctx.params.id, { orderId: ctx.body?.orderId ?? null });
				return result.ok ? ok(reservationView(result.reservation)) : failure(result);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/reservations/:id/release',
			...website('api'),
			handler: async (ctx) => {
				const problems = validateRelease(ctx.body);
				if (problems.length > 0) return invalid(problems);
				const result = await service.release(await site(ctx), ctx.params.id, 'released');
				return result.ok ? ok(reservationView(result.reservation)) : failure(result);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/reservations/:id/attach',
			...website('api'),
			handler: async (ctx) => {
				const orderId = ctx.body?.orderId;
				if (idCheck(orderId) !== null)
					return invalid([{ path: '/orderId', code: orderId === undefined ? 'required' : 'id_invalid' }]);
				const result = await service.attach(await site(ctx), ctx.params.id, orderId);
				return result.ok ? ok(reservationView(/** @type {Record<string, any>} */ (result.reservation))) : failure(result);
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/redemptions',
			...website('api'),
			handler: async (ctx) => {
				const p = page(ctx);
				const statuses =
					ctx.query.status === 'released'
						? ['released']
						: ctx.query.status === 'all'
							? ['redeemed', 'released']
							: ['redeemed'];
				const items = await (
					await site(ctx)
				).repos.reservations.redemptions({
					after: typeof p.after === 'string' ? p.after : null,
					fetchLimit: p.fetchLimit,
					statuses,
				});
				return p.respond(
					items.map((/** @type {Record<string, any>} */ doc) => reservationView(doc)),
					(/** @type {{ redeemedAt: string, id: string }} */ view) => redemptionCursor(view),
				);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/redemptions',
			...website('api'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const problems = validateReservation(ctx.body, cartRules(s));
				if (problems.length > 0) return invalid(problems);
				const result = await service.redeemNow(s, { ...ctx.body, key: ctx.idempotencyKey }, requesterOf(ctx));
				if (!result.ok) return failure(result);
				return created(reservationView(result.reservation), { location: `/v1/redemptions/${result.reservation.id}` });
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/redemptions/:id',
			...website('api'),
			handler: async (ctx) => {
				const reservation = await (await site(ctx)).repos.reservations.get(ctx.params.id);
				return reservation && reservation.redeemedAt
					? ok(reservationView(reservation))
					: problem('not_found', 'No such redemption.');
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/redemptions/:id/release',
			...website('api'),
			handler: async (ctx) => {
				const problems = validateRelease(ctx.body);
				if (problems.length > 0) return invalid(problems);
				const s = await site(ctx);
				const reservation = await s.repos.reservations.get(ctx.params.id);
				if (!reservation?.redeemedAt) return problem('not_found', 'No such redemption.');
				const result = await service.release(s, ctx.params.id, 'released');
				return result.ok ? ok(reservationView(result.reservation)) : failure(result);
			},
		}),

		// ── distribution: share links, QR codes, exports ───────────────────────────────────────────────────
		defineRoute({
			method: 'POST',
			path: '/v1/share-links',
			...website('distribution'),
			idempotent: false,
			handler: async (ctx) => {
				const problems = validateShareLink(ctx.body);
				if (problems.length > 0) return invalid(problems);
				const result = await service.shareLink(await site(ctx), ctx.body);
				return result.ok ? ok(result.link) : failure(result);
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/share-links/:code',
			...website('distribution'),
			handler: async (ctx) => {
				const result = await service.shareLink(await site(ctx), { code: ctx.params.code });
				return result.ok ? ok(result.link) : failure(result);
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/share-links/:code/qr',
			...website('distribution'),
			handler: async (ctx) => {
				const result = await service.qr(await site(ctx), ctx.params.code);
				if (!result.ok) return failure(result);
				return new Response(result.svg, {
					status: 200,
					headers: {
						'content-type': 'image/svg+xml; charset=utf-8',
						'cache-control': 'private, max-age=300',
						'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
						'x-content-type-options': 'nosniff',
					},
				});
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/exports/:couponId',
			...website('distribution'),
			handler: async (ctx) => {
				const result = await service.exportCodes(await site(ctx), ctx.params.couponId);
				if (!result.ok) return failure(result);
				return new Response(result.csv, {
					status: 200,
					headers: {
						'content-type': 'text/csv; charset=utf-8',
						'content-disposition': `attachment; filename="${result.filename}"`,
						'cache-control': 'no-store',
						'x-content-type-options': 'nosniff',
					},
				});
			},
		}),

		// ── reporting ──────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/reports',
			...website('reporting'),
			handler: async (ctx) => {
				const result = await service.report(await site(ctx), { from: ctx.query.from, to: ctx.query.to });
				return result.ok ? ok(result.report) : failure({ ...result, path: '/to' });
			},
		}),

		// ── apply_box: element stub view (ss-element-stub@1, Loader drop-in) ─────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/elements/apply_box/view',
			...website('apply_box', null),
			handler: async (ctx) => {
				const s = await site(ctx);
				const catalog = strings(typeof ctx.query.lang === 'string' ? ctx.query.lang : 'en');
				const listed = s.settings.applyBox.show_listed ? await service.listed(s) : [];
				return ok({
					title: t(catalog, 'apply_box.title'),
					body: t(catalog, 'apply_box.stub_body'),
					items: listed.slice(0, 50).map((entry) => ({
						text: t(catalog, 'apply_box.listed', { name: entry.name, code: entry.code }),
						...(entry.url ? { href: entry.url } : {}),
					})),
					actions: [],
				});
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/elements/apply_box/actions/:action',
			...website('apply_box', null),
			idempotent: 'optional',
			handler: async (ctx) => {
				if (ctx.params.action !== 'apply') return problem('not_found', 'Unknown action.');
				const s = await site(ctx);
				const problems = validateValidation(ctx.body, cartRules(s));
				if (problems.length > 0) return invalid(problems);
				const result = await service.validate(s, ctx.body, requesterOf(ctx));
				if (!result.ok) return failure(result);
				const catalog = strings(typeof ctx.query.lang === 'string' ? ctx.query.lang : 'en');
				const { valid, reason, quote } = result.result;
				const saved = formatMoney(
					quote.discount + quote.shippingDiscount,
					quote.currency,
					catalog['apply_box.locale'] ?? 'en',
				);
				return ok({
					title: t(catalog, 'apply_box.title'),
					body: valid
						? t(catalog, 'apply_box.applied', { code: result.result.code, amount: saved })
						: t(catalog, `apply_box.error.${reason}`),
					items: [],
					actions: [],
				});
			},
		}),

		// ── dashboard (SSO session) ────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/dashboard/overview',
			auth: 'launch',
			element: 'codes',
			handler: async (ctx) =>
				ctx.websiteId && ctx.entitlement
					? ok(await service.overview(await site(ctx)))
					: problem('bad_request', 'Open the dashboard for a website.'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/dashboard/coupons',
			auth: 'launch',
			element: 'codes',
			roles: [...DASHBOARD_WRITE_ROLES],
			handler: async (ctx) => {
				if (!ctx.websiteId || !ctx.entitlement) return problem('bad_request', 'Open the dashboard for a website.');
				const s = await site(ctx);
				const problems = validateCoupon(ctx.body, s.settings.couponRules);
				if (problems.length > 0) return invalid(problems);
				const view = sessionView(ctx.session);
				const actor = view.actor
					? { type: 'staff', id: view.actor }
					: { type: view.kind === 'admin' ? 'staff' : 'merchant', id: view.user ?? 'unknown' };
				const result = await service.createCoupon(s, ctx.body, actor);
				if (!result.ok) return failure(result);
				return created({
					...couponView(result.coupon),
					generated: { count: result.codes.length, codes: result.codes.slice(0, 100) },
				});
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/dashboard/coupons/:id/export',
			auth: 'launch',
			element: 'distribution',
			handler: async (ctx) => {
				if (!ctx.websiteId || !ctx.entitlement) return problem('bad_request', 'Open the dashboard for a website.');
				const result = await service.exportCodes(await site(ctx), ctx.params.id);
				if (!result.ok) return failure(result);
				return new Response(result.csv, {
					status: 200,
					headers: {
						'content-type': 'text/csv; charset=utf-8',
						'content-disposition': `attachment; filename="${result.filename}"`,
						'cache-control': 'no-store',
					},
				});
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/dashboard/eligibility:check',
			auth: 'launch',
			idempotent: false,
			handler: (ctx) => {
				const source = ctx.body?.source;
				return typeof source === 'string' ? ok(checkCondition(source)) : invalid([{ path: '/source', code: 'required' }]);
			},
		}),
	];
};

/** Interval of the per-website sweep run after requests (the daily cron catches up on quiet websites). */
export const SWEEP_EVERY_MS = 5 * 60_000;
/** Reservations expired per page of the background sweep. */
const SWEEP_BATCH = 50;
/** Pages per background run (bounded; the deadline usually stops it first). */
const SWEEP_PAGES = 10;

/**
 * Expire lapsed reservations of one website within `deadline` (the background task; readers never wait for it, an
 * expired reservation is treated as expired when touched).
 * @param {Coupons} coupons
 * @param {{ websiteId: string | null, deadline: number }} input
 * @returns {Promise<number>} reservations expired
 */
export const sweepWebsite = async ({ app, service, siteFor }, { websiteId, deadline }) => {
	const site = websiteId ? await siteFor(websiteId) : null;
	if (!site) return 0;
	let expired = 0;
	for (let page = 0; page < SWEEP_PAGES && app.now() < deadline; page += 1) {
		const count = await service.sweep(site, { limit: SWEEP_BATCH });
		expired += count;
		if (count < SWEEP_BATCH) break;
	}
	return expired;
};

/**
 * Register the event consumers (app-kit dedupes deliveries on the event id) and the throttled per-website sweep that
 * runs after requests (`product.background.every`, at most every SWEEP_EVERY_MS per website). Called once per product
 * by the composition roots (app/_lib/product.js, serve.js).
 * @param {Coupons} coupons
 */
export const wireEvents = (coupons) => {
	for (const [type, handler] of Object.entries(createEventHandlers(coupons))) coupons.product.events.on(type, handler);
	const sweepTask = coupons.product.background.every(
		'sweep',
		SWEEP_EVERY_MS,
		(/** @type {any} */ input) => sweepWebsite(coupons, input),
		{
			per: 'website',
			budgetMs: 10_000,
		},
	);
	return { ...coupons, tasks: { sweep: sweepTask } };
};
