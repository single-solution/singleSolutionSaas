'use client';
/**
 * A website's own page, the same in both consoles (PLAN redesign): ONE `Page` whose header carries the domain, status,
 * daily cost, primary action and ⋯. The **home** job is product rows only (name, status, cost, Open, ⋯). Install,
 * usage, recent changes, Website settings and the Setup sheet are their own addresses. Open configure asks for the
 * person's password first (stolen session blast radius). Add product is a drawer; Remove is a typed confirm. What each
 * person may do follows `can`; the Portal checks every right again.
 * @module
 */
import { useEffect, useState } from 'react';
import {
	ActionMenu,
	Button,
	Callout,
	Card,
	EmptyState,
	Icon,
	IconBadge,
	LocalTime,
	Page,
	Skeleton,
	Timeline,
	TypedConfirmDialog,
	copyText,
	describeProblem,
	formatCredits,
	useToast,
} from '@ss/ui';
import { MORE, SETUP, WEBSITE, WEBSITE_SETTINGS as T } from '../../texts/console.js';
import { apiFetch } from '../client.js';
import { Link } from '../link.js';
import { useNavigation } from '../navigation.js';
import { api } from '../paths.js';
import { parseWebsitePart, SETTINGS_SECTIONS } from '../website-parts.js';
import { UsageView, productStatusLabel, productTone } from './billing.js';
import { openDashboard } from './common.js';
import { ConfirmChange } from './confirm-change.js';
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
 * One product row on the website home: name, status, cost, Open, ⋯. Install lives on `/install`.
 * @param {{ card: ProductCard, can: WebsiteCan, opening: boolean, onOpen: () => void, onRemove: () => void }} props
 */
function ProductRow({ card, can, opening, onOpen, onRemove }) {
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
				: {})}
		/>
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
	/** Product waiting for password confirm before launch. */
	const [launching, setLaunching] = useState(/** @type {ProductCard | null} */ (null));
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
	// pages of their own (not the product-rows home)
	const own =
		kind === 'settings'
			? 'settings'
			: kind === 'setup'
				? 'setup'
				: kind === 'install'
					? 'install'
					: kind === 'usage'
						? 'usage'
						: kind === 'changes'
							? 'changes'
							: null;
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
	else if (parsed.kind === 'usage') error = null;
	else if (parsed.kind === 'install' || parsed.kind === 'setup') {
		error = !can.tokens
			? WEBSITE.noSuchPage
			: parsed.kind === 'setup' && setup && !setup.ok
				? describeProblem(setup.problem)
				: null;
	}

	const onHome = own === null && !error && !gone;
	const onInstall = own === 'install' && !error && !gone;
	const onUsage = own === 'usage' && !error && !gone;
	const onChanges = own === 'changes' && !error && !gone;
	const usage = useOnce(onUsage ? api.usage(merchantId, { websiteId }) : null);
	const tokens = useOnce(onInstall && can.tokens ? api.tokens(merchantId, websiteId) : null);
	const twoStepOn = twoStepOnOf(useOnce(onInstall && can.tokens ? '/v1/me' : null));

	// a deep link to one product scrolls its row into view on the home
	useEffect(() => {
		if (onHome && productId) document.getElementById(`product-${productId}`)?.scrollIntoView?.({ block: 'start' });
	}, [onHome, productId]);
	// the list picked another website: nothing of the last one stays open
	useEffect(() => {
		setDialog(null);
		setRemoving(null);
		setLaunching(null);
		setProblem(null);
		setGone(false);
	}, [websiteId]);

	/** @param {ProductCard[]} next */
	const setCards = (next) => setCardsState(next);
	/** @param {ProductCard} card */
	const askOpen = (card) => setLaunching(card);
	/** @param {{ password: string, code?: string, recoveryCode?: string }} confirmation */
	const sendLaunch = async (confirmation) => {
		if (!launching)
			return { ok: /** @type {const} */ (false), problem: /** @type {any} */ ({ status: 400, title: 'Nothing to open' }) };
		setOpening(launching.productId);
		const { path, body } = launch(launching.productId);
		const result = await openDashboard(path, { ...(body && typeof body === 'object' ? body : {}), ...confirmation });
		setOpening(null);
		if (!result.ok) return result;
		setLaunching(null);
		return { ok: /** @type {const} */ (true) };
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
	/** Home header: at most two secondary actions (Page rule); the rest open from More. */
	const homeSecondary = [
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
						label: WEBSITE.installCeremony,
						icon: /** @type {const} */ ('code'),
						onClick: () => nav.go(hrefOf('install')),
					},
					{
						label: WEBSITE.setupSheet,
						icon: /** @type {const} */ ('layers'),
						onClick: () => nav.go(hrefOf('setup')),
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
			: own === null && homeSecondary.length > 0
				? { secondary: homeSecondary.slice(0, 2) }
				: {}),
		more: [
			...(own === null
				? homeSecondary.slice(2).map((action) => ({
						label: action.label,
						icon: action.icon,
						onSelect: action.onClick,
					}))
				: []),
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
				...(can.tokens
					? [
							{ id: 'install', label: WEBSITE.installCeremony, icon: /** @type {const} */ ('code') },
							{ id: 'setup', label: WEBSITE.setupSheet, icon: /** @type {const} */ ('layers') },
						]
					: []),
				{ id: 'usage', label: WEBSITE.usageDetails, icon: /** @type {const} */ ('trendingUp') },
				...(can.settings ? [{ id: 'changes', label: WEBSITE.recentChanges, icon: /** @type {const} */ ('clock') }] : []),
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
	const current =
		parsed?.kind === 'settings'
			? `settings/${parsed.section}`
			: own === 'install'
				? 'install'
				: own === 'usage'
					? 'usage'
					: own === 'changes'
						? 'changes'
						: 'setup';

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
	else if (onInstall) {
		const entries = /** @type {import('./website.js').TokenEntry[]} */ (tokens?.ok ? (tokens.data?.items ?? []) : []);
		body = (
			<div className="space-y-4">
				<p className="text-sm text-muted">{WEBSITE.installCeremonyHelp}</p>
				{tokens && !tokens.ok ? <Callout tone="danger">{describeProblem(tokens.problem)}</Callout> : null}
				{cards.length === 0 ? (
					<EmptyState
						compact
						icon="box"
						title={can.manage ? WEBSITE.noProducts : WEBSITE.noProductsMerchant}
						description={can.manage ? WEBSITE.noProductsHelp : WEBSITE.noProductsMerchantHelp}
						action={
							can.manage ? (
								<Button size="sm" icon={<Icon name="plus" size={14} />} onClick={() => setDialog('add')}>
									{WEBSITE.addProduct}
								</Button>
							) : undefined
						}
					/>
				) : !tokens ? (
					<Skeleton lines={4} />
				) : (
					cards.map((card) => {
						const entry = entries.find((e) => e.productId === card.productId) ?? null;
						return entry ? (
							<Card key={card.productId} lead={<IconBadge product={card.productId} size="sm" />} title={card.name}>
								<InstallBlock
									key={`${websiteId}:${card.productId}`}
									entry={entry}
									domain={website.domain}
									merchantId={merchantId}
									websiteId={websiteId}
									twoStepOn={twoStepOn}
								/>
							</Card>
						) : null;
					})
				)}
			</div>
		);
	} else if (onUsage)
		body = (
			<div id="usage">
				{!usage ? (
					<Skeleton lines={4} />
				) : usage.ok ? (
					<UsageView usage={usage.data} showWebsite={false} chart />
				) : (
					<Callout tone="danger">{describeProblem(usage.problem)}</Callout>
				)}
			</div>
		);
	else if (onChanges)
		body = (
			<div id="activity">
				<Card title={WEBSITE.recentChanges} subtitle={T.changes.intro}>
					{settings && !settings.ok ? (
						<Callout tone="danger">{describeProblem(settings.problem)}</Callout>
					) : (
						<ChangesTimeline changes={state.changes} />
					)}
				</Card>
			</div>
		);
	else if (onHome) {
		sections = [
			{
				id: 'products',
				label: WEBSITE.productsTitle,
				icon: 'box',
				body: (
					<>
						{cards.length === 0 ? (
							<EmptyState
								compact
								icon="box"
								title={can.manage ? WEBSITE.noProducts : WEBSITE.noProductsMerchant}
								description={can.manage ? WEBSITE.noProductsHelp : WEBSITE.noProductsMerchantHelp}
								action={
									can.manage ? (
										<Button size="sm" icon={<Icon name="plus" size={14} />} onClick={() => setDialog('add')}>
											{WEBSITE.addProduct}
										</Button>
									) : undefined
								}
							/>
						) : (
							cards.map((card) => (
								<ProductRow
									key={card.productId}
									card={card}
									can={can}
									opening={opening === card.productId}
									onOpen={() => askOpen(card)}
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
				info={kind === 'settings' ? T.intro : own === 'install' ? WEBSITE.installCeremonyHelp : WEBSITE.pageInfo}
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
				{...(list && (own === null || own === 'install' || own === 'usage' || own === 'changes') ? { list } : {})}
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
			<ConfirmChange
				open={Boolean(launching)}
				title={WEBSITE.openConfirmTitle(launching?.name ?? '')}
				help={WEBSITE.openConfirmHelp}
				confirmLabel={WEBSITE.openConfirmLabel}
				send={sendLaunch}
				onClose={() => setLaunching(null)}
				onDone={() => setLaunching(null)}
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
