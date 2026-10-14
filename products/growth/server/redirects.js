/**
 * The Redirects routes (feature `redirects`; SEO audit G9). The website's server reads the rules with the server token:
 * `GET /v1/redirects/match?path=` answers the rule of one address (or 204), and `GET /v1/redirects/all` the whole
 * list for edge middleware, with an ETag (a 304 costs one read of the version document, never of the rules) and
 * `Cache-Control: private, max-age=300`, so a site reads it at most every 5 minutes. Staff manage the rules from the
 * `redirects` admin widget (ticket, `redirects.edit`) or the merchant's server (server token): list with counts,
 * create, change, delete, suggestions from the 404 log, CSV export, and CSV import with a dry run that lists what would
 * change. Every change is checked against the whole set (no loops, no chains, one rule per `from`, at most
 * {@link MAX_RULES}) and written to the activity log. Nothing runs on a timer.
 * @module
 */
import { countHandlers, created, defineRoute, noContent, ok, paginate, problem } from '@ss/app-kit';
import { createId } from '@ss/contracts';
import {
	CODES,
	MAX_RULES,
	ancestorsOf,
	changeActivity,
	createIndex,
	csvOf,
	importActivity,
	locationOf,
	newProblems,
	planImport,
	problemMessage,
	requestOf,
	ruleActivity,
	ruleOfBody,
	sameRule,
	suggestionsOf,
} from '../core/redirects.js';
import { shiftDay } from '../core/analytics.js';
import { dayOf } from '../core/events.js';
import { createRedirectStore } from '../adapters/redirects.js';
import { createStore } from '../adapters/store.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('../core/redirects.js').Rule} Rule */
/** @typedef {import('../core/redirects.js').RuleInput} RuleInput */
/** @typedef {import('../core/redirects.js').SetProblem} SetProblem */
/** @typedef {import('../core/redirects.js').FieldProblem} FieldProblem */
/** @typedef {import('../core/redirects.js').ImportPlan} ImportPlan */
/** @typedef {(ctx: any, entry: { action: string, target: string, label: string, detail: string }) => Promise<unknown>} Log */

/** Rate limit of the per-address read (code constant protecting our hosting). */
const MATCH_LIMITS = [{ limit: 3000, windowSeconds: 60, per: /** @type {const} */ ('website') }];
/** Rate limit of the whole list: a site caches it for 5 minutes (code constant protecting our hosting). */
const ALL_LIMITS = [{ limit: 60, windowSeconds: 60, per: /** @type {const} */ ('website') }];
/** How long a site may keep the whole list before it asks again (with `If-None-Match`). */
const ALL_CACHE = 'private, max-age=300';
/** The whole lists one instance keeps in memory (each with its version): at most this many websites and rules. */
const KEPT = Object.freeze({ websites: 200, rules: 20_000 });
/** The largest CSV import body (5,000 rules of long paths), with room for the JSON around it. */
const IMPORT_BYTES = 4 * 1024 * 1024 + 64 * 1024;
/** Suggestions read the 404 log of this many days by default (at most a year). */
const SUGGESTION_DAYS = 90;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A 422 `validation_failed` with each field's problem (the first one's words as the detail).
 * @param {ReadonlyArray<{ path: string, code: string, message: string }>} errors
 */
const refused = (errors) =>
	problem('validation_failed', errors[0]?.message ?? 'The rule is not valid.', {
		errors: errors.map(({ path, code, message }) => ({ path, code, message })),
	});

/** @param {string} field @param {string} message */
const invalid = (field, message) => refused([{ path: `/${field}`, code: 'invalid', message }]);

/** @param {string} from */
const taken = (from) => problem('redirect_taken', `Another rule redirects ${from}.`, { extensions: { from } });

const full = () =>
	problem('redirects_full', `A website has at most ${MAX_RULES} rules: delete some first.`, { extensions: { max: MAX_RULES } });

/**
 * A change refused, with its problem.
 * @param {ReturnType<typeof problem>} refusal
 */
const no = (refusal) => ({ ok: /** @type {const} */ (false), problem: refusal });

/** @param {SetProblem} found */
const setProblem = (found) =>
	problem(found.kind === 'loop' ? 'redirect_loop' : 'redirect_chain', problemMessage(found), {
		extensions: { steps: found.steps, gone: found.gone },
	});

/**
 * A rule as the API answers it.
 * @param {Rule} rule
 */
const viewOf = (rule) => ({
	id: rule.id,
	from: rule.from,
	match: rule.match,
	to: rule.to,
	code: rule.code,
	note: rule.note,
	createdAt: new Date(rule.createdAt ?? 0).toISOString(),
	updatedAt: new Date(rule.updatedAt ?? 0).toISOString(),
});

/**
 * Whether an `If-None-Match` header names an ETag (`*`, or one of a list; weak tags compare as strong).
 * @param {string | null} header
 * @param {string} etag
 */
const namesEtag = (header, etag) =>
	header !== null &&
	header
		.split(',')
		.map((tag) => tag.trim().replace(/^W\//, ''))
		.some((tag) => tag === '*' || tag === etag);

/** @typedef {{ version: string, body: { version: string, count: number, rules: unknown[] } }} KeptList */

/**
 * Keep a website's whole list in an instance's memory as the newest, then let the oldest go while more websites or
 * rules are kept than `limits` allow (never the list just kept).
 * @param {Map<string, KeptList>} lists
 * @param {string} websiteId
 * @param {KeptList} list
 * @param {{ websites: number, rules: number }} limits
 */
export const keepList = (lists, websiteId, list, limits) => {
	lists.delete(websiteId);
	lists.set(websiteId, list);
	let rules = 0;
	for (const kept of lists.values()) rules += kept.body.count;
	for (const [key, kept] of lists) {
		if (key === websiteId || (lists.size <= limits.websites && rules <= limits.rules)) break;
		lists.delete(key);
		rules -= kept.body.count;
	}
};

/**
 * @param {Product} product
 * @param {{ log: Log }} options `log`: writes an activity-log entry (by the ticket's staff member, the acting user, or
 *   `Server`)
 */
export const redirectRoutes = (product, { log }) => {
	const { now } = product;
	/** @type {Map<string, KeptList>} the whole lists this instance served last, by website */
	const lists = new Map();

	/** @param {any} ctx */
	const storeOf = async (ctx) => createRedirectStore(await ctx.data(), { merchantId: String(ctx.merchantId) });
	/** @param {any} ctx */
	const domainOf = (ctx) => String(ctx.status.domain);

	/**
	 * The list's filter: `q`, text in `from`, `to` or the note; `code`, one answer (another value filters nothing).
	 * @param {any} ctx
	 */
	const listQuery = (ctx) => {
		const q = typeof ctx.query.q === 'string' ? ctx.query.q.trim().slice(0, 100) : '';
		const code = CODES.find((value) => String(value) === ctx.query.code);
		return { ...(q === '' ? {} : { q }), ...(code === undefined ? {} : { code }) };
	};

	/**
	 * A page of rules, newest first (`?q=&code=&cursor=&limit=`).
	 * @param {any} ctx
	 */
	const list = async (ctx) => {
		const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url }, { defaultLimit: 50 });
		const rows = await (await storeOf(ctx)).page({ after: page.after, limit: page.fetchLimit, ...listQuery(ctx) });
		return page.respond(rows.map(viewOf), (rule) => [rule.createdAt, rule.id]);
	};

	/** `GET …/redirects/count` and `/counts?by=code|match`: the list's own filter (PLAN 0.8.10 K4). */
	const counts = countHandlers({
		source: async (ctx) => (await storeOf(ctx)).countSource(listQuery(ctx)),
		by: { code: 'code', match: 'match' },
	});

	/**
	 * Create a rule.
	 * @param {any} ctx
	 */
	const create = async (ctx) => {
		const checked = ruleOfBody(ctx.body, domainOf(ctx));
		if (!checked.ok) return refused(checked.errors);
		const at = new Date(now());
		/** @type {Rule} */
		const rule = { id: createId('rdr'), ...checked.rule, createdAt: at, updatedAt: at };
		const outcome = await (
			await storeOf(ctx)
		).change((current) => {
			if (current.some((other) => other.from === rule.from)) return no(taken(rule.from));
			if (current.length >= MAX_RULES) return no(full());
			const [found] = newProblems(current, [...current, rule]);
			if (found) return no(setProblem(found));
			return { ok: /** @type {const} */ (true), writes: { create: [rule] } };
		});
		if (!outcome.ok) return outcome.problem;
		await log(ctx, { action: 'redirect.created', target: rule.id, ...ruleActivity(rule) });
		return created(viewOf(rule));
	};

	/**
	 * Change a rule: the members sent are merged into it and the whole is checked as on create.
	 * @param {any} ctx
	 */
	const update = async (ctx) => {
		const domain = domainOf(ctx);
		const at = new Date(now());
		const outcome = await (
			await storeOf(ctx)
		).change((current) => {
			const stored = current.find((rule) => rule.id === ctx.params.id);
			if (!stored) return no(problem('not_found', 'No rule has this id.'));
			const checked = ruleOfBody(ctx.body, domain, stored);
			if (!checked.ok) return no(refused(checked.errors));
			/** @type {Rule} */
			const rule = { ...stored, ...checked.rule, updatedAt: at };
			if (sameRule(stored, rule)) return { ok: /** @type {const} */ (true), rule: stored, before: null };
			if (current.some((other) => other.id !== rule.id && other.from === rule.from)) return no(taken(rule.from));
			const [found] = newProblems(
				current,
				current.map((other) => (other.id === rule.id ? rule : other)),
			);
			if (found) return no(setProblem(found));
			return { ok: /** @type {const} */ (true), rule, before: stored, writes: { update: [rule] } };
		});
		if (!outcome.ok) return outcome.problem;
		if (outcome.before)
			await log(ctx, { action: 'redirect.updated', target: outcome.rule.id, ...changeActivity(outcome.before, outcome.rule) });
		return viewOf(outcome.rule);
	};

	/**
	 * Delete a rule (refused when the rules left would hold a chain: a path the rule answered would then pass two rules).
	 * @param {any} ctx
	 */
	const remove = async (ctx) => {
		const outcome = await (
			await storeOf(ctx)
		).change((current) => {
			const stored = current.find((rule) => rule.id === ctx.params.id);
			if (!stored) return no(problem('not_found', 'No rule has this id.'));
			const [found] = newProblems(
				current,
				current.filter((rule) => rule.id !== stored.id),
			);
			if (found) return no(setProblem(found));
			return { ok: /** @type {const} */ (true), rule: stored, writes: { remove: [stored.id] } };
		});
		if (!outcome.ok) return outcome.problem;
		await log(ctx, { action: 'redirect.deleted', target: outcome.rule.id, ...ruleActivity(outcome.rule) });
		return noContent();
	};

	/**
	 * Every rule for edge middleware, A to Z by `from`: `{ version, count, rules: [{ from, match, to, code }] }` with
	 * `ETag` and `Cache-Control`; 304 when `If-None-Match` names the version. An instance keeps the list of the
	 * websites it served last, by version, so a changed version costs one read of the rules.
	 * @param {any} ctx
	 */
	const all = async (ctx) => {
		const store = await storeOf(ctx);
		const version = (await store.version()) ?? 'none';
		const headers = { etag: `"${version}"`, 'cache-control': ALL_CACHE };
		if (namesEtag(ctx.headers.get('if-none-match'), headers.etag)) return new Response(null, { status: 304, headers });
		const websiteId = String(ctx.websiteId);
		let kept = lists.get(websiteId);
		if (kept?.version !== version) {
			const rules = await store.all();
			kept = {
				version,
				body: { version, count: rules.length, rules: rules.map(({ from, match, to, code }) => ({ from, match, to, code })) },
			};
			keepList(lists, websiteId, kept, KEPT);
		}
		return ok(kept.body, { headers });
	};

	/**
	 * The rule of one address (`?path=/old/page?utm_source=x`) with where to send the visitor (`location`: the rest of
	 * a prefix rule's path and the query string added; null for 410), or 204 when no rule answers it.
	 * @param {any} ctx
	 */
	const match = async (ctx) => {
		const asked = requestOf(ctx.query.path);
		if (asked === null) return invalid('path', 'path is the address asked about: a path from /, with its query string if any.');
		if (asked.path === null) return noContent();
		const path = asked.path;
		const rule = createIndex(await (await storeOf(ctx)).candidates(ancestorsOf(path))).match(path);
		if (rule === null) return noContent();
		return { from: rule.from, match: rule.match, to: rule.to, code: rule.code, location: locationOf(rule, path, asked.query) };
	};

	/**
	 * Rules to add, from the 404 log (`?days=` 1–365, 90 by default; `limit` 1–100, 20 by default): the most-hit
	 * missing paths of those days that no rule answers, each with a target when an open page has the same last segment.
	 * `recording` says whether Searches and 404s records 404s now.
	 * @param {any} ctx
	 */
	const suggestions = async (ctx) => {
		/** @param {unknown} value @param {number} fallback */
		const whole = (value, fallback) =>
			value === undefined || value === '' ? fallback : /^\d{1,3}$/.test(String(value)) ? Number(value) : Number.NaN;
		const days = whole(ctx.query.days, SUGGESTION_DAYS);
		if (!(days >= 1 && days <= 365)) return invalid('days', 'days is a whole number of days, 1 to 365.');
		const limit = whole(ctx.query.limit, 20);
		if (!(limit >= 1 && limit <= 100)) return invalid('limit', 'limit is 1 to 100.');
		const [business, on, data] = await Promise.all([
			product.business(ctx.websiteId),
			product.featuresOn(ctx.websiteId),
			ctx.data(),
		]);
		const to = dayOf(now(), business.timeZone ?? 'UTC');
		const from = shiftDay(to, 1 - days);
		const merchantId = String(ctx.merchantId);
		const [totals, rules] = await Promise.all([
			createStore(data, { merchantId }).metricTotals(from, to, ['not_found', 'page']),
			createRedirectStore(data, { merchantId }).all(),
		]);
		return { from, to, recording: on.includes('searches_404s'), items: suggestionsOf({ totals, rules, limit }) };
	};

	/**
	 * The rules as a CSV file (`redirects.csv`, A to Z by `from`).
	 * @param {any} ctx
	 */
	const exportCsv = async (ctx) =>
		new Response(csvOf(await (await storeOf(ctx)).all()), {
			headers: {
				'content-type': 'text/csv; charset=utf-8',
				'content-disposition': 'attachment; filename="redirects.csv"',
			},
		});

	/**
	 * Import rules from a CSV file `{ csv, dryRun }`: a dry run (the default) writes nothing and lists what would change
	 * and every problem; a real import with problems answers 422 and imports nothing.
	 * @param {any} ctx
	 */
	const importCsv = async (ctx) => {
		const body = ctx.body;
		if (!isObject(body) || typeof body.csv !== 'string' || body.csv.trim() === '')
			return invalid('csv', 'Send the text of the CSV file in csv.');
		if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') return invalid('dryRun', 'dryRun is true or false.');
		const unknown = Object.keys(body).find((name) => name !== 'csv' && name !== 'dryRun');
		if (unknown) return invalid(unknown, `${unknown} is not a member of an import.`);
		const csv = body.csv;
		const dryRun = body.dryRun !== false;
		const domain = domainOf(ctx);
		const at = new Date(now());
		const store = await storeOf(ctx);
		/** @param {Rule[]} current */
		const plan = (current) => {
			const planned = planImport({ csv, existing: current, domain });
			const writes = {
				create: planned.changes
					.filter((change) => change.action === 'create')
					.map((change) => ({ id: createId('rdr'), ...change.rule, createdAt: at, updatedAt: at })),
				update: planned.changes
					.filter((change) => change.action === 'update')
					.map((change) => ({ .../** @type {Rule} */ (change.before), ...change.rule, updatedAt: at })),
			};
			return { ok: !dryRun && planned.errors.length === 0, planned, writes };
		};
		const { planned } = dryRun ? plan(await store.all()) : await store.change(plan);
		if (!dryRun && planned.errors.length > 0)
			return problem('validation_failed', 'The file has problems, so nothing was imported: check it with a dry run.', {
				errors: planned.errors.map((error) => ({
					path: `/csv/${error.line}${error.path}`,
					code: error.code,
					message: error.message,
				})),
			});
		const created = planned.changes.filter((change) => change.action === 'create').length;
		const updated = planned.changes.length - created;
		if (!dryRun && planned.changes.length > 0)
			await log(ctx, {
				action: 'redirects.imported',
				target: 'redirects',
				...importActivity({ created, updated, unchanged: planned.unchanged }),
			});
		return {
			dryRun,
			rows: planned.rows,
			created,
			updated,
			unchanged: planned.unchanged,
			changes: planned.changes.map(({ line, action, rule, before }) => ({
				line,
				action,
				...rule,
				before: before ? { match: before.match, to: before.to, code: before.code, note: before.note } : null,
			})),
			errors: planned.errors,
		};
	};

	return [
		// ------------------------------------------------------------------------- the website's server (server token)
		defineRoute({
			method: 'GET',
			path: '/v1/redirects/match',
			auth: 'server',
			feature: 'redirects',
			rateLimit: MATCH_LIMITS,
			handler: match,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/redirects/all',
			auth: 'server',
			feature: 'redirects',
			rateLimit: ALL_LIMITS,
			handler: all,
		}),
		defineRoute({ method: 'GET', path: '/v1/redirects', auth: 'server', feature: 'redirects', handler: list }),
		defineRoute({ method: 'GET', path: '/v1/redirects/count', auth: 'server', feature: 'redirects', handler: counts.count }),
		defineRoute({
			method: 'GET',
			path: '/v1/redirects/counts',
			auth: 'server',
			feature: 'redirects',
			handler: counts.counts,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/redirects',
			auth: 'server',
			feature: 'redirects',
			idempotent: true,
			handler: create,
		}),
		defineRoute({ method: 'PATCH', path: '/v1/redirects/:id', auth: 'server', feature: 'redirects', handler: update }),
		defineRoute({ method: 'DELETE', path: '/v1/redirects/:id', auth: 'server', feature: 'redirects', handler: remove }),
		defineRoute({
			method: 'GET',
			path: '/v1/redirects/suggestions',
			auth: 'server',
			feature: 'redirects',
			handler: suggestions,
		}),
		defineRoute({ method: 'GET', path: '/v1/redirects/csv', auth: 'server', feature: 'redirects', handler: exportCsv }),
		defineRoute({
			method: 'POST',
			path: '/v1/redirects/csv',
			auth: 'server',
			feature: 'redirects',
			maxBodyBytes: IMPORT_BYTES,
			idempotent: true,
			handler: importCsv,
		}),

		// ------------------------------------------------------------------- the redirects admin widget (ticket twins)
		defineRoute({ method: 'GET', path: '/v1/admin/redirects', auth: 'ticket', permission: 'redirects.edit', handler: list }),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/redirects/count',
			auth: 'ticket',
			permission: 'redirects.edit',
			handler: counts.count,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/redirects/counts',
			auth: 'ticket',
			permission: 'redirects.edit',
			handler: counts.counts,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/redirects',
			auth: 'ticket',
			permission: 'redirects.edit',
			idempotent: true,
			handler: create,
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/admin/redirects/:id',
			auth: 'ticket',
			permission: 'redirects.edit',
			handler: update,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/admin/redirects/:id',
			auth: 'ticket',
			permission: 'redirects.edit',
			handler: remove,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/redirects/suggestions',
			auth: 'ticket',
			permission: 'redirects.edit',
			handler: suggestions,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/redirects/csv',
			auth: 'ticket',
			permission: 'redirects.edit',
			handler: exportCsv,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/redirects/csv',
			auth: 'ticket',
			permission: 'redirects.edit',
			maxBodyBytes: IMPORT_BYTES,
			idempotent: true,
			handler: importCsv,
		}),
	];
};
