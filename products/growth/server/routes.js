/**
 * Growth's routes (the kit adds its own: connect, notices, tickets, data rights, widget config, `/sso` and the
 * dashboard API). Every browser-token, server-token and ticket route belongs to its feature (or features);
 * `openapi.json` is generated from these definitions (`ss app assets`), so `method`, `path`, `auth`, `feature` and
 * `permission` stay string literals. Nothing runs on a timer: events are written as they arrive, the SEO checklist and
 * IndexNow run when the merchant asks, redirect rules change when staff change them. Days (daily totals, analytics
 * ranges) are days of the website's business time zone (business.json `timeZone`, UTC when missing; PLAN 0.8.10 K8).
 * Public entry `./routes` of this package: `product.handler(createRoutes(product))`.
 * @module
 */
import { actorOf, countHandlers, defineRoute, ok, paginate, problem } from '@ss/app-kit';
import { JOURNEYS, LIVE_MS, buildReport, rangeOf, shiftDay, topOf } from '../core/analytics.js';
import { noticeAnswer } from '../core/config.js';
import { COLLECT_FEATURES, EVENT_FEATURES, checkBatch, cityOf, countryOf, dayOf, expiryOf, mergeTotals } from '../core/events.js';
import { indexNowActivity, indexNowSubmission, robotsTxtOf, verificationOf } from '../core/seo.js';
import { zonedDayStart } from '@ss/contracts/format';
import { createStore } from '../adapters/store.js';
import { renderDocs } from './docs.js';
import { importRoutes } from './imports.js';
import { redirectRoutes } from './redirects.js';
import { invalid, robotsInputOf, seoCheckRoutes } from './seo-checks.js';
import { WIDGET_SCRIPT } from './widget-script.js';

/** @typedef {import('../adapters/product.js').Product} Product */

/** Rate limits of the page script's events (code constants protecting our hosting). */
const COLLECT_LIMITS = [
	{ limit: 3000, windowSeconds: 60, per: /** @type {const} */ ('website') },
	{ limit: 120, windowSeconds: 60, per: /** @type {const} */ ('visitor') },
];
/** Rate limits of the notice read of custom UIs (code constants protecting our hosting). */
const NOTICE_LIMITS = [
	{ limit: 3000, windowSeconds: 60, per: /** @type {const} */ ('website') },
	{ limit: 60, windowSeconds: 60, per: /** @type {const} */ ('visitor') },
];
/** Rate limits of an IndexNow submission (on request; the SEO checklist has its own). */
const WEB_LIMITS = [{ limit: 10, windowSeconds: 3600, per: /** @type {const} */ ('website') }];

/** Who acts when no member of the merchant's staff is named (PLAN 0.8.10 K2). */
const SERVER = Object.freeze({ kind: 'server', id: 'server', name: 'Server' });

/**
 * @param {Product} product
 */
export const createRoutes = (product) => {
	const { now, web } = product;

	/** @param {any} ctx */
	const storeOf = async (ctx) => createStore(await ctx.data(), { merchantId: String(ctx.merchantId) });

	/**
	 * The website's business time zone (business.json `timeZone`, else UTC): the zone of every day Growth counts.
	 * @param {any} ctx
	 */
	const timeZoneOf = async (ctx) => (await product.business(ctx.websiteId)).timeZone ?? 'UTC';

	/**
	 * The analytics report of a range of days (`?from=&to=`, days of the business time zone; the last 30 days by
	 * default; `top`: rows of each top list, 10 by default, at most 100). With the `sessions` detail (G3) it adds the
	 * live visitors and the latest journeys, read from the raw events now.
	 * @param {any} ctx
	 */
	const analytics = async (ctx) => {
		const timeZone = await timeZoneOf(ctx);
		const range = rangeOf(ctx.query, now(), timeZone);
		if (!range.ok) return invalid('from', range.message);
		const [on, { detail }] = await Promise.all([
			product.featuresOn(ctx.websiteId),
			product.settings.values(ctx.websiteId, 'visitor_analytics'),
		]);
		const store = await storeOf(ctx);
		const sessions = detail === 'sessions';
		const [{ totals, days }, live, journeys] = await Promise.all([
			store.totals(range.from, range.to),
			sessions ? store.live(new Date(now() - LIVE_MS)) : null,
			sessions
				? store.journeys(
						new Date(zonedDayStart(range.from, timeZone)),
						// up to the start of the day after `to` in the business time zone
						new Date(zonedDayStart(shiftDay(range.to, 1), timeZone)),
						JOURNEYS,
					)
				: null,
		]);
		return buildReport({
			from: range.from,
			to: range.to,
			timeZone,
			on,
			totals,
			days,
			top: topOf(ctx.query.top),
			detail: sessions ? 'sessions' : 'anonymous',
			live,
			journeys,
		});
	};

	/**
	 * The raw events' filter of `GET /v1/events` and its counts: `type`, one event type, and `session`, one session
	 * (G3); any other value is ignored.
	 * @param {any} ctx
	 */
	const eventQuery = (ctx) => ({
		type: Object.hasOwn(EVENT_FEATURES, ctx.query.type) ? String(ctx.query.type) : undefined,
		session:
			typeof ctx.query.session === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(ctx.query.session) ? ctx.query.session : undefined,
	});

	/**
	 * A page of raw events, newest first (`?type=&session=&cursor=&limit=`).
	 * @param {any} ctx
	 */
	const eventList = async (ctx) => {
		const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url }, { defaultLimit: 50 });
		const rows = await (await storeOf(ctx)).list({ after: page.after, limit: page.fetchLimit, ...eventQuery(ctx) });
		return page.respond(
			rows.map((row) => ({ ...row, at: row.at.toISOString(), expiresAt: row.expiresAt.toISOString() })),
			(row) => [row.at, row.id],
		);
	};

	/** `GET /v1/events/count` and `/counts?by=type`: the list's own filter (PLAN 0.8.10 K4). */
	const eventCounts = countHandlers({
		source: async (ctx) => (await storeOf(ctx)).eventSource(eventQuery(ctx)),
		by: { type: 'type' },
	});

	/**
	 * Submit URLs of the website to IndexNow with the merchant's key.
	 * @param {any} ctx
	 */
	const submitIndexNow = async (ctx) => {
		const { key, keyPath } = await product.settings.values(ctx.websiteId, 'indexnow');
		const submission = indexNowSubmission({ urls: ctx.body?.urls, key, keyPath, domain: String(ctx.status.domain) });
		if (!submission.ok) return { ok: /** @type {const} */ (false), problem: invalid(submission.field, submission.message) };
		const answer = await web.indexNow(submission.body);
		if (!answer.ok) {
			// what IndexNow answered goes with the problem, so a widget shows its own text for it (OT-4)
			const refused = problem(
				'indexnow_refused',
				answer.status === 403
					? `IndexNow did not accept the key: serve it at ${submission.body.keyLocation}.`
					: answer.status === 422
						? 'IndexNow says the URLs do not match the key’s host.'
						: answer.status === 429
							? 'IndexNow asks to send fewer submissions; try again later.'
							: `IndexNow answered ${answer.status ?? 'nothing'}.`,
				{ extensions: { indexNowStatus: answer.status } },
			);
			return { ok: /** @type {const} */ (false), problem: refused };
		}
		return {
			ok: /** @type {const} */ (true),
			answer: { submitted: submission.body.urlList.length, status: answer.status },
			urls: submission.body.urlList,
		};
	};

	/**
	 * An action in the activity log (PLAN 0.8.10 K2, K9): by the ticket's member of the merchant's staff, else the
	 * acting user a server-token call named, else `Server`; with a label and a short detail.
	 * @param {any} ctx
	 * @param {{ action: string, target: string, label: string, detail: string }} entry
	 */
	const logAction = (ctx, entry) =>
		product.activity.record(
			{ websiteId: ctx.websiteId, merchantId: ctx.merchantId, after: ctx.after },
			{ actor: actorOf(ctx, SERVER), ...entry },
		);

	return [
		// the page script and the widgets: public and the same for every website (no token, no Origin needed)
		defineRoute({
			method: 'GET',
			path: '/widget.js',
			auth: 'none',
			handler: () =>
				new Response(WIDGET_SCRIPT, {
					headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=300' },
				}),
		}),

		// ------------------------------------------------------------------------- the page script's events
		defineRoute({
			method: 'POST',
			path: '/v1/collect',
			auth: 'browser',
			feature: ['visitor_analytics', 'conversion_funnel', 'searches_404s', 'web_vitals'],
			maxBodyBytes: 65_536,
			rateLimit: COLLECT_LIMITS,
			handler: async (ctx) => {
				const [features, { recordCountry, retentionMonths, detail }, timeZone] = await Promise.all([
					product.featuresOn(ctx.websiteId),
					product.settings.values(ctx.websiteId, 'visitor_analytics'),
					timeZoneOf(ctx),
				]);
				// events are kept only while Visitor analytics is on (Web Vitals may be on without it, for Google
				// Analytics alone; SG-27)
				const on = features.includes('visitor_analytics') ? features.filter((key) => COLLECT_FEATURES.includes(key)) : [];
				/** @param {string} name */
				const header = (name) => ctx.headers.get(name);
				// the host's country (and, with sessions, city) header; on a visitor call from the merchant's server it is
				// the server's own
				const country = recordCountry === false ? null : countryOf(header);
				const sessions = detail === 'sessions';
				const city = sessions && recordCountry !== false ? cityOf(header) : null;
				const kept = checkBatch(ctx.body, { on, domain: String(ctx.status.domain), country, sessions, city });
				const at = now();
				await (
					await storeOf(ctx)
				).record(kept, {
					at,
					day: dayOf(at, timeZone),
					expiresAt: expiryOf(at, Number(retentionMonths)),
					totals: mergeTotals(kept),
				});
				return ok({ accepted: kept.length }, { status: 202 });
			},
		}),

		// ------------------------------------------------------------------- the notice bar for custom UIs (G6)
		defineRoute({
			method: 'GET',
			path: '/v1/notice',
			auth: 'browser',
			feature: 'notice_bar',
			database: false,
			rateLimit: NOTICE_LIMITS,
			// `{ text, linkText, linkUrl, dismissible }` while the dates say so, else null; `?path=` leaves out pages it hides on
			handler: async (ctx) =>
				ok(noticeAnswer({ notice_bar: await product.settings.values(ctx.websiteId, 'notice_bar') }, now(), ctx.query.path)),
		}),

		// --------------------------------------------------------------------------- analytics (server, ticket)
		defineRoute({ method: 'GET', path: '/v1/analytics', auth: 'server', feature: 'visitor_analytics', handler: analytics }),
		defineRoute({ method: 'GET', path: '/v1/events', auth: 'server', feature: 'visitor_analytics', handler: eventList }),
		defineRoute({
			method: 'GET',
			path: '/v1/events/count',
			auth: 'server',
			feature: 'visitor_analytics',
			handler: eventCounts.count,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/events/counts',
			auth: 'server',
			feature: 'visitor_analytics',
			handler: eventCounts.counts,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/analytics',
			auth: 'ticket',
			permission: 'analytics.read',
			handler: analytics,
		}),
		// the event log of the analytics dashboard (ticket twins of the raw events, PLAN 0.8.10 K4)
		defineRoute({ method: 'GET', path: '/v1/admin/events', auth: 'ticket', permission: 'analytics.read', handler: eventList }),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/events/count',
			auth: 'ticket',
			permission: 'analytics.read',
			handler: eventCounts.count,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/events/counts',
			auth: 'ticket',
			permission: 'analytics.read',
			handler: eventCounts.counts,
		}),

		// ----------------------------------------------------------------- robots and verification (server)
		defineRoute({
			method: 'GET',
			path: '/v1/robots.txt',
			auth: 'server',
			feature: 'robots_verification',
			database: false,
			// the presets keep out the search results of Searches and 404s' search parameters (G12)
			handler: async (ctx) => {
				const { values, searchParams } = await robotsInputOf(product, ctx.websiteId);
				return new Response(robotsTxtOf(values, String(ctx.status.domain), searchParams), {
					headers: { 'content-type': 'text/plain; charset=utf-8' },
				});
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/verification',
			auth: 'server',
			feature: 'robots_verification',
			database: false,
			handler: async (ctx) => verificationOf(await product.settings.values(ctx.websiteId, 'robots_verification')),
		}),

		// --------------------------------------------------------------------------------------- IndexNow
		defineRoute({
			method: 'GET',
			path: '/v1/indexnow/key.txt',
			auth: 'server',
			feature: 'indexnow',
			database: false,
			handler: async (ctx) => {
				const { key } = await product.settings.values(ctx.websiteId, 'indexnow');
				if (typeof key !== 'string' || key === '') return problem('not_found', 'Set your IndexNow key in Settings first.');
				return new Response(key, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/indexnow',
			auth: 'server',
			feature: 'indexnow',
			database: false,
			rateLimit: WEB_LIMITS,
			handler: async (ctx) => {
				const submitted = await submitIndexNow(ctx);
				return submitted.ok ? submitted.answer : submitted.problem;
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/indexnow',
			auth: 'ticket',
			permission: 'indexnow.submit',
			rateLimit: WEB_LIMITS,
			handler: async (ctx) => {
				const submitted = await submitIndexNow(ctx);
				if (!submitted.ok) return submitted.problem;
				await logAction(ctx, {
					action: 'indexnow.submitted',
					target: 'indexnow',
					...indexNowActivity(submitted.urls, submitted.answer.status),
				});
				return submitted.answer;
			},
		}),

		// public docs: no sign-in, no tokens
		defineRoute({
			method: 'GET',
			path: '/docs',
			auth: 'none',
			handler: (ctx) =>
				new Response(renderDocs({ base: new URL(ctx.request.url).origin }), {
					headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' },
				}),
		}),

		// the SEO checklist: the live website's SEO health report, run when staff ask (SEO audit §3.2 B)
		...seoCheckRoutes(product, { log: logAction }),

		// redirect rules: read by the website's server, managed by staff (feature `redirects`, SEO audit G9)
		...redirectRoutes(product, { log: logAction }),

		// days of daily totals moved in from another system (ss-import, feature `import`, PLAN 0.8.10 K10)
		...importRoutes(product),
	];
};
