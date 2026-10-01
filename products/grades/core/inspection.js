/**
 * Unit inspection (pure): merchant checklists (pass/fail, scored and note items with weights, critical items and
 * required photos), choosing the checklist of a unit, validating results, the weighted score (0–100), the suggested
 * tier from score thresholds, completion checks and the buyer-facing report.
 * @module
 */
import { matches } from './rules.js';
import { itemContext, tierView } from './tiers.js';
import { cleanText, isKey, isObject } from './text.js';

/** Checklist item kinds. */
export const ITEM_KINDS = Object.freeze(['pass_fail', 'score', 'text']);
/** Longest text answer and note. */
export const MAX_TEXT = 2000;
export const MAX_NOTE = 500;

/**
 * @typedef {object} ChecklistItem
 * @property {string} key
 * @property {string} label
 * @property {string} help
 * @property {'pass_fail' | 'score' | 'text'} kind
 * @property {number} max highest score (1 for pass/fail)
 * @property {number} weight
 * @property {boolean} required
 * @property {boolean} critical
 * @property {number} photosRequired
 */

/**
 * @typedef {object} Checklist
 * @property {string} key
 * @property {string} name
 * @property {string[]} tiers empty = any
 * @property {string} appliesWhen
 * @property {ChecklistItem[]} items
 */

/** @typedef {{ item: string, value: boolean | number | string, note: string | null }} Result */

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 */
const intIn = (value, min, max, fallback) =>
	Number.isInteger(value) && /** @type {number} */ (value) >= min && /** @type {number} */ (value) <= max
		? /** @type {number} */ (value)
		: fallback;

/**
 * Checklists from the feature value (well-formed entries; unknown tiers dropped from `tiers`).
 * @param {unknown} list `inspection.checklists`
 * @param {ReadonlyMap<string, import('./tiers.js').Tier>} index
 * @returns {Checklist[]}
 */
export const normaliseChecklists = (list, index) => {
	const seen = new Set();
	/** @type {Checklist[]} */
	const out = [];
	for (const entry of Array.isArray(list) ? list : []) {
		if (!isObject(entry) || !isKey(entry.key) || seen.has(entry.key)) continue;
		const keys = new Set();
		/** @type {ChecklistItem[]} */
		const items = [];
		for (const raw of Array.isArray(entry.items) ? entry.items : []) {
			const label = isObject(raw) ? cleanText(raw.label, 120) : null;
			if (!isObject(raw) || !isKey(raw.key) || keys.has(raw.key) || !label || !ITEM_KINDS.includes(raw.kind)) continue;
			keys.add(raw.key);
			const kind = /** @type {ChecklistItem['kind']} */ (raw.kind);
			items.push({
				key: raw.key,
				label,
				help: cleanText(raw.help, 500) ?? '',
				kind,
				max: kind === 'score' ? intIn(raw.max, 1, 10, 5) : 1,
				weight: kind === 'text' ? 0 : intIn(raw.weight, 0, 100, 1),
				required: raw.required === true,
				critical: kind !== 'text' && raw.critical === true,
				photosRequired: intIn(raw.photos_required, 0, 10, 0),
			});
		}
		if (items.length === 0) continue;
		seen.add(entry.key);
		out.push({
			key: entry.key,
			name: cleanText(entry.name, 80) ?? entry.key,
			tiers: (Array.isArray(entry.tiers) ? entry.tiers : []).filter((key) => typeof key === 'string' && index.has(key)),
			appliesWhen: typeof entry.applies_when === 'string' ? entry.applies_when : '',
			items,
		});
	}
	return out;
};

/**
 * The checklist for a unit: the named one, else the first whose tiers include the unit's tier (or any) and whose
 * condition matches the item and unit.
 * @param {Checklist[]} checklists
 * @param {{ key?: string | null, unit: Record<string, any>, item: Record<string, any> | null, now: number, timeZone: string }} input
 * @returns {Checklist | null}
 */
export const pickChecklist = (checklists, { key = null, unit, item, now, timeZone }) => {
	if (key) return checklists.find((checklist) => checklist.key === key) ?? null;
	const context = {
		...itemContext(item ?? { itemId: unit.itemId }),
		unit: { itemId: unit.itemId, variantId: unit.variantId ?? null, serial: unit.serial ?? null, tier: unit.tier ?? null },
	};
	return (
		checklists.find(
			(checklist) =>
				(checklist.tiers.length === 0 || checklist.tiers.includes(unit.tier)) &&
				matches(checklist.appliesWhen, context, { now, timeZone }),
		) ?? null
	);
};

/**
 * Validate submitted results against a checklist.
 * @param {Checklist} checklist
 * @param {unknown} input `results` of the request body
 * @returns {{ problems: Array<{ path: string, code: string }>, results: Result[] }}
 */
export const validateResults = (checklist, input) => {
	/** @type {Array<{ path: string, code: string }>} */
	const problems = [];
	/** @type {Result[]} */
	const results = [];
	if (!Array.isArray(input) || input.length > 50) return { problems: [{ path: '/results', code: 'results_invalid' }], results };
	const byKey = new Map(checklist.items.map((item) => [item.key, item]));
	const seen = new Set();
	for (const [index, row] of input.entries()) {
		const path = `/results/${index}`;
		const definition = isObject(row) && typeof row.item === 'string' ? byKey.get(row.item) : undefined;
		if (!isObject(row) || !definition) {
			problems.push({ path: `${path}/item`, code: 'item_unknown' });
			continue;
		}
		if (seen.has(definition.key)) {
			problems.push({ path: `${path}/item`, code: 'item_duplicate' });
			continue;
		}
		seen.add(definition.key);
		const note = row.note === undefined || row.note === null ? null : cleanText(row.note, MAX_NOTE);
		if (row.note !== undefined && row.note !== null && (typeof row.note !== 'string' || row.note.length > MAX_NOTE)) {
			problems.push({ path: `${path}/note`, code: 'note_invalid' });
			continue;
		}
		const { value } = row;
		const valid =
			definition.kind === 'pass_fail'
				? typeof value === 'boolean'
				: definition.kind === 'score'
					? Number.isInteger(value) && value >= 0 && value <= definition.max
					: typeof value === 'string' && value.length <= MAX_TEXT && cleanText(value, MAX_TEXT) !== null;
		if (!valid) {
			problems.push({ path: `${path}/value`, code: 'value_invalid' });
			continue;
		}
		results.push({
			item: definition.key,
			value: definition.kind === 'text' ? /** @type {string} */ (cleanText(value, MAX_TEXT)) : value,
			note,
		});
	}
	return { problems, results };
};

/**
 * Earlier results overlaid with new ones (by item).
 * @param {Result[]} existing
 * @param {Result[]} incoming
 * @param {Checklist} checklist
 * @returns {Result[]}
 */
export const mergeResults = (existing, incoming, checklist) => {
	const map = new Map(existing.map((result) => [result.item, result]));
	for (const result of incoming) map.set(result.item, result);
	return checklist.items.flatMap((item) => {
		const result = map.get(item.key);
		return result ? [result] : [];
	});
};

/**
 * Share of one scored answer (0..1).
 * @param {ChecklistItem} item
 * @param {Result['value']} value
 */
const ratio = (item, value) => (item.kind === 'pass_fail' ? (value === true ? 1 : 0) : Number(value) / item.max);

/**
 * Weighted score (0–100, rounded) over the answered scored items; null when none is answered.
 * @param {Checklist} checklist
 * @param {Result[]} results
 * @returns {number | null}
 */
export const scoreOf = (checklist, results) => {
	const byKey = new Map(results.map((result) => [result.item, result]));
	let weights = 0;
	let total = 0;
	for (const item of checklist.items) {
		const result = byKey.get(item.key);
		if (item.kind === 'text' || item.weight === 0 || !result) continue;
		weights += item.weight;
		total += item.weight * ratio(item, result.value);
	}
	return weights === 0 ? null : Math.round((total / weights) * 100);
};

/**
 * A critical item failed: pass/fail answered "fail", or a score of 0.
 * @param {Checklist} checklist
 * @param {Result[]} results
 */
export const criticalFailed = (checklist, results) => {
	const byKey = new Map(results.map((result) => [result.item, result]));
	return checklist.items.some((item) => {
		const result = byKey.get(item.key);
		return item.critical && result !== undefined && (result.value === false || result.value === 0);
	});
};

/**
 * The suggested tier: after a critical fail the configured tier (else the lowest threshold's), otherwise the best
 * tier whose minimum score is reached.
 * @param {{ score: number | null, critical: boolean, thresholds: unknown, index: ReadonlyMap<string, import('./tiers.js').Tier>,
 *   criticalFailTier: string }} input
 * @returns {string | null}
 */
export const suggestTier = ({ score, critical, thresholds, index, criticalFailTier }) => {
	const valid = (Array.isArray(thresholds) ? thresholds : [])
		.filter(
			(row) => isObject(row) && typeof row.tier === 'string' && index.get(row.tier)?.active && Number.isInteger(row.min_score),
		)
		.map((row) => ({ tier: /** @type {string} */ (row.tier), min: /** @type {number} */ (row.min_score) }))
		.sort((a, b) => b.min - a.min || /** @type {any} */ (index.get(a.tier)).rank - /** @type {any} */ (index.get(b.tier)).rank);
	if (critical) {
		if (index.get(criticalFailTier)?.active) return criticalFailTier;
		return valid.at(-1)?.tier ?? null;
	}
	if (score === null) return null;
	return valid.find((row) => score >= row.min)?.tier ?? null;
};

/**
 * Why an inspection cannot complete: required items without an answer, and checklist items with fewer stored photos
 * than required.
 * @param {Checklist} checklist
 * @param {Result[]} results
 * @param {ReadonlyMap<string, number>} photoCounts stored photos per checklist item
 * @returns {Array<{ path: string, code: string }>}
 */
export const completionProblems = (checklist, results, photoCounts) => {
	const answered = new Set(results.map((result) => result.item));
	return checklist.items.flatMap((item) => [
		...(item.required && !answered.has(item.key) ? [{ path: `/results/${item.key}`, code: 'required' }] : []),
		...((photoCounts.get(item.key) ?? 0) < item.photosRequired
			? [{ path: `/photos/${item.key}`, code: 'photos_missing' }]
			: []),
	]);
};

/**
 * The checklist definition for inspectors and APIs.
 * @param {Checklist} checklist
 */
export const checklistView = (checklist) => ({
	key: checklist.key,
	name: checklist.name,
	tiers: checklist.tiers,
	items: checklist.items.map((item) => ({
		key: item.key,
		label: item.label,
		help: item.help,
		kind: item.kind,
		max: item.max,
		weight: item.weight,
		required: item.required,
		critical: item.critical,
		photosRequired: item.photosRequired,
	})),
});

/**
 * The buyer-facing report of a unit's completed inspection: tier (label, colour), score, the checklist answers with
 * their labels and photos. Internal ids, notes marked private and (unless allowed) the inspector stay out.
 * @param {{ unit: Record<string, any>, inspection: Record<string, any>, checklist: Checklist | null,
 *   index: ReadonlyMap<string, import('./tiers.js').Tier>, badgeStyle: string,
 *   photos: Array<{ item: string, url: string | null, contentType: string }>, showInspector: boolean }} input
 */
export const reportView = ({ unit, inspection, checklist, index, badgeStyle, photos, showInspector }) => {
	const tier = unit.tier ? index.get(unit.tier) : undefined;
	const definitions = new Map((checklist?.items ?? []).map((item) => [item.key, item]));
	return {
		itemId: unit.itemId,
		variantId: unit.variantId ?? null,
		serial: unit.serial ?? null,
		tier: tier ? tierView(tier, badgeStyle) : null,
		score: inspection.score ?? null,
		checklist: checklist ? { key: checklist.key, name: checklist.name } : null,
		results: (Array.isArray(inspection.results) ? inspection.results : []).map((/** @type {Result} */ result) => {
			const definition = definitions.get(result.item);
			return {
				item: result.item,
				label: definition?.label ?? result.item,
				kind: definition?.kind ?? (typeof result.value === 'boolean' ? 'pass_fail' : typeof result.value),
				max: definition?.max ?? null,
				value: result.value,
				note: result.note ?? null,
				photos: photos
					.filter((photo) => photo.item === result.item && photo.url)
					.map(({ url, contentType }) => ({ url, contentType })),
			};
		}),
		inspectedAt: inspection.completedAt ?? null,
		inspector: showInspector ? (inspection.inspector ?? null) : null,
	};
};
