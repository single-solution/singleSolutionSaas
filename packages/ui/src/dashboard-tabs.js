'use client';
/**
 * The standard tabs of every product dashboard (PLAN 0.4.3), each on the kit's dashboard API. Rights are the kit's:
 * merchants see features read-only and only the settings of switched-on features; Owners and Support switch features;
 * Owners alone edit Defaults and Prices. A product fills in its own parts through each tab's props (its Overview items,
 * settings sections and notices, connection forms and hints, developer sections) or replaces a tab with its own,
 * built from the shared pieces.
 * @module
 */
import { useState } from 'react';
import { Button } from './Button.js';
import { CodeBlock } from './CodeBlock.js';
import { Badge, Callout, Card, Masonry, Section } from './display.js';
import { Checkbox, FieldGrid, Input } from './fields.js';
import { ActionMenu } from './Menu.js';
import { ConfirmDialog } from './overlay.js';
import { OverviewSkeleton, ProductOverview, RecentChanges } from './overview.js';
import { formatCreditsPerHour, parseCredits, supportContact } from './format.js';
import { useDisplayLocale } from './time.js';
import { call, fill, useLoad } from './dashboard-api.js';
import {
	FormatForm,
	Loaded,
	Outcome,
	ResealCard,
	SettingsForms,
	TextsForm,
	ThemeForm,
	toneOf,
	useDashboard,
	withDependents,
} from './dashboard-parts.js';

/** @typedef {import('./dashboard-api.js').Answer} Answer */
/** @typedef {import('./dashboard-parts.js').FeatureSettings} FeatureSettings */
/** @typedef {import('./dashboard-parts.js').SettingsNotice} SettingsNotice */
/** @typedef {import('react').ReactNode} ReactNode */
/** @typedef {{ kind: 'merchant' | 'admin', id: string, name: string, role?: 'owner' | 'support' }} Who */
/**
 * What every tab is given: the picked website (null on the Owner's global tabs) and its domain, the viewer, the
 * support contact, the Portal's address, and `open`, which shows another section (the Overview's buttons).
 * @typedef {{ websiteId: string | null, domain: string, who: Who,
 *   support: { channels: import('./format.js').SupportChannel[] }, portal: string, open: (tab: string) => void }} TabProps
 */
/** @typedef {{ key: string, name: string, description: string, dependsOn: string[], millicreditsPerHour: number, on?: boolean }} Feature */
/**
 * One connection of a website (`GET …/connections`).
 * @typedef {{ name: string, label: string, kind?: string, neededBy: string[], status: string, message?: string,
 *   last4?: string | null }} Connection
 */
/**
 * What a product adds to its Overview: its own "Needs you" items, setup steps, number tiles and sections.
 * @typedef {{ needs?: import('./overview.js').Need[], steps?: import('./overview.js').SetupStep[], numbers?: ReactNode,
 *   children?: ReactNode }} OverviewMore
 */
/**
 * A product's hook that adds its parts to the Overview, from the overview answer (null while loading) and the tab's
 * props; it may load more (`useLoad`, `null` until it knows what).
 * @typedef {(overview: Answer | null, props: TabProps) => OverviewMore} UseOverviewMore
 */

/** @type {UseOverviewMore} */
const useNothingMore = () => ({});

/**
 * Overview (PLAN 0.6 "Overviews talk", 0.4.3): the kit's whole Overview (`ProductOverview`) — the greeting, what needs
 * the viewer with its buttons, the setup checklist, today's cost and the features on, Recent changes — with the
 * product's own parts from `useMore`.
 * @param {TabProps & { useMore?: UseOverviewMore }} props
 */
export function OverviewTab(props) {
	const { websiteId, who, support, portal, open, useMore = useNothingMore } = props;
	const { texts, namesOf } = useDashboard();
	const base = `/v1/dashboard/websites/${websiteId}`;
	const { answer, reload } = useLoad(`${base}/overview`);
	const more = useMore(answer, props);
	return (
		<Loaded answer={answer} skeleton={<OverviewSkeleton />}>
			{(data) => (
				<ProductOverview
					data={data}
					who={who}
					product={texts.title}
					support={support}
					portal={portal}
					namesOf={namesOf}
					open={open}
					recheck={async () => {
						await call('POST', `${base}/business/refresh`);
						reload();
					}}
					{...more}
				/>
			)}
		</Loaded>
	);
}

/**
 * Features: one card per feature with its price, what it needs and its connections that do not work; admins switch
 * them (switching one off switches off the features that need it) and confirm the new hourly cost. `warnings` gives
 * the product's warnings for the features picked (shown above the cards and in the confirmation).
 * @param {TabProps & { warnings?: (on: string[]) => string[] }} props
 */
export function FeaturesTab({ websiteId, who, support, warnings }) {
	const { texts, namesOf } = useDashboard();
	const locale = useDisplayLocale();
	const F = texts.features;
	const base = `/v1/dashboard/websites/${websiteId}`;
	const { answer, reload } = useLoad(`${base}/features`);
	const connections = useLoad(`${base}/connections`);
	const [picked, setPicked] = useState(/** @type {string[] | null} */ (null));
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState(/** @type {Answer | null} */ (null));
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
				const warned = warnings ? warnings(on) : [];
				/** @param {Feature} feature @param {boolean} checked */
				const toggle = (feature, checked) => {
					const off = withDependents(features, on, feature.key);
					setPicked(checked ? [...on, feature.key] : on.filter((key) => !off.has(key)));
				};
				return (
					<div className="space-y-4">
						{admin ? null : <Callout tone="info">{fill(F.contact, { contact: supportContact(support) })}</Callout>}
						{warned.map((warning) => (
							<Callout key={warning} tone="warning">
								{warning}
							</Callout>
						))}
						<Masonry wideAlone>
							{features.map((feature) => {
								const missing = feature.dependsOn.filter((dep) => !on.includes(dep));
								const broken = links.filter((link) => link.neededBy.includes(feature.key) && link.status !== 'connected');
								return (
									<Card
										key={feature.key}
										bodyClassName="space-y-3"
										title={feature.name}
										subtitle={fill(F.price, { price: formatCreditsPerHour(feature.millicreditsPerHour, { locale }) })}
										actions={
											<a className="text-sm font-semibold text-primary" href={`/docs#feature-${feature.key}`}>
												{F.docs}
											</a>
										}>
										<p className="text-sm">{feature.description}</p>
										{feature.dependsOn.length > 0 ? (
											<p className="text-sm text-muted">{fill(F.needs, { features: namesOf(feature.dependsOn) })}</p>
										) : null}
										{feature.on
											? broken.map((link) => (
													<p key={link.name} className="text-sm text-danger">
														{fill(F.notWorking, { connection: link.label })}
													</p>
												))
											: null}
										<Checkbox
											label={F.on}
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
								{texts.save}
							</Button>
						) : null}
						<Outcome result={result} />
						<ConfirmDialog
							open={confirming}
							busy={busy}
							title={F.confirmTitle}
							confirmLabel={texts.save}
							cancelLabel={texts.cancel}
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
							<p>{fill(F.confirmCost, { cost: formatCreditsPerHour(cost, { locale }) })}</p>
							{turnedOff.length > 0 ? <p>{fill(F.alsoOff, { features: namesOf(turnedOff) })}</p> : null}
							{warned.map((warning) => (
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
 * Settings: the product's own `sections` first, then the features' settings forms (with the product's `notice` and
 * its `featureCards` beside them), then the widget texts, theme and Format.
 * @param {TabProps & { sections?: ReactNode, notice?: SettingsNotice,
 *   featureCards?: (features: FeatureSettings[]) => ReactNode }} props
 */
export function SettingsTab({ websiteId, sections, notice, featureCards }) {
	const { texts: words } = useDashboard();
	const S = words.settings;
	const base = `/v1/dashboard/websites/${websiteId}`;
	const settings = useLoad(`${base}/settings`);
	const texts = useLoad(`${base}/texts`);
	const theme = useLoad(`${base}/theme`);
	const format = useLoad(`${base}/format`);
	return (
		<div className="space-y-6">
			{sections}
			<Section title={S.featuresTitle} description={S.featuresHelp}>
				<Masonry wideAlone>
					<Loaded answer={settings.answer}>
						{(data) => (
							<>
								<SettingsForms
									features={data.features}
									saveUrl={(key) => `${base}/settings/${encodeURIComponent(key)}`}
									resetBody={false}
									savedSource="website"
									reload={settings.reload}
									{...(notice ? { notice } : {})}
								/>
								{featureCards ? featureCards(data.features) : null}
							</>
						)}
					</Loaded>
				</Masonry>
			</Section>
			<Section title={S.looksTitle} description={S.looksHelp}>
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

/**
 * Connections: one card per connection with its status, a value to save (and test), Test, and Remove in its ⋯ menu
 * once something is saved (after a confirmation). `form` gives the product's own form for a connection (null: the
 * one value field); `hint` its help line under the status.
 * @param {TabProps & { form?: (item: Connection, save: (value: unknown) => Promise<void>) => ReactNode,
 *   hint?: (name: string) => ReactNode }} props
 */
export function ConnectionsTab({ websiteId, form, hint }) {
	const { texts, namesOf } = useDashboard();
	const C = texts.connections;
	const base = `/v1/dashboard/websites/${websiteId}/connections`;
	const { answer, reload } = useLoad(base);
	const [values, setValues] = useState(/** @type {Record<string, string>} */ ({}));
	const [result, setResult] = useState(/** @type {Answer | null} */ (null));
	const [removing, setRemoving] = useState(/** @type {{ name: string, label: string } | null} */ (null));
	/** @param {Promise<Answer>} pending */
	const act = async (pending) => {
		setResult(await pending);
		reload();
	};
	return (
		<Loaded answer={answer}>
			{(data) => (
				<div className="space-y-4">
					{data.connections.length === 0 ? <p className="text-sm text-muted">{C.none}</p> : null}
					<Masonry wideAlone>
						{data.connections.map((/** @type {Connection} */ item) => {
							/** @param {unknown} value */
							const save = (value) => act(call('PUT', `${base}/${item.name}`, { value }));
							const own = form ? form(item, save) : null;
							const help = hint ? hint(item.name) : null;
							return (
								<Card
									key={item.name}
									title={item.label}
									subtitle={
										item.neededBy.length > 0
											? fill(C.neededBy, { features: namesOf(item.neededBy, 4) })
											: C.neededByNone
									}>
									<p className="flex flex-wrap items-center gap-2 text-sm">
										<Badge tone={toneOf(item.status)} dot>
											{C[/** @type {'connected'} */ (item.status)]}
										</Badge>
										{item.last4 ? <code>••••{item.last4}</code> : null}
										{item.message ? <span className="text-muted">{item.message}</span> : null}
									</p>
									{help ? <p className="mt-2 text-sm text-muted">{help}</p> : null}
									{own ?? (
										<div className="mt-3 flex flex-wrap items-end gap-2">
											<Input
												fieldClassName="min-w-0 flex-1 basis-64"
												label={item.kind === 'token' ? C.token : C.value}
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
												{C.save}
											</Button>
										</div>
									)}
									<div className="mt-3 flex flex-wrap gap-2">
										<Button
											size="sm"
											variant="secondary"
											onClick={() => act(call('POST', `${base}/${item.name}/test`))}>
											{C.test}
										</Button>
										{item.status === 'not_connected' ? null : (
											<ActionMenu
												label={fill(C.more, { name: item.label })}
												items={[
													{
														label: C.remove,
														danger: true,
														onSelect: () => setRemoving({ name: item.name, label: item.label }),
													},
												]}
											/>
										)}
									</div>
								</Card>
							);
						})}
					</Masonry>
					<Outcome result={result} />
					<ConfirmDialog
						open={removing !== null}
						title={fill(C.removeTitle, { name: removing?.label ?? '' })}
						confirmLabel={C.remove}
						cancelLabel={texts.cancel}
						danger
						onClose={() => setRemoving(null)}
						onConfirm={async () => {
							const name = removing?.name ?? '';
							setRemoving(null);
							await act(call('DELETE', `${base}/${name}`));
						}}>
						<p>{C.removeHelp}</p>
					</ConfirmDialog>
				</div>
			)}
		</Loaded>
	);
}

/**
 * Developers: the docs of every feature (off ones marked), this website's id, the server token, the Portal's tokens and
 * the product's `links` beside them; then the product's own sections (`children`), by default the widget script.
 * @param {TabProps & { links?: ReactNode, children?: ReactNode }} props
 */
export function DevelopersTab({ websiteId, portal, links, children }) {
	const { texts } = useDashboard();
	const D = texts.developers;
	const { answer } = useLoad(`/v1/dashboard/websites/${websiteId}/features`);
	const origin = typeof window === 'undefined' ? '' : window.location.origin;
	return (
		<Loaded answer={answer}>
			{(data) => (
				<div className="space-y-6">
					<Card title={texts.tabs.developers}>
						<p className="text-sm">{D.intro}</p>
						<p className="mt-2 text-sm">{fill(D.websiteId, { id: String(websiteId) })}</p>
						<p className="mt-2 text-sm">{D.server}</p>
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
							{links}
							<a className="text-sm font-semibold text-primary" href={portal}>
								{D.manageTokens}
							</a>
						</p>
					</Card>
					{children ?? (
						<Section title={D.script} description={D.scriptHelp}>
							<CodeBlock code={`<script src="${origin}/widget.js" data-token="YOUR_BROWSER_TOKEN" async></script>`} />
						</Section>
					)}
				</div>
			)}
		</Loaded>
	);
}

/**
 * Defaults (Owner): the global defaults of every feature's settings (with the product's `notice`), the widget texts,
 * theme and Format, and their Recent changes.
 * @param {Partial<TabProps> & { notice?: SettingsNotice }} props
 */
export function DefaultsTab({ notice }) {
	const { texts } = useDashboard();
	const { answer, reload } = useLoad('/v1/dashboard/defaults');
	/** @param {string} key */
	const saveUrl = (key) => `/v1/dashboard/defaults/${encodeURIComponent(key)}`;
	return (
		<Loaded answer={answer}>
			{(data) => (
				<div className="space-y-4">
					<Callout tone="info">{texts.defaults.intro}</Callout>
					<Masonry wideAlone>
						<SettingsForms
							features={data.features}
							saveUrl={saveUrl}
							resetBody
							savedSource="default"
							reload={reload}
							{...(notice ? { notice } : {})}
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

/** Prices (Owner): one hourly price per feature, in credits, for every merchant and website; Re-seal; Recent changes. */
export function PricesTab() {
	const { texts } = useDashboard();
	const { answer, reload } = useLoad('/v1/dashboard/prices');
	const [draft, setDraft] = useState(/** @type {Record<string, string>} */ ({}));
	const [result, setResult] = useState(/** @type {Answer | null} */ (null));
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
						<Callout tone="info">{texts.prices.intro}</Callout>
						<Card>
							<FieldGrid>
								{parsed.map(({ feature, text, credits }) => (
									<Input
										key={feature.key}
										label={feature.name}
										help={texts.prices.perHour}
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
								{texts.save}
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
