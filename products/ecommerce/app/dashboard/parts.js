'use client';
/**
 * Pieces the dashboard's tabs share: loading and outcome states, Recent changes, the status banner and the kit's
 * settings, texts and theme forms (a website's values or the global defaults).
 * @module
 */
import { ViewTransition, useState } from 'react';
import {
	Button,
	Callout,
	Card,
	ErrorState,
	FieldGrid,
	Input,
	SchemaForm,
	Select,
	Skeleton,
	TextArea,
	describeProblem,
	formatDateTime,
} from '@ss/ui';
import { call, fill } from './api.js';
import { TEXTS } from './texts.js';

/** @typedef {{ key: string, name: string, on?: boolean, schema: any, values: Record<string, { value: unknown, source: string }> }} FeatureSettings */

/**
 * Whether a feature has settings to show.
 * @param {{ schema: any }} feature
 */
export const hasSettings = (feature) => Object.keys(feature.schema?.properties ?? {}).length > 0;

/**
 * Skeleton while loading, the problem when it failed, else the content (it fades in).
 * @param {{ answer: import('./api.js').Answer | null, children: (data: any) => import('react').ReactNode }} props
 */
export function Loaded({ answer, children }) {
	if (!answer) return <Skeleton lines={3} label={TEXTS.loading} />;
	if (!answer.ok) return <ErrorState title={TEXTS.failed} message={describeProblem(answer.problem)} />;
	// fades and slides in when it replaces the skeleton; a refresh of shown content changes it in place
	return (
		<ViewTransition enter="ss-vt-enter" default="none">
			{children(answer.data)}
		</ViewTransition>
	);
}

/**
 * The outcome of the last write: saved, or the problem.
 * @param {{ result: import('./api.js').Answer | null }} props
 */
export function Outcome({ result }) {
	if (!result) return null;
	return result.ok ? (
		<Callout tone="success">{TEXTS.saved}</Callout>
	) : (
		<Callout tone="danger">{describeProblem(result.problem)}</Callout>
	);
}

/** @param {{ items: Array<{ who: { name: string }, what: string, detail: string, at: string }> }} props */
export function RecentChanges({ items }) {
	return (
		<Card title={TEXTS.overview.recent}>
			{items.length === 0 ? (
				<p className="text-sm text-muted">{TEXTS.overview.noChanges}</p>
			) : (
				<ul className="space-y-2 text-sm">
					{items.map((item) => (
						<li key={`${item.at}-${item.detail}`}>
							<span className="font-semibold">{item.who.name}</span> · {item.detail}{' '}
							<span className="text-muted">{formatDateTime(item.at)}</span>
						</li>
					))}
				</ul>
			)}
		</Card>
	);
}

/** @param {{ status: { status: string, graceEndsAt: string | null } }} props */
export function StatusBanner({ status }) {
	const text = fill(TEXTS.status[/** @type {keyof typeof TEXTS.status} */ (status.status)] ?? status.status, {
		time: formatDateTime(status.graceEndsAt),
	});
	const tone = status.status === 'active' ? 'success' : status.status === 'grace' ? 'warning' : 'danger';
	return <Callout tone={tone}>{text}</Callout>;
}

/**
 * Settings forms, one per feature (features without settings are skipped): a website's settings or the global
 * defaults. `notice` adds a callout to a feature's card from its current (unsaved included) values.
 * @param {{ features: FeatureSettings[], saveUrl: (key: string) => string, resetBody: boolean, savedSource: string,
 *   reload: () => void, notice?: (key: string, values: Record<string, unknown>) => import('react').ReactNode }} props
 *   `resetBody`: reset with `PUT { value: null }` (defaults) instead of `DELETE`
 */
export function SettingsForms({ features, saveUrl, resetBody, savedSource, reload, notice }) {
	const [edits, setEdits] = useState(/** @type {Record<string, Record<string, unknown>>} */ ({}));
	const [result, setResult] = useState(/** @type {{ feature: string, answer: import('./api.js').Answer } | null} */ (null));
	/** @param {string} feature @param {string} name */
	const reset = async (feature, name) => {
		setResult({
			feature,
			answer: resetBody
				? await call('PUT', saveUrl(`${feature}.${name}`), { value: null })
				: await call('DELETE', saveUrl(`${feature}.${name}`)),
		});
		reload();
	};
	const shown = features.filter(hasSettings);
	if (shown.length === 0) return null;
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
					<Card key={feature.key} title={feature.name} subtitle={feature.on === false ? TEXTS.settings.off : undefined}>
						{notice ? notice(feature.key, values) : null}
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
								/** @type {import('./api.js').Answer} */
								let last = { ok: true, data: null };
								for (const [name, value] of Object.entries(changed)) {
									last = await call('PUT', saveUrl(`${feature.key}.${name}`), { value });
									if (!last.ok) break;
								}
								setResult({ feature: feature.key, answer: last });
								if (last.ok) setEdits({ ...edits, [feature.key]: {} });
								reload();
							}}>
							{TEXTS.save}
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
 * Widget texts: every word the widgets show, with its English default.
 * @param {{ texts: Array<{ key: string, english: string, value: string, source: string }>, saveUrl: (key: string) => string,
 *   resetBody: boolean, savedSource: string, reload: () => void }} props
 */
export function TextsForm({ texts, saveUrl, resetBody, savedSource, reload }) {
	const [edits, setEdits] = useState(/** @type {Record<string, string>} */ ({}));
	const [result, setResult] = useState(/** @type {import('./api.js').Answer | null} */ (null));
	const [filter, setFilter] = useState('');
	const needle = filter.trim().toLowerCase();
	const shown = needle
		? texts.filter((text) => `${text.key} ${text.english} ${text.value}`.toLowerCase().includes(needle))
		: texts;
	return (
		<Card title={TEXTS.settings.texts} subtitle={TEXTS.settings.textsHelp}>
			<Input
				fieldClassName="mb-4"
				label={TEXTS.settings.textsFilter}
				type="search"
				value={filter}
				onChange={(event) => setFilter(event.target.value)}
			/>
			<div className="space-y-3">
				{shown.map((text) => (
					<div key={text.key} className="flex flex-wrap items-end gap-2">
						<Input
							fieldClassName="min-w-0 flex-1 basis-64"
							label={text.key}
							help={text.english}
							value={edits[text.key] ?? text.value}
							onChange={(event) => setEdits({ ...edits, [text.key]: event.target.value })}
						/>
						<Button
							size="sm"
							disabled={edits[text.key] === undefined}
							onClick={async () => {
								const next = await call('PUT', saveUrl(text.key), { value: edits[text.key] });
								setResult(next);
								if (next.ok) setEdits(Object.fromEntries(Object.entries(edits).filter(([key]) => key !== text.key)));
								reload();
							}}>
							{TEXTS.save}
						</Button>
						{text.source === savedSource ? (
							<Button
								size="sm"
								variant="ghost"
								onClick={async () => {
									setResult(
										resetBody
											? await call('PUT', saveUrl(text.key), { value: null })
											: await call('DELETE', saveUrl(text.key)),
									);
									reload();
								}}>
								{TEXTS.reset}
							</Button>
						) : null}
					</div>
				))}
			</div>
			<Outcome result={result} />
		</Card>
	);
}

/**
 * The widgets' theme (one per website): light or dark, font, corner radius, accent colour and custom CSS.
 * @param {{ theme: { colors: Record<string, string>, fontFamily: string, radius: number, mode: string, customCss: string },
 *   save: (theme: Record<string, unknown>) => Promise<import('./api.js').Answer>, reload: () => void }} props
 */
export function ThemeForm({ theme, save, reload }) {
	const [draft, setDraft] = useState(theme);
	const [result, setResult] = useState(/** @type {import('./api.js').Answer | null} */ (null));
	return (
		<Card title={TEXTS.settings.theme}>
			<FieldGrid>
				<Select
					label={TEXTS.settings.mode}
					value={draft.mode}
					options={Object.entries(TEXTS.settings.modes).map(([value, label]) => ({ value, label }))}
					onChange={(event) => setDraft({ ...draft, mode: event.target.value })}
				/>
				<Input
					label={TEXTS.settings.fontFamily}
					value={draft.fontFamily}
					onChange={(event) => setDraft({ ...draft, fontFamily: event.target.value })}
				/>
				<Input
					label={TEXTS.settings.radius}
					type="number"
					min={0}
					max={24}
					value={String(draft.radius)}
					onChange={(event) => setDraft({ ...draft, radius: Number(event.target.value) })}
				/>
				<Input
					label={TEXTS.settings.accent}
					type="color"
					value={draft.colors.accent ?? '#4f46e5'}
					onChange={(event) => setDraft({ ...draft, colors: { ...draft.colors, accent: event.target.value } })}
				/>
			</FieldGrid>
			<TextArea
				label={TEXTS.settings.customCss}
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
				{TEXTS.save}
			</Button>
			<Outcome result={result} />
		</Card>
	);
}
