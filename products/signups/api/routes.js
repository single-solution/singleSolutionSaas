/**
 * Route table: app-kit's standard resources (entitlement, config, events, strings, health, data export/anonymise, the
 * .well-known endpoints, /sso and — in development — the certification probes), the Signups Mode C API, the issuer's
 * public endpoints (JWKS, discovery) and the dashboard API (SSO sessions). Every product route is gated by its element:
 * a disabled element answers 403 element_disabled in every mode. Handlers are thin — validation and rules live in
 * core/, orchestration in service.js.
 *
 * Idempotency: POSTs that send a message or create a record require `Idempotency-Key` (app-kit stores and replays the
 * response). The token-issuing POSTs (code verification, link consumption, refresh) are **single-use by construction**
 * (atomic attempt reservation and compare-and-set) and deliberately not replayable: storing their responses in a replay
 * cache would keep live credentials outside the merchant's database.
 */
import { created, defineRoute, noContent, ok, paginate, problem, standardRoutes } from '@ss/app-kit';
import { parseIdentifier } from '../core/identifier.js';
import { discoveryDocument, websiteIdOfJwksFile } from '../core/tokens.js';
import { normaliseEmail } from '../core/email.js';
import { normalisePhone } from '../core/phone.js';
import {
	validateConsentAccept,
	validateCustomerAdminPatch,
	validateCustomerCreate,
	validateDataRequest,
	validateMagicConsume,
	validateMagicRequest,
	validateOtpRequest,
	validateOtpVerify,
	validateRefresh,
} from '../core/validate.js';
import { repositoriesFor } from '../adapters/db.js';
import { createMessenger } from '../adapters/messaging.js';
import { DASHBOARD_ROLES, resolveDashboard } from './dashboard.js';
import { createEventHandlers } from './events.js';
import { createSignupsService } from './service.js';
import { sessionView } from './session.js';
import { settingsForDoc } from './settings.js';

/** @typedef {import('../adapters/platform.js').SignupsApp} SignupsApp */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./service.js').Outcome} Outcome */

/** Header carrying the customer's access token (the same header every product reads, PLAN F.14). */
export const IDENTITY_HEADER = 'ss-identity';
/** Server keys may forward the end customer's IP for the per-IP limits. */
export const CLIENT_IP_HEADER = 'ss-client-ip';
const IP = /^[0-9A-Fa-f:.]{2,45}$/;
const NEGATIVE_CACHE_MS = 60_000;

/**
 * Field problems → RFC 9457 `validation_failed`.
 * @param {Array<{ path: string, code: string }>} problems
 */
const invalid = (problems) =>
	problem('validation_failed', 'The request is not valid.', {
		errors: problems.map((p) => ({ path: p.path, code: p.code, message: p.code.replace(/_/g, ' ') })),
	});

/**
 * A service outcome → an app-kit result.
 * @param {Outcome} outcome
 */
export const respond = (outcome) => {
	if (!outcome.ok)
		return problem(outcome.code, outcome.detail, {
			...(outcome.errors ? { errors: outcome.errors } : {}),
			headers: outcome.retryAfter ? { 'retry-after': String(outcome.retryAfter) } : {},
		});
	if (outcome.status === 204) return noContent();
	if (outcome.status === 201) return created(outcome.value);
	return ok(outcome.value, { status: outcome.status });
};

/**
 * The application (service + site resolution) shared by the routes, the event consumers, the dashboard and the job.
 * @param {SignupsApp} app
 */
export const createSignups = (app) => {
	const { product } = app;
	const repoFor = repositoriesFor(product, { now: app.now });
	const service = createSignupsService({
		app,
		messenger: createMessenger({ connectors: product.connectors, log: app.log }),
		publish: (event) => product.portal.publishEvent(event),
		recordUsage: (usage) => product.usage.record(usage),
		audit: (entry) => product.audit.record(entry),
		log: app.log,
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
			merchantId: doc.merchantId,
			env: doc.env,
			domain: doc.domain,
			allowSubdomains: doc.allowSubdomains === true,
			settings: settingsForDoc(product, doc),
			repos: await repoFor(websiteId, { merchantId: doc.merchantId, env: doc.env }),
			doc,
		};
	};
	/**
	 * Site of a website from its entitlement (null without an active subscription or with `element` off).
	 * @param {string} websiteId
	 * @param {string} [element]
	 * @returns {Promise<Site | null>}
	 */
	const siteFor = async (websiteId, element = 'profile') => {
		const result = await product.entitlements.forWebsite(websiteId);
		if (!result.ok || !product.entitlements.can(result.doc, element)) return null;
		return siteOf(websiteId, result.doc);
	};
	/**
	 * Site for a Portal privacy request (any subscription state: data rights outlive a switched-off element).
	 * @param {string} websiteId
	 */
	const privacySite = async (websiteId) => {
		const result = await product.entitlements.forWebsite(websiteId);
		if (!result.ok) throw problem('not_found', 'This website has no subscription to this product.');
		return siteOf(websiteId, result.doc);
	};
	// the Portal-signed privacy routes were wired at product creation; their handlers are bound here
	const { privacy } = app;
	privacy.export = async (input) => service.privacyExport(await privacySite(input.websiteId), input);
	privacy.anonymize = async (input) => service.privacyAnonymize(await privacySite(input.websiteId), input);
	return { app, product, service, siteOf, siteFor };
};

/** @typedef {ReturnType<typeof createSignups>} Signups */

/**
 * @param {Signups} signups
 */
export const buildRoutes = (signups) => {
	const { app, product, service, siteOf, siteFor } = signups;
	/** @param {any} ctx */
	const site = (ctx) => siteOf(ctx.websiteId, ctx.entitlement.doc);
	/** @param {any} ctx @returns {import('./service.js').RequestInfo} */
	const requestInfo = (ctx) => {
		const raw =
			ctx.website?.kind === 'sk'
				? ctx.headers.get(CLIENT_IP_HEADER)
				: ctx.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
		return { ip: typeof raw === 'string' && IP.test(raw) ? raw : null, userAgent: ctx.headers.get('user-agent') };
	};
	/**
	 * The signed-in customer: `SS-Identity` (the access token this product issued) for any key; server keys may name a
	 * customer instead (`?customerId=` or `customerId` in the body).
	 * @param {any} ctx
	 * @param {Site} s
	 * @returns {Promise<{ ok: true, customer: import('./service.js').Customer, session: import('./service.js').Session | null } | { ok: false, result: any }>}
	 */
	const customerOf = async (ctx, s) => {
		const token = ctx.headers.get(IDENTITY_HEADER);
		if (!token && ctx.website.kind === 'sk') {
			const id = ctx.query.customerId ?? ctx.body?.customerId;
			if (typeof id !== 'string' || !id) return { ok: false, result: invalid([{ path: '/customerId', code: 'required' }]) };
			const customer = await s.repos.customers.get(id);
			return customer && customer.status !== 'deleted'
				? { ok: true, customer, session: null }
				: { ok: false, result: problem('not_found', 'No such customer.') };
		}
		const auth = await service.authenticate(s, token);
		if (!auth.ok)
			return {
				ok: false,
				result:
					auth.code === 'identity_required'
						? problem('identity_required', `Send the customer's access token in the ${IDENTITY_HEADER} header.`)
						: problem('identity_invalid', 'The customer access token is invalid, expired or revoked.'),
			};
		return { ok: true, customer: auth.customer, session: auth.session };
	};
	/** @param {string} element @param {'sk' | null} [keyKind] */
	const website = (element, keyKind = null) => ({
		auth: /** @type {const} */ ('website'),
		element,
		...(keyKind ? { keyKind } : {}),
	});
	/** @param {any} ctx */
	const actor = (ctx) => ({ type: 'api', id: ctx.website.keyId });

	/** @type {Map<string, number>} websites without an issuer here (unauthenticated JWKS lookups) */
	const unknown = new Map();
	/**
	 * Site of a public issuer request, or null (no subscription / sessions off). Misses are cached briefly so
	 * unauthenticated lookups of random ids do not reach the Portal on every request.
	 * @param {string | null} websiteId
	 */
	const issuerSite = async (websiteId) => {
		if (!websiteId) return null;
		const miss = unknown.get(websiteId);
		if (miss && app.now() - miss < NEGATIVE_CACHE_MS) return null;
		const s = await siteFor(websiteId, 'sessions');
		if (!s) {
			if (unknown.size > 10_000) unknown.clear();
			unknown.set(websiteId, app.now());
		}
		return s;
	};
	const publicRate = { limit: 300, windowMs: 60_000 };

	return [
		...standardRoutes(product),
		defineRoute({ method: 'GET', path: '/v1/session', auth: 'launch', handler: (ctx) => ok(sessionView(ctx.session)) }),

		// ── issuer (public) ────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/.well-known/jwks/:file',
			auth: 'none',
			cors: true,
			rateLimit: publicRate,
			handler: async (ctx) => {
				const s = await issuerSite(websiteIdOfJwksFile(ctx.params.file));
				if (!s) return problem('not_found', 'No issuer for this website.');
				return ok(await service.jwks(s), { headers: { 'cache-control': 'public, max-age=300' } });
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/i/:websiteId/.well-known/openid-configuration',
			auth: 'none',
			cors: true,
			rateLimit: publicRate,
			handler: async (ctx) => {
				const s = await issuerSite(/^web_[0-9a-z]{1,64}$/.test(ctx.params.websiteId) ? ctx.params.websiteId : null);
				if (!s) return problem('not_found', 'No issuer for this website.');
				return ok(discoveryDocument({ base: app.base, websiteId: s.websiteId }), {
					headers: { 'cache-control': 'public, max-age=300' },
				});
			},
		}),

		// ── profile: customers (server) and the signed-in profile ─────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/customers',
			...website('profile', 'sk'),
			handler: async (ctx) => {
				const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url });
				const s = await site(ctx);
				const email = ctx.query.email === undefined ? undefined : normaliseEmail(ctx.query.email);
				const phone = ctx.query.phone === undefined ? undefined : normalisePhone(ctx.query.phone, service.phoneOptions(s));
				if (email === null || phone === null) return page.respond([]);
				const items = await s.repos.customers.list({
					after: typeof page.after === 'string' ? page.after : null,
					fetchLimit: page.fetchLimit,
					...(email ? { email } : {}),
					...(phone ? { phone } : {}),
				});
				return page.respond(
					items.map((/** @type {any} */ c) => service.viewOf(s, c)),
					(/** @type {{ id: string }} */ c) => c.id,
				);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/customers',
			...website('profile', 'sk'),
			handler: async (ctx) => {
				const problems = validateCustomerCreate(ctx.body);
				if (problems.length > 0) return invalid(problems);
				return respond(await service.createCustomer(await site(ctx), ctx.body, { actor: actor(ctx) }));
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/customers/:id',
			...website('profile', 'sk'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const customer = await s.repos.customers.get(ctx.params.id);
				return customer ? ok(service.viewOf(s, /** @type {any} */ (customer))) : problem('not_found', 'No such customer.');
			},
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/customers/:id',
			...website('profile', 'sk'),
			handler: async (ctx) => {
				const problems = validateCustomerAdminPatch(ctx.body);
				if (problems.length > 0) return invalid(problems);
				const s = await site(ctx);
				const customer = await s.repos.customers.get(ctx.params.id);
				if (!customer || customer.status === 'deleted') return problem('not_found', 'No such customer.');
				return respond(
					await service.patchCustomer(s, /** @type {any} */ (customer), ctx.body, { admin: true, actor: actor(ctx) }),
				);
			},
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/customers/:id',
			...website('profile', 'sk'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const customer = await s.repos.customers.get(ctx.params.id);
				if (!customer || customer.status === 'deleted') return problem('not_found', 'No such customer.');
				return respond(await service.deleteCustomer(s, /** @type {any} */ (customer), { actor: actor(ctx) }));
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/profile',
			...website('profile'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const who = await customerOf(ctx, s);
				return who.ok ? ok(service.viewOf(s, who.customer)) : who.result;
			},
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/profile',
			...website('profile'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const who = await customerOf(ctx, s);
				if (!who.ok) return who.result;
				return respond(await service.patchCustomer(s, who.customer, ctx.body ?? {}));
			},
		}),

		// ── otp ─────────────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'POST',
			path: '/v1/otp',
			...website('otp'),
			handler: async (ctx) => {
				const problems = validateOtpRequest(ctx.body);
				if (problems.length > 0) return invalid(problems);
				const s = await site(ctx);
				const parsed = parseIdentifier(ctx.body, { channels: s.settings.otp.channels, ...service.phoneOptions(s) });
				if (!parsed.ok) return problem(parsed.code);
				const purpose = ctx.body.purpose ?? 'sign_in';
				/** @type {import('./service.js').Customer | null} */
				let customer = null;
				if (purpose === 'link') {
					const who = await customerOf(ctx, s);
					if (!who.ok) return who.result;
					customer = who.customer;
				}
				return respond(
					await service.requestChallenge(
						s,
						{ kind: 'otp', identifier: parsed.identifier, purpose, lang: ctx.body.locale, deviceId: ctx.body.deviceId },
						{ ...requestInfo(ctx), customer },
					),
				);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/otp/:id/verify',
			...website('otp'),
			idempotent: false,
			handler: async (ctx) => {
				const problems = validateOtpVerify(ctx.body);
				if (problems.length > 0) return invalid(problems);
				return respond(await service.verifyCode(await site(ctx), ctx.params.id, ctx.body, requestInfo(ctx)));
			},
		}),

		// ── magic_link ──────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'POST',
			path: '/v1/magic-links',
			...website('magic_link'),
			handler: async (ctx) => {
				const problems = validateMagicRequest(ctx.body);
				if (problems.length > 0) return invalid(problems);
				const s = await site(ctx);
				const parsed = parseIdentifier({ channel: 'email', to: ctx.body.email }, { channels: ['email'] });
				if (!parsed.ok) return problem(parsed.code);
				const purpose = ctx.body.purpose ?? 'sign_in';
				/** @type {import('./service.js').Customer | null} */
				let customer = null;
				if (purpose === 'link') {
					const who = await customerOf(ctx, s);
					if (!who.ok) return who.result;
					customer = who.customer;
				}
				return respond(
					await service.requestChallenge(
						s,
						{
							kind: 'magic_link',
							identifier: parsed.identifier,
							purpose,
							lang: ctx.body.locale,
							deviceId: ctx.body.deviceId,
							redirect: ctx.body.redirect,
						},
						{ ...requestInfo(ctx), customer },
					),
				);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/magic-links:consume',
			...website('magic_link'),
			idempotent: false,
			handler: async (ctx) => {
				const problems = validateMagicConsume(ctx.body);
				if (problems.length > 0) return invalid(problems);
				return respond(await service.consumeLink(await site(ctx), ctx.body, requestInfo(ctx)));
			},
		}),

		// ── sessions ────────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'POST',
			path: '/v1/sessions:refresh',
			...website('sessions'),
			idempotent: false,
			handler: async (ctx) => {
				const problems = validateRefresh(ctx.body);
				if (problems.length > 0) return invalid(problems);
				return respond(await service.refresh(await site(ctx), ctx.body));
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/sessions:logout',
			...website('sessions'),
			idempotent: false,
			handler: async (ctx) => {
				const problems = validateRefresh(ctx.body);
				if (problems.length > 0) return invalid(problems);
				return respond(await service.logout(await site(ctx), ctx.body));
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/sessions',
			...website('sessions'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const who = await customerOf(ctx, s);
				if (!who.ok) return who.result;
				return ok({ items: await service.sessions(s, who.customer.id, who.session?.id ?? null) });
			},
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/sessions/:id',
			...website('sessions'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const who = await customerOf(ctx, s);
				if (!who.ok) return who.result;
				return respond(await service.revokeSession(s, who.customer.id, ctx.params.id));
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/sessions:revoke-all',
			...website('sessions'),
			idempotent: 'optional',
			handler: async (ctx) => {
				const s = await site(ctx);
				const who = await customerOf(ctx, s);
				if (!who.ok) return who.result;
				return respond(await service.revokeAll(s, who.customer.id));
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/issuer',
			...website('sessions', 'sk'),
			handler: async (ctx) => ok(await service.issuer(await site(ctx))),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/issuer:rotate',
			...website('sessions', 'sk'),
			idempotent: 'optional',
			handler: async (ctx) => ok(await service.rotateKeys(await site(ctx), { actor: actor(ctx) })),
		}),

		// ── account pages ───────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/account',
			...website('account_pages'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const who = await customerOf(ctx, s);
				if (!who.ok) return who.result;
				if (!who.session)
					return problem('identity_required', `Send the customer's access token in the ${IDENTITY_HEADER} header.`);
				return ok(await service.account(s, who.customer, who.session));
			},
		}),

		// ── risk ────────────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/risk-events',
			...website('risk', 'sk'),
			handler: async (ctx) => {
				const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url });
				const s = await site(ctx);
				const items = await s.repos.riskEvents.list({
					after: typeof page.after === 'string' ? page.after : null,
					fetchLimit: page.fetchLimit,
				});
				return page.respond(items, (/** @type {{ occurredAt: string, id: string }} */ e) => `${e.occurredAt}|${e.id}`);
			},
		}),

		// ── consent ─────────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/consents',
			...website('consent'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const who = await customerOf(ctx, s);
				return who.ok ? ok(await service.consents(s, who.customer)) : who.result;
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/consents',
			...website('consent'),
			idempotent: 'optional',
			handler: async (ctx) => {
				const problems = validateConsentAccept(ctx.body);
				if (problems.length > 0) return invalid(problems);
				const s = await site(ctx);
				const who = await customerOf(ctx, s);
				return who.ok ? respond(await service.acceptConsents(s, who.customer, ctx.body.consents)) : who.result;
			},
		}),

		// ── data rights ─────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/data-requests',
			...website('data_rights'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const who = await customerOf(ctx, s);
				if (!who.ok) return who.result;
				return ok({ items: (await s.repos.dataRequests.list(who.customer.id, 50)).map(service.requestView) });
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/data-requests',
			...website('data_rights'),
			handler: async (ctx) => {
				const problems = validateDataRequest(ctx.body);
				if (problems.length > 0) return invalid(problems);
				const s = await site(ctx);
				const who = await customerOf(ctx, s);
				return who.ok ? respond(await service.createDataRequest(s, who.customer, ctx.body.type)) : who.result;
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/data-requests/:id/export',
			...website('data_rights'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const who = await customerOf(ctx, s);
				return who.ok ? respond(await service.downloadExport(s, who.customer, ctx.params.id)) : who.result;
			},
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/data-requests/:id',
			...website('data_rights'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const who = await customerOf(ctx, s);
				return who.ok ? respond(await service.cancelDataRequest(s, who.customer.id, ctx.params.id)) : who.result;
			},
		}),

		// ── dashboard (SSO session) ─────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/dashboard/overview',
			auth: 'launch',
			roles: [...DASHBOARD_ROLES],
			handler: async (ctx) => {
				const context = await resolveDashboard({
					signups: signups,
					sessionId: ctx.session.id,
					website: ctx.websiteId,
				});
				if (context.state !== 'ready') return problem('bad_request', 'Open the dashboard for a website.');
				return ok({ demo: context.data.demo, overview: await context.data.overview(), issuer: await context.data.issuer() });
			},
		}),
	];
};

/**
 * Register the event consumers (app-kit dedupes deliveries on the event id).
 * @param {Signups} signups
 */
export const wireEvents = (signups) => {
	for (const [type, handler] of Object.entries(createEventHandlers({ service: signups.service, siteFor: signups.siteFor })))
		signups.product.events.on(type, handler);
	return signups;
};
