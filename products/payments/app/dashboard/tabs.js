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
	Stat,
	TextArea,
	describeProblem,
	formatCredits,
	formatCreditsPerHour,
	formatDateTime,
	parseCredits,
} from '@ss/ui';
import manifest from '../../manifest.json' with { type: 'json' };
import { GATEWAY_CONNECTIONS, GATEWAY_FEATURES, GATEWAYS } from '../../core/gateways.js';
import { callbackUrls, createSnippets } from '../../core/snippets.js';
import { call, fill, useLoad } from './api.js';
import { ConnectionForm, FORMS } from './forms.js';
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

/** @param {{ items: Array<{ who: { name: string }, what: string, detail: string, at: string }> }} props */
function RecentChanges({ items }) {
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
function StatusBanner({ status }) {
	const text = fill(TEXTS.status[/** @type {keyof typeof TEXTS.status} */ (status.status)] ?? status.status, {
		time: formatDateTime(status.graceEndsAt),
	});
	const tone = status.status === 'active' ? 'success' : status.status === 'grace' ? 'warning' : 'danger';
	return <Callout tone={tone}>{text}</Callout>;
}

/**
 * Switched-on gateways whose keys are connected (bank transfer counts while it is on: its details are settings).
 * @param {{ featuresOn: string[], checklist: { connections: Array<{ name: string, status: string }> } }} data
 */
const gatewaysReady = (data) =>
	GATEWAYS.filter((gateway) => {
		if (!data.featuresOn.includes(GATEWAY_FEATURES[gateway])) return false;
		const name = GATEWAY_CONNECTIONS[gateway];
		return name === null || data.checklist.connections.some((item) => item.name === name && item.status === 'connected');
	}).length;

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
							<div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
								<Stat
									label={TEXTS.overview.today}
									value={formatCredits(data.todayMillicredits)}
									icon="coins"
									kind="credit"
								/>
								<Stat
									label={TEXTS.overview.features}
									value={data.featuresOn.length}
									hint={data.featuresOn.length > 0 ? data.featuresOn.join(', ') : TEXTS.overview.noFeatures}
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
								<Stat
									label={TEXTS.overview.gateways}
									value={gatewaysReady(data)}
									hint={TEXTS.overview.gatewaysHelp}
									icon="coins"
									kind="connection"
								/>
							</div>
						</Section>
						<Section title={TEXTS.overview.setup} description={TEXTS.overview.setupHelp}>
							<Card>
								<ul className="space-y-3 text-sm">
									{needed.map((item) => (
										<li key={item.name} className="flex flex-wrap items-center gap-2">
											<Badge
												tone={
													item.status === 'connected'
														? 'success'
														: item.status === 'test_failed'
															? 'danger'
															: 'warning'
												}
												dot>
												{TEXTS.connections[/** @type {'connected'} */ (item.status)]}
											</Badge>
											<span className="font-semibold">{item.label}</span>
											{item.message ? <span className="text-muted">{item.message}</span> : null}
										</li>
									))}
									<li className="flex flex-wrap items-center gap-2">
										<Badge tone={data.checklist.business.found ? 'success' : 'warning'} dot>
											{data.checklist.business.found ? TEXTS.overview.businessFound : TEXTS.overview.businessMissing}
										</Badge>
										<span className="font-semibold">{TEXTS.overview.business}</span>
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
									</li>
									{data.checklist.widget ? (
										<li className="flex flex-wrap items-center gap-2">
											<Badge tone={data.checklist.widget.installed ? 'success' : 'warning'} dot>
												{data.checklist.widget.installed
													? fill(TEXTS.overview.widgetSeen, {
															time: formatDateTime(data.checklist.widget.lastSeenAt),
														})
													: TEXTS.overview.widgetMissing}
											</Badge>
											<span className="font-semibold">{TEXTS.overview.widget}</span>
										</li>
									) : null}
								</ul>
							</Card>
						</Section>
						<Section title={TEXTS.overview.changes} description={TEXTS.overview.changesHelp}>
							<RecentChanges items={data.recentChanges} />
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
						<Masonry>
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
												{fill(TEXTS.features.needs, { features: feature.dependsOn.join(', ') })}
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
							{turnedOff.length > 0 ? <p>{fill(TEXTS.features.alsoOff, { features: turnedOff.join(', ') })}</p> : null}
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
	const [result, setResult] = useState(/** @type {import('./api.js').Answer | null} */ (null));
	return (
		<Card title={TEXTS.settings.texts} subtitle={TEXTS.settings.textsHelp}>
			<div className="space-y-3">
				{texts.map((text) => (
					<div key={text.key} className="flex flex-wrap items-end gap-2">
						<Input
							fieldClassName="min-w-64 flex-1"
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

/** @param {TabProps} props */
function SettingsTab({ websiteId }) {
	const base = `/v1/dashboard/websites/${websiteId}`;
	const settings = useLoad(`${base}/settings`);
	const texts = useLoad(`${base}/texts`);
	const theme = useLoad(`${base}/theme`);
	return (
		<div className="space-y-8">
			<Section title={TEXTS.settings.featuresTitle} description={TEXTS.settings.featuresHelp}>
				<Masonry>
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
				<Masonry>
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
					<Masonry>
						{data.connections.map((/** @type {any} */ item) => {
							/** @param {unknown} value */
							const save = (value) => act(call('PUT', `${base}/${item.name}`, { value }));
							return (
								<Card
									key={item.name}
									title={item.label}
									subtitle={
										item.neededBy.length > 0
											? fill(TEXTS.connections.neededBy, { features: item.neededBy.join(', ') })
											: TEXTS.connections.neededByNone
									}>
									<p className="flex flex-wrap items-center gap-2 text-sm">
										<Badge
											tone={
												item.status === 'connected' ? 'success' : item.status === 'test_failed' ? 'danger' : 'warning'
											}
											dot>
											{TEXTS.connections[/** @type {'connected'} */ (item.status)]}
										</Badge>
										{item.last4 ? <code>••••{item.last4}</code> : null}
										{item.message ? <span className="text-muted">{item.message}</span> : null}
									</p>
									{item.name in FORMS ? (
										<ConnectionForm name={item.name} onSave={save} />
									) : (
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
									)}
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
	const urls = callbackUrls(origin, String(websiteId));
	return (
		<Loaded answer={answer}>
			{(data) => (
				<div className="space-y-8">
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
					<Section title={TEXTS.developers.api} description={TEXTS.developers.apiHelp}>
						<CodeBlock code={snippets.create} />
						<CodeBlock code={snippets.verify} />
					</Section>
					<Section title={TEXTS.developers.callbacks} description={TEXTS.developers.callbacksHelp}>
						<CodeBlock
							code={Object.entries(urls)
								.map(
									([gateway, url]) =>
										`${gateway}: ${url}${gateway === 'jazzcash' || gateway === 'easypaisa' ? '/<paymentId>' : ''}`,
								)
								.join('\n')}
						/>
					</Section>
					<Section title={TEXTS.developers.events} description={TEXTS.developers.eventsHelp}>
						<CodeBlock code={snippets.webhook} />
					</Section>
					<Section title={TEXTS.developers.more} description={TEXTS.developers.moreHelp}>
						<CodeBlock code={snippets.link} />
						<CodeBlock code={snippets.refund} />
						<CodeBlock code={snippets.subscription} />
					</Section>
					<Section title={TEXTS.developers.widgets} description={TEXTS.developers.widgetsHelp}>
						<CodeBlock code={snippets.visitor} />
						<CodeBlock code={snippets.admin} />
					</Section>
					<Section title={TEXTS.developers.ticket} description={TEXTS.developers.ticketHelp}>
						<CodeBlock code={snippets.ticketNode} />
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
					<Masonry>
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
