'use client';
/**
 * The standard tabs of every product dashboard (PLAN 0.4.3), each on the kit's dashboard API. Rights are the kit's:
 * merchants see features read-only and only the settings of switched-on features; Owners and Support switch features;
 * Owners alone edit Defaults and Prices. A product fills in its own parts through each tab's props (its Overview items,
 * settings lists and notices, connection forms and hints, developer sections) or replaces a tab with its own, built
 * from the shared pieces.
 *
 * Every tab with more than a couple of cards has an inner sidebar and shows ONE view at a time (owner 2026-10-16: no
 * long scrolls): Features by category, Settings by feature (grouped by category), Texts by screen or widget, Theme &
 * format by Colors / Type / Shapes / Formats, Connections one per connection, Developers and Prices by section.
 * @module
 */
import { useState } from 'react';
import { Button } from './Button.js';
import { CodeBlock } from './CodeBlock.js';
import { Badge, Callout, Card, StatusPill, TextLink } from './display.js';
import { SaveBar, SectionLayout, SettingList, SettingsCard, ViewTitle } from './blocks.js';
import { Input, Switch } from './fields.js';
import { ActionMenu } from './Menu.js';
import { ConfirmDialog } from './overlay.js';
import { OverviewSkeleton, ProductOverview, RecentChanges } from './overview.js';
import { Paged } from './paged.js';
import { ListRow, RowList } from './rows.js';
import { formatCreditsPerHour, parseCredits, supportContact } from './format.js';
import { useDisplayLocale } from './time.js';
import { call, fill, useLoad } from './dashboard-api.js';
import { Loaded, Outcome, ResealCard, toneOf, useDashboard, withDependents } from './dashboard-parts.js';
import {
	LookBar,
	NothingToShow,
	SettingsBar,
	TextsCard,
	featureSections,
	lookSections,
	textSections,
	useLookEditor,
	useSettingsEditor,
	useTextsEditor,
} from './dashboard-settings.js';

/** @typedef {import('./dashboard-api.js').Answer} Answer */
/** @typedef {import('./dashboard-parts.js').FeatureSettings} FeatureSettings */
/** @typedef {import('./dashboard-parts.js').SettingsNotice} SettingsNotice */
/** @typedef {import('./dashboard-settings.js').FeatureExtra} FeatureExtra */
/** @typedef {import('./blocks.js').SectionSpec} SectionSpec */
/** @typedef {import('react').ReactNode} ReactNode */
/** @typedef {{ kind: 'merchant' | 'admin', id: string, name: string, role?: 'owner' | 'support' }} Who */
/**
 * What every tab is given: the picked website (null on the Owner's global tabs) and its domain, the viewer, the
 * support contact, the Portal's address, and `open`, which shows another section (the Overview's buttons), at the
 * section of its inner sidebar when one is given (`open('settings', 'catalog.page-addresses')`).
 * @typedef {{ websiteId: string | null, domain: string, who: Who,
 *   support: { channels: import('./format.js').SupportChannel[] }, portal: string,
 *   open: (tab: string, section?: string) => void }} TabProps
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

/** A name as part of an address. @param {string} name */
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

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
 * Features: the inner sidebar lists the categories (most used first, with how many are on), the view is one category's
 * features as rows with their price, what each needs and its switch; admins switch them (switching one off switches
 * off the features that need it) and confirm the new hourly cost. `warnings` gives the product's warnings for the
 * features picked (shown above the list and in the confirmation).
 * @param {TabProps & { warnings?: (on: string[]) => string[] }} props
 */
export function FeaturesTab({ websiteId, who, support, warnings, open }) {
	const { texts, namesOf, byCategory } = useDashboard();
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
				const changed = on.length !== saved.length || on.some((key) => !saved.includes(key));
				const cost = features.reduce((sum, feature) => sum + (on.includes(feature.key) ? feature.millicreditsPerHour : 0), 0);
				/** @type {Connection[]} */
				const links = connections.answer?.ok ? connections.answer.data.connections : [];
				const warned = warnings ? warnings(on) : [];
				const byKey = new Map(features.map((feature) => [feature.key, feature]));
				/** @param {Feature} feature @param {boolean} checked */
				const toggle = (feature, checked) => {
					const off = withDependents(features, on, feature.key);
					setPicked(checked ? [...on, feature.key] : on.filter((key) => !off.has(key)));
				};
				const sections = byCategory(features.map((feature) => feature.key)).map((category) => {
					const list = category.keys.map((key) => /** @type {Feature} */ (byKey.get(key)));
					const count = list.filter((feature) => on.includes(feature.key)).length;
					return {
						id: `category-${slug(category.title)}`,
						label: category.title,
						badge: <Badge>{`${count}/${list.length}`}</Badge>,
						content: (
							<>
								<ViewTitle title={category.title} description={fill(F.countOn, { on: count, total: list.length })} />
								<Card padded={false}>
									<RowList inset>
										{list.map((feature) => {
											const missing = feature.dependsOn.filter((dep) => !on.includes(dep));
											const broken = links.filter(
												(link) => link.neededBy.includes(feature.key) && link.status !== 'connected',
											);
											return (
												<ListRow
													key={feature.key}
													wrap
													className="py-4"
													title={feature.name}
													{...(feature.on && broken.length > 0
														? {
																status: (
																	<StatusPill
																		status="setup"
																		title={broken
																			.map((link) => fill(F.notWorking, { connection: link.label }))
																			.join(' · ')}>
																		{F.needsSetup}
																	</StatusPill>
																),
															}
														: {})}
													meta={
														<>
															<span className="block max-w-[40rem]">{feature.description}</span>
															<span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
																<span>
																	{fill(F.price, {
																		price: formatCreditsPerHour(feature.millicreditsPerHour, { locale }),
																	})}
																</span>
																{feature.dependsOn.length > 0 ? (
																	<span>{fill(F.needs, { features: namesOf(feature.dependsOn) })}</span>
																) : null}
																<TextLink className="font-medium" href={`/docs#feature-${feature.key}`}>
																	{F.docs}
																</TextLink>
															</span>
														</>
													}
													action={
														<Switch
															size="sm"
															hideLabel
															label={feature.name}
															checked={on.includes(feature.key)}
															disabled={!admin || (missing.length > 0 && !on.includes(feature.key))}
															onChange={(next) => toggle(feature, next)}
														/>
													}>
													{feature.on && broken.length > 0 ? (
														<div className="flex flex-wrap gap-2">
															{broken.map((link) => (
																<Button
																	key={link.name}
																	size="sm"
																	variant="secondary"
																	title={fill(F.notWorking, { connection: link.label })}
																	// the Connections tab opens on this connection
																	onClick={() => open?.('connections', `connection-${link.name}`)}>
																	{`${F.connect} ${link.label}`}
																</Button>
															))}
														</div>
													) : null}
												</ListRow>
											);
										})}
									</RowList>
								</Card>
							</>
						),
					};
				});
				return (
					<div className="space-y-4">
						{admin ? null : <Callout tone="info">{fill(F.contact, { contact: supportContact(support) })}</Callout>}
						{warned.map((warning) => (
							<Callout key={warning} tone="warning">
								{warning}
							</Callout>
						))}
						<Outcome result={result} />
						<SectionLayout label={texts.tabs.features} sections={sections} />
						{admin ? (
							<SaveBar
								show={changed}
								onSave={() => setConfirming(true)}
								onDiscard={() => setPicked(null)}
								message={F.unsaved}
								saveLabel={texts.save}
							/>
						) : null}
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
 * Settings: the inner sidebar lists the switched-on features that have settings, grouped by category (a feature that
 * is off, or whose needs are off, is not listed); the view is that feature's settings as cards by group (a feature with
 * many groups lists them as sub-items, its Advanced settings last). The product adds under a feature (`extras`: a node
 * under its settings, or `{ items }`, views of their own such as list editors) and its own `sections` after the features
 * (not tied to a feature), and a `notice` above a feature's cards.
 * @param {TabProps & { sections?: SectionSpec[], notice?: SettingsNotice, extras?: Record<string, FeatureExtra> }} props
 */
export function SettingsTab({ websiteId, sections, notice, extras }) {
	const base = `/v1/dashboard/websites/${websiteId}`;
	const settings = useLoad(`${base}/settings`);
	return (
		<Loaded answer={settings.answer}>
			{(data) => (
				<SettingsPanel
					features={data.features}
					base={base}
					reload={settings.reload}
					{...(sections ? { sections } : {})}
					{...(notice ? { notice } : {})}
					{...(extras ? { extras } : {})}
				/>
			)}
		</Loaded>
	);
}

/**
 * @param {{ features: FeatureSettings[], base: string, reload: () => void, sections?: SectionSpec[],
 *   notice?: SettingsNotice, extras?: Record<string, FeatureExtra> }} props
 */
function SettingsPanel({ features, base, reload, sections = [], notice, extras }) {
	const dash = useDashboard();
	const editor = useSettingsEditor({
		saveUrl: (key) => `${base}/settings/${encodeURIComponent(key)}`,
		resetBody: false,
		reload,
	});
	const list = [
		...featureSections({
			features,
			editor,
			savedSource: 'website',
			dash,
			hideOff: true,
			...(notice ? { notice } : {}),
			...(extras ? { extras } : {}),
		}),
		...sections,
	];
	return (
		<>
			<SectionLayout
				label={dash.texts.tabs.settings}
				sections={list}
				searchLabel={dash.texts.settings.navSearch}
				empty={<NothingToShow>{dash.texts.settings.nothingOn}</NothingToShow>}
			/>
			<SettingsBar editor={editor} texts={dash.texts} />
		</>
	);
}

/**
 * Texts: every word the widgets show. The inner sidebar lists the screens and widgets (a text's key starts with its
 * screen), a search box above finds a text by its words in all of them. Each text saves on its own.
 * @param {TabProps} props
 */
export function TextsTab({ websiteId }) {
	const base = `/v1/dashboard/websites/${websiteId}`;
	const texts = useLoad(`${base}/texts`);
	return (
		<Loaded answer={texts.answer}>
			{(data) => (
				<TextsPanel
					items={data.texts}
					saveUrl={(key) => `${base}/texts/${encodeURIComponent(key)}`}
					resetBody={false}
					savedSource="website"
					reload={texts.reload}
				/>
			)}
		</Loaded>
	);
}

/**
 * The texts' search and sidebar (a website's or the global defaults).
 * @param {{ items: Array<{ key: string, english: string, value: string, source: string }>, saveUrl: (key: string) => string,
 *   resetBody: boolean, savedSource: string, reload: () => void }} props
 */
function TextsPanel({ items, saveUrl, resetBody, savedSource, reload }) {
	const dash = useDashboard();
	const T = dash.texts.texts;
	const editor = useTextsEditor({ saveUrl, resetBody, reload });
	const [query, setQuery] = useState('');
	const needle = query.trim().toLowerCase();
	const found = needle
		? items.filter((text) => `${text.key} ${text.english} ${text.value}`.toLowerCase().includes(needle))
		: items;
	return (
		<div className="space-y-4">
			<Input
				fieldClassName="max-w-sm"
				label={T.search}
				hideLabel
				placeholder={T.search}
				type="search"
				value={query}
				onChange={(event) => setQuery(event.target.value)}
				layout="stack"
			/>
			{needle ? (
				<TextsCard
					items={found}
					editor={editor}
					savedSource={savedSource}
					texts={dash.texts}
					title={T.results}
					searchable={false}
				/>
			) : (
				<SectionLayout
					label={dash.texts.tabs.texts}
					searchFrom={6}
					searchLabel={T.navSearch}
					sections={textSections({ items, editor, savedSource, dash })}
				/>
			)}
		</div>
	);
}

/**
 * Theme & format: the inner sidebar has Colors, Type, Shapes and Formats; one Save changes bar saves whichever changed.
 * @param {TabProps} props
 */
export function LookTab({ websiteId }) {
	const base = `/v1/dashboard/websites/${websiteId}`;
	const theme = useLoad(`${base}/theme`);
	const format = useLoad(`${base}/format`);
	return (
		<Loaded answer={theme.answer}>
			{(themeData) => (
				<Loaded answer={format.answer}>
					{(formatData) => (
						<LookPanel
							theme={themeData.theme}
							format={formatData.format}
							saveTheme={(next) => call('PUT', `${base}/theme`, next)}
							saveFormat={(next) => call('PUT', `${base}/format`, next)}
							reload={() => {
								theme.reload();
								format.reload();
							}}
						/>
					)}
				</Loaded>
			)}
		</Loaded>
	);
}

/**
 * @param {Parameters<typeof useLookEditor>[0]} props
 */
function LookPanel(props) {
	const dash = useDashboard();
	const editor = useLookEditor(props);
	return (
		<>
			<SectionLayout label={dash.texts.tabs.look} sections={lookSections({ editor, dash })} />
			<LookBar editor={editor} texts={dash.texts} />
		</>
	);
}

/**
 * Connections: the inner sidebar lists the connections with their state; the view is one connection with its status, a
 * value to save (and test), Test, and Remove in its ⋯ menu once something is saved (after a confirmation). `form`
 * gives the product's own form for a connection (null: the one value field); `hint` its help line under the status.
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
			{(data) => {
				/** @type {Connection[]} */
				const connections = data.connections;
				const sections = connections.map((item) => {
					/** @param {unknown} value */
					const save = (value) => act(call('PUT', `${base}/${item.name}`, { value }));
					const own = form ? form(item, save) : null;
					const help = hint ? hint(item.name) : null;
					const tone = toneOf(item.status);
					return {
						id: `connection-${item.name}`,
						label: item.label,
						icon: /** @type {const} */ ('plug'),
						badge: (
							<span
								role="img"
								aria-label={String(C[/** @type {'connected'} */ (item.status)])}
								className={`size-2 rounded-full ${tone === 'success' ? 'bg-success' : tone === 'danger' ? 'bg-danger' : 'bg-warning'}`}
							/>
						),
						content: (
							<>
								<ViewTitle
									title={item.label}
									description={
										item.neededBy.length > 0
											? fill(C.neededBy, { features: namesOf(item.neededBy, 4) })
											: C.neededByNone
									}
								/>
								<Card>
									<p className="flex flex-wrap items-center gap-2 text-sm">
										<Badge tone={tone} dot>
											{C[/** @type {'connected'} */ (item.status)]}
										</Badge>
										{item.last4 ? <code>••••{item.last4}</code> : null}
										{item.message ? <span className="text-muted">{item.message}</span> : null}
									</p>
									{help ? <p className="mt-2 text-help text-muted">{help}</p> : null}
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
							</>
						),
					};
				});
				return (
					<div className="space-y-4">
						<Outcome result={result} />
						<SectionLayout
							label={texts.tabs.connections}
							sections={sections}
							empty={<p className="text-sm text-muted">{C.none}</p>}
						/>
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
				);
			}}
		</Loaded>
	);
}

/**
 * Developers: the inner sidebar has Start here (this website's id, the server token, the Portal's tokens and the
 * product's `links`), the product's own `sections` (by default the widget script), and the docs of every feature (off
 * ones marked, searchable).
 * @param {TabProps & { links?: ReactNode, sections?: SectionSpec[], children?: ReactNode }} props
 */
export function DevelopersTab({ websiteId, portal, links, sections, children }) {
	const { texts } = useDashboard();
	const D = texts.developers;
	const { answer } = useLoad(`/v1/dashboard/websites/${websiteId}/features`);
	const origin = typeof window === 'undefined' ? '' : window.location.origin;
	return (
		<Loaded answer={answer}>
			{(data) => {
				/** @type {Feature[]} */
				const features = data.features;
				/** @type {SectionSpec[]} */
				const own = sections ?? [
					{
						id: 'script',
						label: D.script,
						icon: 'code',
						content: (
							<>
								<ViewTitle title={D.script} description={D.scriptHelp} />
								<CodeBlock code={`<script src="${origin}/widget.js" data-token="YOUR_BROWSER_TOKEN" async></script>`} />
							</>
						),
					},
				];
				return (
					<SectionLayout
						label={texts.tabs.developers}
						sections={[
							{
								id: 'start',
								label: D.start,
								icon: 'home',
								content: (
									<>
										<ViewTitle title={D.start} description={D.intro} />
										<Card>
											<p className="text-sm">{fill(D.websiteId, { id: String(websiteId) })}</p>
											<p className="mt-2 text-sm">{D.server}</p>
											<p className="mt-3 flex flex-wrap gap-4">
												<TextLink className="text-sm" href="/docs">
													{D.openDocs}
												</TextLink>
												{links}
												<TextLink className="text-sm" href={portal}>
													{D.manageTokens}
												</TextLink>
											</p>
										</Card>
									</>
								),
							},
							...own,
							...(children
								? [{ id: 'more', label: D.more, icon: /** @type {const} */ ('layers'), content: children }]
								: []),
							{
								id: 'docs',
								label: D.docs,
								icon: 'external',
								content: (
									<>
										<ViewTitle title={D.docs} description={D.docsHelp} />
										<Card>
											<Paged
												items={features}
												pageSize={10}
												label={D.search}
												text={(feature) => `${feature.name} ${feature.key}`}>
												{(page) => (
													<RowList>
														{page.map((feature) => (
															<ListRow
																key={feature.key}
																wrap
																className="py-2"
																title={
																	<>
																		<TextLink href={`/docs#feature-${feature.key}`}>{feature.name}</TextLink>
																		{feature.on ? '' : ` (${D.off})`}
																	</>
																}
															/>
														))}
													</RowList>
												)}
											</Paged>
										</Card>
									</>
								),
							},
						]}
					/>
				);
			}}
		</Loaded>
	);
}

/**
 * Defaults (Owner): the inner sidebar has the global defaults of every feature's settings (by category, with the
 * product's `notice`), the widget texts by screen, the theme and Format, and Recent changes.
 * @param {Partial<TabProps> & { notice?: SettingsNotice }} props
 */
export function DefaultsTab({ notice }) {
	const { texts } = useDashboard();
	const { answer, reload } = useLoad('/v1/dashboard/defaults');
	return (
		<Loaded answer={answer}>
			{(data) => (
				<div className="space-y-4">
					<Callout tone="info">{texts.defaults.intro}</Callout>
					<DefaultsPanel data={data} reload={reload} {...(notice ? { notice } : {})} />
				</div>
			)}
		</Loaded>
	);
}

/**
 * @param {{ data: any, reload: () => void, notice?: SettingsNotice }} props
 */
function DefaultsPanel({ data, reload, notice }) {
	const dash = useDashboard();
	const D = dash.texts.defaults;
	/** @param {string} key */
	const saveUrl = (key) => `/v1/dashboard/defaults/${encodeURIComponent(key)}`;
	const settings = useSettingsEditor({ saveUrl, resetBody: true, reload });
	const words = useTextsEditor({ saveUrl: (key) => saveUrl(`text.${key}`), resetBody: true, reload });
	const look = useLookEditor({
		theme: data.theme.theme,
		format: data.format.format,
		saveTheme: (next) => call('PUT', saveUrl('theme'), { value: next }),
		saveFormat: (next) => call('PUT', saveUrl('format'), { value: next }),
		reload,
	});
	const sections = [
		...featureSections({
			features: data.features,
			editor: settings,
			savedSource: 'default',
			dash,
			...(notice ? { notice } : {}),
		}),
		...textSections({ items: data.texts, editor: words, savedSource: 'default', dash, group: D.texts }),
		...lookSections({ editor: look, dash, group: D.look }),
		{
			id: 'changes',
			label: D.changes,
			icon: /** @type {const} */ ('clock'),
			group: D.changes,
			content: <RecentChanges items={data.recentChanges} />,
		},
	];
	return (
		<>
			<SectionLayout label={dash.texts.tabs.defaults} sections={sections} searchFrom={12} searchLabel={D.navSearch} />
			<SettingsBar editor={settings} texts={dash.texts} />
			<LookBar editor={look} texts={dash.texts} />
		</>
	);
}

/**
 * Prices (Owner): the inner sidebar has the hourly prices by category (one price per feature, in credits, for every
 * merchant and website), the encryption key's Re-seal, and Recent changes.
 */
export function PricesTab() {
	const { texts, byCategory } = useDashboard();
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
				const byKey = new Map(parsed.map((entry) => [entry.feature.key, entry]));
				const dirty = Object.keys(draft).length > 0;
				const sections = [
					...byCategory(features.map((feature) => feature.key)).map((category) => ({
						id: `prices-${slug(category.title)}`,
						label: category.title,
						group: texts.prices.hourly,
						content: (
							<>
								<ViewTitle title={category.title} description={texts.prices.perHour} />
								<SettingsCard wide>
									<SettingList>
										{category.keys.map((key) => {
											const entry = /** @type {NonNullable<ReturnType<typeof byKey.get>>} */ (byKey.get(key));
											return (
												<Input
													key={key}
													label={entry.feature.name}
													help={texts.prices.perHour}
													inputMode="decimal"
													value={entry.text}
													error={entry.credits.ok ? undefined : entry.credits.message}
													onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
												/>
											);
										})}
									</SettingList>
								</SettingsCard>
								<Outcome result={result} />
							</>
						),
					})),
					{
						id: 'security',
						label: texts.reseal.title,
						icon: /** @type {const} */ ('key'),
						group: texts.prices.security,
						content: <ResealCard />,
					},
					{
						id: 'changes',
						label: texts.prices.changes,
						icon: /** @type {const} */ ('clock'),
						group: texts.prices.changes,
						content: <RecentChanges items={data.recentChanges} />,
					},
				];
				return (
					<div className="space-y-4">
						<Callout tone="info">{texts.prices.intro}</Callout>
						<SectionLayout label={texts.tabs.prices} sections={sections} />
						<SaveBar
							show={dirty}
							message={texts.prices.unsaved}
							saveLabel={texts.save}
							discardLabel={texts.settings.discard}
							onDiscard={() => {
								setDraft({});
								setResult(null);
							}}
							onSave={async () => {
								if (parsed.some((entry) => !entry.credits.ok)) return;
								const prices = Object.fromEntries(
									parsed.map(({ feature, credits }) => [feature.key, credits.ok ? credits.value : 0]),
								);
								const next = await call('PUT', '/v1/dashboard/prices', { prices });
								setResult(next);
								if (next.ok) setDraft({});
								reload();
							}}
						/>
					</div>
				);
			}}
		</Loaded>
	);
}
