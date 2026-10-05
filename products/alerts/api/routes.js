/**
 * Route table: app-kit's standard resources (entitlement, config, events, strings, health, data export/anonymise,
 * the .well-known endpoints, /sso and — in development — the certification probes) plus the Alerts Mode C API, the
 * hosted link pages and the dashboard API (SSO sessions). Every product route is gated by its element: a disabled
 * element answers 403 element_disabled in every mode. POSTs that move state require an Idempotency-Key (app-kit stores
 * and replays the response); handlers are thin — validation and rules live in core/. The cron route lives in jobs/.
 */
import { created, defineRoute, ok, paginate, problem, standardRoutes } from '@ss/app-kit';
import { addressFor, contactIdOf } from '../core/contact.js';
import { sanitizeItem } from '../core/subscription.js';
import { CSV_COLUMNS, csvRowToInput, fromInventory, fromPrice, parseCsv } from '../core/triggers.js';
import { enabledTypes, isId, targetKeyOf } from '../core/types.js';
import { isObject, validateTrigger } from '../core/validate.js';
import { messageView, subscriptionView, triggerView } from '../core/views.js';
import { analyticsOf } from './analytics.js';
import { createEventHandlers } from './events.js';
import { createPages } from './pages.js';
import { createAlerts } from './service.js';
import { sessionView } from './session.js';

/** @typedef {import('./service.js').Alerts} Alerts */
/** @typedef {import('./service.js').Site} Site */

export { createAlerts };

/**
 * Field problems → RFC 9457 `validation_failed`.
 * @param {Array<{ path: string, code: string }>} problems
 */
const invalid = (problems) =>
	problem('validation_failed', 'The request is not valid.', {
		errors: problems.map((p) => ({ path: p.path, code: p.code, message: p.code.replace(/[_:]/g, ' ') })),
	});

/**
 * A capture outcome → result.
 * @param {import('./capture.js').Outcome} outcome
 */
const respond = (outcome) => {
	if (outcome.ok)
		return outcome.status === 201
			? created(outcome.body, { location: `/v1/subscriptions/${outcome.body.id}` })
			: ok(outcome.body, { status: outcome.status });
	if (outcome.code === 'validation_failed') return invalid(outcome.errors ?? []);
	return problem(outcome.code, outcome.detail ?? outcome.code.replace(/_/g, ' '), {
		...(outcome.errors
			? { errors: outcome.errors.map((e) => ({ path: e.path, code: e.code, message: e.code.replace(/_/g, ' ') })) }
			: {}),
	});
};

/**
 * The visitor's IP (first X-Forwarded-For hop, as set by the hosting edge).
 * @param {Headers} headers
 */
const ipOf = (headers) => headers.get('x-forwarded-for')?.split(',')[0]?.trim() || headers.get('x-real-ip') || null;

/**
 * A trigger request body → change.
 * @param {Record<string, any>} body validated
 * @param {number} at
 * @param {Site} site
 * @returns {import('../core/triggers.js').Change | null}
 */
export const changeOf = (body, at, site) => {
	const occurred = typeof body.occurredAt === 'string' ? Date.parse(body.occurredAt) : at;
	const item = sanitizeItem(body.item, {
		domain: site.domain,
		allowSubdomains: site.allowSubdomains,
		policy: site.settings.capture.itemUrlPolicy,
	});
	/** @type {import('../core/triggers.js').Change | null} */
	let change = null;
	if (body.kind === 'inventory') change = fromInventory(body, occurred);
	else if (body.kind === 'price') change = fromPrice(body, occurred);
	else
		change = {
			kind: 'custom',
			target: isId(body.itemId) ? { itemId: body.itemId } : { itemId: '*' },
			eventType: body.type,
			data: isObject(body.data) ? body.data : isId(body.itemId) ? { itemId: body.itemId } : {},
			at: occurred,
		};
	return change && item ? { ...change, item } : change;
};

/**
 * @param {Alerts} alerts
 */
export const buildRoutes = (alerts) => {
	const { product, capture, engine, dispatcher, siteOf, deps } = alerts;
	const pages = createPages({ alerts });
	/** @param {any} ctx */
	const site = (ctx) => siteOf(ctx.websiteId, ctx.entitlement.doc);
	/**
	 * @param {string} element
	 * @param {'sk' | null} [keyKind] null = browser keys too (customer identity optional)
	 */
	const website = (element, keyKind = 'sk') => ({
		auth: /** @type {const} */ ('website'),
		element,
		...(keyKind ? { keyKind } : { identity: /** @type {const} */ ('optional') }),
	});
	/** Customer of a browser request (the website's own login, verified by app-kit). @param {any} ctx */
	const customerOf = (ctx) => (ctx.website?.kind === 'pk' ? (ctx.identity?.subject ?? null) : null);
	/** @param {{ subscribedAt: string, id: string }} sub */
	const subCursor = (sub) => `${sub.subscribedAt}|${sub.id}`;

	/**
	 * Run one validated trigger body.
	 * @param {any} ctx
	 * @param {Site} s
	 * @param {Record<string, any>} body
	 * @param {string} key
	 * @param {'api' | 'import'} source
	 */
	const runTrigger = async (ctx, s, body, key, source) => {
		const change = changeOf(body, deps.now(), s);
		if (!change) return null;
		return engine.process(s, change, { source, key, trusted: true, dispatch: source === 'api' });
	};

	return [
		...standardRoutes(product),
		defineRoute({ method: 'GET', path: '/v1/session', auth: 'launch', handler: (ctx) => ok(sessionView(ctx.session)) }),

		// ── triggers ────────────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/triggers',
			...website('triggers'),
			handler: async (ctx) => {
				const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url });
				const runs = await (await site(ctx)).repos.triggers.list({ after: page.after, fetchLimit: page.fetchLimit });
				return page.respond(runs.map(triggerView), (/** @type {any} */ run) => `${run.at}|${run.id}`);
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/triggers/:id',
			...website('triggers'),
			handler: async (ctx) => {
				const run = await (await site(ctx)).repos.triggers.get(ctx.params.id);
				return run ? ok(triggerView(run)) : problem('not_found', 'No such trigger run.');
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/triggers',
			...website('triggers'),
			handler: async (ctx) => {
				const problems = validateTrigger(ctx.body);
				if (problems.length > 0) return invalid(problems);
				const s = await site(ctx);
				const run = await runTrigger(ctx, s, ctx.body, `api:${ctx.body.id ?? ctx.idempotencyKey}`, 'api');
				if (!run) return invalid([{ path: '', code: 'invalid' }]);
				return created(triggerView(run), { location: `/v1/triggers/${run.id}` });
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/triggers:batch',
			...website('triggers'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const changes = ctx.body?.changes;
				if (!Array.isArray(changes) || changes.length === 0) return invalid([{ path: '/changes', code: 'required' }]);
				if (changes.length > s.settings.triggers.maxBatch) return invalid([{ path: '/changes', code: 'too_many' }]);
				const results = [];
				let queued = 0;
				for (const [index, body] of changes.entries()) {
					const problems = validateTrigger(body);
					if (problems.length > 0) {
						results.push({ index, ok: false, errors: problems });
						continue;
					}
					const run = await runTrigger(ctx, s, body, `api:${body.id ?? `${ctx.idempotencyKey}:${index}`}`, 'import');
					queued += Number(run?.queued ?? 0);
					results.push(
						run
							? { index, ok: true, run: triggerView(run) }
							: { index, ok: false, errors: [{ path: '', code: 'invalid' }] },
					);
				}
				const sent =
					queued > 0 && s.settings.dispatch.inline ? await dispatcher.run(s, { limit: Math.min(200, queued + 10) }) : null;
				return ok({ results, queued, dispatched: sent });
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/triggers:import',
			...website('triggers'),
			maxBodyBytes: 4 * 1024 * 1024,
			handler: async (ctx) => {
				const s = await site(ctx);
				if (typeof ctx.body?.csv !== 'string') return invalid([{ path: '/csv', code: 'required' }]);
				const parsed = parseCsv(ctx.body.csv, { maxRows: s.settings.triggers.maxCsvRows });
				if (!parsed.ok)
					return problem('csv_invalid', parsed.code.replace(/_/g, ' '), {
						errors: [{ path: '/csv', code: parsed.code, message: parsed.code }],
					});
				if (!parsed.header.includes('item_id'))
					return problem('csv_invalid', `the header needs item_id (columns: ${CSV_COLUMNS.join(', ')})`);
				const errors = [];
				let processed = 0;
				let queued = 0;
				for (const [index, row] of parsed.rows.entries()) {
					const body = csvRowToInput(parsed.header, row);
					const problems = validateTrigger(body);
					if (problems.length > 0) {
						errors.push({ row: index + 2, errors: problems });
						continue;
					}
					const run = await runTrigger(ctx, s, body, `csv:${ctx.idempotencyKey}:${index}`, 'import');
					processed += 1;
					queued += Number(run?.queued ?? 0);
				}
				const sent =
					queued > 0 && s.settings.dispatch.inline ? await dispatcher.run(s, { limit: Math.min(200, queued + 10) }) : null;
				return ok({ rows: parsed.rows.length, processed, queued, errors: errors.slice(0, 100), dispatched: sent });
			},
		}),

		// ── types ───────────────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/alert-types',
			...website('types', null),
			handler: async (ctx) => {
				const s = await site(ctx);
				const t = s.settings.types;
				return ok({
					items: enabledTypes(t).map((type) => {
						const custom = type.startsWith('custom:') ? t.customTypes.find((c) => `custom:${c.key}` === type) : null;
						return {
							type,
							name: custom ? (custom.name ?? custom.key) : type,
							...(type === 'price_drop'
								? { priceDrop: { minPercent: t.minDropPercent, minAmount: t.minDropAmount, allowTarget: t.allowTarget } }
								: {}),
						};
					}),
					capture: {
						channels: s.settings.capture.channels,
						requireConsent: s.settings.capture.requireConsent,
						doubleOptIn: s.settings.capture.doubleOptIn,
						allowEntry: s.settings.capture.allowEntry,
						defaultLang: s.settings.capture.defaultLang,
					},
					waitlist: { order: s.settings.waitlist.order, showPosition: s.settings.waitlist.showPosition },
				});
			},
		}),

		// ── capture ─────────────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'POST',
			path: '/v1/subscriptions',
			...website('capture', null),
			handler: async (ctx) => {
				const s = await site(ctx);
				const keyKind = ctx.website.kind === 'sk' ? 'sk' : 'pk';
				return respond(
					await capture.subscribe(s, {
						body: ctx.body,
						keyKind,
						identity: ctx.identity,
						claims: ctx.identity?.claims ?? null,
						ip: ipOf(ctx.headers),
					}),
				);
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/subscriptions',
			...website('capture', null),
			handler: async (ctx) => {
				const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url });
				const s = await site(ctx);
				const serverKey = ctx.website.kind === 'sk';
				/** @type {Record<string, string | undefined>} */
				const filter = {};
				if (!serverKey) {
					const customerId = customerOf(ctx);
					if (!customerId) return page.respond([]);
					filter.customerId = customerId;
				} else {
					const { customerId, status, type, itemId, variantId, email, phone } = ctx.query;
					if (customerId) filter.customerId = customerId;
					if (status) filter.status = status;
					if (type) filter.type = type;
					if (itemId) filter.targetKey = targetKeyOf({ itemId, variantId: variantId || null });
					const address = email ? addressFor('email', email) : phone ? addressFor('sms', phone) : null;
					if ((email || phone) && !address) return invalid([{ path: email ? '/email' : '/phone', code: 'contact_invalid' }]);
					if (address) filter.contactKey = deps.tokens.contactKey(ctx.websiteId, contactIdOf(address));
				}
				const subs = await s.repos.subscriptions.list({ ...filter, after: page.after, fetchLimit: page.fetchLimit });
				return page.respond(
					subs.map((/** @type {any} */ sub) => subscriptionView(sub, { reveal: serverKey })),
					subCursor,
				);
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/subscriptions/:id',
			...website('capture', null),
			handler: async (ctx) => {
				const s = await site(ctx);
				const sub = await s.repos.subscriptions.get(ctx.params.id);
				const serverKey = ctx.website.kind === 'sk';
				if (!sub || (!serverKey && (!customerOf(ctx) || sub.customerId !== customerOf(ctx))))
					return problem('not_found', 'No such subscription.');
				return ok(await capture.view(s, sub, { reveal: serverKey }));
			},
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/subscriptions/:id',
			...website('capture', null),
			handler: async (ctx) =>
				respond(
					await capture.remove(await site(ctx), ctx.params.id, {
						customerId: customerOf(ctx),
						serverKey: ctx.website.kind === 'sk',
					}),
				),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/subscriptions:confirm',
			...website('capture', null),
			handler: async (ctx) => {
				const claims = deps.tokens.verify('confirm', ctx.body?.token);
				if (!claims || claims.websiteId !== ctx.websiteId)
					return problem('token_invalid', 'The confirmation link is invalid or has expired.');
				return respond(await capture.confirm(await site(ctx), claims));
			},
		}),

		// ── dispatch ────────────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/messages',
			...website('dispatch'),
			handler: async (ctx) => {
				const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url });
				const messages = await (
					await site(ctx)
				).repos.messages.list({
					status: typeof ctx.query.status === 'string' ? ctx.query.status : undefined,
					after: page.after,
					fetchLimit: page.fetchLimit,
				});
				return page.respond(messages.map(messageView), (/** @type {any} */ m) => `${m.queuedAt}|${m.id}`);
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/messages/:id',
			...website('dispatch'),
			handler: async (ctx) => {
				const message = await (await site(ctx)).repos.messages.get(ctx.params.id);
				return message ? ok(messageView(message)) : problem('not_found', 'No such message.');
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/messages:dispatch',
			...website('dispatch'),
			idempotent: 'optional',
			handler: async (ctx) => {
				const s = await site(ctx);
				const recovered = await dispatcher.recover(s);
				const resumed = await engine.resume(s);
				return ok({ ...(await dispatcher.run(s, { limit: 200 })), recovered, resumed });
			},
		}),

		// ── waitlist priority ───────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/waitlist',
			...website('waitlist_priority'),
			handler: async (ctx) => {
				const { type, itemId, variantId } = ctx.query;
				if (!type || !itemId)
					return invalid([
						...(type ? [] : [{ path: '/type', code: 'required' }]),
						...(itemId ? [] : [{ path: '/itemId', code: 'required' }]),
					]);
				const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url });
				const s = await site(ctx);
				const subs = await s.repos.subscriptions.waitlist({
					type,
					targetKey: targetKeyOf({ itemId, variantId: variantId || null }),
					after: page.after,
					fetchLimit: page.fetchLimit,
				});
				return page.respond(
					subs.map((/** @type {any} */ sub) => subscriptionView(sub, { reveal: true })),
					(/** @type {any} */ sub) => `${sub.rank ?? 0}|${sub.subscribedAt}|${sub.id}`,
				);
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/waitlist/position',
			...website('waitlist_priority', null),
			handler: async (ctx) => {
				const s = await site(ctx);
				const sub =
					typeof ctx.query.subscriptionId === 'string' ? await s.repos.subscriptions.get(ctx.query.subscriptionId) : null;
				const serverKey = ctx.website.kind === 'sk';
				if (!sub || (!serverKey && (!customerOf(ctx) || sub.customerId !== customerOf(ctx))))
					return problem('not_found', 'No such subscription.');
				const ahead = sub.status === 'pending' ? await s.repos.subscriptions.ahead(sub) : null;
				return ok({ subscriptionId: sub.id, status: sub.status, position: ahead === null ? null : ahead + 1, ahead });
			},
		}),

		// ── unsubscribe ─────────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/unsubscribe/:token',
			...website('unsubscribe', null),
			handler: async (ctx) => {
				const claims = deps.tokens.verify('unsubscribe', ctx.params.token);
				const found = claims && claims.websiteId === ctx.websiteId ? await capture.preview(await site(ctx), claims) : null;
				return found ? ok(found) : problem('token_invalid', 'The unsubscribe link is invalid or has expired.');
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/unsubscribe',
			...website('unsubscribe', null),
			handler: async (ctx) => {
				const claims = deps.tokens.verify('unsubscribe', ctx.body?.token);
				if (!claims || claims.websiteId !== ctx.websiteId)
					return problem('token_invalid', 'The unsubscribe link is invalid or has expired.');
				return respond(await capture.unsubscribe(await site(ctx), claims));
			},
		}),

		// ── analytics ───────────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/analytics',
			...website('analytics'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const requested = ctx.query.days === undefined ? s.settings.analytics.defaultDays : Number(ctx.query.days);
				if (!Number.isInteger(requested) || requested < 1 || requested > s.settings.analytics.maxDays)
					return invalid([{ path: '/days', code: `between_1_and_${s.settings.analytics.maxDays}` }]);
				return ok(await analyticsOf(s, requested, deps.now()));
			},
		}),

		// ── hosted link pages (no key: the signed token is the authorisation) ───────────────────────────────────
		.../** @type {Array<[string, 'unsubscribe' | 'confirm']>} */ ([
			['/u/:token', 'unsubscribe'],
			['/c/:token', 'confirm'],
		]).flatMap(([path, purpose]) => [
			defineRoute({
				method: 'GET',
				path,
				auth: 'none',
				handler: (ctx) =>
					purpose === 'unsubscribe'
						? pages.unsubscribeForm(ctx.params.token, ctx.path)
						: pages.confirmForm(ctx.params.token, ctx.path),
			}),
			defineRoute({
				method: 'POST',
				path,
				auth: 'none',
				rawBody: true,
				idempotent: false,
				maxBodyBytes: 4096,
				handler: (ctx) => (purpose === 'unsubscribe' ? pages.unsubscribe(ctx.params.token) : pages.confirm(ctx.params.token)),
			}),
		]),

		// ── dashboard (SSO session) ─────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/dashboard/overview',
			auth: 'launch',
			element: 'types',
			handler: async (ctx) => {
				if (!ctx.websiteId || !ctx.entitlement) return problem('bad_request', 'Open the dashboard for a website.');
				const s = await site(ctx);
				return ok({
					active: await s.repos.subscriptions.countActive(),
					analytics: await analyticsOf(s, s.settings.analytics.defaultDays, deps.now()),
				});
			},
		}),
	];
};

/**
 * Register the event consumers (app-kit dedupes deliveries on the event id).
 * @param {Alerts} alerts
 */
export const wireEvents = (alerts) => {
	for (const [type, handler] of Object.entries(createEventHandlers({ alerts }))) alerts.product.events.on(type, handler);
	return alerts;
};
