/**
 * The SEO checklist routes (feature `seo_checklist`; SEO audit §3.2 B): the live website's SEO health report, run
 * when staff ask (the `seo_checklist` admin widget with `seo.check`, or the merchant's server), never on a timer.
 *
 * A run reads robots.txt, the sitemap it names (else `/sitemap.xml`; for an index, its first files), the pages (the
 * home page, then the checklist's pages or the paths asked for), an address the site does not have (a soft 404 shows
 * there) and the old paths of up to three redirect rules; a full run (no paths asked for) also picks sample pages from
 * the sitemap: a product, a category, a landing or listing page and a glossary page when the site has them. It adds
 * the Web Vitals visitors measured (28 days) and the 404 log's addresses without a redirect rule (90 days), both from
 * the merchant database. Every read is limited (time, size, a few at a time, one deadline for the run; `adapters/
 * web.js`), and the outbound safety rules of `@ss/net` apply.
 *
 * The last full run is kept (`adapters/seo-reports.js`): the widget shows it when it opens, and a full run asked
 * within {@link MIN_INTERVAL_MS} of it answers it (`cached: true`) instead of reading the site again. Each check
 * carries its title, the reason (what was found) and the fix steps from the website's widget texts, and a link to
 * Google's Rich Results Test for its page.
 * @module
 */
import { defineRoute, formatText, ok, problem } from '@ss/app-kit';
import { shiftDay } from '../core/analytics.js';
import { dayOf } from '../core/events.js';
import { locationOf, suggestionsOf } from '../core/redirects.js';
import {
	SAMPLE_KINDS,
	SITE_CHECKS,
	candidatesOf,
	comparableOf,
	pageChecks,
	pageVitalsOf,
	pagesOf,
	productOf,
	redirectsLiveCheck,
	richResultsTestOf,
	robotsChecks,
	siteVitalsCheck,
	sitemapCheck,
	sitemapUrlsCheck,
	soft404Check,
	suggestionsCheck,
	summaryOf,
	verificationCheck,
} from '../core/seo-checks.js';
import { sitemapOf, sitemapsIn } from '../core/seo-scan.js';
import { checksActivity, pathOfUrl, siteUrlOf } from '../core/seo.js';
import { createRedirectStore } from '../adapters/redirects.js';
import { createReportStore } from '../adapters/seo-reports.js';
import { createStore } from '../adapters/store.js';
import { SITEMAP_MAX_BYTES } from '../adapters/web.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('../core/seo-checks.js').Check} Check */
/** @typedef {import('../core/seo-checks.js').Fetched} Fetched */
/** @typedef {import('../adapters/seo-reports.js').KeptReport} KeptReport */
/** @typedef {(ctx: any, entry: { action: string, target: string, label: string, detail: string }) => Promise<unknown>} Log */

/** The time one run may take, all its reads together. */
const RUN_MS = 25_000;
/** A full run asked again within this time answers the kept report. */
export const MIN_INTERVAL_MS = 5 * 60_000;
/** Files of a sitemap index read for samples. */
const MAX_SITEMAP_FILES = 3;
/** Redirect rules whose old path is tried on the live site. */
const MAX_RULE_PROBES = 3;
/** Days of Web Vitals (as Google's own field data) and of the 404 log a run reads. */
const VITAL_DAYS = 28;
const NOT_FOUND_DAYS = 90;
/** Rate limit of a run, the API and the widget together (it reads the merchant's site; a code constant protecting both). */
const RUN_LIMITS = [{ limit: 10, windowSeconds: 3600, per: /** @type {const} */ ('website'), bucket: 'seo_checks' }];

/** A 422 at one field. @param {string} field @param {string} message */
export const invalid = (field, message) =>
	problem('validation_failed', message, { errors: [{ path: `/${field}`, message, code: 'invalid' }] });

/**
 * @param {Product} product
 * @param {{ log: Log }} options `log`: writes an action to the activity log
 */
export const seoCheckRoutes = (product, { log }) => {
	const { now, web } = product;

	/**
	 * The sitemap: the first one robots.txt names on the website, else `/sitemap.xml`; for an index, its first files
	 * (read one after the other, each body dropped once its addresses are taken).
	 * @param {Fetched} robots
	 * @param {string} domain
	 * @param {number} until the run's deadline
	 */
	const readSitemap = async (robots, domain, until) => {
		const named = robots.status === 200 ? sitemapsIn(robots.body).map((url) => siteUrlOf(url, domain)) : [];
		const url = named.find((found) => found !== null) ?? `https://${domain}/sitemap.xml`;
		const read = await web.read(url, { maxBytes: SITEMAP_MAX_BYTES, until });
		const parsed = read.status === 200 ? sitemapOf(read.body) : { type: null, files: [], entries: [] };
		let entries = parsed.entries;
		/** @type {Fetched[]} */
		const files = [];
		for (const file of parsed.files
			.map((loc) => siteUrlOf(loc, domain))
			.filter((loc) => loc !== null)
			.slice(0, MAX_SITEMAP_FILES)) {
			const fileRead = await web.read(file, { maxBytes: SITEMAP_MAX_BYTES, until });
			if (fileRead.status === 200) entries = [...entries, ...sitemapOf(fileRead.body).entries];
			files.push({ ...fileRead, body: '' });
		}
		return { read: { ...read, body: '' }, type: parsed.type, entries, files };
	};

	/**
	 * The daily totals a run reads (one read each): the Web Vitals of the last 28 days while Web Vitals are kept, and
	 * the 404 log of the last 90 days while Searches and 404s is on.
	 * @param {any} ctx
	 * @param {string[]} on
	 */
	const totalsOf = async (ctx, on) => {
		const vitalsKept = on.includes('web_vitals') && on.includes('visitor_analytics');
		const notFound = on.includes('searches_404s');
		if (!vitalsKept && !notFound) return { vitals: null, notFound: null };
		const today = dayOf(now(), (await product.business(ctx.websiteId)).timeZone ?? 'UTC');
		const store = createStore(await ctx.data(), { merchantId: String(ctx.merchantId) });
		const [vitals, missing] = await Promise.all([
			vitalsKept ? store.metricTotals(shiftDay(today, 1 - VITAL_DAYS), today, ['vital', 'vital_page']) : null,
			notFound ? store.metricTotals(shiftDay(today, 1 - NOT_FOUND_DAYS), today, ['not_found', 'page']) : null,
		]);
		return { vitals, notFound: missing };
	};

	/**
	 * One run: read the site, then check it.
	 * @param {any} ctx
	 * @param {string[]} typed the pages to check (the home page first)
	 * @param {boolean} sample whether to add sample pages from the sitemap (a full run)
	 * @returns {Promise<KeptReport>}
	 */
	const run = async (ctx, typed, sample) => {
		const domain = String(ctx.status.domain);
		const origin = `https://${domain}`;
		const until = web.deadline(RUN_MS);
		const on = await product.featuresOn(ctx.websiteId);
		const rules = on.includes('redirects')
			? await createRedirectStore(await ctx.data(), { merchantId: String(ctx.merchantId) }).all()
			: [];

		const robots = await web.read(`${origin}/robots.txt`, { until });
		const sitemap = await readSitemap(robots, domain, until);
		const candidates = sample ? candidatesOf(sitemap.entries, { domain, skip: typed.map(comparableOf) }) : [];
		const probes = [...rules]
			.sort(
				(a, b) =>
					(a.match === 'exact' ? 0 : 1) - (b.match === 'exact' ? 0 : 1) ||
					(b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0),
			)
			.slice(0, MAX_RULE_PROBES);
		const missingUrl = `${origin}/this-page-does-not-exist-${crypto.randomUUID().slice(0, 8)}`;
		const [reads, totals] = await Promise.all([
			web.readAll([...typed, ...candidates, missingUrl, ...probes.map((rule) => `${origin}${rule.from}`)], { until }),
			totalsOf(ctx, on),
		]);
		const typedReads = reads.slice(0, typed.length);
		const candidateReads = reads.slice(typed.length, typed.length + candidates.length);
		const missing = /** @type {Fetched} */ (reads[typed.length + candidates.length]);
		const ruleReads = reads.slice(typed.length + candidates.length + 1);

		const listed = new Set(sitemap.entries.map((entry) => comparableOf(entry.loc)));
		/** @param {Fetched} read @param {boolean} sampled */
		const checkPage = (read, sampled) => ({
			read,
			sampled,
			...pageChecks(read, {
				domain,
				listed: listed.has(comparableOf(read.url)),
				vitals: totals.vitals ? pageVitalsOf(totals.vitals, new URL(read.url).pathname) : null,
			}),
		});
		const own = typedReads.map((read) => checkPage(read, false));
		const tried = candidateReads.map((read) => checkPage(read, true));
		const samples = SAMPLE_KINDS.map((kind) => tried.find((page) => page.kind === kind)).filter(
			/** @returns {page is (typeof tried)[number]} */ (page) => page !== undefined,
		);
		const pages = [...own, ...samples];
		const home = /** @type {(typeof own)[number]} */ (own[0]);

		// what robots.txt must let Google read: the home page, the sitemap, every page, and the products' images
		const images = pages
			.flatMap((page) => (page.kind === 'product' && page.scan ? (productOf(page.scan.jsonLd.nodes)?.images ?? []) : []))
			.map((image) => {
				try {
					const url = new URL(image, origin);
					return url.host === domain ? `${url.pathname}${url.search}` : null;
				} catch {
					return null;
				}
			})
			.filter((path) => path !== null)
			.slice(0, 5);
		const sitemapPath = new URL(sitemap.read.url).host === domain ? [pathOfUrl(sitemap.read.url)] : [];
		const paths = [...new Set(['/', ...sitemapPath, ...pages.map((page) => pathOfUrl(page.read.url))])].map((path) => ({
			path,
		}));

		const vitals = totals.vitals ? siteVitalsCheck(totals.vitals) : null;
		/** @type {Array<Check | null>} */
		const site = [
			...robotsChecks(robots, { paths: [...paths, ...[...new Set(images)].map((path) => ({ path, image: true }))] }),
			sitemapCheck({ ...sitemap, entries: sitemap.entries.length }),
			sitemapUrlsCheck({ reads: candidateReads, entries: sitemap.entries, domain }),
			soft404Check(missing),
			redirectsLiveCheck(
				probes.map((rule, index) => ({
					read: /** @type {Fetched} */ (ruleReads[index]),
					code: rule.code,
					location: locationOf(rule, rule.from),
				})),
				origin,
			),
			totals.notFound
				? suggestionsCheck(suggestionsOf({ totals: totals.notFound, rules, limit: Number.POSITIVE_INFINITY }))
				: null,
			home.scan ? verificationCheck(home.read, home.scan) : null,
			vitals,
		];
		return {
			checkedAt: new Date(now()),
			pages: pages.map((page) => ({ url: page.read.url, kind: page.kind, sampled: page.sampled })),
			checks: [...site.filter((item) => item !== null), ...pages.flatMap((page) => page.checks)],
		};
	};

	/**
	 * A report as answered: each check with its title, reason and fix steps (the website's widget texts) and the Rich
	 * Results Test of its page.
	 * @param {any} ctx
	 * @param {KeptReport} report
	 * @param {boolean} cached the kept report of an earlier run
	 */
	const present = async (ctx, report, cached) => {
		const texts = await product.settings.texts(ctx.websiteId);
		return {
			checkedAt: report.checkedAt.toISOString(),
			cached,
			summary: summaryOf(report.checks),
			pages: report.pages,
			checks: report.checks.map((item) => ({
				...item,
				title: texts[`seo.check.${item.id}.title`] ?? item.id,
				reason: formatText(texts[`seo.check.${item.id}.${item.finding}`] ?? '', item.detail),
				fix: item.status === 'pass' ? '' : formatText(texts[`seo.check.${item.id}.fix`] ?? '', item.detail),
				test: item.page !== null && !SITE_CHECKS.includes(item.id) ? richResultsTestOf(item.page) : null,
			})),
		};
	};

	/**
	 * Run the checklist: the paths asked for (and the home page), else a full run of the checklist's pages and the
	 * sample pages, which is kept, and answered from the kept report within {@link MIN_INTERVAL_MS}.
	 * @param {any} ctx
	 */
	const runChecks = async (ctx) => {
		const asked = ctx.body?.paths;
		if (asked !== undefined && (!Array.isArray(asked) || asked.length > 20))
			return {
				ok: /** @type {const} */ (false),
				problem: invalid('paths', 'paths is a list of at most 20 paths on your website.'),
			};
		const reports = createReportStore(await ctx.data(), { merchantId: String(ctx.merchantId) });
		const full = asked === undefined;
		if (full) {
			const kept = await reports.kept();
			if (kept && now() - kept.checkedAt.getTime() < MIN_INTERVAL_MS)
				return { ok: /** @type {const} */ (true), ran: false, report: await present(ctx, kept, true) };
		}
		const { paths } = await product.settings.values(ctx.websiteId, 'seo_checklist');
		const report = await run(ctx, pagesOf(asked ?? paths, String(ctx.status.domain)), full);
		if (full) await reports.keep(report);
		return { ok: /** @type {const} */ (true), ran: true, report: await present(ctx, report, false) };
	};

	/**
	 * The last full report, or null.
	 * @param {any} ctx
	 */
	const keptReport = async (ctx) => {
		const kept = await createReportStore(await ctx.data(), { merchantId: String(ctx.merchantId) }).kept();
		return ok(kept === null ? null : await present(ctx, kept, true));
	};

	return [
		defineRoute({
			method: 'POST',
			path: '/v1/seo/checks',
			auth: 'server',
			feature: 'seo_checklist',
			rateLimit: RUN_LIMITS,
			handler: async (ctx) => {
				const checked = await runChecks(ctx);
				return checked.ok ? checked.report : checked.problem;
			},
		}),
		defineRoute({ method: 'GET', path: '/v1/seo/report', auth: 'server', feature: 'seo_checklist', handler: keptReport }),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/seo/checks',
			auth: 'ticket',
			permission: 'seo.check',
			rateLimit: RUN_LIMITS,
			handler: async (ctx) => {
				const checked = await runChecks(ctx);
				if (!checked.ok) return checked.problem;
				if (checked.ran)
					await log(ctx, {
						action: 'seo.checked',
						target: 'seo_checklist',
						...checksActivity(
							checked.report.pages.map((page) => page.url),
							checked.report.summary,
						),
					});
				return checked.report;
			},
		}),
		defineRoute({ method: 'GET', path: '/v1/admin/seo/report', auth: 'ticket', permission: 'seo.check', handler: keptReport }),
	];
};
