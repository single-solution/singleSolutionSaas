/**
 * Route table: app-kit's standard resources (entitlement, config, events, strings, health, data export/anonymise,
 * the .well-known endpoints, /sso and — in development — the certification probes) plus the Loyalty Mode C API and the
 * dashboard API (SSO sessions). The daily cron route lives in jobs/ and is added by the composition root. Every product route is gated by its element: a disabled element
 * answers 403 element_disabled in every mode. POSTs that move state require an Idempotency-Key (app-kit stores and
 * replays the response); handlers are thin — validation and rules live in core/.
 */
import { created, defineRoute, ok, paginate, problem, standardRoutes } from '@ss/app-kit';
import { checkCondition, compileCondition } from '../core/rules.js';
import { newMember } from '../core/member.js';
import {
	validateActivity,
	validateAdjustment,
	validateConfirm,
	validateCustomer,
	validateEarn,
	validateQuote,
	validateRedeem,
	validateReferral,
} from '../core/validate.js';
import { redemptionView, transactionView } from '../core/views.js';
import { repositoriesFor } from '../adapters/db.js';
import { DASHBOARD_WRITE_ROLES } from './dashboard.js';
import { createEventHandlers } from './events.js';
import { createLoyaltyService } from './service.js';
import { sessionView } from './session.js';
import { settingsForDoc } from './settings.js';

/** @typedef {import('../adapters/platform.js').LoyaltyApp} LoyaltyApp */
/** @typedef {import('./service.js').Site} Site */

/** Header carrying a customer wallet token on `pk_` requests. */
export const IDENTITY_HEADER = 'ss-identity';

/**
 * Field problems → RFC 9457 `validation_failed`.
 * @param {Array<{ path: string, code: string }>} problems
 */
const invalid = (problems) =>
	problem('validation_failed', 'The request is not valid.', {
		errors: problems.map((p) => ({ path: p.path, code: p.code, message: p.code.replace(/_/g, ' ') })),
	});

/** Map a service failure reason to a problem. @param {string} reason */
const failure = (reason) => {
	if (reason === 'conflict') return problem('conflict', 'The member changed concurrently; retry the request.');
	if (reason === 'not_found') return problem('not_found', 'Not found.');
	return problem(reason, reason.replace(/_/g, ' '));
};

/** Cursor of a ledger page: `<occurredAt>|<id>`. @param {{ occurredAt: string, id: string }} tx */
const txCursor = (tx) => `${tx.occurredAt}|${tx.id}`;

/**
 * The application (service + site resolution) shared by the routes, the event consumers and the dashboard.
 * @param {LoyaltyApp} app
 */
export const createLoyalty = (app) => {
	const { product } = app;
	const repoFor = repositoriesFor(product, { now: app.now });
	const service = createLoyaltyService({
		publish: (event) => product.portal.publishEvent(event),
		recordUsage: (usage) => product.usage.record(usage),
		audit: (entry) => product.audit.record(entry),
		hash: app.hash,
		randomBytes: app.randomBytes,
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
			settings: settingsForDoc(product, doc),
			repos: await repoFor(websiteId, { merchantId: doc.merchantId, env: doc.env }),
		};
	};
	/**
	 * Site of a website from its entitlement (null without an active subscription or with the base element off).
	 * @param {string} websiteId
	 * @returns {Promise<Site | null>}
	 */
	const siteFor = async (websiteId) => {
		const result = await product.entitlements.forWebsite(websiteId);
		if (!result.ok || !product.entitlements.can(result.doc, 'earn_rules')) return null;
		return siteOf(websiteId, result.doc);
	};
	return { app, product, service, siteOf, siteFor };
};

/** @typedef {ReturnType<typeof createLoyalty>} Loyalty */

/**
 * @param {Loyalty} loyalty
 */
export const buildRoutes = (loyalty) => {
	const { app, product, service, siteOf } = loyalty;
	/** @param {any} ctx */
	const site = (ctx) => siteOf(ctx.websiteId, ctx.entitlement.doc);
	/**
	 * Customer of a request: `pk_` keys only through a valid wallet token, `sk_` keys may name one (`?customerId=`).
	 * @param {any} ctx
	 * @returns {string | null}
	 */
	const customerOf = (ctx) => {
		if (ctx.website?.kind === 'pk') return app.tokens.verify(ctx.headers.get(IDENTITY_HEADER), ctx.websiteId);
		const id = ctx.query.customerId;
		return typeof id === 'string' && id ? id : null;
	};
	const website = (/** @type {string} */ element, /** @type {'sk' | null} */ keyKind = 'sk') => ({
		auth: /** @type {const} */ ('website'),
		element,
		...(keyKind ? { keyKind } : {}),
	});
	/**
	 * A ledger page.
	 * @param {any} ctx
	 * @param {{ customerId?: string | null, kinds?: string[] }} filter
	 */
	const ledgerPage = async (ctx, { customerId = null, kinds }) => {
		const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url });
		const s = await site(ctx);
		const items = await s.repos.transactions.list({
			...(customerId ? { customerId } : {}),
			after: typeof page.after === 'string' ? page.after : null,
			fetchLimit: page.fetchLimit,
			...(kinds ? { kinds } : {}),
		});
		return page.respond(items.map(transactionView), txCursor);
	};

	/** Dashboard session → website and settings (null = pick a website / demo). @param {any} ctx */
	const dashboardSite = async (ctx) => (ctx.websiteId && ctx.entitlement ? site(ctx) : null);

	return [
		...standardRoutes(product),
		defineRoute({ method: 'GET', path: '/v1/session', auth: 'launch', handler: (ctx) => ok(sessionView(ctx.session)) }),

		// ── earn_rules: earnings, members, rules, activities ─────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/earnings',
			...website('earn_rules', null),
			handler: async (ctx) => {
				// browser keys see only the identified customer's earnings (wallet token); without one the page is empty
				const customerId = customerOf(ctx);
				if (ctx.website.kind === 'pk' && !customerId) {
					const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url });
					return page.respond([]);
				}
				return ledgerPage(ctx, { customerId, kinds: ['earn', 'referral'] });
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/earnings',
			...website('earn_rules'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const problems = validateEarn(ctx.body, { maxPoints: s.settings.earn.max_points_per_transaction });
				if (problems.length > 0) return invalid(problems);
				const result = await service.earn(s, {
					...ctx.body,
					key: ctx.idempotencyKey,
					actor: { type: 'api', id: ctx.website.keyId },
				});
				if (!result.ok) return failure(result.reason);
				return created(transactionView(result.tx), {
					location: `/v1/members/${encodeURIComponent(result.tx.customerId)}/history`,
				});
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/members',
			...website('earn_rules'),
			handler: async (ctx) => {
				const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url });
				const s = await site(ctx);
				const members = await s.repos.members.list({
					after: typeof page.after === 'string' ? page.after : null,
					fetchLimit: page.fetchLimit,
					prefix: typeof ctx.query.q === 'string' ? ctx.query.q : '',
				});
				return page.respond(
					members.map((/** @type {import("../core/member.js").Member} */ member) => service.view(s, member)),
					(/** @type {{ customerId: string }} */ member) => member.customerId,
				);
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/members/:customerId',
			...website('earn_rules'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const member = await service.member(s, ctx.params.customerId);
				return member ? ok(service.view(s, member)) : problem('not_found', 'No such member.');
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/members/:customerId/balance',
			...website('earn_rules'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const member = (await service.member(s, ctx.params.customerId)) ?? newMember(ctx.params.customerId, app.now());
				const view = service.view(s, member);
				return ok({
					customerId: view.customerId,
					balance: view.balance,
					tier: view.tier?.key ?? null,
					expiring: view.expiring,
				});
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/members/:customerId/history',
			...website('earn_rules'),
			handler: (ctx) => ledgerPage(ctx, { customerId: ctx.params.customerId }),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/rules',
			...website('earn_rules'),
			handler: async (ctx) => {
				const s = await site(ctx);
				return ok({
					timeZone: s.settings.timeZone,
					rounding: s.settings.earn.rounding,
					items: s.settings.rules.map((rule) => {
						const compiled = compileCondition(rule.when);
						return { ...rule, valid: compiled.ok, error: compiled.ok ? null : compiled.error };
					}),
				});
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/rules:check',
			...website('earn_rules'),
			idempotent: false,
			handler: (ctx) => {
				const source = ctx.body?.source;
				if (typeof source !== 'string') return invalid([{ path: '/source', code: 'required' }]);
				return ok(checkCondition(source));
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/activities',
			...website('earn_rules'),
			handler: async (ctx) => {
				const problems = validateActivity(ctx.body);
				if (problems.length > 0) return invalid(problems);
				const s = await site(ctx);
				const result = await service.activity(s, { ...ctx.body, id: ctx.body.id ?? ctx.idempotencyKey });
				if (!result.ok && result.reason !== 'skipped') return failure(result.reason);
				return ok({ earned: result.ok ? result.tx.points : 0, transaction: result.ok ? transactionView(result.tx) : null });
			},
		}),

		// ── redeem ───────────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'POST',
			path: '/v1/redemptions:quote',
			...website('redeem'),
			idempotent: false,
			handler: async (ctx) => {
				const problems = validateQuote(ctx.body);
				if (problems.length > 0) return invalid(problems);
				return ok(await service.quote(await site(ctx), ctx.body));
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/redemptions',
			...website('redeem'),
			handler: async (ctx) => {
				const problems = validateRedeem(ctx.body);
				if (problems.length > 0) return invalid(problems);
				const result = await service.redeem(await site(ctx), { ...ctx.body, key: ctx.idempotencyKey });
				if (!result.ok) return failure(result.reason);
				return created(redemptionView(result.redemption), { location: `/v1/redemptions/${result.redemption.id}` });
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/redemptions/:id',
			...website('redeem'),
			handler: async (ctx) => {
				const redemption = await service.redemption(await site(ctx), ctx.params.id);
				return redemption ? ok(redemptionView(redemption)) : problem('not_found', 'No such redemption.');
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/redemptions/:id/release',
			...website('redeem'),
			handler: async (ctx) => {
				const result = await service.release(await site(ctx), ctx.params.id);
				return result.ok ? ok(redemptionView(result.redemption)) : failure(result.reason);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/redemptions/:id/confirm',
			...website('redeem'),
			handler: async (ctx) => {
				const problems = validateConfirm(ctx.body);
				if (problems.length > 0) return invalid(problems);
				const result = await service.confirm(await site(ctx), ctx.params.id, ctx.body.orderId);
				return result.ok ? ok(redemptionView(result.redemption)) : failure(result.reason);
			},
		}),

		// ── wallet ───────────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'POST',
			path: '/v1/wallet-tokens',
			...website('wallet'),
			handler: async (ctx) => {
				const problems = validateCustomer(ctx.body);
				if (problems.length > 0) return invalid(problems);
				const s = await site(ctx);
				const issued = app.tokens.issue({
					websiteId: ctx.websiteId,
					customerId: ctx.body.customerId,
					ttlMinutes: s.settings.wallet.token_ttl_minutes,
				});
				return created({ customerId: ctx.body.customerId, ...issued });
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/wallet',
			...website('wallet', null),
			handler: async (ctx) => {
				const customerId = customerOf(ctx);
				if (!customerId)
					return ctx.website.kind === 'pk'
						? problem('identity_required', `Send a wallet token in the ${IDENTITY_HEADER} header.`)
						: invalid([{ path: '/customerId', code: 'required' }]);
				const s = await site(ctx);
				const page = paginate(
					{
						cursor: ctx.query.cursor,
						limit: ctx.query.limit ?? String(s.settings.wallet.history_page_size),
						url: ctx.request.url,
					},
					{ defaultLimit: s.settings.wallet.history_page_size, maxLimit: 50 },
				);
				const member = (await service.member(s, customerId)) ?? newMember(customerId, app.now());
				const items = s.settings.wallet.show_history
					? await s.repos.transactions.list({
							customerId,
							after: typeof page.after === 'string' ? page.after : null,
							fetchLimit: page.fetchLimit,
						})
					: [];
				return ok({
					...service.view(s, member),
					display: { showHistory: s.settings.wallet.show_history, showTier: s.settings.wallet.show_tier },
					history: page.page(
						items.filter((/** @type {{ points: number }} */ tx) => tx.points !== 0).map(transactionView),
						txCursor,
					),
				});
			},
		}),

		// ── tiers ────────────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/tiers',
			...website('tiers', null),
			handler: async (ctx) => {
				const tiers = (await site(ctx)).settings.tiers;
				return ok({
					basis: tiers?.basis,
					windowMonths: tiers?.window_months,
					downgrade: tiers?.downgrade,
					items: [...(tiers?.tiers ?? [])].sort((a, b) => a.threshold - b.threshold),
				});
			},
		}),

		// ── expiry ───────────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'POST',
			path: '/v1/expiry:run',
			...website('expiry'),
			idempotent: 'optional',
			handler: async (ctx) => ok(await service.runExpiry(await site(ctx))),
		}),

		// ── referrals ────────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'POST',
			path: '/v1/referral-codes',
			...website('referrals'),
			handler: async (ctx) => {
				const problems = validateCustomer(ctx.body);
				if (problems.length > 0) return invalid(problems);
				const result = await service.referralCode(await site(ctx), ctx.body.customerId);
				return result.ok ? created({ customerId: ctx.body.customerId, code: result.code }) : failure(result.reason);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/referrals',
			...website('referrals'),
			handler: async (ctx) => {
				const problems = validateReferral(ctx.body);
				if (problems.length > 0) return invalid(problems);
				const result = await service.attribute(await site(ctx), { code: ctx.body.code, customerId: ctx.body.customerId });
				return result.ok ? created(result.referral) : failure(result.reason);
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/referrals/:customerId',
			...website('referrals'),
			handler: async (ctx) => {
				const referral = await (await site(ctx)).repos.referrals.byReferee(ctx.params.customerId);
				return referral ? ok(referral) : problem('not_found', 'This customer was not referred.');
			},
		}),

		// ── adjustments ──────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/adjustments',
			...website('adjustments'),
			handler: (ctx) => ledgerPage(ctx, { customerId: customerOf(ctx), kinds: ['adjust'] }),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/adjustments',
			...website('adjustments'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const problems = validateAdjustment(ctx.body, {
					maxPoints: s.settings.adjustments.max_points,
					reasons: s.settings.adjustments.reasons,
					requireNote: s.settings.adjustments.require_note,
				});
				if (problems.length > 0) return invalid(problems);
				const result = await service.adjust(s, {
					...ctx.body,
					key: ctx.idempotencyKey,
					actor: { type: 'api', id: ctx.website.keyId },
				});
				return result.ok ? created(transactionView(result.tx)) : failure(result.reason);
			},
		}),

		// ── dashboard (SSO session) ──────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/dashboard/overview',
			auth: 'launch',
			element: 'earn_rules',
			handler: async (ctx) => {
				const s = await dashboardSite(ctx);
				return s ? ok(await service.overview(s)) : problem('bad_request', 'Open the dashboard for a website.');
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/dashboard/adjustments',
			auth: 'launch',
			element: 'adjustments',
			roles: [...DASHBOARD_WRITE_ROLES],
			handler: async (ctx) => {
				const s = await dashboardSite(ctx);
				if (!s) return problem('bad_request', 'Open the dashboard for a website.');
				const problems = validateAdjustment(ctx.body, {
					maxPoints: s.settings.adjustments.max_points,
					reasons: s.settings.adjustments.reasons,
					requireNote: s.settings.adjustments.require_note,
				});
				if (problems.length > 0) return invalid(problems);
				const view = sessionView(ctx.session);
				const actor = view.actor
					? { type: 'staff', id: view.actor }
					: { type: view.kind === 'admin' ? 'staff' : 'merchant', id: view.user ?? 'unknown' };
				const result = await service.adjust(s, { ...ctx.body, key: ctx.idempotencyKey, actor });
				return result.ok ? created(transactionView(result.tx)) : failure(result.reason);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/dashboard/rules:check',
			auth: 'launch',
			idempotent: false,
			handler: (ctx) => {
				const source = ctx.body?.source;
				return typeof source === 'string' ? ok(checkCondition(source)) : invalid([{ path: '/source', code: 'required' }]);
			},
		}),
	];
};

/**
 * Register the event consumers (app-kit dedupes deliveries on the event id).
 * @param {Loyalty} loyalty
 */
export const wireEvents = (loyalty) => {
	for (const [type, handler] of Object.entries(createEventHandlers(loyalty))) loyalty.product.events.on(type, handler);
	return loyalty;
};
