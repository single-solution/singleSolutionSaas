'use client';
/**
 * The setup steps of a product dashboard's Overview (owner 2026-10-17: every product shows what a shop still has to
 * set, as a checklist with a button to the exact place). A product declares a small list of **requirements** — the
 * settings and lists a switched-on feature needs a merchant to set — and `useSetupSteps` turns them into
 * {@link import('./overview.js').SetupStep}s from the real state: a step shows only while one of its features is on,
 * is ticked from the saved setting or list, and its button opens the inner-sidebar section of Settings (or another tab)
 * that holds it. The connections a feature needs are the kit's own steps (`ProductOverview`), computed from the
 * manifest's `neededBy`, so a product lists no connection here and no store value is written into the code.
 * @module
 */
import { useLoad } from './dashboard-api.js';
import { settingSectionOf } from './dashboard-settings.js';

/** @typedef {import('./dashboard-api.js').Answer} Answer */
/** @typedef {import('./overview.js').SetupStep} SetupStep */
/**
 * What a requirement's `done` and `detail` are given: the setting or list value, and the other settings of its feature
 * (by name) with the switched-on features.
 * @typedef {{ values: Record<string, unknown>, on: string[] }} SetupContext
 */
/**
 * One thing a merchant must set, in plain words.
 * - Exactly one of `setting` (`feature.name`), `list` (a list of the kit's lists API) or `oneOf` (done while at least
 *   one of these features is on, the button opens Features) says what it is about.
 * - `when`: the step applies only while one of these features is on (none: always); `after`: and only once this
 *   connection is connected (a setting that makes sense once storage is connected).
 * - Done: `done(value, context)` when given; else a setting with `confirm` is done once the merchant (or the Owner's
 *   Defaults) chose it, because its built-in value is only a start, and one with `own` only once the merchant saved it
 *   on this website; any other setting or list is done once it holds a value.
 * - `optional`: shown, but not counted in the progress.
 * - `label` the thing to do, `why` one plain line saying why it matters, `action` the button's words; the button opens
 *   `tab` (Settings) at `section` (a setting's own section when not given).
 * @typedef {object} SetupRequirement
 * @property {string} key
 * @property {string[]} [when]
 * @property {string} [after]
 * @property {string} [setting]
 * @property {string} [list]
 * @property {string[]} [oneOf]
 * @property {(value: any, context: SetupContext) => boolean} [done]
 * @property {boolean} [confirm]
 * @property {boolean} [own]
 * @property {boolean} [optional]
 * @property {string} label
 * @property {string} why
 * @property {string} action
 * @property {string} [tab]
 * @property {string} [section]
 * @property {(value: any, context: SetupContext) => string | undefined} [detail] a line shown under the step (the value now)
 */

/** Whether a saved value holds something: text, a list or any number or switch. @param {unknown} value */
export const isFilled = (value) =>
	typeof value === 'string'
		? value.trim() !== ''
		: Array.isArray(value)
			? value.length > 0
			: value !== null && value !== undefined;

/**
 * Whether any requirement that applies reads a setting (a product that loads the settings itself loads them only then).
 * @param {Answer | null} overview
 * @param {ReadonlyArray<SetupRequirement>} requirements
 */
export const wantsSettings = (overview, requirements) =>
	overview?.ok === true &&
	requirements.some(
		(requirement) =>
			requirement.setting !== undefined &&
			(!requirement.when || requirement.when.some((key) => overview.data.featuresOn.includes(key))),
	);

/**
 * The setup steps a product's requirements make for a website. Settings are read once (from `settings` when the
 * caller has the answer already), each list once, and only while a step of theirs applies; a step whose state is not
 * known yet (still loading, or its feature is not shown) is left out, so the checklist never shows a wrong tick.
 * @param {{ overview: Answer | null, websiteId: string | null, open: (tab: string, section?: string) => void,
 *   settings?: Answer | null }} from the overview answer, the website, the tab's `open`, and the settings answer if read
 * @param {ReadonlyArray<SetupRequirement>} requirements a constant list of the product
 * @returns {SetupStep[]}
 */
export function useSetupSteps({ overview, websiteId, open, settings: given }, requirements) {
	const base = `/v1/dashboard/websites/${websiteId}`;
	/** @type {string[]} */
	const on = overview?.ok ? overview.data.featuresOn : [];
	/** @type {Array<{ name: string, status: string }>} */
	const connections = overview?.ok ? overview.data.checklist.connections : [];
	/** @param {SetupRequirement} requirement */
	const applies = (requirement) =>
		(!requirement.when || requirement.when.some((key) => on.includes(key))) &&
		(!requirement.after || connections.some((item) => item.name === requirement.after && item.status === 'connected'));
	const live = requirements.filter((requirement) => overview?.ok && applies(requirement));
	const own = useLoad(given === undefined && live.some((requirement) => requirement.setting) ? `${base}/settings` : null);
	const settings = given === undefined ? own.answer : given;
	const names = [...new Set(requirements.flatMap((requirement) => (requirement.list ? [requirement.list] : [])))];
	// one load per list the product names (a constant count of hooks), started only while a step of the list applies
	const lists = new Map(
		names.map((name) => [
			name,
			useLoad(live.some((requirement) => requirement.list === name) ? `${base}/lists/${name}` : null).answer,
		]),
	);

	/** @type {SetupStep[]} */
	const steps = [];
	for (const requirement of live) {
		/** @type {SetupContext} */
		let context = { values: {}, on };
		/** @type {boolean} */
		let done;
		/** @type {unknown} */
		let value;
		let section = requirement.section;
		if (requirement.oneOf) {
			const some = requirement.oneOf.some((key) => on.includes(key));
			done = some;
		} else if (requirement.setting) {
			const [featureKey = '', name = ''] = requirement.setting.split('.');
			/** @type {import('./dashboard-parts.js').FeatureSettings | undefined} */
			const feature = settings?.ok
				? settings.data.features.find((/** @type {{ key: string }} */ item) => item.key === featureKey)
				: undefined;
			const entry = feature?.values?.[name];
			if (!feature || !entry) continue;
			value = entry.value;
			context = {
				values: Object.fromEntries(Object.entries(feature.values).map(([setting, item]) => [setting, item.value])),
				on,
			};
			done = requirement.done
				? requirement.done(value, context)
				: requirement.own
					? entry.source === 'website'
					: requirement.confirm
						? entry.source !== 'built-in'
						: isFilled(value);
			section ??= settingSectionOf(feature);
		} else if (requirement.list) {
			const answer = lists.get(requirement.list);
			if (!answer?.ok) continue;
			value = answer.data?.value;
			done = requirement.done ? requirement.done(value, context) : isFilled(value);
		} else continue;
		const detail = requirement.detail?.(value, context);
		const tab = requirement.tab ?? 'settings';
		steps.push({
			key: requirement.key,
			label: requirement.label,
			why: requirement.why,
			done,
			actionLabel: requirement.action,
			...(requirement.optional ? { optional: true } : {}),
			...(detail ? { detail } : {}),
			onSelect: () => (section ? open(tab, section) : open(tab)),
		});
	}
	return steps;
}
