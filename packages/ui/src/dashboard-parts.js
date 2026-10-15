'use client';
/**
 * The pieces every product dashboard's tabs share (PLAN 0.4.3): the product's words and feature names
 * (`DashboardProvider`, `useDashboard`), the loading and outcome states, and the kit's settings, texts, theme and
 * Format forms (a website's values or the global defaults) and the Owner's Re-seal card.
 * @module
 */
import { ViewTransition, createContext, useContext, useMemo, useState } from 'react';
import { Button } from './Button.js';
import { Callout, Card, ErrorState, Skeleton, SoftBreaks } from './display.js';
import { Checkbox, FieldGrid, Input, Select, TextArea } from './fields.js';
import { SchemaForm } from './SchemaForm.js';
import { describeProblem } from './problems.js';
import { call, fill } from './dashboard-api.js';
import { dashboardTexts } from './dashboard-texts.js';

/** @typedef {import('./dashboard-api.js').Answer} Answer */
/** @typedef {import('react').ReactNode} ReactNode */
/** @typedef {typeof import('./dashboard-texts.js').DASHBOARD_TEXTS & { title: string } & Record<string, any>} DashboardTexts */
/** What a dashboard needs of the product's manifest.json. @typedef {{ features: Array<{ key: string, name: string }> }} DashboardManifest */
/**
 * @typedef {object} Dashboard
 * @property {DashboardTexts} texts the shared words with the product's own laid over them
 * @property {(keys: string[], max?: number) => string} namesOf feature names by key, at most `max` of them and how
 *   many more (a long list would make its tile or card tall)
 */
/** @typedef {{ key: string, name: string, on?: boolean, schema: any, values: Record<string, { value: unknown, source: string }> }} FeatureSettings */
/**
 * A callout on a feature's settings card, from its current values (unsaved ones included) and every feature's
 * settings (null: none).
 * @typedef {(key: string, values: Record<string, unknown>, features: FeatureSettings[]) => ReactNode} SettingsNotice
 */

const DashboardContext = createContext(/** @type {Dashboard | null} */ (null));

/**
 * The product's words and feature names for every dashboard piece inside (`ProductDashboard` gives it; a product's
 * own tests wrap a single piece in it).
 * @param {{ manifest: DashboardManifest, texts: { title: string } & Record<string, any>, children?: ReactNode }} props
 */
export function DashboardProvider({ manifest, texts, children }) {
	const value = useMemo(() => {
		const words = /** @type {DashboardTexts} */ (dashboardTexts(texts));
		const names = new Map(manifest.features.map((feature) => [feature.key, feature.name]));
		return {
			texts: words,
			/** @param {string[]} keys @param {number} [max] */
			namesOf: (keys, max = Infinity) => {
				const found = keys.map((key) => names.get(key) ?? key);
				return found.length > max
					? fill(words.andMore, { names: found.slice(0, max).join(', '), count: found.length - max })
					: found.join(', ');
			},
		};
	}, [manifest, texts]);
	return <DashboardContext.Provider value={value}>{children}</DashboardContext.Provider>;
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
 * Its skeleton while loading (`skeleton`, else a few lines), the problem when it failed, else the content (it fades in).
 * @param {{ answer: Answer | null, skeleton?: ReactNode, children: (data: any) => ReactNode }} props
 */
export function Loaded({ answer, skeleton, children }) {
	const { texts } = useDashboard();
	if (!answer) return skeleton ?? <Skeleton lines={3} label={texts.loading} />;
	if (!answer.ok) return <ErrorState title={texts.failed} message={describeProblem(answer.problem)} />;
	// fades and slides in when it replaces the skeleton; a refresh of shown content changes it in place
	return (
		<ViewTransition enter="ss-vt-enter" default="none">
			{children(answer.data)}
		</ViewTransition>
	);
}

/**
 * The outcome of the last write: saved, or the problem.
 * @param {{ result: Answer | null }} props
 */
export function Outcome({ result }) {
	const { texts } = useDashboard();
	if (!result) return null;
	return result.ok ? (
		<Callout tone="success">{texts.saved}</Callout>
	) : (
		<Callout tone="danger">{describeProblem(result.problem)}</Callout>
	);
}

/**
 * Settings forms, one card per feature that has settings (none: nothing), each with its own Save and outcome: a
 * website's settings or the global defaults. `resetBody` resets with `PUT { value: null }` (defaults) instead of
 * `DELETE`; `notice` adds the product's callout to a feature's card.
 * @param {{ features: FeatureSettings[], saveUrl: (key: string) => string, resetBody: boolean, savedSource: string,
 *   reload: () => void, notice?: SettingsNotice }} props
 */
export function SettingsForms({ features, saveUrl, resetBody, savedSource, reload, notice }) {
	const { texts } = useDashboard();
	const [edits, setEdits] = useState(/** @type {Record<string, Record<string, unknown>>} */ ({}));
	const [result, setResult] = useState(/** @type {{ feature: string, answer: Answer } | null} */ (null));
	const shown = features.filter(hasSettings);
	if (shown.length === 0) return null;
	/** @param {string} feature @param {string} name */
	const reset = async (feature, name) => {
		const key = saveUrl(`${feature}.${name}`);
		setResult({ feature, answer: resetBody ? await call('PUT', key, { value: null }) : await call('DELETE', key) });
		reload();
	};
	return (
		<>
			{shown.map((feature) => {
				const changed = edits[feature.key] ?? {};
				const values = Object.fromEntries(
					Object.entries(feature.values).map(([name, entry]) => [name, name in changed ? changed[name] : entry.value]),
				);
				const overridden = Object.fromEntries(
					Object.entries(feature.values).map(([name, entry]) => [name, entry.source === savedSource]),
				);
				return (
					<Card key={feature.key} title={feature.name} subtitle={feature.on === false ? texts.settings.off : undefined}>
						{notice ? notice(feature.key, values, features) : null}
						<SchemaForm
							schema={feature.schema}
							values={values}
							overridden={overridden}
							onReset={(name) => void reset(feature.key, name)}
							onChange={(name, value) => setEdits({ ...edits, [feature.key]: { ...changed, [name]: value } })}
						/>
						<Button
							className="mt-4"
							disabled={Object.keys(changed).length === 0}
							onClick={async () => {
								/** @type {Answer} */
								let last = { ok: true, data: null };
								for (const [name, value] of Object.entries(changed)) {
									last = await call('PUT', saveUrl(`${feature.key}.${name}`), { value });
									if (!last.ok) break;
								}
								setResult({ feature: feature.key, answer: last });
								if (last.ok) setEdits({ ...edits, [feature.key]: {} });
								reload();
							}}>
							{texts.save}
						</Button>
						{result?.feature === feature.key ? (
							<div className="mt-4">
								<Outcome result={result.answer} />
							</div>
						) : null}
					</Card>
				);
			})}
		</>
	);
}

/**
 * Widget texts: every word the widgets show, with its English default, and a box that finds a text by its key or
 * words. Each text saves on its own; one saved here gets a Reset (`resetBody` as in `SettingsForms`).
 * @param {{ texts: Array<{ key: string, english: string, value: string, source: string }>, saveUrl: (key: string) => string,
 *   resetBody: boolean, savedSource: string, reload: () => void }} props
 */
export function TextsForm({ texts, saveUrl, resetBody, savedSource, reload }) {
	const { texts: words } = useDashboard();
	const [edits, setEdits] = useState(/** @type {Record<string, string>} */ ({}));
	const [result, setResult] = useState(/** @type {{ key: string, answer: Answer } | null} */ (null));
	const [filter, setFilter] = useState('');
	const needle = filter.trim().toLowerCase();
	const shown = needle
		? texts.filter((text) => `${text.key} ${text.english} ${text.value}`.toLowerCase().includes(needle))
		: texts;
	return (
		<Card title={words.settings.texts} subtitle={words.settings.textsHelp}>
			<Input
				fieldClassName="mb-4"
				label={words.settings.textsFilter}
				type="search"
				value={filter}
				onChange={(event) => setFilter(event.target.value)}
			/>
			<div className="space-y-4">
				{shown.map((text) => {
					const englishId = `text-${text.key.replace(/[^\w-]/g, '-')}-english`;
					return (
						<div key={text.key} className="space-y-1.5">
							<div className="flex flex-wrap items-end gap-2">
								<Input
									fieldClassName="min-w-0 flex-1 basis-64"
									label={<SoftBreaks text={text.key} />}
									aria-describedby={englishId}
									value={edits[text.key] ?? text.value}
									onChange={(event) => setEdits({ ...edits, [text.key]: event.target.value })}
								/>
								<Button
									size="sm"
									disabled={edits[text.key] === undefined}
									onClick={async () => {
										const next = await call('PUT', saveUrl(text.key), { value: edits[text.key] });
										setResult({ key: text.key, answer: next });
										if (next.ok)
											setEdits(Object.fromEntries(Object.entries(edits).filter(([key]) => key !== text.key)));
										reload();
									}}>
									{words.save}
								</Button>
								{text.source === savedSource ? (
									<Button
										size="sm"
										variant="ghost"
										onClick={async () => {
											setResult({
												key: text.key,
												answer: resetBody
													? await call('PUT', saveUrl(text.key), { value: null })
													: await call('DELETE', saveUrl(text.key)),
											});
											reload();
										}}>
										{words.reset}
									</Button>
								) : null}
							</div>
							<p id={englishId} className="text-xs text-muted">
								{text.english}
							</p>
							{result?.key === text.key ? <Outcome result={result.answer} /> : null}
						</div>
					);
				})}
			</div>
		</Card>
	);
}

/**
 * The widgets' theme (one per website): light or dark, font, corner radius, accent color and custom CSS.
 * @param {{ theme: { colors: Record<string, string>, fontFamily: string, radius: number, mode: string, customCss: string },
 *   save: (theme: Record<string, unknown>) => Promise<Answer>, reload: () => void }} props
 */
export function ThemeForm({ theme, save, reload }) {
	const { texts } = useDashboard();
	const [draft, setDraft] = useState(theme);
	const [result, setResult] = useState(/** @type {Answer | null} */ (null));
	return (
		<Card title={texts.settings.theme}>
			<FieldGrid>
				<Select
					label={texts.settings.mode}
					value={draft.mode}
					options={Object.entries(texts.settings.modes).map(([value, label]) => ({ value, label }))}
					onChange={(event) => setDraft({ ...draft, mode: event.target.value })}
				/>
				<Input
					label={texts.settings.fontFamily}
					value={draft.fontFamily}
					onChange={(event) => setDraft({ ...draft, fontFamily: event.target.value })}
				/>
				<Input
					label={texts.settings.radius}
					type="number"
					min={0}
					max={24}
					value={String(draft.radius)}
					onChange={(event) => setDraft({ ...draft, radius: Number(event.target.value) })}
				/>
				<Input
					label={texts.settings.accent}
					type="color"
					value={draft.colors.accent ?? '#4f46e5'}
					onChange={(event) => setDraft({ ...draft, colors: { ...draft.colors, accent: event.target.value } })}
				/>
			</FieldGrid>
			<TextArea
				label={texts.settings.customCss}
				rows={6}
				value={draft.customCss}
				onChange={(event) => setDraft({ ...draft, customCss: event.target.value })}
			/>
			<Button
				className="mt-4"
				onClick={async () => {
					setResult(await save(draft));
					reload();
				}}>
				{texts.save}
			</Button>
			<Outcome result={result} />
		</Card>
	);
}

/**
 * How money and dates look in the widgets, messages, invoices and hosted pages (one Format per website, PLAN 0.8.10 K7).
 * @param {{ format: { locale: string, currencyDisplay: string, currencySymbol: string, wholeUnits: boolean, times: string },
 *   save: (format: Record<string, unknown>) => Promise<Answer>, reload: () => void }} props
 */
export function FormatForm({ format, save, reload }) {
	const { texts } = useDashboard();
	const [draft, setDraft] = useState(format);
	const [result, setResult] = useState(/** @type {Answer | null} */ (null));
	return (
		<Card title={texts.settings.format} subtitle={texts.settings.formatHelp}>
			<FieldGrid>
				<Input
					label={texts.settings.locale}
					help={texts.settings.localeHelp}
					placeholder="en-US"
					value={draft.locale}
					onChange={(event) => setDraft({ ...draft, locale: event.target.value.trim() })}
				/>
				<Select
					label={texts.settings.currencyDisplay}
					value={draft.currencyDisplay}
					options={Object.entries(texts.settings.currencyDisplays).map(([value, label]) => ({ value, label }))}
					onChange={(event) => setDraft({ ...draft, currencyDisplay: event.target.value })}
				/>
				<Input
					label={texts.settings.currencySymbol}
					maxLength={8}
					disabled={draft.currencyDisplay !== 'custom'}
					value={draft.currencySymbol}
					onChange={(event) => setDraft({ ...draft, currencySymbol: event.target.value })}
				/>
				<Select
					label={texts.settings.times}
					value={draft.times}
					options={Object.entries(texts.settings.timesOptions).map(([value, label]) => ({ value, label }))}
					onChange={(event) => setDraft({ ...draft, times: event.target.value })}
				/>
				<Checkbox
					label={texts.settings.wholeUnits}
					checked={draft.wholeUnits}
					onChange={(event) => setDraft({ ...draft, wholeUnits: event.target.checked })}
				/>
			</FieldGrid>
			<Button
				className="mt-4"
				onClick={async () => {
					setResult(await save(draft));
					reload();
				}}>
				{texts.save}
			</Button>
			<Outcome result={result} />
		</Card>
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
		<Card title={texts.reseal.title} subtitle={texts.reseal.intro}>
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
					<Callout tone={done.failedWebsites.length === 0 ? 'success' : 'warning'}>
						{fill(texts.reseal.result, done)}{' '}
						{done.failedWebsites.length === 0
							? texts.reseal.finished
							: fill(texts.reseal.again, { failed: done.failedWebsites.length })}
					</Callout>
				) : null}
				{result && !result.ok ? <Outcome result={result} /> : null}
			</div>
		</Card>
	);
}
