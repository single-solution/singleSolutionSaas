'use client';
/**
 * A website's own page, the same in both consoles (layout contract; LY-2b): one `Page` whose header carries the domain
 * (crumbs `Websites › domain` for a merchant, `Merchants › name › domain` for an admin), the status pill, the daily
 * cost, the products on and (on the settings pages) the settings version and when they were saved, the one primary
 * action and the ⋯ More menu. Its parts are the inner navigation, each its own address (`website-parts.js`):
 * **Overview** (the products as a table, the 30-day spend) · **Products** (one item per product: its status, features,
 * cost, Open dashboard and Remove) · **Website settings** (Business, Brand and look, Region and format, Domains, pages
 * and legal, Team and alerts, Data and files, Between your products; the floating Save bar is the only save) ·
 * **Install and tokens** · **Setup sheet** · **Usage** · **Recent changes**. Add product and Add website are drawers; a
 * short yes/no stays a dialog. What each person may do follows the `can` the console passes; the Portal checks every
 * right again.
 * @module
 */
import { useEffect, useState } from 'react';
import {
	ActionMenu,
	BarChart,
	Button,
	Callout,
	Card,
	CardFlow,
	DataTable,
	EmptyState,
	KeyValueList,
	LocalTime,
	Page,
	Skeleton,
	TypedConfirmDialog,
	copyText,
	describeProblem,
	formatCredits,
	isEmptySeries,
	useToast,
} from '@ss/ui';
import { BILLING, MORE, SETUP, WEBSITE, WEBSITE_SETTINGS as T } from '../../texts/console.js';
import { apiFetch } from '../client.js';
import { Link } from '../link.js';
import { useNavigation } from '../navigation.js';
import { api } from '../paths.js';
import { parseWebsitePart, SETTINGS_SECTIONS } from '../website-parts.js';
import { ProductStatusBadge, UsageView, creditDayBars, formatChartCredits, productPill, productStatusLabel, productTone } from './billing.js';
import { openDashboard } from './common.js';
import { SetupView, useSetupSheet } from './setup.js';
import { ChangesTable, SettingsSectionBody, contextOf, readinessLines, useWebsiteSettings } from './website-settings.js';
import {
	AddProductDrawer,
	InstallBlock,
	dailyCostOf,
	twoStepOnOf,
	useOnce,
	websiteDot,
} from './website.js';

/** @typedef {import('./website.js').ProductCard} ProductCard */
/**
 * What the person may do on a website: add and remove its products, remove the website, see tokens and the Setup
 * sheet, open the product dashboards and read the Website settings.
 * @typedef {{ manage: boolean, removeWebsite: boolean, tokens: boolean, open: boolean, settings: boolean }} WebsiteCan
 */
/** @typedef {import('@ss/ui').PageStatus} SitePill */

/** No changes yet: one array, so a page without Recent changes does not reset its state on every render. */
const NO_CHANGES = /** @type {any[]} */ ([]);

/**
 * The spend on one website over the last 30 UTC days (all its products).
 * @param {{ merchantId: string, websiteId: string }} props
 */
function WebsiteSpend({ merchantId, websiteId }) {
	const result = useOnce(api.usage(merchantId, { websiteId }));
	const usage = result?.ok ? result.data : null;
	const bars = creditDayBars(usage?.days);
	return (
		<>
			{result && !result.ok ? <Callout tone="danger">{describeProblem(result.problem)}</Callout> : null}
			{usage && !isEmptySeries(bars) ? (
				<Card title={MORE.websiteSpend} subtitle={formatCredits(usage.total ?? 0)}>
					<BarChart label={MORE.websiteSpend} data={bars} format={formatChartCredits} height={120} />
				</Card>
			) : null}
		</>
	);
}

/**
 * Install and tokens: every product's install block (widget script tag, browser token, server token).
 * @param {{ merchantId: string, website: any }} props
 */
function InstallPart({ merchantId, website }) {
	const websiteId = String(website.websiteId);
	const result = useOnce(api.tokens(merchantId, websiteId));
	// two-step on: the confirmation of a server token asks for the code at once
	const twoStepOn = twoStepOnOf(useOnce('/v1/me'));
	const tokens = /** @type {import('./website.js').TokenEntry[]} */ (result?.ok ? (result.data?.items ?? []) : []);
	if (!result) return <Skeleton lines={4} />;
	if (!result.ok) return <Callout tone="danger">{describeProblem(result.problem)}</Callout>;
	if (tokens.length === 0) return <EmptyState compact icon="key" kind="developer" title={WEBSITE.noTokens} />;
	return (
		<div className="space-y-4">
			{tokens.map((entry) => (
				<InstallBlock
					key={entry.productId}
					entry={entry}
					domain={website.domain}
					merchantId={merchantId}
					websiteId={websiteId}
					twoStepOn={twoStepOn}
				/>
			))}
		</div>
	);
}

/**
 * Usage of the website: the last 30 UTC days by product and feature.
 * @param {{ merchantId: string, websiteId: string }} props
 */
function UsagePart({ merchantId, websiteId }) {
	const result = useOnce(api.usage(merchantId, { websiteId }));
	if (!result) return <Skeleton lines={4} />;
	if (!result.ok) return <Callout tone="danger">{describeProblem(result.problem)}</Callout>;
	return <UsageView usage={result.data} showWebsite={false} chartTitle={BILLING.usageChart} />;
}

/**
 * @typedef {object} WebsitePageProps
 * @property {any} website the website (`websiteId`, `merchantId`, `domain`)
 * @property {ProductCard[]} cards its products
 * @property {string} part the part of the address after the website (`website-parts.js`)
 * @property {import('@ss/ui').PageCrumb[]} crumbs the steps above the website's domain
 * @property {(part: string) => string} hrefOf the address of a part (`''` = Overview)
 * @property {WebsiteCan} can
 * @property {Record<'success' | 'warning' | 'danger' | 'neutral', SitePill>} pills how the website's worst product status reads
 * @property {Array<{ productId: string, name: string }> | null} [addable] active connected products (Add product)
 * @property {(productId: string) => { path: string, body?: unknown }} launch the Open route of a product
 * @property {string} afterRemoved where to go once the website was removed
 * @property {any} settings the loaded Website settings (`loadWebsiteSettings`), a failure, or null when not asked
 * @property {any} setup the loaded Setup sheet (`loadSetup`), a failure, or null when not asked
 * @property {boolean} [canSwitch] the admin console switches recommended features on
 */

/**
 * The website page.
 * @param {WebsitePageProps} props
 */
export function WebsitePageView({
	website,
	cards: initialCards,
	part,
	crumbs,
	hrefOf,
	can,
	pills,
	addable = null,
	launch,
	afterRemoved,
	settings,
	setup,
	canSwitch = false,
}) {
	const toast = useToast();
	const nav = useNavigation();
	const merchantId = String(website.merchantId);
	const websiteId = String(website.websiteId);
	const manage = { merchantId, websiteId };
	const [cards, setCardsState] = useState(initialCards);
	useEffect(() => setCardsState(initialCards), [initialCards]);
	const [dialog, setDialog] = useState(/** @type {null | 'add' | 'removeWebsite'} */ (null));
	const [removing, setRemoving] = useState(/** @type {ProductCard | null} */ (null));
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {import('@ss/ui/problems').Problem | null} */ (null));
	const [opening, setOpening] = useState(/** @type {string | null} */ (null));
	// the website was removed: the page waits (as a skeleton) for the list to open
	const [gone, setGone] = useState(false);

	const loadedSettings = settings?.ok ? settings : null;
	const state = useWebsiteSettings({
		data: loadedSettings?.data ?? null,
		changes: loadedSettings?.changes ?? NO_CHANGES,
		connections: loadedSettings?.connections ?? null,
		merchantId,
		websiteId,
	});
	const setupState = useSetupSheet({ sheet: setup?.ok ? setup.sheet : null, manage });

	const parsed = parseWebsitePart(part);
	const kind = parsed?.kind ?? null;
	const hasSettings = can.settings && state.settings !== null;
	const productId = parsed?.kind === 'product' ? parsed.id : null;
	const shown = productId ? (cards.find((c) => c.productId === productId) ?? null) : null;
	const current =
		parsed === null
			? ''
			: parsed.kind === 'overview'
				? 'overview'
				: parsed.kind === 'product'
					? `products/${parsed.id}`
					: parsed.kind === 'settings'
						? `settings/${parsed.section}`
						: parsed.kind;

	/** @param {ProductCard[]} next */
	const setCards = (next) => setCardsState(next);
	/** @param {ProductCard} card */
	const open = async (card) => {
		setOpening(card.productId);
		const { path, body } = launch(card.productId);
		const result = await openDashboard(path, body);
		setOpening(null);
		if (!result.ok) toast.show({ tone: 'danger', title: describeProblem(result.problem) });
	};
	const removeProduct = async () => {
		if (!removing) return;
		setBusy(true);
		setProblem(null);
		const result = await apiFetch(api.websiteProduct(merchantId, websiteId, removing.productId), { method: 'DELETE' });
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		setCards(cards.filter((c) => c.productId !== removing.productId));
		toast.show({ title: WEBSITE.productRemoved(removing.name) });
		const wasShown = removing.productId === productId;
		setRemoving(null);
		if (wasShown) nav.go(hrefOf(''));
	};
	const removeWebsite = async () => {
		setBusy(true);
		setProblem(null);
		const result = await apiFetch(api.website(merchantId, websiteId), { method: 'DELETE', body: { confirm: website.domain } });
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		setDialog(null);
		setGone(true);
		toast.show({ title: WEBSITE.websiteRemoved(website.domain) });
		nav.go(afterRemoved);
	};
	const copyDomain = async () => {
		const copied = await copyText(website.domain);
		toast.show(copied ? { title: MORE.copied } : { tone: 'danger', title: website.domain });
	};

	// the inner navigation: Overview, the products (each with its status dot), the settings sections (a dot where a
	// product still needs something, a count of links), then the rest
	/** @type {import('@ss/ui').InnerNavGroup[]} */
	const groups = [
		{ items: [{ id: 'overview', label: WEBSITE.overview, icon: 'home' }] },
		...(cards.length > 0
			? [
					{
						label: WEBSITE.productsTitle,
						items: cards.map((card) => ({
							id: `products/${card.productId}`,
							label: card.name,
							dot: productTone(card),
							dotLabel: productStatusLabel(card),
						})),
					},
				]
			: []),
		...(hasSettings
			? [
					{
						label: WEBSITE.websiteSettings,
						items: SETTINGS_SECTIONS.filter(
							(section) => (section !== 'connections' && section !== 'links') || state.connections !== null,
						).map((section) => ({
							id: `settings/${section}`,
							label: T.sections[section],
							...(section === 'connections'
								? connectionsMark(state.connections)
								: section === 'links'
									? state.connections && state.connections.links.length > 0
										? { count: state.connections.links.length }
										: {}
									: contextOf(state.readiness, section)),
						})),
					},
				]
			: []),
		{
			items: [
				...(can.tokens ? [{ id: 'install', label: WEBSITE.tokens, icon: /** @type {const} */ ('key') }] : []),
				...(can.tokens ? [{ id: 'setup', label: WEBSITE.setupSheet, icon: /** @type {const} */ ('layers') }] : []),
				{ id: 'usage', label: WEBSITE.usage, icon: /** @type {const} */ ('trendingUp') },
				...(hasSettings
					? [
							{
								id: 'changes',
								label: WEBSITE.recentChanges,
								icon: /** @type {const} */ ('clock'),
								...(state.changes.length > 0 ? { count: state.changes.length } : {}),
							},
						]
					: []),
			],
		},
	];

	const onSettings = kind === 'settings' || kind === 'changes';
	const onSetup = kind === 'setup' && setupState.sheet !== null;
	const facts = [
		{ label: WEBSITE.dailyCost, value: WEBSITE.perDay(formatCredits(dailyCostOf(cards))) },
		{
			label: WEBSITE.productsTitle,
			value: cards.length,
			href: hrefOf(cards[0] ? `products/${cards[0].productId}` : ''),
		},
		...(onSettings && state.settings
			? [
					{ label: WEBSITE.settingsVersion, value: state.settings.version },
					{
						label: T.savedAt,
						value: state.settings.updatedAt ? <LocalTime value={state.settings.updatedAt} /> : T.neverSaved,
					},
				]
			: []),
	];
	/** @type {import('@ss/ui').PageActions} */
	const actions = {
		...(onSetup
			? { primary: { label: SETUP.download, icon: 'arrowDown', onClick: setupState.download } }
			: can.manage
				? { primary: { label: WEBSITE.addProduct, icon: 'plus', onClick: () => setDialog('add') } }
				: {}),
		...(onSetup
			? {
					secondary: [
						{ label: SETUP.copy, icon: 'copy', onClick: setupState.copy },
						{ label: SETUP.refresh, loading: setupState.refreshing, onClick: setupState.refresh },
					],
				}
			: {}),
		more: [
			{
				label: MORE.visitWebsite,
				icon: 'external',
				onSelect: () => void window.open(`https://${website.domain}`, '_blank', 'noopener,noreferrer'),
			},
			{ label: MORE.copyDomain, icon: 'copy', onSelect: () => void copyDomain() },
			...(can.removeWebsite
				? [
						{
							label: WEBSITE.removeWebsite,
							danger: true,
							divider: true,
							disabled: cards.length > 0,
							...(cards.length > 0 ? { hint: WEBSITE.removeProductsFirst } : {}),
							onSelect: () => {
								setProblem(null);
								setDialog('removeWebsite');
							},
						},
					]
				: []),
		],
	};

	/** @param {ProductCard} card */
	const productMenu = (card) => [
		...(can.open ? [{ label: WEBSITE.openLabel(card.name), icon: /** @type {const} */ ('external'), onSelect: () => void open(card) }] : []),
		...(can.manage
			? [
					{
						label: WEBSITE.remove,
						danger: true,
						onSelect: () => {
							setProblem(null);
							setRemoving(card);
						},
					},
				]
			: []),
	];

	// what stands in place of the body when the address is not a page of this website or the person may not see it
	/** @type {string | null} */
	let error = null;
	if (parsed === null) error = WEBSITE.noSuchPage;
	else if (parsed.kind === 'product' && !shown) error = WEBSITE.noSuchProduct;
	else if (parsed.kind === 'settings' || parsed.kind === 'changes')
		error = !can.settings ? WEBSITE.noSuchPage : settings && !settings.ok ? describeProblem(settings.problem) : null;
	else if (parsed.kind === 'install' || parsed.kind === 'setup') {
		error = !can.tokens ? WEBSITE.noSuchPage : parsed.kind === 'setup' && setup && !setup.ok ? describeProblem(setup.problem) : null;
	}

	/** @type {import('react').ReactNode} */
	let body = null;
	if (!error && parsed) {
		if (parsed.kind === 'overview')
			body = (
				<CardFlow>
					<Card padded={false} title={WEBSITE.productsTitle} subtitle={WEBSITE.productsCount(cards.length)}>
						{cards.length === 0 ? (
							<EmptyState compact icon="box" title={can.manage ? WEBSITE.noProducts : WEBSITE.noProductsMerchant} />
						) : (
							<DataTable
								caption={WEBSITE.productsOf(website.domain)}
								rows={cards}
								rowKey={(card) => card.productId}
								rowLabel={(card) => card.name}
								onRowClick={(card) => nav.go(hrefOf(`products/${card.productId}`))}
								rowMenu={productMenu}
								columns={[
									{
										key: 'name',
										header: WEBSITE.productColumn,
										sortable: true,
										render: (card) => (
											<Link href={hrefOf(`products/${card.productId}`)} className="font-medium text-fg hover:underline">
												{card.name}
											</Link>
										),
									},
									{ key: 'status', header: WEBSITE.statusColumn, kind: 'status', pill: productPill },
									{
										key: 'features',
										header: WEBSITE.featuresColumn,
										kind: 'number',
										sortValue: (card) => card.featuresOn.length,
										render: (card) => card.featuresOn.length,
									},
									{
										key: 'dailyCost',
										header: BILLING.dailyCost,
										kind: 'money',
										sortable: true,
										render: (card) => WEBSITE.perDay(formatCredits(card.dailyCost)),
									},
								]}
							/>
						)}
					</Card>
					<WebsiteSpend key={`spend-${websiteId}`} merchantId={merchantId} websiteId={websiteId} />
				</CardFlow>
			);
		else if (parsed.kind === 'product' && shown)
			body = (
				<CardFlow>
					<Card
						title={shown.name}
						actions={
							<>
								{can.open ? (
									<Button
										variant="secondary"
										size="sm"
										loading={opening === shown.productId}
										aria-label={WEBSITE.openLabel(shown.name)}
										title={WEBSITE.openHelp}
										onClick={() => void open(shown)}>
										{WEBSITE.open}
									</Button>
								) : null}
								{can.manage ? (
									<ActionMenu
										label={WEBSITE.productActions(shown.name)}
										items={[
											{
												label: WEBSITE.remove,
												danger: true,
												onSelect: () => {
													setProblem(null);
													setRemoving(shown);
												},
											},
										]}
									/>
								) : null}
							</>
						}>
						<KeyValueList
							items={[
								{ label: WEBSITE.statusColumn, value: <ProductStatusBadge status={shown.status} featuresOn={shown.featuresOn} /> },
								{ label: BILLING.dailyCost, value: WEBSITE.perDay(formatCredits(shown.dailyCost)) },
								{
									label: WEBSITE.featuresColumn,
									value: shown.featuresOn.length > 0 ? shown.featuresOn.join(', ') : WEBSITE.noFeaturesOn,
								},
							]}
						/>
					</Card>
				</CardFlow>
			);
		else if (parsed.kind === 'settings')
			body = (
				<div className="space-y-6">
					{readinessLines(state.readiness).length > 0 ? (
						<Callout tone="attention" title={T.readyTitle}>
							<ul className="list-disc space-y-0.5 pl-5">
								{readinessLines(state.readiness).map((line) => (
									<li key={line}>{line}</li>
								))}
							</ul>
						</Callout>
					) : null}
					<SettingsSectionBody section={parsed.section} state={state} />
				</div>
			);
		else if (parsed.kind === 'changes') body = <ChangesTable changes={state.changes} />;
		else if (parsed.kind === 'install') body = <InstallPart merchantId={merchantId} website={website} />;
		else if (parsed.kind === 'usage') body = <UsagePart merchantId={merchantId} websiteId={websiteId} />;
		else if (parsed.kind === 'setup' && setup?.ok)
			body = (
				<SetupView
					state={setupState}
					links={setup.links}
					manage={manage}
					canSwitch={canSwitch}
					settingsHref={hrefOf('settings')}
				/>
			);
	}

	return (
		<>
			<Page
				linkAs={Link}
				flush={kind === 'changes'}
				bodyKey={part}
				crumbs={[...crumbs, { label: website.domain }]}
				status={[pills[websiteDot(cards)]]}
				facts={facts}
				actions={actions}
				info={onSettings ? T.intro : WEBSITE.pageInfo}
				nav={{
					groups: groups.map((group) => ({
						...group,
						items: group.items.map((item) => ({ ...item, href: hrefOf(item.id === 'overview' ? '' : item.id) })),
					})),
					value: current,
					label: WEBSITE.navLabel,
				}}
				loading={gone}
				{...(error ? { error } : {})}>
				{body}
			</Page>
			<AddProductDrawer
				open={dialog === 'add'}
				merchantId={merchantId}
				website={website}
				products={(addable ?? []).filter((p) => !cards.some((c) => c.productId === p.productId))}
				onClose={() => setDialog(null)}
				onAdded={(card) => {
					setCards([...cards, card].sort((a, b) => a.productId.localeCompare(b.productId)));
					setDialog(null);
					toast.show({ title: WEBSITE.productAdded(card.name) });
					nav.go(hrefOf(`products/${card.productId}`));
				}}
			/>
			<TypedConfirmDialog
				open={Boolean(removing)}
				onClose={() => setRemoving(null)}
				onConfirm={() => void removeProduct()}
				expected={removing?.name ?? ''}
				busy={busy}
				danger
				confirmLabel={WEBSITE.remove}
				title={WEBSITE.removeTitle(removing?.name ?? '')}
				error={problem ? describeProblem(problem) : null}>
				<p className="text-sm text-muted">{WEBSITE.removeHelp}</p>
			</TypedConfirmDialog>
			<TypedConfirmDialog
				open={dialog === 'removeWebsite'}
				onClose={() => setDialog(null)}
				onConfirm={() => void removeWebsite()}
				expected={website.domain}
				busy={busy}
				danger
				confirmLabel={WEBSITE.removeWebsite}
				title={WEBSITE.removeWebsiteTitle(website.domain)}
				error={problem ? describeProblem(problem) : null}>
				<p className="text-sm text-muted">{WEBSITE.removeWebsiteHelp}</p>
			</TypedConfirmDialog>
		</>
	);
}

/**
 * The inner navigation mark of Data and files: a red dot when a product's database or storage test failed.
 * @param {import('./website-connections.js').ConnectionsView | null} view
 */
const connectionsMark = (view) =>
	view?.products.some((p) => p.database?.state === 'test_failed' || p.storage?.state === 'test_failed')
		? { dot: /** @type {const} */ ('danger'), dotLabel: T.data.state.test_failed }
		: {};
