/**
 * Growth's routes (the kit adds its own: connect, notices, tickets, data rights, widget config, `/sso` and the
 * dashboard API). Every browser-token, server-token and ticket route belongs to its feature (or features);
 * `openapi.json` is generated from these definitions (`ss app assets`), so `method`, `path`, `auth`, `feature` and
 * `permission` stay string literals. Nothing runs on a timer: events are written as they arrive, the SEO checklist and
 * IndexNow run when the merchant asks. Days (daily totals, analytics ranges) are days of the website's business time
 * zone (business.json `timeZone`, UTC when missing; PLAN 0.8.10 K8).
 * Public entry `./routes` of this package: `product.handler(createRoutes(product))`.
 * @module
 */
import { actorOf, countHandlers, defineRoute, formatText, ok, paginate, problem } from '@ss/app-kit';
import { buildReport, rangeOf } from '../core/analytics.js';
import { COLLECT_FEATURES, EVENT_FEATURES, checkBatch, countryOf, dayOf, expiryOf, mergeTotals } from '../core/events.js';
import {
	checksActivity,
	indexNowActivity,
	indexNowSubmission,
	pageChecks,
	pagesOf,
	reportOf,
	robotsTxtOf,
	siteChecks,
	siteUrlOf,
	sitemapsIn,
	verificationOf,
} from '../core/seo.js';
import { createStore } from '../adapters/store.js';
import { renderDocs } from './docs.js';
import { WIDGET_SCRIPT } from './widget-script.js';

/** @typedef {import('../adapters/product.js').Product} Product */

/** Rate limits of the page script's events (code constants protecting our hosting). */
const COLLECT_LIMITS = [
	{ limit: 3000, windowSeconds: 60, per: /** @type {const} */ ('website') },
	{ limit: 120, windowSeconds: 60, per: /** @type {const} */ ('visitor') },
];
/** Rate limits of the on-request work that reads other sites (SEO checklist, IndexNow). */
const WEB_LIMITS = [{ limit: 10, windowSeconds: 3600, per: /** @type {const} */ ('website') }];

/** Who acts when no member of the merchant's staff is named (PLAN 0.8.10 K2). */
const SERVER = Object.freeze({ kind: 'server', id: 'server', name: 'Server' });

/** @param {string} field @param {string} message */
const invalid = (field, message) =>
	problem('validation_failed', message, { errors: [{ path: `/${field}`, message, code: 'invalid' }] });

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
	 * default).
	 * @param {any} ctx
	 */
	const analytics = async (ctx) => {
		const timeZone = await timeZoneOf(ctx);
		const range = rangeOf(ctx.query, now(), timeZone);
		if (!range.ok) return invalid('from', range.message);
		const on = await product.featuresOn(ctx.websiteId);
		const { totals, days } = await (await storeOf(ctx)).totals(range.from, range.to);
		return buildReport({ from: range.from, to: range.to, timeZone, on, totals, days });
	};

	/**
	 * The raw events' filter of `GET /v1/events` and its counts: `type`, one event type (any other value is ignored).
	 * @param {any} ctx
	 */
	const eventQuery = (ctx) => ({ type: Object.hasOwn(EVENT_FEATURES, ctx.query.type) ? String(ctx.query.type) : undefined });

	/** `GET /v1/events/count` and `/counts?by=type`: the list's own filter (PLAN 0.8.10 K4). */
	const eventCounts = countHandlers({
		source: async (ctx) => (await storeOf(ctx)).eventSource(eventQuery(ctx)),
		by: { type: 'type' },
	});

	/**
	 * Run the SEO checklist: read the website's robots.txt, its sitemap and its pages (the paths asked for, else the
	 * `seo_checklist` settings), then check them. Every check carries its title and fix steps (the website's widget
	 * texts).
	 * @param {any} ctx
	 */
	const seoChecks = async (ctx) => {
		const domain = String(ctx.status.domain);
		const asked = ctx.body?.paths;
		if (asked !== undefined && (!Array.isArray(asked) || asked.length > 20))
			return {
				ok: /** @type {const} */ (false),
				problem: invalid('paths', 'paths is a list of at most 20 paths on your website.'),
			};
		const { paths } = await product.settings.values(ctx.websiteId, 'seo_checklist');
		const pages = pagesOf(asked ?? paths, domain);
		const robots = await web.read(`https://${domain}/robots.txt`);
		const listed = robots.status === 200 ? sitemapsIn(robots.body).map((url) => siteUrlOf(url, domain)) : [];
		const sitemapUrl = listed.find((url) => url !== null) ?? `https://${domain}/sitemap.xml`;
		const [sitemap, ...read] = await Promise.all([
			web.read(sitemapUrl, { statusOnly: true }),
			...pages.map((url) => web.read(url)),
		]);
		const home = /** @type {import('../core/seo.js').Fetched} */ (read[0]);
		const checks = [...siteChecks({ home, robots, sitemap }), ...read.flatMap((page) => pageChecks(page, domain))];
		const texts = await product.settings.texts(ctx.websiteId);
		const report = reportOf(checks, now());
		return {
			ok: /** @type {const} */ (true),
			report: {
				...report,
				pages,
				checks: report.checks.map((check) => ({
					...check,
					title: texts[`seo.check.${check.id}.title`] ?? check.id,
					fix: check.status === 'pass' ? '' : formatText(texts[`seo.check.${check.id}.fix`] ?? '', check.detail),
				})),
			},
		};
	};

	/**
	 * Submit URLs of the website to IndexNow with the merchant's key.
	 * @param {any} ctx
	 */
	const submitIndexNow = async (ctx) => {
		const { key } = await product.settings.values(ctx.websiteId, 'indexnow');
		const submission = indexNowSubmission({ urls: ctx.body?.urls, key, domain: String(ctx.status.domain) });
		if (!submission.ok) return { ok: /** @type {const} */ (false), problem: invalid(submission.field, submission.message) };
		const answer = await web.indexNow(submission.body);
		if (!answer.ok) {
			const refused = problem(
				'indexnow_refused',
				answer.status === 403
					? `IndexNow did not accept the key: serve it at ${submission.body.keyLocation}.`
					: answer.status === 422
						? 'IndexNow says the URLs do not match the key’s host.'
						: answer.status === 429
							? 'IndexNow asks to send fewer submissions; try again later.'
							: `IndexNow answered ${answer.status ?? 'nothing'}.`,
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
				const [features, { recordCountry, retentionMonths }, timeZone] = await Promise.all([
					product.featuresOn(ctx.websiteId),
					product.settings.values(ctx.websiteId, 'visitor_analytics'),
					timeZoneOf(ctx),
				]);
				const on = features.filter((key) => COLLECT_FEATURES.includes(key));
				// the host's country header; on a visitor call from the merchant's server it is the server's own
				const country = recordCountry === false ? null : countryOf((name) => ctx.headers.get(name));
				const kept = checkBatch(ctx.body, { on, domain: String(ctx.status.domain), country });
				const at = now();
				await (
					await storeOf(ctx)
				).record(kept, {
					at,
					day: dayOf(at, timeZone),
					expiresAt: expiryOf(at, Number(retentionMonths) || 13),
					totals: mergeTotals(kept),
				});
				return ok({ accepted: kept.length }, { status: 202 });
			},
		}),

		// --------------------------------------------------------------------------- analytics (server, ticket)
		defineRoute({ method: 'GET', path: '/v1/analytics', auth: 'server', feature: 'visitor_analytics', handler: analytics }),
		defineRoute({
			method: 'GET',
			path: '/v1/events',
			auth: 'server',
			feature: 'visitor_analytics',
			handler: async (ctx) => {
				const page = paginate(
					{ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url },
					{ defaultLimit: 50 },
				);
				const rows = await (await storeOf(ctx)).list({ after: page.after, limit: page.fetchLimit, ...eventQuery(ctx) });
				return page.respond(
					rows.map((row) => ({ ...row, at: row.at.toISOString(), expiresAt: row.expiresAt.toISOString() })),
					(row) => [row.at, row.id],
				);
			},
		}),
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

		// ----------------------------------------------------------------- robots and verification (server)
		defineRoute({
			method: 'GET',
			path: '/v1/robots.txt',
			auth: 'server',
			feature: 'robots_verification',
			database: false,
			handler: async (ctx) =>
				new Response(
					robotsTxtOf(await product.settings.values(ctx.websiteId, 'robots_verification'), String(ctx.status.domain)),
					{ headers: { 'content-type': 'text/plain; charset=utf-8' } },
				),
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

		// ----------------------------------------------------------------------------------- SEO checklist
		defineRoute({
			method: 'POST',
			path: '/v1/seo/checks',
			auth: 'server',
			feature: 'seo_checklist',
			database: false,
			rateLimit: WEB_LIMITS,
			handler: async (ctx) => {
				const checked = await seoChecks(ctx);
				return checked.ok ? checked.report : checked.problem;
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/seo/checks',
			auth: 'ticket',
			permission: 'seo.check',
			rateLimit: WEB_LIMITS,
			handler: async (ctx) => {
				const checked = await seoChecks(ctx);
				if (!checked.ok) return checked.problem;
				await logAction(ctx, {
					action: 'seo.checked',
					target: 'seo_checklist',
					...checksActivity(checked.report.pages, checked.report.summary),
				});
				return checked.report;
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
	];
};
