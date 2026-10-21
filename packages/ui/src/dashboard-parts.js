'use client';
/**
 * The pieces every product dashboard's tabs share (PLAN 0.4.3): the product's words and feature names
 * (`DashboardProvider`, `useDashboard`), the loading and outcome states, and the kit's settings form (a website's
 * values or the global defaults) and the Owner's Re-seal card. The widget texts are fields in place
 * (`dashboard-settings.js`).
 * @module
 */
import { ViewTransition, createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from './Button.js';
import { SaveBar } from './blocks.js';
import { Callout, Card, ErrorState, Skeleton } from './display.js';
import { SchemaForm, isJsonDraft } from './SchemaForm.js';
import { describeProblem, problemLines } from './problems.js';
import { ToastProvider, useToast } from './Toast.js';
import { call, fill } from './dashboard-api.js';
import { DASHBOARD_TEXTS, dashboardTexts, resealAdvice } from './dashboard-texts.js';

/** @typedef {import('./dashboard-api.js').Answer} Answer */
/** @typedef {import('react').ReactNode} ReactNode */
/** @typedef {typeof import('./dashboard-texts.js').DASHBOARD_TEXTS & { title: string } & Record<string, any>} DashboardTexts */
/**
 * What a dashboard needs of the product's manifest.json: the features (their `description` and `dependsOn` are used
 * when there).
 * @typedef {{ id?: string, features: Array<{ key: string, name: string, description?: string, dependsOn?: string[] }> }} DashboardManifest
 */
/**
 * The feature categories of a product, in the order they are listed (the most used first); a feature in none is listed
 * under More. They head the groups of the Features and Settings sidebars.
 * @typedef {ReadonlyArray<{ title: string, features: ReadonlyArray<string> }>} DashboardCategories
 */
/**
 * @typedef {object} Dashboard
 * @property {DashboardTexts} texts the shared words with the product's own laid over them
 * @property {(keys: string[], max?: number) => string} namesOf feature names by key, at most `max` of them and how
 *   many more (a long list would make its tile or card tall)
 * @property {(key: string) => string} nameOf the name of a feature
 * @property {(key: string) => string} describe the one-line description of a feature ('' when the manifest has none)
 * @property {(key: string) => string[]} needsOf the keys a feature depends on
 * @property {(keys: string[]) => Array<{ title: string, keys: string[] }>} byCategory the keys grouped by category, the
 *   categories and the features in each in the product's order, the rest under More
 */
/**
 * One feature's settings as the dashboard API answers them: each value with where it comes from (`source`: `website`,
 * `default`, `built-in`, or `portal` for a setting that starts from the website's settings, with `from` the path).
 * @typedef {{ key: string, name: string, on?: boolean, schema: any,
 *   values: Record<string, { value: unknown, source: string, from?: string }> }} FeatureSettings
 */
/**
 * A callout on a feature's settings card, from its current values (unsaved ones included) and every feature's
 * settings (null: none).
 * @typedef {(key: string, values: Record<string, unknown>, features: FeatureSettings[]) => ReactNode} SettingsNotice
 */

/** @type {DashboardCategories} */
const NO_CATEGORIES = [];

const DashboardContext = createContext(/** @type {Dashboard | null} */ (null));

/**
 * The product's words and feature names for every dashboard piece inside (`ProductDashboard` gives it; a product's
 * own tests wrap a single piece in it).
 * @param {{ manifest: DashboardManifest, texts: { title: string } & Record<string, any>, categories?: DashboardCategories,
 *   children?: ReactNode }} props
 */
export function DashboardProvider({ manifest, texts, categories = NO_CATEGORIES, children }) {
	const value = useMemo(() => {
		const words = /** @type {DashboardTexts} */ (dashboardTexts(texts));
		const names = new Map(manifest.features.map((feature) => [feature.key, feature.name]));
		const entries = new Map(manifest.features.map((feature) => [feature.key, feature]));
		return {
			texts: words,
			/** @param {string} key */
			nameOf: (key) => names.get(key) ?? key,
			/** @param {string} key */
			describe: (key) => entries.get(key)?.description ?? '',
			/** @param {string} key */
			needsOf: (key) => entries.get(key)?.dependsOn ?? [],
			/** @param {string[]} keys */
			byCategory: (keys) => {
				const listed = categories
					.map((category) => ({
						title: category.title,
						keys: category.features.filter((key) => keys.includes(key)),
					}))
					.filter((category) => category.keys.length > 0);
				const placed = new Set(listed.flatMap((category) => category.keys));
				const rest = keys.filter((key) => !placed.has(key));
				return rest.length > 0 ? [...listed, { title: words.categories.more, keys: rest }] : listed;
			},
			/** @param {string[]} keys @param {number} [max] */
			namesOf: (keys, max = Infinity) => {
				const found = keys.map((key) => names.get(key) ?? key);
				return found.length > max
					? fill(words.andMore, { names: found.slice(0, max).join(', '), count: found.length - max })
					: found.join(', ');
			},
		};
	}, [manifest, texts, categories]);
	return (
		<DashboardContext.Provider value={value}>
			<ToastProvider>{children}</ToastProvider>
		</DashboardContext.Provider>
	);
}

/**
 * The product's words and feature names (inside `DashboardProvider` or `ProductDashboard`).
 * @returns {Dashboard}
 */
export const useDashboard = () => {
	const found = useContext(DashboardContext);
	if (!found) throw new Error('useDashboard: render inside <DashboardProvider> or <ProductDashboard>');
	return found;
};

/**
 * Whether a feature has settings to show.
 * @param {{ schema?: any }} feature
 */
export const hasSettings = (feature) => Object.keys(feature.schema?.properties ?? {}).length > 0;

/**
 * The badge tone of a connection's status.
 * @param {string} status
 * @returns {'success' | 'danger' | 'warning'}
 */
export const toneOf = (status) => (status === 'connected' ? 'success' : status === 'test_failed' ? 'danger' : 'warning');

/**
 * Keys switched off together with `key`: the features that need it, directly or through others.
 * @param {Array<{ key: string, dependsOn: string[] }>} features
 * @param {string[]} on
 * @param {string} key
 */
export const withDependents = (features, on, key) => {
	const off = new Set([key]);
	let grew = true;
	while (grew) {
		grew = false;
		for (const feature of features)
			if (on.includes(feature.key) && !off.has(feature.key) && feature.dependsOn.some((dep) => off.has(dep))) {
				off.add(feature.key);
				grew = true;
			}
	}
	return off;
};

/**
 * Its skeleton while loading (`skeleton`, else a few lines), the problem when it failed (with Try again when the answer
 * can be fetched again), else the content (it fades in).
 * @param {{ answer: Answer | null, skeleton?: ReactNode, children: (data: any) => ReactNode }} props
 */
export function Loaded({ answer, skeleton, children }) {
	const { texts } = useDashboard();
	if (!answer) return skeleton ?? <Skeleton lines={3} label={texts.loading} />;
	if (!answer.ok)
		return (
			<ErrorState
				title={texts.failed}
				message={describeProblem(answer.problem)}
				{...(answer.retry
					? {
							action: (
								<Button variant="secondary" onClick={answer.retry}>
									{texts.tryAgain}
								</Button>
							),
						}
					: {})}
			/>
		);
	// fades and slides in when it replaces the skeleton; a refresh of shown content changes it in place
	return (
		<ViewTransition enter="ss-vt-enter" default="none">
			{children(answer.data)}
		</ViewTransition>
	);
}

/** No inline lines: every problem is said by the toast. @returns {string[]} */
const NO_LINES = () => [];

/**
 * The outcome of the last write as a toast at the bottom right (owner 2026-10-17: no Saved banners): Saved, or the
 * problem. Each new result shows once; the component draws nothing in the page. It is {@link SaveOutcome} without the
 * inline list (one implementation of the save outcome for every editor).
 * @param {{ result: Answer | null }} props
 */
export function Outcome({ result }) {
	return <SaveOutcome result={result} format={NO_LINES} />;
}

/**
 * The outcome of saving a list or form the merchant edits, for every product's editors (owner 2026-10-17: a save error is
 * a toast, a field error stays where the merchant is working). Saved is a toast; a refused save is a toast with the
 * reason; the errors that name a row or a field stay inline under the editor as a short list. Each new result shows
 * once; the toasts draw nothing in the page.
 * @param {{ result: Answer | null, local?: string[], format?: (problem: any) => string[], title?: string }} props
 *   `local`: errors the editor found itself before sending (they come first); `format`: the product's own wording of
 *   the server's row errors (default: `path: message`); `title`: the heading of the inline list
 */
export function SaveOutcome({ result, local = [], format = problemLines, title }) {
	// an editor drawn alone (a product's own test) has the shared words
	const texts = useContext(DashboardContext)?.texts ?? DASHBOARD_TEXTS;
	const toast = useToast();
	const shown = useRef(/** @type {unknown} */ (null));
	const failed = result !== null && !result.ok;
	const lines = local.length > 0 ? local : failed ? format(result.problem) : [];
	const trigger = local.length > 0 ? local : result;
	useEffect(() => {
		if (!trigger || shown.current === trigger) return;
		shown.current = trigger;
		if (local.length > 0 || failed)
			toast.show({
				tone: 'danger',
				title: texts.saveFailed,
				description:
					lines.length > 0 ? texts.fixThese : describeProblem(/** @type {Answer & { ok: false }} */ (result).problem),
			});
		else toast.show({ title: texts.saved });
	}, [trigger, local.length, failed, lines.length, result, toast, texts]);
	if (lines.length === 0) return null;
	return (
		<Callout tone="danger" title={title ?? texts.saveFailed}>
			<ul className="list-disc pl-5">
				{lines.map((line) => (
					<li key={line}>{line}</li>
				))}
			</ul>
		</Callout>
	);
}

/**
 * Settings forms of the features that have settings (none: nothing), a website's or the global defaults: each feature
 * is a titled group of cards (`x-ui.group` makes the cards, a feature without groups is one card) and one sticky
 * Save changes bar with Discard appears while anything is edited. `resetBody` resets with `PUT { value: null }`
 * (defaults) instead of `DELETE`; `notice` adds the product's callout to a feature.
 * @param {{ features: FeatureSettings[], saveUrl: (key: string) => string, resetBody: boolean, savedSource: string,
 *   reload: () => void, notice?: SettingsNotice }} props
 */
export function SettingsForms({ features, saveUrl, resetBody, savedSource, reload, notice }) {
	const { texts } = useDashboard();
	const [edits, setEdits] = useState(/** @type {Record<string, Record<string, unknown>>} */ ({}));
	const [result, setResult] = useState(/** @type {{ feature: string, answer: Answer } | null} */ (null));
	const [saving, setSaving] = useState(false);
	const shown = features.filter(hasSettings);
	if (shown.length === 0) return null;
	const dirty = shown.some((feature) => Object.keys(edits[feature.key] ?? {}).length > 0);
	// text typed in a raw JSON box that is not valid JSON yet is no value: Save waits until it is
	const blocked = shown.some((feature) => Object.values(edits[feature.key] ?? {}).some(isJsonDraft));
	/** @param {string} feature @param {string} name */
	const reset = async (feature, name) => {
		const key = saveUrl(`${feature}.${name}`);
		setResult({ feature, answer: resetBody ? await call('PUT', key, { value: null }) : await call('DELETE', key) });
		reload();
	};
	const save = async () => {
		if (blocked) return false;
		setSaving(true);
		/** @type {{ feature: string, answer: Answer } | null} */
		let outcome = null;
		const left = { ...edits };
		for (const feature of shown) {
			const changed = edits[feature.key] ?? {};
			for (const [name, value] of Object.entries(changed)) {
				const answer = await call('PUT', saveUrl(`${feature.key}.${name}`), { value });
				outcome = { feature: feature.key, answer };
				if (!answer.ok) break;
			}
			if (outcome && !outcome.answer.ok) break;
			if (Object.keys(changed).length > 0) delete left[feature.key];
		}
		setSaving(false);
		setResult(outcome);
		setEdits(left);
		reload();
	};
	return (
		<>
			{shown.map((feature) => {
				const changed = edits[feature.key] ?? {};
				const values = Object.fromEntries(
					Object.entries(feature.values).map(([name, entry]) => [name, name in changed ? changed[name] : entry.value]),
				);
				// a product's notice reads values, never text that is not valid JSON yet: it sees the saved value then
				const saneValues = Object.fromEntries(
					Object.entries(values).map(([name, value]) => [name, isJsonDraft(value) ? feature.values[name]?.value : value]),
				);
				const overridden = Object.fromEntries(
					Object.entries(feature.values).map(([name, entry]) => [name, entry.source === savedSource]),
				);
				return (
					<SchemaForm
						key={feature.key}
						title={feature.name}
						description={feature.on === false ? texts.settings.off : undefined}
						schema={feature.schema}
						values={values}
						overridden={overridden}
						onReset={(name) => void reset(feature.key, name)}
						invalidJsonText={texts.settings.invalidJson}
						onChange={(name, value) => setEdits({ ...edits, [feature.key]: { ...changed, [name]: value } })}
						before={notice ? notice(feature.key, saneValues, features) : null}
						after={result?.feature === feature.key ? <Outcome result={result.answer} /> : null}
					/>
				);
			})}
			<SaveBar
				show={dirty}
				saving={saving}
				disabled={blocked}
				onSave={save}
				onDiscard={() => {
					setEdits({});
					setResult(null);
				}}
				message={texts.settings.unsaved}
				saveLabel={texts.settings.saveChanges}
				discardLabel={texts.settings.discard}
			/>
		</>
	);
}

/**
 * The Owner's Re-seal (PLAN 0.4.8): after `ENCRYPTION_KEY` is changed (the old key set as `ENCRYPTION_KEY_PREVIOUS`),
 * every stored secret is sealed again with the new key; pressing again is safe.
 */
export function ResealCard() {
	const { texts } = useDashboard();
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState(/** @type {Answer | null} */ (null));
	const done = result?.ok ? result.data : null;
	return (
		<Card>
			<div className="space-y-4">
				<Button
					disabled={busy}
					onClick={async () => {
						setBusy(true);
						setResult(await call('POST', '/v1/dashboard/reseal'));
						setBusy(false);
					}}>
					{texts.reseal.button}
				</Button>
				{done ? (
					<Callout tone={done.failedWebsites.length === 0 && done.unreadable === 0 ? 'success' : 'warning'}>
						{fill(texts.reseal.result, done)} {resealAdvice(texts.reseal, done)}
					</Callout>
				) : null}
				{result && !result.ok ? <Outcome result={result} /> : null}
			</div>
		</Card>
	);
}
