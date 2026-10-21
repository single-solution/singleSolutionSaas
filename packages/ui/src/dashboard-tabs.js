'use client';
/**
 * The standard tabs of every product dashboard (PLAN 0.4.3), each on the kit's dashboard API. Rights are the kit's:
 * merchants see features read-only and only the settings of switched-on features; Owners and Support switch features;
 * Owners alone edit Defaults and Prices. A product fills in its own parts through each tab's props (its Overview items,
 * settings lists and notices, connection forms and hints, developer sections) or replaces a tab with its own, built
 * from the shared pieces.
 *
 * Every tab with more than a couple of cards is a list of rich rows beside the page, which shows the picked row
 * (owner 2026-10-21): Settings has every feature (grouped by category, with its switch; there is no Features tab),
 * Texts a screen or widget, Connections one per connection, Developers and Prices a section. The look, the Format and the business facts are not
 * here: they are the Portal's Website settings, and what a product needs of them shows on its Overview.
 * @module
 */
import { useState } from 'react';
import { Button } from './Button.js';
import { CodeBlock } from './CodeBlock.js';
import { Card, EmptyState, ManagedNote, TextLink } from './display.js';
import { DataTable } from './DataTable.js';
import { SaveBar, SettingList, SettingsCard } from './blocks.js';
import { Input } from './fields.js';
import { NextStep } from './NextStep.js';
import { ConfirmDialog } from './overlay.js';
import { ChangesTable, OverviewSkeleton, ProductOverview } from './overview.js';
import { usePaged } from './paged.js';
import { Pagination } from './Pagination.js';
import { Toolbar } from './Toolbar.js';
import { formatCreditsPerHour, parseCredits } from './format.js';
import { useDisplayLocale } from './time.js';
import { call, fill, useLoad } from './dashboard-api.js';
import { featureLooks, useFeatureSwitches } from './dashboard-features.js';
import { LoadedPage, SectionsPage, useCrumbs } from './dashboard-page.js';
import { Outcome, ResealCard, toneOf, useDashboard } from './dashboard-parts.js';
import {
	SettingsBar,
	TextsTable,
	featureSections,
	textSections,
	useSettingsEditor,
	useTextsEditor,
} from './dashboard-settings.js';
import { websiteSettingsUrl } from './portal-links.js';

/** @typedef {import('./dashboard-api.js').Answer} Answer */
/** @typedef {import('./dashboard-parts.js').FeatureSettings} FeatureSettings */
/** @typedef {import('./dashboard-parts.js').SettingsNotice} SettingsNotice */
/** @typedef {import('./dashboard-settings.js').FeatureExtra} FeatureExtra */
/** @typedef {import('./blocks.js').SectionSpec} SectionSpec */
/** @typedef {import('./dashboard-page.js').Section} Section */
/** @typedef {import('react').ReactNode} ReactNode */
/** @typedef {{ kind: 'merchant' | 'admin', id: string, name: string, role?: 'owner' | 'support' }} Who */
/**
 * What every tab is given: the picked website (null on the Owner's global tabs), its merchant and its domain, the viewer, the
 * support contact, the Portal's address and name (`brand`, its Branding), and `open`, which shows another section (the
 * Overview's buttons), at the section of its inner sidebar when one is given (`open('settings', 'catalog.page-addresses')`).
 * @typedef {{ websiteId: string | null, merchantId?: string | null, domain: string, who: Who,
 *   support: { channels: import('./format.js').SupportChannel[] }, portal: string, brand?: string,
 *   open: (tab: string, section?: string) => void }} TabProps
 */
/** @typedef {{ key: string, name: string, description: string, dependsOn: string[], millicreditsPerHour: number, on?: boolean }} Feature */
/**
 * One connection of a website (`GET …/connections`).
 * @typedef {{ name: string, label: string, kind?: string, neededBy: string[], status: string, message?: string,
 *   managed?: boolean, last4?: string | null }} Connection `managed`: the Portal owns it (the database, the storage, the AI provider key, the links)
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
	const crumbs = useCrumbs();
	const base = `/v1/dashboard/websites/${websiteId}`;
	const { answer, reload } = useLoad(`${base}/overview`);
	const more = useMore(answer, props);
	return (
		<LoadedPage answer={answer} tab="overview" skeleton={<OverviewSkeleton />}>
			{(data) => (
				<ProductOverview
					data={data}
					who={who}
					product={texts.title}
					crumbs={crumbs('overview')}
					support={support}
					portal={portal}
					namesOf={namesOf}
					open={open}
					recheck={async () => {
						await call('POST', `${base}/website-settings/refresh`);
						reload();
					}}
					{...more}
				/>
			)}
		</LoadedPage>
	);
}

/**
 * Settings (owner 2026-10-21: the Features tab is folded in): the list beside the page has a row for EVERY feature,
 * grouped by category (the chips), with its switch for Owner and Support (switching one off switches off the features
 * that need it, after a confirmation with the new hourly cost), its price, how many settings the website changed and
 * what blocks it. The page of a feature that is on is its settings, all open, with one save bar; the page of one
 * that is off says what it is and how to switch it on (a merchant is told to ask support). The product adds under a
 * feature (`extras`: a node under its settings, or `{ items }`, views of their own such as list editors), its own
 * `sections` after the features (not tied to a feature), a `notice` above a feature's cards and its `warnings` for
 * the features that are on (rules between features, shown in the confirmation of a switch and above the page).
 * @param {TabProps & { sections?: SectionSpec[], notice?: SettingsNotice, extras?: Record<string, FeatureExtra>,
 *   warnings?: (on: string[]) => string[] }} props
 */
export function SettingsTab({ websiteId, merchantId, who, portal, support, open, sections, notice, extras, warnings }) {
	const base = `/v1/dashboard/websites/${websiteId}`;
	const settings = useLoad(`${base}/settings`);
	const catalog = useLoad(`${base}/features`);
	const connections = useLoad(`${base}/connections`);
	return (
		<LoadedPage answer={bothOf(settings.answer, catalog.answer)} tab="settings" withNav>
			{(data) => (
				<SettingsPanel
					features={data.settings}
					catalog={data.catalog}
					links={connections.answer?.ok ? connections.answer.data.connections : []}
					base={base}
					who={who}
					support={support}
					portal={portal}
					websiteId={websiteId}
					merchantId={merchantId ?? null}
					open={open}
					reload={() => {
						settings.reload();
						catalog.reload();
					}}
					portalLink={(section) =>
						websiteSettingsUrl({ portal, admin: who.kind === 'admin', websiteId, merchantId, section })
					}
					{...(sections ? { sections } : {})}
					{...(notice ? { notice } : {})}
					{...(extras ? { extras } : {})}
					{...(warnings ? { warnings } : {})}
				/>
			)}
		</LoadedPage>
	);
}

/**
 * The settings and the features of a website as one answer: the features when both are there, the first problem when
 * one failed (with its Try again), nothing while one is still loading.
 * @param {Answer | null} settings
 * @param {Answer | null} catalog
 * @returns {Answer | null}
 */
const bothOf = (settings, catalog) => {
	if (settings && !settings.ok) return settings;
	if (catalog && !catalog.ok) return catalog;
	if (!settings || !catalog) return null;
	return { ok: true, data: { settings: settings.data.features, catalog: catalog.data.features } };
};

/**
 * @param {{ features: FeatureSettings[], catalog: Feature[], links: Connection[], base: string, who: Who,
 *   support: TabProps['support'], portal: string, websiteId: string | null, merchantId: string | null,
 *   open?: TabProps['open'], reload: () => void, sections?: SectionSpec[], notice?: SettingsNotice,
 *   extras?: Record<string, FeatureExtra>, warnings?: (on: string[]) => string[],
 *   portalLink: (section: string) => string }} props `features`: the settings of the features that have some (a
 *   merchant's: only of those that are on); `catalog`: every feature
 */
function SettingsPanel({
	features,
	catalog,
	links,
	base,
	who,
	support,
	portal,
	websiteId,
	merchantId,
	open,
	reload,
	sections = [],
	notice,
	extras,
	warnings,
	portalLink,
}) {
	const dash = useDashboard();
	const locale = useDisplayLocale();
	const F = dash.texts.features;
	const editor = useSettingsEditor({
		saveUrl: (key) => `${base}/settings/${encodeURIComponent(key)}`,
		resetBody: false,
		reload,
	});
	const switches = useFeatureSwitches({ base, catalog, ...(warnings ? { warnings } : {}), reload });
	// every feature of the product, with its settings when it has some
	const all = [
		...catalog.map((feature) => ({
			...(features.find((entry) => entry.key === feature.key) ?? { schema: null, values: {} }),
			key: feature.key,
			name: feature.name,
			on: Boolean(feature.on),
		})),
		...features.filter((entry) => !catalog.some((feature) => feature.key === entry.key)),
	];
	const list = [
		...featureSections({
			features: all,
			editor,
			savedSource: 'website',
			dash,
			portalLink,
			look: featureLooks({
				catalog,
				links,
				who,
				dash,
				locale,
				ask: switches.ask,
				support,
				portal,
				merchantId,
				websiteId,
				...(open ? { open } : {}),
			}),
			...(notice ? { notice } : {}),
			...(extras ? { extras } : {}),
		}),
		...sections,
	];
	const on = catalog.filter((feature) => feature.on).length;
	return (
		<>
			<SectionsPage
				tab="settings"
				label={dash.texts.tabs.settings}
				sections={list}
				searchLabel={dash.texts.settings.navSearch}
				facts={[
					{ label: F.on, value: on },
					{ label: F.off, value: catalog.length - on },
					{ label: F.cost, value: formatCreditsPerHour(switches.cost, { locale }) },
				]}
				{...(switches.warned.length > 0
					? {
							toolbar: (
								<NextStep tone="warning" icon="alert" className="min-w-0 flex-1">
									{switches.warned.join(' ')}
								</NextStep>
							),
						}
					: {})}
				empty={<EmptyState icon="sliders" title={dash.texts.settings.nothingOn} />}
			/>
			<SettingsBar editor={editor} texts={dash.texts} />
			<Outcome result={switches.result} />
			{switches.dialog}
		</>
	);
}

/**
 * Texts: every word the widgets show. The inner sidebar lists the screens and widgets (a text's key starts with its
 * screen), each a table of its texts; the search above finds a text by its words in all of them and shows the matches
 * in place of the screen (the sidebar stays). A text is changed in a drawer and saves on its own.
 * @param {TabProps} props
 */
export function TextsTab({ websiteId }) {
	const base = `/v1/dashboard/websites/${websiteId}`;
	const texts = useLoad(`${base}/texts`);
	return (
		<LoadedPage answer={texts.answer} tab="texts" withNav>
			{(data) => (
				<TextsPanel
					items={data.texts}
					saveUrl={(key) => `${base}/texts/${encodeURIComponent(key)}`}
					resetBody={false}
					savedSource="website"
					reload={texts.reload}
				/>
			)}
		</LoadedPage>
	);
}

/**
 * The texts' pages and search (a website's or the global defaults).
 * @param {{ items: Array<{ key: string, english: string, value: string, source: string }>, saveUrl: (key: string) => string,
 *   resetBody: boolean, savedSource: string, reload: () => void }} props
 */
function TextsPanel({ items, saveUrl, resetBody, savedSource, reload }) {
	const dash = useDashboard();
	const T = dash.texts.texts;
	const editor = useTextsEditor({ saveUrl, resetBody, reload });
	const paged = usePaged(items, { text: (text) => `${text.key} ${text.english} ${text.value}`, pageSize: 50 });
	const searching = paged.query.trim() !== '';
	return (
		<SectionsPage
			tab="texts"
			label={dash.texts.tabs.texts}
			sections={textSections({ items, editor, savedSource, dash })}
			searchFrom={6}
			searchLabel={T.navSearch}
			{...(items.length > 0
				? {
						toolbar: (
							<Toolbar
								search={{
									onSearch: paged.setQuery,
									value: paged.query,
									label: T.search,
									placeholder: T.search,
									delay: 0,
								}}
							/>
						),
					}
				: {})}
			{...(searching
				? { footer: <Pagination {...paged.pagination} />, flushChildren: true, resultLabel: T.results, info: T.help }
				: {})}>
			{searching ? (
				<TextsTable
					items={paged.rows}
					editor={editor}
					savedSource={savedSource}
					texts={dash.texts}
					caption={T.results}
					empty={T.none}
				/>
			) : null}
		</SectionsPage>
	);
}

/**
 * Connections: the inner sidebar lists the connections, each with a dot for its state; the page is one connection:
 * its state is a pill in the header beside Test (and Remove in the More menu once something is saved, after a
 * confirmation), who needs it is behind the (i), and the body holds a value to save (Save and test) or the product's own
 * form. `form` gives the product's own form for a connection (null: the one value field); `hint` its help line under the
 * status. A connection the Portal owns (`managed`: the database, the storage, the AI provider key and the links to other products) has no
 * form and no Remove here: a note says where it is set, with a link to the Portal; the database and the storage can be
 * tested.
 * @param {TabProps & { form?: (item: Connection, save: (value: unknown) => Promise<void>) => ReactNode,
 *   hint?: (name: string) => ReactNode }} props
 */
export function ConnectionsTab({ websiteId, merchantId, who, portal, form, hint }) {
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
		<LoadedPage answer={answer} tab="connections" withNav>
			{(data) => {
				/** @type {Connection[]} */
				const connections = data.connections;
				const sections = connections.map((item) => {
					/** @param {unknown} value */
					const save = (value) => act(call('PUT', `${base}/${item.name}`, { value }));
					const managed = item.managed === true;
					const own = form && !managed ? form(item, save) : null;
					const help = hint ? hint(item.name) : null;
					const tone = toneOf(item.status);
					const state = String(C[/** @type {'connected'} */ (item.status)]);
					/** @type {import('./display.js').PillStatus} */
					const pill = tone === 'success' ? 'active' : tone === 'danger' ? 'error' : 'setup';
					const details = item.last4 || item.message || (help && !managed);
					return {
						id: `connection-${item.name}`,
						label: item.label,
						icon: /** @type {const} */ ('plug'),
						status: tone,
						statusLabel: state,
						info: item.neededBy.length > 0 ? fill(C.neededBy, { features: namesOf(item.neededBy, 4) }) : C.neededByNone,
						pills: [
							{
								status: pill,
								label: state,
							},
						],
						actions: {
							...(item.kind === 'link'
								? {}
								: {
										secondary: [{ label: C.test, onClick: () => act(call('POST', `${base}/${item.name}/test`)) }],
									}),
							...(item.status === 'not_connected' || managed
								? {}
								: {
										more: [
											{
												label: C.remove,
												danger: true,
												onSelect: () => setRemoving({ name: item.name, label: item.label }),
											},
										],
									}),
						},
						content: (
							<>
								{details ? (
									<Card>
										<p className="flex flex-wrap items-center gap-2 text-sm">
											{item.last4 ? <code>••••{item.last4}</code> : null}
											{item.message ? <span className="text-muted">{item.message}</span> : null}
											{help && !managed ? <span className="text-help text-muted">{help}</span> : null}
										</p>
									</Card>
								) : null}
								{managed ? (
									<ManagedNote
										title={texts.managed.title}
										href={websiteSettingsUrl({
											portal,
											admin: who.kind === 'admin',
											websiteId,
											merchantId,
											section: item.kind === 'link' ? 'links' : 'connections',
										})}
										linkLabel={C.managed.open}>
										{C.managed[/** @type {'database'} */ (item.kind ?? 'database')] ?? C.managed.link}
									</ManagedNote>
								) : own ? (
									<Card>{own}</Card>
								) : (
									<SettingsCard
										wide
										footer={
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
										}>
										<SettingList>
											<Input
												label={C.value}
												type="password"
												autoComplete="off"
												value={values[item.name] ?? ''}
												onChange={(event) => setValues({ ...values, [item.name]: event.target.value })}
											/>
										</SettingList>
									</SettingsCard>
								)}
							</>
						),
					};
				});
				return (
					<>
						<Outcome result={result} />
						<SectionsPage
							tab="connections"
							label={texts.tabs.connections}
							sections={sections}
							empty={<EmptyState icon="plug" title={C.none} />}
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
					</>
				);
			}}
		</LoadedPage>
	);
}

/**
 * Developers: the inner sidebar has the product's own `sections` (by default the widget script: the snippets, API calls and
 * addresses of this product), `children` under More, and the docs of every feature, a table with a search (off ones
 * marked). What each page is for is behind its (i). The website's id and the tokens are in the Portal (Install and
 * tokens, the Setup sheet); the docs link is in the header.
 * @param {TabProps & { sections?: SectionSpec[], children?: ReactNode }} props
 */
export function DevelopersTab({ websiteId, sections, children }) {
	const { answer } = useLoad(`/v1/dashboard/websites/${websiteId}/features`);
	return (
		<LoadedPage answer={answer} tab="developers" withNav>
			{(data) => (
				<DevelopersPanel features={data.features} {...(sections ? { sections } : {})}>
					{children}
				</DevelopersPanel>
			)}
		</LoadedPage>
	);
}

/**
 * @param {{ features: Feature[], sections?: SectionSpec[], children?: ReactNode }} props
 */
function DevelopersPanel({ features, sections, children }) {
	const { texts } = useDashboard();
	const D = texts.developers;
	const origin = typeof window === 'undefined' ? '' : window.location.origin;
	const paged = usePaged(features, { text: (feature) => `${feature.name} ${feature.key}`, pageSize: 25 });
	/** @type {import('./DataTable.js').DataColumn<Feature>[]} */
	const columns = [
		{
			key: 'name',
			header: D.columns.feature,
			sortable: true,
			render: (feature) => <TextLink href={`/docs#feature-${feature.key}`}>{feature.name}</TextLink>,
		},
		{
			key: 'on',
			header: D.columns.status,
			kind: 'status',
			pill: (feature) => ({
				status: feature.on ? 'active' : 'off',
				label: feature.on ? D.columns.on : D.columns.off,
			}),
		},
	];
	/** @type {Section[]} */
	const own = sections ?? [
		{
			id: 'script',
			label: D.script,
			icon: 'code',
			info: D.scriptHelp,
			content: <CodeBlock code={`<script src="${origin}/widget.js" data-token="YOUR_BROWSER_TOKEN" async></script>`} />,
		},
	];
	return (
		<SectionsPage
			tab="developers"
			label={texts.tabs.developers}
			sections={[
				...own,
				...(children ? [{ id: 'more', label: D.more, icon: /** @type {const} */ ('layers'), content: children }] : []),
				{
					id: 'docs',
					label: D.docs,
					icon: 'external',
					flush: true,
					info: D.docsHelp,
					toolbar: (
						<Toolbar
							search={{
								onSearch: paged.setQuery,
								value: paged.query,
								label: D.search,
								placeholder: D.search,
								delay: 0,
							}}
						/>
					),
					footer: <Pagination {...paged.pagination} />,
					content: (
						<DataTable
							caption={D.docs}
							columns={columns}
							rows={paged.rows}
							rowKey={(feature) => feature.key}
							empty={D.none}
						/>
					),
				},
			]}
		/>
	);
}

/**
 * Defaults (Owner): the inner sidebar has the global defaults of every feature's settings (by category, with the
 * product's `notice`), the widget texts by screen, and Recent changes (the theme and the Format are the Portal's).
 * @param {Partial<TabProps> & { notice?: SettingsNotice }} props
 */
export function DefaultsTab({ notice }) {
	const { answer, reload } = useLoad('/v1/dashboard/defaults');
	return (
		<LoadedPage answer={answer} tab="defaults" withNav>
			{(data) => <DefaultsPanel data={data} reload={reload} {...(notice ? { notice } : {})} />}
		</LoadedPage>
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
	const sections = [
		...featureSections({
			features: data.features,
			editor: settings,
			savedSource: 'default',
			dash,
			...(notice ? { notice } : {}),
		}),
		...textSections({ items: data.texts, editor: words, savedSource: 'default', dash, group: D.texts }),
		{
			id: 'changes',
			label: D.changes,
			icon: /** @type {const} */ ('clock'),
			group: D.changes,
			flush: true,
			content: <ChangesTable items={data.recentChanges} />,
		},
	];
	return (
		<>
			<SectionsPage
				tab="defaults"
				label={dash.texts.tabs.defaults}
				sections={sections}
				searchFrom={12}
				searchLabel={D.navSearch}
				info={D.intro}
			/>
			<SettingsBar editor={settings} texts={dash.texts} />
		</>
	);
}

/**
 * Prices (Owner): the inner sidebar has the hourly prices by category (one price per feature, in credits, for every
 * merchant and website; a category says how many prices are changed and not saved yet), the encryption key's Re-seal,
 * and Recent changes. What the prices are is behind the (i) of the page.
 */
export function PricesTab() {
	const { texts, byCategory } = useDashboard();
	const { answer, reload } = useLoad('/v1/dashboard/prices');
	const [draft, setDraft] = useState(/** @type {Record<string, string>} */ ({}));
	const [result, setResult] = useState(/** @type {Answer | null} */ (null));
	return (
		<LoadedPage answer={answer} tab="prices" withNav>
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
					...byCategory(features.map((feature) => feature.key)).map((category) => {
						const changed = category.keys.filter((key) => Object.hasOwn(draft, key)).length;
						return {
							id: `prices-${slug(category.title)}`,
							label: category.title,
							group: texts.prices.hourly,
							...(changed > 0 ? { badge: changed } : {}),
							content: (
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
							),
						};
					}),
					{
						id: 'security',
						label: texts.reseal.title,
						icon: /** @type {const} */ ('key'),
						group: texts.prices.security,
						info: texts.reseal.intro,
						content: <ResealCard />,
					},
					{
						id: 'changes',
						label: texts.prices.changes,
						icon: /** @type {const} */ ('clock'),
						group: texts.prices.changes,
						flush: true,
						content: <ChangesTable items={data.recentChanges} />,
					},
				];
				return (
					<>
						<SectionsPage tab="prices" label={texts.tabs.prices} sections={sections} info={texts.prices.intro} />
						<Outcome result={result} />
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
					</>
				);
			}}
		</LoadedPage>
	);
}
