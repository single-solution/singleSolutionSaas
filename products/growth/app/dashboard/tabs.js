'use client';
/**
 * The dashboard's tabs (PLAN 0.4.3), each on the kit's dashboard API. Rights are the kit's: merchants see features
 * read-only and only the settings of switched-on features; Owners and Support switch features; Owners alone edit
 * Defaults and Prices.
 * @module
 */
import { ViewTransition, useState } from 'react';
import {
	Badge,
	Button,
	Callout,
	Card,
	Checkbox,
	CodeBlock,
	ConfirmDialog,
	ErrorState,
	FieldGrid,
	Input,
	Masonry,
	OverviewSkeleton,
	ProductOverview,
	RecentChanges,
	SchemaForm,
	Section,
	Select,
	Skeleton,
	SoftBreaks,
	Stat,
	TextArea,
	describeProblem,
	formatCreditsPerHour,
	parseCredits,
	useViewerTimeZone,
} from '@ss/ui';
import manifest from '../../manifest.json' with { type: 'json' };
import { searchParamsOf, tagsReady } from '../../core/config.js';
import { createSnippets } from '../../core/snippets.js';
import { BROWSER_EVENTS, SITE_EVENTS } from '../../core/widgets.js';
import { call, fill, useLoad } from './api.js';
import { AtAGlance, settingsNotice } from './setup.js';
import { TEXTS } from './texts.js';

/** @typedef {{ kind: 'merchant' | 'admin', id: string, name: string, role?: 'owner' | 'support' }} Who */
/**
 * `open` shows another section of the dashboard (the Overview's buttons).
 * @typedef {{ websiteId: string | null, domain: string, who: Who, support: { email: string, phone: string },
 *   portal: string, open: (tab: import('@ss/ui').OverviewTab) => void }} TabProps
 */
/** @typedef {{ key: string, name: string, description: string, dependsOn: string[], millicreditsPerHour: number, on?: boolean }} Feature */

/**
 * Its skeleton while loading (`skeleton`, else a few lines), the problem when it failed, else the content (it fades in).
 * @param {{ answer: import('./api.js').Answer | null, skeleton?: import('react').ReactNode,
 *   children: (data: any) => import('react').ReactNode }} props
 */
function Loaded({ answer, skeleton, children }) {
	if (!answer) return skeleton ?? <Skeleton lines={3} label={TEXTS.loading} />;
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
function Outcome({ result }) {
	if (!result) return null;
	return result.ok ? (
		<Callout tone="success">{TEXTS.saved}</Callout>
	) : (
		<Callout tone="danger">{describeProblem(result.problem)}</Callout>
	);
}

/** Feature names by key (manifest.json). */
const NAMES = new Map(manifest.features.map((feature) => [feature.key, feature.name]));

/**
 * The names of features, at most `max` of them and how many more (a long list would make its tile or card tall).
 * @param {string[]} keys
 * @param {number} [max]
 */
const namesOf = (keys, max = Infinity) => {
	const names = keys.map((key) => NAMES.get(key) ?? key);
	return names.length > max
		? fill(TEXTS.andMore, { names: names.slice(0, max).join(', '), count: names.length - max })
		: names.join(', ');
};

/** @param {string} status */
const toneOf = (status) => (status === 'connected' ? 'success' : status === 'test_failed' ? 'danger' : 'warning');

/**
 * The settings of each switched-on feature, from the settings screen's answer.
 * @param {{ features: Array<{ key: string, on?: boolean, values: Record<string, { value: unknown }> }> }} data
 */
const valuesOf = (data) =>
	Object.fromEntries(
		data.features.map((feature) => [
			feature.key,
			Object.fromEntries(Object.entries(feature.values).map(([name, entry]) => [name, entry.value])),
		]),
	);

/**
 * Overview (PLAN 0.6 "Overviews talk", 0.4.3): the kit's whole Overview from `@ss/ui`, with Growth's own part from the
 * website's settings: the tags ready (while a tag feature is on), the tag features with no id or script yet, and the
 * setup of the switched-on features at a glance.
 * @param {TabProps} props
 */
function OverviewTab({ websiteId, who, support, portal, open }) {
	const timeZone = useViewerTimeZone();
	const base = `/v1/dashboard/websites/${websiteId}`;
	const { answer, reload } = useLoad(`${base}/overview`);
	const settings = useLoad(`${base}/settings`);
	const O = TEXTS.overview;
	return (
		<Loaded answer={answer} skeleton={<OverviewSkeleton />}>
			{(data) => {
				const values = settings.answer?.ok ? valuesOf(settings.answer.data) : null;
				const tags = values ? tagsReady(data.featuresOn, values) : null;
				const missing = tags ? tags.total - tags.ready : 0;
				return (
					<ProductOverview
						data={data}
						who={who}
						product={TEXTS.title}
						support={support}
						portal={portal}
						namesOf={namesOf}
						open={open}
						recheck={async () => {
							await call('POST', `${base}/business/refresh`);
							reload();
						}}
						needs={
							missing > 0
								? [
										{
											key: 'tags',
											tone: 'warning',
											title: missing === 1 ? O.noTag.one : fill(O.noTag.many, { count: missing }),
											effect: O.noTag.effect,
											action: (
												<Button size="sm" variant="secondary" onClick={() => open('settings')}>
													{O.noTag.action}
												</Button>
											),
										},
									]
								: []
						}
						steps={
							tags && tags.total > 0
								? [{ key: 'tags', label: O.tagsStep, done: missing === 0, onSelect: () => open('settings') }]
								: []
						}
						numbers={
							tags && tags.total > 0 ? (
								<Stat
									label={O.tags}
									value={fill(O.ofTotal, { count: tags.ready, total: tags.total })}
									hint={O.tagsHelp}
									icon="zap"
									kind="connection"
								/>
							) : null
						}>
						{values ? (
							<AtAGlance
								values={values}
								context={{ on: data.featuresOn, domain: data.website.domain, now: Date.now(), timeZone }}
							/>
						) : null}
					</ProductOverview>
				);
			}}
		</Loaded>
	);
}

/**
 * Keys switched off together with `key`: the features that need it, directly or through others.
 * @param {Feature[]} features
 * @param {string[]} on
 * @param {string} key
 */
const withDependents = (features, on, key) => {
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

/** @param {TabProps} props */
function FeaturesTab({ websiteId, who, support }) {
	const base = `/v1/dashboard/websites/${websiteId}`;
	const { answer, reload } = useLoad(`${base}/features`);
	const connections = useLoad(`${base}/connections`);
	const [picked, setPicked] = useState(/** @type {string[] | null} */ (null));
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState(/** @type {import('./api.js').Answer | null} */ (null));
	const admin = who.kind === 'admin';
	return (
		<Loaded answer={answer}>
			{(data) => {
				/** @type {Feature[]} */
				const features = data.features;
				const saved = features.filter((feature) => feature.on).map((feature) => feature.key);
				const on = picked ?? saved;
				const turnedOff = saved.filter((key) => !on.includes(key));
				const cost = features.reduce((sum, feature) => sum + (on.includes(feature.key) ? feature.millicreditsPerHour : 0), 0);
				/** @type {Array<{ label: string, status: string, neededBy: string[] }>} */
				const links = connections.answer?.ok ? connections.answer.data.connections : [];
				/** @param {Feature} feature @param {boolean} checked */
				const toggle = (feature, checked) => {
					const off = withDependents(features, on, feature.key);
					setPicked(checked ? [...on, feature.key] : on.filter((key) => !off.has(key)));
				};
				return (
					<div className="space-y-4">
						{admin ? null : <Callout tone="info">{fill(TEXTS.features.contact, { contact: support.email })}</Callout>}
						<Masonry wideAlone>
							{features.map((feature) => {
								const missing = feature.dependsOn.filter((dep) => !on.includes(dep));
								const broken = links.filter((link) => link.neededBy.includes(feature.key) && link.status !== 'connected');
								return (
									<Card
										key={feature.key}
										bodyClassName="space-y-3"
										title={feature.name}
										subtitle={fill(TEXTS.features.price, { price: formatCreditsPerHour(feature.millicreditsPerHour) })}
										actions={
											<a className="text-sm font-semibold text-primary" href={`/docs#feature-${feature.key}`}>
												{TEXTS.features.docs}
											</a>
										}>
										<p className="text-sm">{feature.description}</p>
										{feature.dependsOn.length > 0 ? (
											<p className="text-sm text-muted">
												{fill(TEXTS.features.needs, { features: namesOf(feature.dependsOn) })}
											</p>
										) : null}
										{feature.on
											? broken.map((link) => (
													<p key={link.label} className="text-sm text-danger">
														{fill(TEXTS.features.notWorking, { connection: link.label })}
													</p>
												))
											: null}
										<Checkbox
											label={TEXTS.features.on}
											checked={on.includes(feature.key)}
											disabled={!admin || (missing.length > 0 && !on.includes(feature.key))}
											onChange={(event) => toggle(feature, event.target.checked)}
										/>
									</Card>
								);
							})}
						</Masonry>
						{admin ? (
							<Button disabled={picked === null} onClick={() => setConfirming(true)}>
								{TEXTS.save}
							</Button>
						) : null}
						<Outcome result={result} />
						<ConfirmDialog
							open={confirming}
							busy={busy}
							title={TEXTS.features.confirmTitle}
							confirmLabel={TEXTS.save}
							cancelLabel={TEXTS.cancel}
							onClose={() => setConfirming(false)}
							onConfirm={async () => {
								setBusy(true);
								const next = await call('PUT', `${base}/features`, { on });
								setBusy(false);
								setConfirming(false);
								setResult(next);
								if (next.ok) {
									setPicked(null);
									reload();
								}
							}}>
							<p>{fill(TEXTS.features.confirmCost, { cost: formatCreditsPerHour(cost) })}</p>
							{turnedOff.length > 0 ? <p>{fill(TEXTS.features.alsoOff, { features: namesOf(turnedOff) })}</p> : null}
						</ConfirmDialog>
					</div>
				);
			}}
		</Loaded>
	);
}

/**
 * Settings forms, one card per feature that has settings (and per shared group), each with its own Save and outcome: a
 * website's settings or the global defaults. Each card starts with what it says about the setup (`settingsNotice`).
 * @param {{ features: Array<{ key: string, name: string, on?: boolean, schema: any, values: Record<string, { value: unknown, source: string }> }>,
 *   saveUrl: (key: string) => string, resetBody: boolean, savedSource: string, reload: () => void,
 *   context: import('./setup.js').Context | null }} props
 *   `resetBody`: reset with `PUT { value: null }` (defaults) instead of `DELETE`; `context`: the website (null on Defaults)
 */
function SettingsForms({ features, saveUrl, resetBody, savedSource, reload, context }) {
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
	return (
		<>
			{features
				.filter((feature) => Object.keys(feature.schema?.properties ?? {}).length > 0)
				.map((feature) => {
					const changed = edits[feature.key] ?? {};
					const values = Object.fromEntries(
						Object.entries(feature.values).map(([name, entry]) => [name, name in changed ? changed[name] : entry.value]),
					);
					const overridden = Object.fromEntries(
						Object.entries(feature.values).map(([name, entry]) => [name, entry.source === savedSource]),
					);
					return (
						<Card key={feature.key} title={feature.name} subtitle={feature.on === false ? TEXTS.settings.off : undefined}>
							{settingsNotice(feature.key, values, context)}
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
function TextsForm({ texts, saveUrl, resetBody, savedSource, reload }) {
	const [edits, setEdits] = useState(/** @type {Record<string, string>} */ ({}));
	const [result, setResult] = useState(/** @type {{ key: string, answer: import('./api.js').Answer } | null} */ (null));
	return (
		<Card title={TEXTS.settings.texts} subtitle={TEXTS.settings.textsHelp}>
			<div className="space-y-4">
				{texts.map((text) => {
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
									{TEXTS.save}
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
										{TEXTS.reset}
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
 *   save: (theme: Record<string, unknown>) => Promise<import('./api.js').Answer>, reload: () => void }} props
 */
function ThemeForm({ theme, save, reload }) {
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

/**
 * How money and dates look in the widgets (one Format per website, PLAN 0.8.10 K7).
 * @param {{ format: { locale: string, currencyDisplay: string, currencySymbol: string, wholeUnits: boolean, times: string },
 *   save: (format: Record<string, unknown>) => Promise<import('./api.js').Answer>, reload: () => void }} props
 */
function FormatForm({ format, save, reload }) {
	const [draft, setDraft] = useState(format);
	const [result, setResult] = useState(/** @type {import('./api.js').Answer | null} */ (null));
	return (
		<Card title={TEXTS.settings.format} subtitle={TEXTS.settings.formatHelp}>
			<FieldGrid>
				<Input
					label={TEXTS.settings.locale}
					help={TEXTS.settings.localeHelp}
					placeholder="en-US"
					value={draft.locale}
					onChange={(event) => setDraft({ ...draft, locale: event.target.value.trim() })}
				/>
				<Select
					label={TEXTS.settings.currencyDisplay}
					value={draft.currencyDisplay}
					options={Object.entries(TEXTS.settings.currencyDisplays).map(([value, label]) => ({ value, label }))}
					onChange={(event) => setDraft({ ...draft, currencyDisplay: event.target.value })}
				/>
				<Input
					label={TEXTS.settings.currencySymbol}
					maxLength={8}
					disabled={draft.currencyDisplay !== 'custom'}
					value={draft.currencySymbol}
					onChange={(event) => setDraft({ ...draft, currencySymbol: event.target.value })}
				/>
				<Select
					label={TEXTS.settings.times}
					value={draft.times}
					options={Object.entries(TEXTS.settings.timesOptions).map(([value, label]) => ({ value, label }))}
					onChange={(event) => setDraft({ ...draft, times: event.target.value })}
				/>
				<Checkbox
					label={TEXTS.settings.wholeUnits}
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
				{TEXTS.save}
			</Button>
			<Outcome result={result} />
		</Card>
	);
}

/** @param {TabProps} props */
function SettingsTab({ websiteId, domain }) {
	const timeZone = useViewerTimeZone();
	const base = `/v1/dashboard/websites/${websiteId}`;
	const settings = useLoad(`${base}/settings`);
	const texts = useLoad(`${base}/texts`);
	const theme = useLoad(`${base}/theme`);
	const format = useLoad(`${base}/format`);
	return (
		<div className="space-y-6">
			<Section title={TEXTS.settings.featuresTitle} description={TEXTS.settings.featuresHelp}>
				<Masonry wideAlone>
					<Loaded answer={settings.answer}>
						{(data) => (
							<SettingsForms
								features={data.features}
								saveUrl={(key) => `${base}/settings/${encodeURIComponent(key)}`}
								resetBody={false}
								savedSource="website"
								reload={settings.reload}
								context={{
									on: data.features
										.filter((/** @type {Feature} */ f) => f.on !== false)
										.map((/** @type {Feature} */ f) => f.key),
									domain,
									now: Date.now(),
									timeZone,
									// what robots.txt keeps out of search results: the search parameters of Searches and 404s
									searchParams: searchParamsOf(
										String(
											data.features.find((/** @type {{ key: string }} */ f) => f.key === 'searches_404s')?.values
												.searchParams?.value ?? '',
										),
									),
								}}
							/>
						)}
					</Loaded>
				</Masonry>
			</Section>
			<Section title={TEXTS.settings.looksTitle} description={TEXTS.settings.looksHelp}>
				<Masonry wideAlone>
					<Loaded answer={texts.answer}>
						{(data) => (
							<TextsForm
								texts={data.texts}
								saveUrl={(key) => `${base}/texts/${encodeURIComponent(key)}`}
								resetBody={false}
								savedSource="website"
								reload={texts.reload}
							/>
						)}
					</Loaded>
					<Loaded answer={theme.answer}>
						{(data) => (
							<ThemeForm theme={data.theme} save={(next) => call('PUT', `${base}/theme`, next)} reload={theme.reload} />
						)}
					</Loaded>
					<Loaded answer={format.answer}>
						{(data) => (
							<FormatForm
								format={data.format}
								save={(next) => call('PUT', `${base}/format`, next)}
								reload={format.reload}
							/>
						)}
					</Loaded>
				</Masonry>
			</Section>
		</div>
	);
}

/** @param {TabProps} props */
function ConnectionsTab({ websiteId }) {
	const base = `/v1/dashboard/websites/${websiteId}/connections`;
	const { answer, reload } = useLoad(base);
	const [values, setValues] = useState(/** @type {Record<string, string>} */ ({}));
	const [result, setResult] = useState(/** @type {import('./api.js').Answer | null} */ (null));
	/** @param {Promise<import('./api.js').Answer>} pending */
	const act = async (pending) => {
		setResult(await pending);
		reload();
	};
	return (
		<Loaded answer={answer}>
			{(data) => (
				<div className="space-y-4">
					<Masonry wideAlone>
						{data.connections.map((/** @type {any} */ item) => {
							/** @param {unknown} value */
							const save = (value) => act(call('PUT', `${base}/${item.name}`, { value }));
							return (
								<Card
									key={item.name}
									title={item.label}
									subtitle={
										item.neededBy.length > 0
											? fill(TEXTS.connections.neededBy, { features: namesOf(item.neededBy, 4) })
											: TEXTS.connections.neededByNone
									}>
									<p className="flex flex-wrap items-center gap-2 text-sm">
										<Badge tone={toneOf(item.status)} dot>
											{TEXTS.connections[/** @type {'connected'} */ (item.status)]}
										</Badge>
										{item.last4 ? <code>••••{item.last4}</code> : null}
										{item.message ? <span className="text-muted">{item.message}</span> : null}
									</p>
									<div className="mt-3 flex flex-wrap items-end gap-2">
										<Input
											fieldClassName="min-w-0 flex-1 basis-64"
											label={item.kind === 'token' ? TEXTS.connections.token : TEXTS.connections.value}
											type="password"
											autoComplete="off"
											value={values[item.name] ?? ''}
											onChange={(event) => setValues({ ...values, [item.name]: event.target.value })}
										/>
										<Button
											size="sm"
											disabled={!values[item.name]?.trim()}
											onClick={() => {
												const done = save(values[item.name]?.trim());
												setValues({ ...values, [item.name]: '' });
												return done;
											}}>
											{TEXTS.connections.save}
										</Button>
									</div>
									<div className="mt-3 flex flex-wrap gap-2">
										<Button
											size="sm"
											variant="secondary"
											onClick={() => act(call('POST', `${base}/${item.name}/test`))}>
											{TEXTS.connections.test}
										</Button>
										<Button size="sm" variant="ghost" onClick={() => act(call('DELETE', `${base}/${item.name}`))}>
											{TEXTS.connections.remove}
										</Button>
									</div>
								</Card>
							);
						})}
					</Masonry>
					<Outcome result={result} />
				</div>
			)}
		</Loaded>
	);
}

/** @param {TabProps} props */
function DevelopersTab({ websiteId, portal }) {
	const { answer } = useLoad(`/v1/dashboard/websites/${websiteId}/features`);
	const origin = typeof window === 'undefined' ? '' : window.location.origin;
	const snippets = createSnippets({
		base: origin,
		widgets: manifest.widgets,
		permissions: manifest.permissions.map((permission) => permission.key),
	});
	return (
		<Loaded answer={answer}>
			{(data) => (
				<div className="space-y-6">
					<Card title={TEXTS.tabs.developers}>
						<p className="text-sm">{TEXTS.developers.intro}</p>
						<p className="mt-2 text-sm">{fill(TEXTS.developers.websiteId, { id: String(websiteId) })}</p>
						<ul className="mt-3 flex flex-wrap gap-2 text-sm">
							{data.features.map((/** @type {Feature} */ feature) => (
								<li key={feature.key}>
									<a className="font-semibold text-primary" href={`/docs#feature-${feature.key}`}>
										{feature.name}
									</a>
									{feature.on ? '' : ` (${TEXTS.developers.off})`}
								</li>
							))}
						</ul>
						<p className="mt-3 flex flex-wrap gap-4">
							<a className="text-sm font-semibold text-primary" href="/docs">
								{TEXTS.developers.openDocs}
							</a>
							<a className="text-sm font-semibold text-primary" href={portal}>
								{TEXTS.developers.manageTokens}
							</a>
						</p>
					</Card>
					<Section title={TEXTS.developers.script} description={TEXTS.developers.scriptHelp}>
						<CodeBlock code={snippets.pageScript} />
						<CodeBlock code={snippets.consent} />
					</Section>
					<Section title={TEXTS.developers.events} description={TEXTS.developers.eventsHelp}>
						<CodeBlock code={[...Object.keys(BROWSER_EVENTS), ...Object.keys(SITE_EVENTS)].join('\n')} />
						<CodeBlock code={snippets.events} />
						<CodeBlock code={snippets.page} />
					</Section>
					<Section title={TEXTS.developers.api} description={TEXTS.developers.apiHelp}>
						<CodeBlock code={snippets.analytics} />
						<CodeBlock code={snippets.robots} />
						<CodeBlock code={snippets.indexNow} />
						<CodeBlock code={snippets.seo} />
						<CodeBlock code={snippets.redirects} />
						<CodeBlock code={snippets.notice} />
					</Section>
					<Section title={TEXTS.developers.widgets} description={TEXTS.developers.widgetsHelp}>
						<CodeBlock code={snippets.admin} />
					</Section>
					<Section title={TEXTS.developers.ticket} description={TEXTS.developers.ticketHelp}>
						<CodeBlock code={snippets.ticketNode} />
						<CodeBlock code={snippets.ticketCurl} />
					</Section>
				</div>
			)}
		</Loaded>
	);
}

function DefaultsTab() {
	const { answer, reload } = useLoad('/v1/dashboard/defaults');
	/** @param {string} key */
	const saveUrl = (key) => `/v1/dashboard/defaults/${encodeURIComponent(key)}`;
	return (
		<Loaded answer={answer}>
			{(data) => (
				<div className="space-y-4">
					<Callout tone="info">{TEXTS.defaults.intro}</Callout>
					<Masonry wideAlone>
						<SettingsForms
							features={data.features}
							saveUrl={saveUrl}
							resetBody
							savedSource="default"
							reload={reload}
							context={null}
						/>
						<TextsForm
							texts={data.texts}
							saveUrl={(key) => saveUrl(`text.${key}`)}
							resetBody
							savedSource="default"
							reload={reload}
						/>
						<ThemeForm
							theme={data.theme.theme}
							save={(next) => call('PUT', saveUrl('theme'), { value: next })}
							reload={reload}
						/>
						<FormatForm
							format={data.format.format}
							save={(next) => call('PUT', saveUrl('format'), { value: next })}
							reload={reload}
						/>
					</Masonry>
					<RecentChanges items={data.recentChanges} />
				</div>
			)}
		</Loaded>
	);
}

/**
 * The Owner's Re-seal (PLAN 0.4.8): after `ENCRYPTION_KEY` is changed (the old key set as `ENCRYPTION_KEY_PREVIOUS`),
 * every stored secret is sealed again with the new key; pressing again is safe.
 */
function ResealCard() {
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState(/** @type {import('./api.js').Answer | null} */ (null));
	const done = result?.ok ? result.data : null;
	return (
		<Card title={TEXTS.reseal.title} subtitle={TEXTS.reseal.intro}>
			<div className="space-y-4">
				<Button
					disabled={busy}
					onClick={async () => {
						setBusy(true);
						setResult(await call('POST', '/v1/dashboard/reseal'));
						setBusy(false);
					}}>
					{TEXTS.reseal.button}
				</Button>
				{done ? (
					<Callout tone={done.failedWebsites.length === 0 ? 'success' : 'warning'}>
						{fill(TEXTS.reseal.result, done)}{' '}
						{done.failedWebsites.length === 0
							? TEXTS.reseal.finished
							: fill(TEXTS.reseal.again, { failed: done.failedWebsites.length })}
					</Callout>
				) : null}
				{result && !result.ok ? <Outcome result={result} /> : null}
			</div>
		</Card>
	);
}

function PricesTab() {
	const { answer, reload } = useLoad('/v1/dashboard/prices');
	const [draft, setDraft] = useState(/** @type {Record<string, string>} */ ({}));
	const [result, setResult] = useState(/** @type {import('./api.js').Answer | null} */ (null));
	return (
		<Loaded answer={answer}>
			{(data) => {
				/** @type {Feature[]} */
				const features = data.features;
				const parsed = features.map((feature) => {
					const text = draft[feature.key] ?? String(feature.millicreditsPerHour / 1000);
					return { feature, text, credits: parseCredits(text) };
				});
				return (
					<div className="space-y-4">
						<Callout tone="info">{TEXTS.prices.intro}</Callout>
						<Card>
							<FieldGrid>
								{parsed.map(({ feature, text, credits }) => (
									<Input
										key={feature.key}
										label={feature.name}
										help={TEXTS.prices.perHour}
										inputMode="decimal"
										value={text}
										error={credits.ok ? undefined : credits.message}
										onChange={(event) => setDraft({ ...draft, [feature.key]: event.target.value })}
									/>
								))}
							</FieldGrid>
							<Button
								className="mt-4"
								disabled={parsed.some((entry) => !entry.credits.ok)}
								onClick={async () => {
									const prices = Object.fromEntries(
										parsed.map(({ feature, credits }) => [feature.key, credits.ok ? credits.value : 0]),
									);
									const next = await call('PUT', '/v1/dashboard/prices', { prices });
									setResult(next);
									if (next.ok) setDraft({});
									reload();
								}}>
								{TEXTS.save}
							</Button>
						</Card>
						<Outcome result={result} />
						<ResealCard />
						<RecentChanges items={data.recentChanges} />
					</div>
				);
			}}
		</Loaded>
	);
}

/** Sidebar order: the five tabs of every dashboard, then the Owner tabs. */
export const TABS = Object.freeze({
	overview: OverviewTab,
	features: FeaturesTab,
	settings: SettingsTab,
	connections: ConnectionsTab,
	developers: DevelopersTab,
	defaults: DefaultsTab,
	prices: PricesTab,
});
