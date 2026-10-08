'use client';
/**
 * The dashboard's tabs (PLAN 0.4.3, 0.8.3 Chat dashboard), each on the kit's dashboard API and Chat's list and
 * tool-secret routes. Rights are the kit's: merchants see features read-only and only the settings of switched-on
 * features; Owners and Support switch features; Owners alone edit Defaults and Prices.
 * @module
 */
import { useState } from 'react';
import {
	Badge,
	Button,
	Callout,
	Card,
	Checkbox,
	CodeBlock,
	ConfirmDialog,
	Input,
	Section,
	Stat,
	formatCredits,
	formatCreditsPerHour,
	formatDateTime,
	parseCredits,
} from '@ss/ui';
import manifest from '../../manifest.json' with { type: 'json' };
import { createSnippets } from '../../core/snippets.js';
import { call, fill, useLoad } from './api.js';
import { AiForm, FORMS, StorageForm } from './forms.js';
import { Loaded, Outcome, RecentChanges, SettingsForms, StatusBanner, TextsForm, ThemeForm } from './parts.js';
import { SettingsTab, aiLabelNotice } from './settings.js';
import { TEXTS } from './texts.js';

/** @typedef {{ kind: 'merchant' | 'admin', id: string, name: string, role?: 'owner' | 'support' }} Who */
/** @typedef {{ websiteId: string | null, who: Who, support: { email: string, phone: string }, portal: string }} TabProps */
/** @typedef {{ key: string, name: string, description: string, dependsOn: string[], millicreditsPerHour: number, on?: boolean }} Feature */
/** @typedef {{ name: string, label: string, neededBy: string[], status: string, message?: string, last4?: string | null }} Connection */

/** @param {string} status */
const toneOf = (status) => (status === 'connected' ? 'success' : status === 'test_failed' ? 'danger' : 'warning');

/** @param {TabProps} props */
function OverviewTab({ websiteId }) {
	const base = `/v1/dashboard/websites/${websiteId}`;
	const { answer, reload } = useLoad(`${base}/overview`);
	const settings = useLoad(`${base}/settings`);
	const [busy, setBusy] = useState(false);
	return (
		<Loaded answer={answer}>
			{(data) => {
				/** @type {Connection[]} */
				const needed = data.checklist.connections;
				/** @type {string[]} */
				const on = data.featuresOn;
				const ready = needed.filter((item) => item.status === 'connected').length;
				/** @type {Array<{ key: string, values: Record<string, { value: unknown }> }>} */
				const features = settings.answer?.ok ? settings.answer.data.features : [];
				const bookingUrl = features.find((feature) => feature.key === 'book_slot')?.values.bookingUrl?.value;
				return (
					<div className="space-y-8">
						<StatusBanner status={data.status} />
						<Section title={TEXTS.overview.numbers} description={TEXTS.overview.numbersHelp}>
							<div className="grid gap-4 sm:grid-cols-3">
								<Stat
									label={TEXTS.overview.today}
									value={formatCredits(data.todayMillicredits)}
									icon="coins"
									accent="indigo"
								/>
								<Stat
									label={TEXTS.overview.features}
									value={on.length}
									hint={on.length > 0 ? on.join(', ') : TEXTS.overview.noFeatures}
									icon="zap"
									accent="violet"
								/>
								<Stat
									label={TEXTS.overview.connectionsReady}
									value={fill(TEXTS.overview.ofTotal, { count: ready, total: needed.length })}
									tone={ready < needed.length ? 'warning' : 'success'}
									icon="plug"
									accent="teal"
								/>
							</div>
						</Section>
						<Section title={TEXTS.overview.setup} description={TEXTS.overview.setupHelp}>
							<Card>
								<ul className="space-y-3 text-sm">
									{needed.map((item) => (
										<li key={item.name} className="flex flex-wrap items-center gap-2">
											<Badge tone={toneOf(item.status)} dot>
												{TEXTS.connections[/** @type {'connected'} */ (item.status)]}
											</Badge>
											<span className="font-semibold">{item.label}</span>
											{item.message ? <span className="text-muted">{item.message}</span> : null}
										</li>
									))}
									{on.includes('book_slot') && settings.answer?.ok ? (
										<li className="flex flex-wrap items-center gap-2">
											<Badge tone={bookingUrl ? 'success' : 'warning'} dot>
												{bookingUrl ? TEXTS.overview.bookingSet : TEXTS.overview.bookingMissing}
											</Badge>
											<span className="font-semibold">{TEXTS.overview.booking}</span>
										</li>
									) : null}
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

/**
 * Chat's rules between features (PLAN 0.8.3): no one can start a chat, or no one answers.
 * @param {string[]} on
 */
const ruleWarnings = (on) =>
	on.includes('visitor_chat')
		? [
				...(on.includes('guest_chat') || on.includes('signed_in_chat') ? [] : [TEXTS.features.noOneStarts]),
				...(on.includes('ai_replies') || on.includes('inbox') ? [] : [TEXTS.features.noOneAnswers]),
			]
		: [];

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
				/** @type {Connection[]} */
				const links = connections.answer?.ok ? connections.answer.data.connections : [];
				const warnings = ruleWarnings(on);
				/** @param {Feature} feature @param {boolean} checked */
				const toggle = (feature, checked) => {
					const off = withDependents(features, on, feature.key);
					setPicked(checked ? [...on, feature.key] : on.filter((key) => !off.has(key)));
				};
				return (
					<div className="space-y-4">
						{admin ? null : <Callout tone="info">{fill(TEXTS.features.contact, { contact: support.email })}</Callout>}
						{warnings.map((warning) => (
							<Callout key={warning} tone="warning">
								{warning}
							</Callout>
						))}
						{features.map((feature) => {
							const missing = feature.dependsOn.filter((dep) => !on.includes(dep));
							const broken = links.filter((link) => link.neededBy.includes(feature.key) && link.status !== 'connected');
							return (
								<Card
									key={feature.key}
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
												<p key={link.name} className="text-sm text-danger">
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
							{warnings.map((warning) => (
								<p key={warning}>{warning}</p>
							))}
						</ConfirmDialog>
					</div>
				);
			}}
		</Loaded>
	);
}

/**
 * The one-line help under a connection: what to paste or enter.
 * @param {string} name
 */
const connectionHint = (name) => TEXTS.connections.hints[/** @type {keyof typeof TEXTS.connections.hints} */ (name)] ?? null;

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
					{data.connections.map((/** @type {Connection} */ item) => {
						const hint = connectionHint(item.name);
						/** @param {object} value */
						const save = (value) => void act(call('PUT', `${base}/${item.name}`, { value }));
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
									<Badge tone={toneOf(item.status)} dot>
										{TEXTS.connections[/** @type {'connected'} */ (item.status)]}
									</Badge>
									{item.last4 ? <code>••••{item.last4}</code> : null}
									{item.message ? <span className="text-muted">{item.message}</span> : null}
								</p>
								{hint ? <p className="mt-2 text-sm text-muted">{hint}</p> : null}
								{item.name === 'storage' ? (
									<StorageForm onSave={save} />
								) : FORMS.includes(item.name) ? (
									<AiForm onSave={save} />
								) : (
									<div className="mt-3 flex flex-wrap items-end gap-2">
										<Input
											fieldClassName="min-w-0 flex-1 basis-64"
											label={TEXTS.connections.value}
											type="password"
											autoComplete="off"
											value={values[item.name] ?? ''}
											onChange={(event) => setValues({ ...values, [item.name]: event.target.value })}
										/>
										<Button
											size="sm"
											disabled={!values[item.name]?.trim()}
											onClick={() => {
												void act(call('PUT', `${base}/${item.name}`, { value: values[item.name]?.trim() }));
												setValues({ ...values, [item.name]: '' });
											}}>
											{TEXTS.connections.save}
										</Button>
									</div>
								)}
								<div className="mt-3 flex flex-wrap gap-2">
									<Button
										size="sm"
										variant="secondary"
										onClick={() => void act(call('POST', `${base}/${item.name}/test`))}>
										{TEXTS.connections.test}
									</Button>
									<Button size="sm" variant="ghost" onClick={() => void act(call('DELETE', `${base}/${item.name}`))}>
										{TEXTS.connections.remove}
									</Button>
								</div>
							</Card>
						);
					})}
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
	const D = TEXTS.developers;
	return (
		<Loaded answer={answer}>
			{(data) => (
				<div className="space-y-8">
					<Card title={TEXTS.tabs.developers}>
						<p className="text-sm">{D.intro}</p>
						<ul className="mt-3 flex flex-wrap gap-2 text-sm">
							{data.features.map((/** @type {Feature} */ feature) => (
								<li key={feature.key}>
									<a className="font-semibold text-primary" href={`/docs#feature-${feature.key}`}>
										{feature.name}
									</a>
									{feature.on ? '' : ` (${D.off})`}
								</li>
							))}
						</ul>
						<p className="mt-3 flex flex-wrap gap-4">
							<a className="text-sm font-semibold text-primary" href="/docs">
								{D.openDocs}
							</a>
							<a className="text-sm font-semibold text-primary" href={portal}>
								{D.manageTokens}
							</a>
						</p>
					</Card>
					<Section title={D.visitor} description={D.visitorHelp}>
						<CodeBlock code={snippets.visitor} />
					</Section>
					<Section title={D.admin} description={D.adminHelp}>
						<CodeBlock code={snippets.admin} />
					</Section>
					<Section title={D.ticket} description={D.ticketHelp}>
						<CodeBlock code={snippets.ticketNode} />
						<CodeBlock code={snippets.ticketCurl} />
					</Section>
					<Section title={D.tools} description={D.toolsHelp}>
						<CodeBlock code={snippets.toolCheck} />
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
					<div className="grid gap-4 xl:grid-cols-2">
						<SettingsForms
							features={data.features}
							saveUrl={saveUrl}
							resetBody
							savedSource="default"
							reload={reload}
							notice={aiLabelNotice}
						/>
					</div>
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
							<div className="space-y-3">
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
							</div>
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
