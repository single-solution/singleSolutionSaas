/**
 * Loader element-stub view models (pure): text only, within the stub's limits (title ≤ 200, body ≤ 2000, items ≤ 50),
 * for websites that run an element without this product's UI bundle (PLAN F.13 / F.16).
 * @module
 */
import { readableValue } from './mapping.js';

const LIMITS = Object.freeze({ title: 200, body: 2000, item: 500, items: 50 });

/**
 * @param {string} title
 * @param {string} body
 * @param {string[]} lines
 */
export const stubView = (title, body, lines) => ({
	title: title.slice(0, LIMITS.title),
	body: body.slice(0, LIMITS.body),
	items: lines.slice(0, LIMITS.items).map((text) => ({ text: text.slice(0, LIMITS.item) })),
});

/**
 * @param {Array<{ label: string, description: string }>} tiers
 * @param {import('./text.js').Translate} t
 */
export const tiersStub = (tiers, t) =>
	stubView(
		t('tiers.title'),
		tiers.length === 0 ? t('tiers.empty') : '',
		tiers.map((tier) => (tier.description ? `${tier.label} — ${tier.description}` : tier.label)),
	);

/**
 * @param {Array<{ headline: string, body: string, warranty: { periodText: string } | null }>} entries
 * @param {import('./text.js').Translate} t
 */
export const showcaseStub = (entries, t) =>
	stubView(
		t('showcase.title'),
		'',
		entries.map((entry) =>
			[entry.headline, entry.body, entry.warranty ? t('showcase.warranty', { period: entry.warranty.periodText }) : '']
				.filter(Boolean)
				.join(' · '),
		),
	);

/**
 * @param {Array<{ label: string, count: number | null }>} options
 * @param {import('./text.js').Translate} t
 */
export const filtersStub = (options, t) =>
	stubView(
		t('filters.title'),
		options.length === 0 ? t('filters.empty') : '',
		options.map((option) =>
			option.count === null ? option.label : t('filters.option', { label: option.label, count: option.count }),
		),
	);

/**
 * @param {Array<{ label: string, periodText: string, text: string }>} terms
 * @param {import('./text.js').Translate} t
 */
export const warrantyStub = (terms, t) =>
	stubView(
		t('warranty.title'),
		'',
		terms.map((term) => `${term.label}: ${term.periodText} — ${term.text}`),
	);

/**
 * @param {{ tier: { label: string } | null, values: Array<{ name: string, value: string | null }> } | null} condition
 * @param {import('./text.js').Translate} t
 */
export const mappingStub = (condition, t) =>
	stubView(
		t('mapping.title'),
		condition?.tier ? t('mapping.tier', { tier: condition.tier.label }) : t('mapping.none'),
		(condition?.values ?? [])
			.filter((row) => row.value !== null)
			.map((row) => `${row.name}: ${readableValue(/** @type {string} */ (row.value))}`),
	);

/**
 * @param {ReturnType<typeof import('./inspection.js').reportView> | null} report
 * @param {import('./text.js').Translate} t
 */
export const inspectionStub = (report, t) =>
	report === null
		? stubView(t('inspection.title'), t('inspection.missing'), [])
		: stubView(
				report.tier ? t('inspection.title_tier', { tier: report.tier.label }) : t('inspection.title'),
				report.score === null ? '' : t('inspection.score', { score: report.score }),
				report.results.map((result) => `${result.label}: ${answerText(result, t)}`),
			);

/**
 * A checklist answer in words.
 * @param {{ kind: string, value: unknown, max: number | null }} result
 * @param {import('./text.js').Translate} t
 */
export const answerText = (result, t) =>
	result.kind === 'pass_fail'
		? t(result.value === true ? 'inspection.pass' : 'inspection.fail')
		: result.kind === 'score'
			? t('inspection.points', { value: Number(result.value), max: result.max ?? Number(result.value) })
			: String(result.value);
