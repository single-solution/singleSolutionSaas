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
	SchemaForm,
	Section,
	Select,
	Skeleton,
	SoftBreaks,
	Stat,
	StatGrid,
	TextArea,
	describeProblem,
	formatCredits,
	formatCreditsPerHour,
	formatDateTime,
	parseCredits,
} from '@ss/ui';
import manifest from '../../manifest.json' with { type: 'json' };
import { call, fill, useLoad } from './api.js';
import { TEXTS } from './texts.js';

/** @typedef {{ kind: 'merchant' | 'admin', id: string, name: string, role?: 'owner' | 'support' }} Who */
/** @typedef {{ websiteId: string | null, who: Who, support: { email: string, phone: string }, portal: string }} TabProps */
/** @typedef {{ key: string, name: string, description: string, dependsOn: string[], millicreditsPerHour: number, on?: boolean }} Feature */

/**
 * Skeleton while loading, the problem when it failed, else the content (it fades in).
 * @param {{ answer: import('./api.js').Answer | null, children: (data: any) => import('react').ReactNode }} props
 */
function Loaded({ answer, children }) {
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
 * One line of the setup checklist: what is needed (and why it is not ready), then its status and any action.
 * @param {{ tone: 'success' | 'warning' | 'danger' | 'neutral', badge: string, label: string, detail?: string | null,
 *   children?: import('react').ReactNode }} props
 */
function CheckRow({ tone, badge, label, detail, children }) {
	return (
		<li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0">
			<span className="min-w-0 flex-[1_1_16rem]">
				<span className="block font-semibold text-fg">{label}</span>
				{detail ? <span className="block text-muted">{detail}</span> : null}
			</span>
			<span className="flex flex-wrap items-center gap-2">
				<Badge tone={tone} dot>
					{badge}
				</Badge>
				{children}
			</span>
		</li>
	);
}

/**
 * Recent changes; `titled` gives the card its own title (Defaults, Prices) where no section heading names it.
 * @param {{ items: Array<{ who: { name: string }, what: string, detail: string, at: string }>, titled?: boolean }} props
 */
function RecentChanges({ items, titled = true }) {
	return (
		<Card {...(titled ? { title: TEXTS.overview.recent } : {})}>
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
function StatusBanner({ status }) {
	const text = fill(TEXTS.status[/** @type {keyof typeof TEXTS.status} */ (status.status)] ?? status.status, {
		time: formatDateTime(status.graceEndsAt),
	});
	const tone = status.status === 'active' ? 'success' : status.status === 'grace' ? 'warning' : 'danger';
	return <Callout tone={tone}>{text}</Callout>;
}

/** @param {TabProps} props */
function OverviewTab({ websiteId }) {
	const base = `/v1/dashboard/websites/${websiteId}`;
	const { answer, reload } = useLoad(`${base}/overview`);
	const [busy, setBusy] = useState(false);
	return (
		<Loaded answer={answer}>
			{(data) => {
				/** @type {Array<{ name: string, label: string, status: string, message?: string }>} */
				const needed = data.checklist.connections;
				const ready = needed.filter((item) => item.status === 'connected').length;
				return (
					<div className="space-y-8">
						<StatusBanner status={data.status} />
						<Section title={TEXTS.overview.numbers} description={TEXTS.overview.numbersHelp}>
							<StatGrid>
								<Stat
									label={TEXTS.overview.today}
									value={formatCredits(data.todayMillicredits)}
									icon="coins"
									kind="credit"
								/>
								<Stat
									label={TEXTS.overview.features}
									value={data.featuresOn.length}
									hint={data.featuresOn.length > 0 ? namesOf(data.featuresOn, 3) : TEXTS.overview.noFeatures}
									icon="zap"
									kind="feature"
								/>
								<Stat
									label={TEXTS.overview.connectionsReady}
									value={fill(TEXTS.overview.ofTotal, { count: ready, total: needed.length })}
									tone={ready < needed.length ? 'warning' : 'success'}
									icon="plug"
									kind="connection"
								/>
							</StatGrid>
						</Section>
						<Section title={TEXTS.overview.setup} description={TEXTS.overview.setupHelp}>
							<Card>
								<ul className="divide-y divide-line-soft text-sm">
									{needed.map((item) => (
										<CheckRow
											key={item.name}
											tone={toneOf(item.status)}
											badge={TEXTS.connections[/** @type {'connected'} */ (item.status)]}
											label={item.label}
											detail={item.message}
										/>
									))}
									{data.checklist.widget ? (
										<CheckRow
											tone={data.checklist.widget.installed ? 'success' : 'warning'}
											badge={
												data.checklist.widget.installed
													? fill(TEXTS.overview.widgetSeen, {
															time: formatDateTime(data.checklist.widget.lastSeenAt),
														})
													: TEXTS.overview.widgetMissing
											}
											label={TEXTS.overview.widget}
										/>
									) : null}
									<CheckRow
										tone={data.checklist.business.found ? 'success' : 'warning'}
										badge={
											data.checklist.business.found ? TEXTS.overview.businessFound : TEXTS.overview.businessMissing
										}
										label={TEXTS.overview.business}>
										<Button
											size="sm"
											variant="secondary"
											loading={busy}
											onClick={async () => {
												setBusy(true);
												await call('POST', `${base}/business/refresh`);
												setBusy(false);
												reload();
											}}>
											{TEXTS.overview.refresh}
										</Button>
									</CheckRow>
								</ul>
							</Card>
						</Section>
						<Section title={TEXTS.overview.changes} description={TEXTS.overview.changesHelp}>
							<RecentChanges items={data.recentChanges} titled={false} />
						</Section>
					</div>
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
 * Settings forms, one card per feature that has settings, each with its own Save and outcome: a website's settings or
 * the global defaults.
 * @param {{ features: Array<{ key: string, name: string, on?: boolean, schema: any, values: Record<string, { value: unknown, source: string }> }>,
 *   saveUrl: (key: string) => string, resetBody: boolean, savedSource: string, reload: () => void }} props
 *   `resetBody`: reset with `PUT { value: null }` (defaults) instead of `DELETE`
 */
function SettingsForms({ features, saveUrl, resetBody, savedSource, reload }) {
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
 * The widgets' theme (one per website): light or dark, font, corner radius, accent colour and custom CSS.
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
 * How money and dates look in the widgets, messages, invoices and hosted pages (one Format per website, PLAN 0.8.10 K7).
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
					placeholder="en-GB"
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
function SettingsTab({ websiteId }) {
	const base = `/v1/dashboard/websites/${websiteId}`;
	const settings = useLoad(`${base}/settings`);
	const texts = useLoad(`${base}/texts`);
	const theme = useLoad(`${base}/theme`);
	const format = useLoad(`${base}/format`);
	return (
		<div className="space-y-8">
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
					{data.connections.length === 0 ? <p className="text-sm text-muted">{TEXTS.connections.none}</p> : null}
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
	return (
		<Loaded answer={answer}>
			{(data) => (
				<div className="space-y-8">
					<Card title={TEXTS.tabs.developers}>
						<p className="text-sm">{TEXTS.developers.intro}</p>
						<p className="mt-2 text-sm">{fill(TEXTS.developers.websiteId, { id: String(websiteId) })}</p>
						<p className="mt-2 text-sm">{TEXTS.developers.server}</p>
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
						<CodeBlock code={`<script src="${origin}/widget.js" data-token="YOUR_BROWSER_TOKEN" async></script>`} />
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
						<SettingsForms features={data.features} saveUrl={saveUrl} resetBody savedSource="default" reload={reload} />
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
