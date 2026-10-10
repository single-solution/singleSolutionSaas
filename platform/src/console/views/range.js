'use client';
/**
 * The Period dropdown of the pages filtered by UTC days (Credits and billing, Activity, Usage and credits): picking a
 * period opens the page with its `from` and `to`, the same query the date fields send. Dates typed by hand show as
 * Custom dates.
 * @module
 */
import { Select } from '@ss/ui';
import { MORE } from '../../texts/console.js';
import { useNavigation } from '../navigation.js';

const DAY_MS = 86_400_000;

/** @param {number} ms */
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** @typedef {'last7' | 'last30' | 'last90' | 'thisMonth' | 'lastMonth'} Preset */

/**
 * The periods as UTC days, today included.
 * @param {number} [now]
 * @returns {Array<{ value: Preset, from: string, to: string }>}
 */
export const rangePresets = (now = Date.now()) => {
	const today = dayOf(now);
	const date = new Date(now);
	const lastMonthEnd = dayOf(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 0));
	return [
		{ value: 'last7', from: dayOf(now - 6 * DAY_MS), to: today },
		{ value: 'last30', from: dayOf(now - 29 * DAY_MS), to: today },
		{ value: 'last90', from: dayOf(now - 89 * DAY_MS), to: today },
		{ value: 'thisMonth', from: `${today.slice(0, 7)}-01`, to: today },
		{ value: 'lastMonth', from: `${lastMonthEnd.slice(0, 7)}-01`, to: lastMonthEnd },
	];
};

/**
 * The preset a range matches: `''` with no dates, `custom` for other dates.
 * @param {string | null | undefined} from
 * @param {string | null | undefined} to
 * @param {number} [now]
 */
export const presetOf = (from, to, now = Date.now()) => {
	if (!from && !to) return '';
	return rangePresets(now).find((p) => p.from === from && p.to === to)?.value ?? 'custom';
};

/**
 * @param {{ from?: string | null, to?: string | null, hrefFor: (range: { from: string | null, to: string | null }) => string,
 *   emptyLabel: string, omit?: Preset, fieldClassName?: string }} props `emptyLabel`: what no dates means on this page
 *   (its default period); `omit`: the preset that equals it
 */
export function RangeSelect({ from = null, to = null, hrefFor, emptyLabel, omit, fieldClassName = 'min-w-44' }) {
	const nav = useNavigation();
	const presets = rangePresets().filter((p) => p.value !== omit);
	const current = presetOf(from, to);
	const value = current === omit ? '' : current;
	return (
		<Select
			label={MORE.range.label}
			value={value}
			disabled={nav.pending}
			fieldClassName={fieldClassName}
			onChange={(e) => {
				const picked = presets.find((p) => p.value === e.currentTarget.value);
				nav.go(hrefFor(picked ? { from: picked.from, to: picked.to } : { from: null, to: null }));
			}}
			options={[
				{ value: '', label: emptyLabel },
				...presets.map((p) => ({ value: p.value, label: MORE.range[p.value] })),
				...(value === 'custom' ? [{ value: 'custom', label: MORE.range.custom }] : []),
			]}
		/>
	);
}
