'use client';
/**
 * The dashboard's tabs (PLAN 0.4.3, 0.8.8), each on the kit's dashboard API and Ecommerce's list settings. Rights are
 * the kit's: merchants see features read-only and only the settings of switched-on features; Owners and Support switch
 * features; Owners alone edit Defaults and Prices.
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
	FieldGrid,
	Input,
	Masonry,
	Section,
	Stat,
	StatGrid,
	formatCredits,
	formatCreditsPerHour,
	formatDateTime,
	parseCredits,
} from '@ss/ui';
import manifest from '../../manifest.json' with { type: 'json' };
import { SITE_ROUTES, createSnippets } from '../../core/snippets.js';
import { call, fill, useLoad } from './api.js';
import { ConnectionForm, FORMS } from './forms.js';
import { FormatForm, Loaded, Outcome, RecentChanges, SettingsForms, StatusBanner, TextsForm, ThemeForm } from './parts.js';
import { SettingsSections, SettingsTab } from './settings.js';
import { TEXTS } from './texts.js';

/** @typedef {{ kind: 'merchant' | 'admin', id: string, name: string, role?: 'owner' | 'support' }} Who */
/** @typedef {{ websiteId: string | null, who: Who, support: { email: string, phone: string }, portal: string }} TabProps */
/** @typedef {{ key: string, name: string, description: string, dependsOn: string[], millicreditsPerHour: number, on?: boolean }} Feature */
/** @typedef {{ name: string, label: string, neededBy: string[], status: string, message?: string, last4?: string | null, testedAt?: string | null }} Connection */

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
 * A connection on the checklist: its status, what needs it and, when connected, when its last test passed.
 * @param {{ item: Connection, why: string, extra?: string }} props
 */
function ConnectionRow({ item, why, extra }) {
	const detail =
		item.status === 'connected'
			? item.testedAt
				? fill(TEXTS.overview.lastTest, { time: formatDateTime(item.testedAt) })
				: null
			: (item.message ?? null);
	return (
		<CheckRow
			tone={toneOf(item.status)}
			badge={TEXTS.connections[/** @type {'connected'} */ (item.status)]}
			label={item.label}
			detail={[why ? fill(TEXTS.overview.neededBy, { features: why }) : '', detail ?? ''].filter(Boolean).join(' · ')}>
			{extra ? <Badge tone="neutral">{extra}</Badge> : null}
		</CheckRow>
	);
}

/** @param {TabProps} props */
function OverviewTab({ websiteId }) {
	const base = `/v1/dashboard/websites/${websiteId}`;
	const { answer, reload } = useLoad(`${base}/overview`);
	const connections = useLoad(`${base}/connections`);
	const [busy, setBusy] = useState(false);
	return (
		<Loaded answer={answer}>
			{(data) => {
				/** @type {Connection[]} */
				const needed = data.checklist.connections;
				/** @type {string[]} */
				const on = data.featuresOn;
				/** @type {Connection[]} */
				const all = connections.answer?.ok ? connections.answer.data.connections : [];
				const shop = on.includes('checkout');
				// not required by a feature, but what a shop with checkout normally wants
				const payments = shop ? (all.find((item) => item.name === 'payments') ?? null) : null;
				const messages =
					shop && !needed.some((item) => item.name === 'notifications')
						? (all.find((item) => item.name === 'notifications') ?? null)
						: null;
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
									value={on.length}
									hint={on.length > 0 ? namesOf(on, 3) : TEXTS.overview.noFeatures}
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
										<ConnectionRow
											key={item.name}
											item={item}
											why={
												item.name === 'database'
													? ''
													: namesOf(
															item.neededBy.filter((key) => on.includes(key)),
															3,
														)
											}
										/>
									))}
									{payments ? (
										<ConnectionRow
											item={payments}
											why={TEXTS.overview.paymentsWhy}
											extra={TEXTS.overview.recommended}
										/>
									) : null}
									{messages ? (
										<ConnectionRow item={messages} why={TEXTS.overview.messagesWhy} extra={TEXTS.overview.optional} />
									) : null}
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
				/** @type {Connection[]} */
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
					<Masonry wideAlone>
						{data.connections.map((/** @type {Connection} */ item) => {
							const hint = connectionHint(item.name);
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
									{hint ? <p className="mt-2 text-sm text-muted">{hint}</p> : null}
									{Object.hasOwn(FORMS, item.name) ? (
										<ConnectionForm name={item.name} onSave={save} />
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
	const D = TEXTS.developers;
	return (
		<Loaded answer={answer}>
			{(data) => (
				<div className="space-y-8">
					<Card title={TEXTS.tabs.developers}>
						<p className="text-sm">{D.intro}</p>
						<ul className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm">
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
					<Section title={D.api} description={D.apiHelp}>
						<CodeBlock code={snippets.api} />
					</Section>
					<Section title={D.event} description={D.eventHelp}>
						<CodeBlock code={snippets.addToCartEvent} />
					</Section>
					<Section title={D.admin} description={D.adminHelp}>
						<CodeBlock code={snippets.admin} />
					</Section>
					<Section title={D.ticket} description={D.ticketHelp}>
						<div className="space-y-4">
							<CodeBlock code={snippets.ticketNode} />
							<CodeBlock code={snippets.ticketCurl} />
						</div>
					</Section>
					<Section title={D.site} description={D.siteHelp}>
						<div className="space-y-4">
							{SITE_ROUTES.map((entry) => (
								<CodeBlock key={entry.name} code={snippets.site[entry.name] ?? ''} />
							))}
							<CodeBlock code={snippets.productMeta} />
							<CodeBlock code={snippets.policies} />
						</div>
					</Section>
					<Section title={D.cors} description={D.corsHelp}>
						<CodeBlock code={snippets.cors} />
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
					<SettingsSections
						features={data.features}
						forms={(shown) => (
							<SettingsForms features={shown} saveUrl={saveUrl} resetBody savedSource="default" reload={reload} />
						)}
						extras={{
							texts: (
								<TextsForm
									texts={data.texts}
									saveUrl={(key) => saveUrl(`text.${key}`)}
									resetBody
									savedSource="default"
									reload={reload}
								/>
							),
							theme: (
								<Masonry columns={2} wideAlone>
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
							),
						}}
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
