/**
 * The `import` feature (PLAN 0.8.10 K10, Migration): what the kit's import routes take into Ecommerce, with the
 * product's own checks in import mode (given ids, past times, history and given numbers allowed; nothing sent, no
 * events or alerts, no stock held), `finish`, which recomputes what the shop derives (categories' paths; products'
 * price, stock state, sold and rating; customers' order and RTO counts; loyalty balances; serial statuses; order
 * counters) in pages of at most {@link FINISH_PAGE} records (`more` and `next`: call again with `?after=<next>`), and
 * the sums `ss-import verify` compares. The catalog's part is `imports-catalog.js`; the shoppers' and orders'
 * `imports-orders.js` (its steps run after the catalog's).
 * @module
 */
import { problem } from '@ss/app-kit';
import { catalogImports } from './imports-catalog.js';
import { orderImports } from './imports-orders.js';

/**
 * What the import checks read of the website (built in `product.js` on the kit's product). The business.json copy
 * (its `country` gives national phone numbers their calling code, K12) comes with each call's check context
 * (`ctx.business()`, read once per call).
 * @typedef {object} ImportDeps
 * @property {(websiteId: string, name: string) => Promise<unknown>} list a list setting (`order_flow`, `grades` …)
 * @property {(websiteId: string, feature: string) => Promise<Record<string, unknown>>} settings a feature's settings
 * @property {(websiteId: string) => Promise<string[]>} featuresOn the switched-on features
 * @property {() => number} now
 */
/**
 * What one page of a finish step did: the records it read (fewer than its `limit`: the step is done), the key of the
 * last one, and its numbers (added up over the page) and notes.
 * @typedef {object} FinishPage
 * @property {number} read
 * @property {string | null} last
 * @property {Record<string, unknown>} counts
 */
/**
 * One step of `finish`: it works on at most `limit` records after the key `after` (null: from its start), in the order
 * of its key, writing only what changed.
 * @typedef {object} FinishStep
 * @property {string} name the step in `next` (`<name>:<key of the last record done>`)
 * @property {RegExp} key what a key of the step looks like
 * @property {Record<string, number>} zero its numbers before any work (every answer carries them)
 * @property {(ctx: any, page: { after: string | null, limit: number }) => Promise<FinishPage>} run
 */
/**
 * One part of the import: its collections, its steps of `finish` and its verification sums.
 * @typedef {object} ImportPart
 * @property {Record<string, import('@ss/app-kit').ImportCollection>} collections
 * @property {FinishStep[]} steps
 * @property {(ctx: any) => Promise<Record<string, number>>} totals
 */

/**
 * Records one `finish` call works on at most, over all its steps, so a call of a large store stays short (each record
 * read may cost a write).
 */
export const FINISH_PAGE = 200;
/** `?after=`: a step's name and the key of the last record it did. */
// eslint-disable-next-line no-control-regex
const AFTER = /^([a-z]+):([^\u0000-\u001f]{0,200})$/;

/**
 * The step and key a finish call starts at (`?after=<next of the previous call>`; none: the first step).
 * @param {unknown} after
 * @param {FinishStep[]} steps
 */
const startOf = (after, steps) => {
	if (after === undefined || after === '') return { index: 0, key: null };
	const match = AFTER.exec(String(after));
	const index = match ? steps.findIndex((step) => step.name === match[1]) : -1;
	const key = match?.[2] || null;
	const step = steps[index];
	if (!step || (key !== null && !step.key.test(key)))
		throw problem('validation_failed', 'after is the next value of the previous finish.', {
			errors: [{ path: '/after', message: 'is the next value of the previous finish' }],
		});
	return { index, key };
};

/**
 * `POST /v1/import/finish?after=<next>`: the steps of every part in order, at most {@link FINISH_PAGE} records a call.
 * The answer carries every step's numbers (0 for the steps it did not reach), `more` while steps are left and `next`
 * to pass as `after`; the importer adds the numbers of every call up.
 * @param {FinishStep[]} steps
 * @param {any} ctx
 */
const finishPage = async (steps, ctx) => {
	let { index, key } = startOf(ctx.query?.after, steps);
	/** @type {Record<string, unknown>} */
	const summary = Object.assign({}, ...steps.map((step) => step.zero));
	let budget = FINISH_PAGE;
	for (let step = steps[index]; step && budget > 0; step = steps[index]) {
		const limit = budget;
		const page = await step.run(ctx, { after: key, limit });
		for (const [name, value] of Object.entries(page.counts))
			summary[name] = typeof value === 'number' ? Number(summary[name] ?? 0) + value : value;
		budget -= page.read;
		if (page.read < limit) {
			index += 1;
			key = null;
		} else key = page.last;
	}
	const left = steps[index];
	return { ...summary, next: left ? `${left.name}:${key ?? ''}` : null, more: left !== undefined };
};

/**
 * The kit's `imports` option.
 * @param {ImportDeps} deps
 * @returns {import('@ss/app-kit').ImportOptions}
 */
export const createImportOptions = (deps) => {
	const parts = [catalogImports(deps), orderImports(deps)];
	const steps = parts.flatMap((part) => part.steps);
	return {
		collections: Object.assign({}, ...parts.map((part) => part.collections)),
		finish: (ctx) => finishPage(steps, ctx),
		totals: async (ctx) => {
			/** @type {Record<string, number>} */
			const sums = {};
			for (const part of parts) Object.assign(sums, await part.totals(ctx));
			return sums;
		},
	};
};
