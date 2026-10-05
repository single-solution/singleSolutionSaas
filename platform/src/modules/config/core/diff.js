/**
 * Pure structural diff of two layer states (the `diff` stored on every version record).
 * @module
 */
import { jsonEqual } from '@ss/contracts';

/** @typedef {import('./state.js').LayerState} LayerState */

/**
 * @typedef {object} DiffEntry
 * @property {'elements' | 'features'} kind
 * @property {string} key
 * @property {'added' | 'removed' | 'changed'} op
 * @property {unknown} [before] the previous entry (`{ enabled|value, locked? }`)
 * @property {unknown} [after] the new entry
 */

/**
 * Entries that differ between two states, sorted by kind then key. Equal states give `[]`.
 * @param {LayerState} before
 * @param {LayerState} after
 * @returns {DiffEntry[]}
 */
export const diffStates = (before, after) => {
	/** @type {DiffEntry[]} */
	const out = [];
	for (const kind of /** @type {const} */ (['elements', 'features'])) {
		const a = /** @type {Record<string, unknown>} */ (before[kind]);
		const b = /** @type {Record<string, unknown>} */ (after[kind]);
		const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
		for (const key of keys) {
			const has = Object.hasOwn(a, key);
			const will = Object.hasOwn(b, key);
			if (has && !will) out.push({ kind, key, op: 'removed', before: a[key] });
			else if (!has && will) out.push({ kind, key, op: 'added', after: b[key] });
			else if (!jsonEqual(a[key], b[key])) out.push({ kind, key, op: 'changed', before: a[key], after: b[key] });
		}
	}
	return out;
};

/**
 * Keys whose new value must be validated (added or changed entries).
 * @param {readonly DiffEntry[]} diff
 * @returns {{ elements: string[], features: string[] }}
 */
export const touchedKeys = (diff) => ({
	elements: diff.filter((d) => d.kind === 'elements' && d.op !== 'removed').map((d) => d.key),
	features: diff.filter((d) => d.kind === 'features' && d.op !== 'removed').map((d) => d.key),
});

/**
 * Entries whose lock state is involved in a diff (locked before or after). Only staff may touch them.
 * @param {readonly DiffEntry[]} diff
 * @returns {DiffEntry[]}
 */
export const lockedTouches = (diff) => diff.filter((d) => isLocked(d.before) || isLocked(d.after));

/** @param {unknown} entry */
const isLocked = (entry) =>
	typeof entry === 'object' && entry !== null && /** @type {{ locked?: unknown }} */ (entry).locked === true;
