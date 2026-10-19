'use client';
/**
 * The standard tabs of every product dashboard (PLAN 0.4.3), each on the kit's dashboard API. Rights are the kit's:
 * merchants see features read-only and only the settings of switched-on features; Owners and Support switch features;
 * Owners alone edit Defaults and Prices. A product fills in its own parts through each tab's props (its Overview items,
 * settings lists and notices, connection forms and hints, developer sections) or replaces a tab with its own, built
 * from the shared pieces.
 *
 * Every tab with more than a couple of cards has an inner sidebar and shows ONE view at a time (owner 2026-10-16: no
 * long scrolls): Features by category, Settings by feature (grouped by category), Texts by screen or widget,
 * Connections one per connection, Developers and Prices by section. The look, the Format and the business facts are not
 * here: they are the Portal's Website settings, and what a product needs of them shows on its Overview.
 * @module
 */
import { useState } from 'react';
import { Button, ButtonLink } from './Button.js';
import { CodeBlock } from './CodeBlock.js';
import { Badge, Callout, Card, EmptyState, ManagedNote, StatusPill, TextLink } from './display.js';
import { DataTable } from './DataTable.js';
import { SaveBar, SectionLayout, SettingList, SettingsCard, ViewTitle } from './blocks.js';
import { Input, Switch } from './fields.js';
import { ActionMenu } from './Menu.js';
import { ConfirmDialog } from './overlay.js';
import { ChangesTable, OverviewSkeleton, ProductOverview, RecentChanges } from './overview.js';
import { Paged, usePaged } from './paged.js';
import { Pagination } from './Pagination.js';
import { Toolbar } from './Toolbar.js';
import { ListRow, RowList } from './rows.js';
import { formatCreditsPerHour, parseCredits, supportContact } from './format.js';
import { useDisplayLocale } from './time.js';
import { call, fill, useLoad } from './dashboard-api.js';
import { LoadedPage, SectionsPage, useCrumbs } from './dashboard-page.js';
import { Loaded, Outcome, ResealCard, toneOf, useDashboard, withDependents } from './dashboard-parts.js';
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
 *   managed?: boolean, last4?: string | null }} Connection `managed`: the Portal owns it (the database, the storage, the links)
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
 * Features: a page whose inner navigation lists the categories (most used first, each with how many are on, a dot when
 * a feature that is on needs a connection, a lock when a merchant has none on); the sub-page is one category's features
 * as a table with their price, what each needs and its switch; admins switch them (switching one off switches off the
 * features that need it) and confirm the new hourly cost. `warnings` gives the product's warnings for the features
 * picked (shown above the table and in the confirmation).
 * @param {TabProps & { warnings?: (on: string[]) => string[] }} props
 */
export function FeaturesTab({ websiteId, merchantId, who, portal, support, warnings, open, brand }) {
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
		<LoadedPage answer={answer} tab="features" withNav>
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
				/** @param {Feature} feature */
				const brokenOf = (feature) =>
					feature.on ? links.filter((link) => link.neededBy.includes(feature.key) && link.status !== 'connected') : [];
				/** @param {Feature} feature @param {boolean} checked */
				const toggle = (feature, checked) => {
					const off = withDependents(features, on, feature.key);
					setPicked(checked ? [...on, feature.key] : on.filter((key) => !off.has(key)));
				};
				const helpOf = fill(F.lockedHelp, { portal: brand || 'Single Solution' });
				/** @type {import('./DataTable.js').DataColumn<Feature>[]} */
				const columns = [
					{ key: 'name', header: F.columns.feature, sortable: true },
					{
						key: 'description',
						header: F.columns.description,
						low: true,
						wrap: true,
						className: 'min-w-64 max-w-md text-muted',
					},
					{ key: 'needs', header: F.columns.needs, low: true, render: (feature) => namesOf(feature.dependsOn) },
					{
						key: 'millicreditsPerHour',
						header: F.columns.price,
						kind: 'money',
						sortable: true,
						render: (feature) => formatCreditsPerHour(feature.millicreditsPerHour, { locale }),
					},
					{
						key: 'docs',
						header: F.docs,
						low: true,
						render: (feature) => <TextLink href={`/docs#feature-${feature.key}`}>{F.docs}</TextLink>,
					},
					{
						key: 'status',
						header: F.columns.status,
						kind: 'status',
						render: (feature) => {
							// a merchant cannot switch features: an off one shows clearly as locked, with who can
							if (!admin && !feature.on)
								return (
									<StatusPill status="locked" title={helpOf}>
										{F.locked}
									</StatusPill>
								);
							const broken = brokenOf(feature);
							if (broken.length === 0) return null;
							return (
								<span className="flex items-center gap-2">
									<StatusPill
										status="setup"
										title={broken.map((link) => fill(F.notWorking, { connection: link.label })).join(' · ')}>
										{F.needsSetup}
									</StatusPill>
									{broken.map((link) =>
										link.managed ? (
											// the database, the storage and the links are set in the Portal
											<ButtonLink
												key={link.name}
												size="sm"
												variant="secondary"
												title={fill(F.notWorking, { connection: link.label })}
												href={websiteSettingsUrl({
													portal,
													admin,
													websiteId,
													merchantId,
													section: link.kind === 'link' ? 'links' : 'connections',
												})}>
												{`${F.connect} ${link.label}`}
											</ButtonLink>
										) : (
											<Button
												key={link.name}
												size="sm"
												variant="secondary"
												title={fill(F.notWorking, { connection: link.label })}
												// the Connections tab opens on this connection
												onClick={() => open?.('connections', `connection-${link.name}`)}>
												{`${F.connect} ${link.label}`}
											</Button>
										),
									)}
								</span>
							);
						},
					},
					{
						key: 'on',
						header: F.on,
						kind: 'status',
						align: 'right',
						render: (feature) => {
							const missing = feature.dependsOn.filter((dep) => !on.includes(dep));
							return (
								<Switch
									size="sm"
									hideLabel
									label={feature.name}
									checked={on.includes(feature.key)}
									locked={!admin}
									lockedLabel={F.locked}
									disabled={missing.length > 0 && !on.includes(feature.key)}
									onChange={(next) => toggle(feature, next)}
								/>
							);
						},
					},
				];
				const notices =
					admin && warned.length === 0 && !result ? null : (
						<div className="shrink-0 space-y-3 p-4 sm:p-6 sm:pb-3">
							{admin ? null : <Callout tone="info">{fill(F.contact, { contact: supportContact(support) })}</Callout>}
							{warned.map((warning) => (
								<Callout key={warning} tone="warning">
									{warning}
								</Callout>
							))}
							<Outcome result={result} />
						</div>
					);
				const sections = byCategory(features.map((feature) => feature.key)).map((category) => {
					const list = category.keys.map((key) => /** @type {Feature} */ (byKey.get(key)));
					const count = list.filter((feature) => on.includes(feature.key)).length;
					const numbers = `${count}/${list.length}`;
					return {
						id: `category-${slug(category.title)}`,
						label: category.title,
						badge: numbers,
						...(list.some((feature) => brokenOf(feature).length > 0)
							? { status: /** @type {const} */ ('attention'), statusLabel: F.needsSetup }
							: {}),
						// a merchant with none of a category on: its features are locked
						...(!admin && count === 0 ? { locked: true } : {}),
						flush: true,
						info: fill(F.countOn, { on: count, total: list.length }),
						facts: [
							{ label: F.on, value: numbers },
							{ label: F.cost, value: formatCreditsPerHour(cost, { locale }) },
						],
						content: (
							<>
								{notices}
								<DataTable
									caption={fill(F.caption, { category: category.title })}
									columns={columns}
									rows={list}
									rowKey={(feature) => feature.key}
									rowLabel={(feature) => feature.name}
								/>
							</>
						),
					};
				});
				return (
					<>
						<SectionsPage tab="features" sections={sections} label={texts.tabs.features} />
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
					</>
				);
			}}
		</LoadedPage>
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
export function SettingsTab({ websiteId, merchantId, who, portal, sections, notice, extras }) {
	const base = `/v1/dashboard/websites/${websiteId}`;
	const settings = useLoad(`${base}/settings`);
	return (
		<LoadedPage answer={settings.answer} tab="settings" withNav>
			{(data) => (
				<SettingsPanel
					features={data.features}
					base={base}
					reload={settings.reload}
					portalLink={(section) =>
						websiteSettingsUrl({ portal, admin: who.kind === 'admin', websiteId, merchantId, section })
					}
					{...(sections ? { sections } : {})}
					{...(notice ? { notice } : {})}
					{...(extras ? { extras } : {})}
				/>
			)}
		</LoadedPage>
	);
}

/**
 * @param {{ features: FeatureSettings[], base: string, reload: () => void, sections?: SectionSpec[],
 *   notice?: SettingsNotice, extras?: Record<string, FeatureExtra>, portalLink: (section: string) => string }} props
 */
function SettingsPanel({ features, base, reload, sections = [], notice, extras, portalLink }) {
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
			portalLink,
			...(notice ? { notice } : {}),
			...(extras ? { extras } : {}),
		}),
		...sections,
	];
	return (
		<>
			<SectionsPage
				tab="settings"
				label={dash.texts.tabs.settings}
				sections={list}
				searchLabel={dash.texts.settings.navSearch}
				empty={<EmptyState icon="sliders" title={dash.texts.settings.nothingOn} />}
			/>
			<SettingsBar editor={editor} texts={dash.texts} />
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
 * Connections: the inner sidebar lists the connections with their state; the view is one connection with its status, a
 * value to save (and test), Test, and Remove in its ⋯ menu once something is saved (after a confirmation). `form`
 * gives the product's own form for a connection (null: the one value field); `hint` its help line under the status.
 * A connection the Portal owns (`managed`: the database, the storage and the links to other products) has no form and no
 * Remove here: a note says where it is set, with a link to the Portal; the database and the storage can be tested.
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
		<Loaded answer={answer}>
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
					return {
						id: `connection-${item.name}`,
						label: item.label,
						icon: /** @type {const} */ ('plug'),
						badge: (
							<span
								role="img"
								aria-label={String(C[/** @type {'connected'} */ (item.status)])}
								className={`size-2 rounded-full ${tone === 'success' ? 'bg-success-solid' : tone === 'danger' ? 'bg-danger-solid' : 'bg-attention-solid'}`}
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
									{managed ? (
										<ManagedNote
											className="mt-3"
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
									) : help ? (
										<p className="mt-2 text-help text-muted">{help}</p>
									) : null}
									{managed
										? null
										: (own ?? (
												<div className="mt-3 flex flex-wrap items-end gap-2">
													<Input
														fieldClassName="min-w-0 flex-1 basis-64"
														label={C.value}
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
											))}
									<div className="mt-3 flex flex-wrap gap-2">
										{item.kind === 'link' ? null : (
											<Button
												size="sm"
												variant="secondary"
												onClick={() => act(call('POST', `${base}/${item.name}/test`))}>
												{C.test}
											</Button>
										)}
										{item.status === 'not_connected' || managed ? null : (
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
 * Developers: the inner sidebar has the product's own `sections` (by default the widget script: the snippets, API calls and
 * addresses of this product), `children` under More, and the docs of every feature (off ones marked, searchable). The
 * website's id and the tokens are in the Portal (Install and tokens, the Setup sheet); the docs link is in the header.
 * @param {TabProps & { sections?: SectionSpec[], children?: ReactNode }} props
 */
export function DevelopersTab({ websiteId, sections, children }) {
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
