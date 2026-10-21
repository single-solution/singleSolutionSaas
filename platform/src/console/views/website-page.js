'use client';
/**
 * A website's own page, the same in both consoles (flat layout 2026-10-21): ONE `Page` whose header carries the domain
 * (crumbs `Websites › domain` for a merchant, `Merchants › name › domain` for an admin), the status pill, the daily
 * cost, the products on, the one primary action and the ⋯ More menu. Its body shows every section at once, all open:
 * **Status and spend** (the key numbers and the 30-day spend) · **Products** (one rich card per product: its status,
 * one line of help, Open dashboard, Remove and its install block with the widget script tag and tokens) · **Recent
 * changes** (a timeline) · **Usage details**. In the merchant console the list of websites stands beside it
 * (`list`). The old addresses (`products/:id`, `install`, `usage`, `changes`) open this page at their section.
 * **Website settings** (Business, Brand and look, Region and format, Domains, pages and legal, Team and alerts, Data
 * and files, Between your products; the floating Save bar is the only save) and the **Setup sheet** are big, so each
 * stays its own address, reached by an action in the header and by the inner navigation. Add product and Add website
 * are drawers; a short yes/no stays a dialog. What each person may do follows the `can` the console passes; the Portal
 * checks every right again.
 * @module
 */
import { useEffect, useState } from 'react';
import {
	ActionMenu,
	BarChart,
	Button,
	Callout,
	Card,
	EmptyState,
	IconBadge,
	LocalTime,
	Page,
	Skeleton,
	Stat,
	StatGrid,
	Timeline,
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
import { parseWebsitePart, sectionOf, SETTINGS_SECTIONS } from '../website-parts.js';
import { UsageView, creditDayBars, formatChartCredits, productStatusLabel, productTone } from './billing.js';
import { openDashboard } from './common.js';
import { SetupView, useSetupSheet } from './setup.js';
import { SettingsSectionBody, contextOf, readinessLines, useWebsiteSettings } from './website-settings.js';
import { AddProductDrawer, InstallBlock, dailyCostOf, twoStepOnOf, useOnce, websiteDot } from './website.js';

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
 * Recent changes of the website settings as a timeline: who changed which section, what changed and when.
 * @param {{ changes: Array<{ at: string, version: number, section: string, changed: string[], who: { name: string | null } | null }> }} props
 */
function ChangesTimeline({ changes }) {
	return (
		<Timeline
			empty={T.changes.empty}
			items={changes.map((change) => ({
				key: `${change.version}-${change.at}`,
				who: change.who?.name || WEBSITE.bySystem,
				what: `${T.changes.row(/** @type {Record<string, string>} */ (T.sections)[change.section] ?? change.section, change.version)} · ${T.changes.fields(change.changed)}`,
				at: change.at,
			}))}
		/>
	);
}

/**
 * @typedef {object} WebsitePageProps
 * @property {any} website the website (`websiteId`, `merchantId`, `domain`)
 * @property {ProductCard[]} cards its products
 * @property {string} part the part of the address after the website (`website-parts.js`)
 * @property {import('@ss/ui').PageCrumb[]} crumbs the steps above the website's domain
 * @property {(part: string) => string} hrefOf the address of a part (`''` = the page)
 * @property {WebsiteCan} can
 * @property {Record<'success' | 'warning' | 'danger' | 'neutral', SitePill>} pills how the website's worst product status reads
 * @property {Array<{ productId: string, name: string }> | null} [addable] active connected products (Add product)
 * @property {(productId: string) => { path: string, body?: unknown }} launch the Open route of a product
 * @property {string} afterRemoved where to go once the website was removed
 * @property {any} [settings] the loaded Website settings (`loadWebsiteSettings`), a failure, or null when not asked
 * @property {any} [setup] the loaded Setup sheet (`loadSetup`), a failure, or null when not asked
 * @property {boolean} [canSwitch] the admin console switches recommended features on
 * @property {import('react').ReactElement<any>} [list] the list of websites beside the page (a `ListColumn`, merchant console)
 * @property {string} [error] what stands in place of the page (a missing website: the list stays)
 */

/**
 * One product on the website as a rich card: its icon, name and status, one line of help (what is on and what it
 * costs), Open dashboard and its menu in the header, and its install block as the body.
 * @param {{ card: ProductCard, domain: string, merchantId: string, websiteId: string, can: WebsiteCan,
 *   tokens: any, pending: boolean, twoStepOn: boolean, opening: boolean, onOpen: () => void, onRemove: () => void }} props
 *   `tokens`: the entry of this product in the loaded tokens (null: none); `pending`: the tokens are still loading
 */
function ProductSection({ card, domain, merchantId, websiteId, can, tokens, pending, twoStepOn, opening, onOpen, onRemove }) {
	return (
		<Card
			id={`product-${card.productId}`}
			lead={<IconBadge product={card.productId} size="sm" />}
			title={card.name}
			status={{ tone: productTone(card), label: productStatusLabel(card) }}
			help={WEBSITE.productHelp(card.featuresOn, WEBSITE.perDay(formatCredits(card.dailyCost)))}
			{...(can.open || can.manage
				? {
						actions: (
							<>
								{can.open ? (
									<Button
										variant="secondary"
										size="sm"
										loading={opening}
										aria-label={WEBSITE.openLabel(card.name)}
										title={WEBSITE.openHelp}
										onClick={onOpen}>
										{WEBSITE.openDashboard}
									</Button>
								) : null}
								{can.manage ? (
									<ActionMenu
										label={WEBSITE.productActions(card.name)}
										items={[{ label: WEBSITE.remove, danger: true, onSelect: onRemove }]}
									/>
								) : null}
							</>
						),
					}
				: {})}>
			{tokens ? (
				<InstallBlock
					key={`${websiteId}:${card.productId}`}
					entry={tokens}
					domain={domain}
					merchantId={merchantId}
					websiteId={websiteId}
					twoStepOn={twoStepOn}
				/>
			) : pending ? (
				<Skeleton lines={3} />
			) : null}
		</Card>
	);
}

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
	settings = null,
	setup = null,
	canSwitch = false,
	list,
	error: missing,
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
	// the page itself, or one of the two big pages of their own (Website settings, the Setup sheet)
	const own = kind === 'settings' ? 'settings' : kind === 'setup' ? 'setup' : null;
	const onSetup = own === 'setup' && setupState.sheet !== null;

	// what stands in place of the body when the address is not a page of this website or the person may not see it
	/** @type {string | null} */
	let error = missing ?? null;
	if (error) {
		// a missing website
	} else if (parsed === null) error = WEBSITE.noSuchPage;
	else if (parsed.kind === 'product' && !shown) error = WEBSITE.noSuchProduct;
	else if (parsed.kind === 'settings')
		error = !can.settings ? WEBSITE.noSuchPage : settings && !settings.ok ? describeProblem(settings.problem) : null;
	else if (parsed.kind === 'changes') error = !can.settings ? WEBSITE.noSuchPage : null;
	else if (parsed.kind === 'install' || parsed.kind === 'setup') {
		error = !can.tokens
			? WEBSITE.noSuchPage
			: parsed.kind === 'setup' && setup && !setup.ok
				? describeProblem(setup.problem)
				: null;
	}

	// what the page loads for itself: the spend, and the tokens of its products (never for a person without tokens)
	const onPage = own === null && !error && !gone;
	const usage = useOnce(onPage ? api.usage(merchantId, { websiteId }) : null);
	const tokens = useOnce(onPage && can.tokens ? api.tokens(merchantId, websiteId) : null);
	// two-step on: the confirmation of a server token asks for the code at once
	const twoStepOn = twoStepOnOf(useOnce(onPage && can.tokens ? '/v1/me' : null));

	// an old address opens the page at its section (or at the product's card)
	const target = onPage ? sectionOf(parsed) : null;
	useEffect(() => {
		if (target) document.getElementById(target)?.scrollIntoView?.({ block: 'start' });
	}, [target]);
	// the list picked another website: nothing of the last one stays open
	useEffect(() => {
		setDialog(null);
		setRemoving(null);
		setProblem(null);
		setGone(false);
	}, [websiteId]);

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

	const dot = websiteDot(cards);
	const dailyCost = WEBSITE.perDay(formatCredits(dailyCostOf(cards)));
	const facts = [
		{ label: WEBSITE.dailyCost, value: dailyCost },
		{ label: WEBSITE.productsTitle, value: cards.length },
		...(kind === 'settings' && state.settings
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
			: own === null && (hasSettings || can.tokens)
				? {
						secondary: [
							...(hasSettings
								? [
										{
											label: WEBSITE.settingsAction,
											icon: /** @type {const} */ ('sliders'),
											onClick: () => nav.go(hrefOf('settings')),
										},
									]
								: []),
							...(can.tokens
								? [
										{
											label: WEBSITE.setupSheet,
											icon: /** @type {const} */ ('layers'),
											onClick: () => nav.go(hrefOf('setup')),
										},
									]
								: []),
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

	// the pages of their own (Website settings, the Setup sheet) keep the inner navigation: back to the page, the Setup
	// sheet, and the settings sections (a dot where a product still needs something, a count of links)
	/** @type {import('@ss/ui').InnerNavGroup[]} */
	const groups = [
		{
			items: [
				{ id: 'overview', label: WEBSITE.overview, icon: 'home' },
				...(can.tokens ? [{ id: 'setup', label: WEBSITE.setupSheet, icon: /** @type {const} */ ('layers') }] : []),
			],
		},
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
	];
	const current = parsed?.kind === 'settings' ? `settings/${parsed.section}` : 'setup';

	/** @type {import('react').ReactNode} */
	let body = null;
	/** @type {import('@ss/ui').PageSection[] | undefined} */
	let sections;
	if (!error && parsed && own === 'settings')
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
				<SettingsSectionBody section={/** @type {{ section: string }} */ (parsed).section} state={state} />
			</div>
		);
	else if (!error && own === 'setup' && setup?.ok)
		body = (
			<SetupView
				state={setupState}
				links={setup.links}
				manage={manage}
				canSwitch={canSwitch}
				settingsHref={hrefOf('settings')}
			/>
		);
	else if (onPage) {
		const days = usage?.ok ? usage.data : null;
		const bars = creditDayBars(days?.days);
		const entries = /** @type {import('./website.js').TokenEntry[]} */ (tokens?.ok ? (tokens.data?.items ?? []) : []);
		sections = [
			{
				id: 'status',
				label: WEBSITE.statusSpend,
				icon: 'activity',
				body: (
					<>
						<StatGrid label={WEBSITE.statusSpend}>
							<Stat label={WEBSITE.statusColumn} value={pills[dot].label} tone={dot} icon="activity" />
							<Stat label={WEBSITE.productsTitle} value={cards.length} icon="box" kind="product" />
							<Stat label={WEBSITE.dailyCost} value={dailyCost} icon="trendingUp" kind="credit" />
						</StatGrid>
						{usage && !usage.ok ? <Callout tone="danger">{describeProblem(usage.problem)}</Callout> : null}
						{days && !isEmptySeries(bars) ? (
							<Card title={MORE.websiteSpend} subtitle={formatCredits(days.total ?? 0)}>
								<BarChart label={MORE.websiteSpend} data={bars} format={formatChartCredits} height={120} />
							</Card>
						) : null}
					</>
				),
			},
			{
				id: 'products',
				label: WEBSITE.productsTitle,
				icon: 'box',
				body: (
					<>
						{tokens && !tokens.ok ? <Callout tone="danger">{describeProblem(tokens.problem)}</Callout> : null}
						{cards.length === 0 ? (
							<EmptyState compact icon="box" title={can.manage ? WEBSITE.noProducts : WEBSITE.noProductsMerchant} />
						) : (
							cards.map((card) => (
								<ProductSection
									key={card.productId}
									card={card}
									domain={website.domain}
									merchantId={merchantId}
									websiteId={websiteId}
									can={can}
									tokens={entries.find((entry) => entry.productId === card.productId) ?? null}
									pending={can.tokens && !tokens}
									twoStepOn={twoStepOn}
									opening={opening === card.productId}
									onOpen={() => void open(card)}
									onRemove={() => {
										setProblem(null);
										setRemoving(card);
									}}
								/>
							))
						)}
					</>
				),
			},
			...(can.settings
				? [
						{
							id: 'activity',
							label: WEBSITE.recentChanges,
							icon: /** @type {const} */ ('clock'),
							body: (
								<Card title={WEBSITE.recentChanges} subtitle={T.changes.intro}>
									{settings && !settings.ok ? (
										<Callout tone="danger">{describeProblem(settings.problem)}</Callout>
									) : (
										<ChangesTimeline changes={state.changes} />
									)}
								</Card>
							),
						},
					]
				: []),
			{
				id: 'usage',
				label: WEBSITE.usageDetails,
				icon: 'trendingUp',
				body: !usage ? (
					<Skeleton lines={4} />
				) : usage.ok ? (
					<Card title={WEBSITE.usageDetails}>
						<UsageView usage={usage.data} showWebsite={false} chart={false} />
					</Card>
				) : null,
			},
		];
	}

	return (
		<>
			<Page
				linkAs={Link}
				flush={false}
				bodyKey={own === null ? websiteId : part}
				crumbs={[...crumbs, { label: website.domain }]}
				status={[pills[dot]]}
				facts={facts}
				actions={actions}
				info={kind === 'settings' ? T.intro : WEBSITE.pageInfo}
				{...(own !== null
					? {
							nav: {
								groups: groups.map((group) => ({
									...group,
									items: group.items.map((item) => ({ ...item, href: hrefOf(item.id === 'overview' ? '' : item.id) })),
								})),
								value: current,
								label: WEBSITE.navLabel,
							},
						}
					: {})}
				{...(list && own === null ? { list } : {})}
				{...(sections ? { sections } : {})}
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
