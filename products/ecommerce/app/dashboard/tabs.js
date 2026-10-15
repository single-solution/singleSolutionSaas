'use client';
/**
 * The dashboard's tabs (PLAN 0.4.3, 0.8.8), each on the kit's dashboard API and Ecommerce's list settings. Rights are
 * the kit's: merchants see features read-only and only the settings of switched-on features; Owners and Support switch
 * features; Owners alone edit Defaults and Prices.
 * @module
 */
import { Fragment, useState } from 'react';
import {
	Badge,
	Button,
	ButtonLink,
	Callout,
	Card,
	Checkbox,
	CodeBlock,
	ConfirmDialog,
	FieldGrid,
	Input,
	LocalTime,
	Masonry,
	OverviewSkeleton,
	ProductOverview,
	RecentChanges,
	Section,
	Stat,
	formatCreditsPerHour,
	parseCredits,
} from '@ss/ui';
import manifest from '../../manifest.json' with { type: 'json' };
import { SEARCH_INDEX_DEFINITION } from '../../core/search.js';
import { SITE_ROUTES, createSnippets } from '../../core/snippets.js';
import { call, fill, useLoad } from './api.js';
import { ConnectionForm, FORMS } from './forms.js';
import { FormatForm, Loaded, Outcome, SettingsForms, TextsForm, ThemeForm } from './parts.js';
import { SettingsSections, SettingsTab, settingsNotice } from './settings.js';
import { TEXTS } from './texts.js';

/** @typedef {{ kind: 'merchant' | 'admin', id: string, name: string, role?: 'owner' | 'support' }} Who */
/**
 * What every tab gets: the website, the viewer, the support contact, the Portal's address, and `open`, which shows
 * another section of the dashboard (the Overview's buttons).
 * @typedef {{ websiteId: string | null, who: Who, support: { email: string, phone: string }, portal: string,
 *   open: (tab: import('@ss/ui').OverviewTab) => void }} TabProps
 */
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
 * Fill `{name}` placeholders with text or elements (a `<LocalTime>`), as children.
 * @param {string} text
 * @param {Record<string, import('react').ReactNode>} values
 * @returns {import('react').ReactNode}
 */
const say = (text, values) =>
	text
		.split(/\{(\w+)\}/g)
		.map((part, i) =>
			i % 2 === 0 ? part : Object.hasOwn(values, part) ? <Fragment key={i}>{values[part]}</Fragment> : `{${part}}`,
		);

/**
 * @typedef {{ search: 'basic' | 'atlas', index: string,
 *   state: { missing: boolean, at: string, message: string } | null }} SearchIndex
 */

/**
 * A setting's value and whether the merchant set it (`source` `website`) in the dashboard's settings answer.
 * @param {import('./api.js').Answer | null} answer @param {string} feature @param {string} key
 * @returns {{ value: unknown, set: boolean } | null} null while not loaded or the feature is not shown
 */
const settingOf = (answer, feature, key) => {
	if (!answer?.ok) return null;
	/** @type {{ key: string, values: Record<string, { value: unknown, source: string }> } | undefined} */
	const found = answer.data.features.find((/** @type {{ key: string }} */ item) => item.key === feature);
	const entry = found?.values?.[key];
	return entry ? { value: entry.value, set: entry.source === 'website' } : null;
};

/**
 * Overview (PLAN 0.6 "Overviews talk", 0.4.3): the kit's whole Overview from `@ss/ui` (greeting, Needs you, setup,
 * numbers, Recent changes), with Ecommerce's own part, judged from setup only (no business data): with checkout,
 * Payments (recommended) and Notifications (optional, when no feature needs it), bank transfer offered with staff
 * recording transfers but no bank details for shoppers; with the catalog, the shop's currency until the merchant sets
 * it (USD by default, Claude's decision 9), the Atlas Search index while the shop or Chat searches with Atlas and the
 * public address of the images once storage is connected; with Staff alerts, someone to alert and the admin page they
 * link to; and how many of the connections the features need are ready. `/connections` is read only with checkout or
 * Staff alerts, `/search-index` and `/settings` only with the catalog.
 * @param {TabProps} props
 */
function OverviewTab({ websiteId, who, support, portal, open }) {
	const base = `/v1/dashboard/websites/${websiteId}`;
	const { answer, reload } = useLoad(`${base}/overview`);
	/** @type {string[]} */
	const on = answer?.ok ? answer.data.featuresOn : [];
	const shop = on.includes('checkout');
	const catalog = on.includes('catalog');
	const alertsOn = on.includes('staff_alerts');
	const connections = useLoad(shop || alertsOn ? `${base}/connections` : null);
	const search = useLoad(catalog ? `${base}/search-index` : null);
	const settings = useLoad(catalog ? `${base}/settings` : null);
	const O = TEXTS.overview;
	/** @param {string} label @param {import('@ss/ui').OverviewTab} tab */
	const go = (label, tab) => (
		<Button size="sm" variant="secondary" onClick={() => open(tab)}>
			{label}
		</Button>
	);
	return (
		<Loaded answer={answer} skeleton={<OverviewSkeleton />}>
			{(data) => {
				/** @type {Connection[]} */
				const needed = data.checklist.connections;
				/** @type {Connection[]} */
				const all = connections.answer?.ok ? connections.answer.data.connections : [];
				/** @param {string} name */
				const connection = (name) => [...needed, ...all].find((item) => item.name === name) ?? null;
				// not required by a feature, but what a shop with checkout normally wants
				const payments = shop && !needed.some((item) => item.name === 'payments') ? connection('payments') : null;
				const messages = shop && !needed.some((item) => item.name === 'notifications') ? connection('notifications') : null;
				const ready = needed.filter((item) => item.status === 'connected').length;
				/** @type {import('@ss/ui').Need[]} */
				const needs = [];
				/** @type {NonNullable<Parameters<typeof ProductOverview>[0]['steps']>} */
				const steps = [];
				if (payments) {
					if (payments.status !== 'connected')
						needs.push({
							key: 'payments',
							tone: 'warning',
							title: O.payments.title,
							effect: O.payments.effect,
							action: go(O.payments.action, 'connections'),
						});
					steps.push({
						key: 'payments',
						label: O.payments.step,
						done: payments.status === 'connected',
						onSelect: () => open('connections'),
					});
				}
				if (messages)
					steps.push({
						key: 'notifications',
						label: O.notificationsStep,
						done: messages.status === 'connected',
						onSelect: () => open('connections'),
					});
				// the shop's currency, until the merchant sets it (decision 9: USD stays the default)
				const currency = catalog ? settingOf(settings.answer, 'catalog', 'currency') : null;
				if (currency) {
					const code = String(currency.value ?? '');
					if (!currency.set)
						needs.push({
							key: 'currency',
							tone: 'warning',
							title: O.currency.title,
							effect: fill(O.currency.effect, { currency: code }),
							action: go(O.currency.action, 'settings'),
						});
					steps.push({
						key: 'currency',
						label: O.currency.step,
						done: currency.set,
						detail: fill(O.currency.now, { currency: code }),
						onSelect: () => open('settings'),
					});
				}
				// the Atlas Search index, while the shop or Chat searches with Atlas (E14)
				/** @type {SearchIndex | null} */
				const atlas = catalog && search.answer?.ok && search.answer.data?.search === 'atlas' ? search.answer.data : null;
				if (atlas) {
					const { state, index } = atlas;
					const docs = (
						<ButtonLink size="sm" href="/docs#atlas-search">
							{O.search.docs}
						</ButtonLink>
					);
					if (state?.missing)
						needs.push({
							key: 'search',
							tone: 'warning',
							title: fill(O.search.title, { index }),
							effect: [
								say(O.search.effect, { time: <LocalTime value={state.at} /> }),
								state.message ? ` ${fill(O.search.message, { message: state.message })}` : '',
							],
							action: docs,
						});
					steps.push({
						key: 'search',
						label: fill(O.search.step, { index }),
						done: state !== null && !state.missing,
						detail: !state
							? O.search.unchecked
							: say(state.missing ? O.search.missing : O.search.ready, { time: <LocalTime value={state.at} /> }),
						href: '/docs#atlas-search',
					});
				}
				// the public address of the images, once storage is connected (SEO audit G1)
				const media =
					catalog && connection('storage')?.status === 'connected'
						? settingOf(settings.answer, 'catalog', 'mediaBaseUrl')
						: null;
				if (media) {
					const address = String(media.value ?? '');
					if (!address)
						needs.push({
							key: 'media',
							tone: 'warning',
							title: O.media.title,
							effect: O.media.effect,
							action: go(O.media.action, 'settings'),
						});
					steps.push({
						key: 'media',
						label: O.media.step,
						done: address !== '',
						...(address ? { detail: address } : {}),
						onSelect: () => open('settings'),
					});
				}
				// someone to alert, and the admin page alerts link to (shop health P5-18, setup part)
				if (alertsOn && settings.answer?.ok) {
					const recipients = settingOf(settings.answer, 'staff_alerts', 'recipients')?.value;
					const permission = String(settingOf(settings.answer, 'staff_alerts', 'staffPermission')?.value ?? '');
					const listed = Array.isArray(recipients) && recipients.length > 0;
					const staff = permission !== '' && connection('accounts')?.status === 'connected';
					if (!listed && !staff)
						needs.push({
							key: 'alerts',
							tone: 'warning',
							title: O.alerts.title,
							effect: O.alerts.effect,
							action: go(O.alerts.action, 'settings'),
						});
					if (!String(settingOf(settings.answer, 'staff_alerts', 'adminUrl')?.value ?? '').trim())
						needs.push({
							key: 'admin-url',
							tone: 'warning',
							title: O.adminUrl.title,
							effect: O.adminUrl.effect,
							action: go(O.adminUrl.action, 'settings'),
						});
				}
				// bank transfer offered, recorded by staff, with nothing telling shoppers where to pay
				if (shop && settings.answer?.ok) {
					const methods = settingOf(settings.answer, 'checkout', 'paymentMethods')?.value;
					const manual = settingOf(settings.answer, 'checkout', 'bankTransferVia')?.value === 'manual';
					const note = String(settingOf(settings.answer, 'checkout', 'noteBankTransfer')?.value ?? '').trim();
					if (Array.isArray(methods) && methods.includes('bank_transfer') && manual && !note)
						needs.push({
							key: 'bank',
							tone: 'warning',
							title: O.bank.title,
							effect: O.bank.effect,
							action: go(O.bank.action, 'settings'),
						});
				}
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
						needs={needs}
						steps={steps}
						numbers={
							<Stat
								label={O.connectionsReady}
								value={fill(O.ofTotal, { count: ready, total: needed.length })}
								hint={O.connectionsHint}
								tone={ready < needed.length ? 'warning' : 'success'}
								icon="plug"
								kind="connection"
							/>
						}
					/>
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
				<div className="space-y-6">
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
							<a className="text-sm font-semibold text-primary" href="/docs#catalog-seo">
								{D.catalogSeo}
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
							<CodeBlock code={snippets.listingPage} />
							<CodeBlock code={snippets.policies} />
						</div>
					</Section>
					<Section
						title={D.searchIndex}
						description={fill(D.searchIndexHelp, { collection: 'ss_ecommerce_products' })}
						actions={
							<a className="text-sm font-semibold text-primary hover:underline" href="/docs#atlas-search">
								{D.searchIndexDocs}
							</a>
						}>
						<CodeBlock code={JSON.stringify(SEARCH_INDEX_DEFINITION, null, 2)} />
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
							<SettingsForms
								features={shown}
								saveUrl={saveUrl}
								resetBody
								savedSource="default"
								reload={reload}
								notice={settingsNotice}
							/>
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
