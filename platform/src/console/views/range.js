'use client';
/**
 * The Period dropdown of the pages filtered by UTC days (Credits and billing, Activity, Usage and credits): picking a
 * period opens the page with its `from` and `to`, the same query the date fields send. Dates typed by hand show as
 * Custom dates.
 * @module
 */
import { Input, Select } from '@ss/ui';
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

/**
 * The Period menu of a {@link Toolbar} (a filter with the same choices as {@link RangeSelect}): picking a period opens
 * the page with its `from` and `to`.
 * @param {{ from?: string | null, to?: string | null, hrefFor: (range: { from: string | null, to: string | null }) => string,
 *   emptyLabel: string, omit?: Preset, go: (href: string) => void }} input `go`: the console's client-side navigation
 * @returns {import('@ss/ui').ToolbarFilter}
 */
export const periodFilter = ({ from = null, to = null, hrefFor, emptyLabel, omit, go }) => {
	const presets = rangePresets().filter((p) => p.value !== omit);
	const current = presetOf(from, to);
	const value = current === omit ? '' : current;
	return {
		id: 'period',
		label: MORE.range.label,
		allLabel: emptyLabel,
		value,
		options: [
			...presets.map((p) => ({ value: p.value, label: MORE.range[p.value] })),
			...(value === 'custom' ? [{ value: 'custom', label: MORE.range.custom }] : []),
		],
		onChange: (picked) => {
			if (picked === 'custom') return;
			const preset = presets.find((p) => p.value === picked);
			go(hrefFor(preset ? { from: preset.from, to: preset.to } : { from: null, to: null }));
		},
	};
};

/** The look of a date field in the toolbar: as high as the search box beside it. */
const DATE_FIELD =
	'ss-motion h-8 rounded-control border border-line bg-surface px-2 text-label text-fg focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-focus';

/**
 * The two date fields (From and To, UTC days) of a toolbar: a pick opens the page with that day.
 * @param {{ from?: string | null, to?: string | null, hrefFor: (range: { from: string | null, to: string | null }) => string,
 *   fromLabel: string, toLabel: string, go: (href: string) => void }} props
 */
export function DateFields({ from = null, to = null, hrefFor, fromLabel, toLabel, go }) {
	return (
		<div className="hidden items-center gap-2 md:flex">
			<Input
				type="date"
				label={fromLabel}
				aria-label={fromLabel}
				hideLabel
				value={from ?? ''}
				fieldClassName="w-36"
				className={DATE_FIELD}
				onChange={(e) => go(hrefFor({ from: e.currentTarget.value || null, to }))}
			/>
			<Input
				type="date"
				label={toLabel}
				aria-label={toLabel}
				hideLabel
				value={to ?? ''}
				fieldClassName="w-36"
				className={DATE_FIELD}
				onChange={(e) => go(hrefFor({ from, to: e.currentTarget.value || null }))}
			/>
		</div>
	);
}
