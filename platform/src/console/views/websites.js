'use client';
/**
 * Merchant Overview and Websites (PLAN 0.8.2 Merchant): the balance and days left at the current spend, the 30-day
 * spend chart and the websites with product chips and Open buttons; the Websites screen — the list of websites (per
 * row the domain, a status dot and the daily cost) beside the selected website's card (on wide screens the first one
 * until another is picked; its products with Open, and Install and tokens and Usage as dialogs; no admin actions).
 * With no websites yet, the welcome with the support contact (PLAN 0.8.2 Sign-in).
 * Layout: the Overview has an inner sidebar (Websites, Needs you, Credits, Latest), one view at a time.
 * @module
 */
import { useEffect, useState } from 'react';
import { Badge, BarChart, Button, ButtonLink, Callout, Card, EmptyState, Icon, IconBadge, ListRow as Row, LocalTime, NeedsList, PageHeader, RowList, SectionLayout, SoftBreaks, Stat, StatGrid, describeProblem, formatCredits, isEmptySeries, useToast, TextLink } from '@ss/ui';
import { AUTH, BILLING, MERCHANT, MORE, WEBSITE } from '../../texts/console.js';
import { apiFetch } from '../client.js';
import { Link } from '../link.js';
import { api, routes } from '../paths.js';
import { DaysLeft, ProductStatusBadge, ReceiptsTable, creditDayBars, formatChartCredits } from './billing.js';
import { FrameBilling } from './frame-billing.js';
import { ListDetail, ListPane, ListRow, ListSearch, PageProblem, openDashboard } from './common.js';
import { ActivityTimeline } from './login-settings.js';
import { contactLine } from './sign-in.js';
import { WebsiteCard, dailyCostOf, websiteDot } from './website.js';

/** @typedef {import('./website.js').ProductCard} ProductCard */
/** @typedef {{ support?: { channels: import('@ss/contracts/text').SupportChannel[] } | null }} BrandingSupport */

/**
 * The welcome of a merchant with no websites yet.
 * @param {{ branding?: BrandingSupport }} props
 */
function Welcome({ branding }) {
	return (
		<EmptyState
			icon="globe"
			kind="website"
			title={AUTH.welcomeTitle}
			description={
				<>
					{AUTH.welcome} {AUTH.contactUs} {contactLine(branding?.support)}.
				</>
			}
		/>
	);
}

/**
 * The merchant's Overview: a greeting with one sentence of what matters now;
 * "Needs you" (a product with no feature on, with Open; a website with no product yet) beside the 30-day spend chart;
 * the money numbers (balance, days left, daily spend, spent this month); the websites with their products and Open
 * buttons; the latest activity as a timeline beside the latest receipts. Low credits show in the frame's banner.
 * @param {any} props loader result of `loadOverview` plus `branding` and the signed-in `me`
 */
export function OverviewView(props) {
	const toast = useToast();
	const [opening, setOpening] = useState(/** @type {string | null} */ (null));
	if (!props.ok) return <PageProblem problem={props.problem} />;
	const rows = /** @type {Array<{ website: any, cards: ProductCard[] }>} */ (props.rows);
	/** @param {any} website @param {ProductCard} card */
	const open = async (website, card) => {
		const key = `${website.websiteId}:${card.productId}`;
		setOpening(key);
		const result = await openDashboard(api.launch(props.merchantId, website.websiteId, card.productId));
		setOpening(null);
		if (!result.ok) toast.show({ tone: 'danger', title: describeProblem(result.problem) });
	};
	const billing = props.billing;
	const productCount = rows.reduce((n, r) => n + r.cards.length, 0);
	/** @param {any} website @param {ProductCard} card */
	const openButton = (website, card) => (
		<Button
			size="sm"
			variant="secondary"
			loading={opening === `${website.websiteId}:${card.productId}`}
			aria-label={`${WEBSITE.openLabel(card.name)} · ${website.domain}`}
			onClick={() => void open(website, card)}
			icon={<Icon name="external" size={14} />}>
			{WEBSITE.open}
		</Button>
	);

	/** @type {import('@ss/ui').Need[]} */
	const needs = [];
	for (const { website, cards } of rows) {
		if (cards.length === 0)
			needs.push({
				key: `empty-${website.websiteId}`,
				tone: 'warning',
				title: MERCHANT.needs.noProducts.title(website.domain),
				effect: MERCHANT.needs.noProducts.effect,
			});
		for (const card of cards)
			if (card.status === 'active' && (card.featuresOn ?? []).length === 0)
				needs.push({
					key: `features-${website.websiteId}-${card.productId}`,
					tone: 'warning',
					title: MERCHANT.needs.noFeatures.title(card.name, website.domain),
					effect: MERCHANT.needs.noFeatures.effect,
					action: openButton(website, card),
				});
	}
	const name = props.me?.merchant?.ownerName || props.me?.merchant?.name || '';

	const sections = [
		{
			id: 'websites',
			label: MERCHANT.websitesTitle,
			icon: /** @type {const} */ ('globe'),
			content: rows.map(({ website, cards }) => (
				<Card
					flow
					padded={false}
					key={website.websiteId}
					title={
						<span className="flex min-w-0 items-center gap-3">
							<IconBadge icon="globe" kind="website" size="sm" />
							<TextLink
								as={Link}
								tone="plain"
								href={routes.website(website.websiteId)}
								title={website.domain}
								className="line-clamp-2 min-w-0 break-words">
								<SoftBreaks text={website.domain} />
							</TextLink>
						</span>
					}
					subtitle={WEBSITE.perDay(formatCredits(dailyCostOf(cards)))}>
					{cards.length === 0 ? (
						<EmptyState compact icon="box" title={WEBSITE.noProductsMerchant} />
					) : (
						<RowList inset label={WEBSITE.productsOf(website.domain)}>
							{cards.map((card) => (
								<Row
									key={card.productId}
									icon="box"
									kind="product"
									title={card.name}
									status={<ProductStatusBadge status={card.status} featuresOn={card.featuresOn} />}
									action={openButton(website, card)}
								/>
							))}
						</RowList>
					)}
				</Card>
			)),
		},
		{
			id: 'needs',
			label: MERCHANT.needs.title,
			icon: /** @type {const} */ ('bell'),
			...(needs.length > 0 ? { badge: <Badge tone="warning">{needs.length}</Badge> } : {}),
			content: (
				<Card title={MERCHANT.needs.title} subtitle={needs.length > 0 ? MERCHANT.needs.intro : undefined}>
					<NeedsList items={needs} none={MERCHANT.needs.none} />
				</Card>
			),
		},
		{
			id: 'credits',
			label: MERCHANT.creditsSection,
			icon: /** @type {const} */ ('coins'),
			content: (
				<>
					<StatGrid>
						{billing ? (
							<>
								<Stat label={BILLING.balance} value={formatCredits(billing.balance)} icon="wallet" kind="credit" />
								<Stat label={BILLING.daysLeft} value={<DaysLeft summary={billing} />} icon="clock" kind="credit" />
								<Stat
									label={BILLING.dailySpend}
									value={formatCredits(billing.dailySpend)}
									icon="trendingUp"
									kind="credit"
								/>
								<Stat
									label={BILLING.spentThisMonth}
									value={formatCredits(billing.spentThisMonth)}
									icon="calendar"
									kind="credit"
								/>
							</>
						) : (
							<>
								<Stat label={MERCHANT.tiles.websites} value={rows.length} icon="globe" kind="website" />
								<Stat label={MERCHANT.tiles.products} value={productCount} icon="box" kind="product" />
							</>
						)}
					</StatGrid>
					<Card title={MERCHANT.spendChart} subtitle={props.usage ? formatCredits(props.usage.total ?? 0) : undefined}>
						<BarChart
							label={MERCHANT.spendChart}
							data={creditDayBars(props.usage?.days)}
							format={formatChartCredits}
							height={132}
						/>
					</Card>
				</>
			),
		},
		{
			id: 'latest',
			label: MERCHANT.latestSection,
			icon: /** @type {const} */ ('activity'),
			content: (
				<>
					<Card
						flow
						title={MORE.recentActivity}
						subtitle={MORE.recentActivityIntro}
						actions={
							<ButtonLink as={Link} href={routes.account()} variant="secondary" size="sm">
								{MORE.viewAll}
							</ButtonLink>
						}>
						<ActivityTimeline items={props.activity ?? []} empty={MORE.noActivity} showMerchant={false} />
					</Card>
					<Card
						flow
						title={MORE.latestReceipts}
						subtitle={MORE.latestReceiptsIntro}
						padded={false}
						actions={
							<ButtonLink as={Link} href={routes.credits()} variant="secondary" size="sm">
								{MORE.viewAll}
							</ButtonLink>
						}>
						<ReceiptsTable receipts={props.receipts ?? []} />
					</Card>
				</>
			),
		},
	];

	return (
		<div className="space-y-6">
			<FrameBilling billing={billing} />
			<PageHeader
				title={MERCHANT.welcome(name)}
				subtitle={MERCHANT.summary({ websites: rows.length, products: productCount, needs: needs.length })}
			/>
			{rows.length === 0 ? (
				<Welcome branding={props.branding} />
			) : (
				<SectionLayout label={MERCHANT.overviewTitle} sections={sections} />
			)}
		</div>
	);
}

/**
 * The spend on one website over the last 30 UTC days (all its products).
 * @param {{ merchantId: string, website: any }} props
 */
function WebsiteSpend({ merchantId, website }) {
	const [result, setResult] = useState(/** @type {import('../client.js').ApiResult<any> | null} */ (null));
	const websiteId = String(website.websiteId);
	useEffect(() => {
		let live = true;
		void apiFetch(api.usage(merchantId, { websiteId })).then((r) => {
			if (live) setResult(r);
		});
		return () => {
			live = false;
		};
	}, [merchantId, websiteId]);
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
 * The merchant's Websites screen (Owner and Support admins add and remove websites and products, PLAN 0.2).
 * @param {any} props loader result of `loadWebsites` plus `branding`
 */
export function WebsitesView(props) {
	const [q, setQ] = useState('');
	if (!props.ok) return <PageProblem problem={props.problem} />;
	const rows = /** @type {Array<{ website: any, cards: ProductCard[] }>} */ (props.rows);
	const selectedId = typeof props.selectedId === 'string' ? props.selectedId : null;
	const auto = selectedId === null;
	const selected = auto ? (rows[0] ?? null) : (rows.find((r) => String(r.website.websiteId) === selectedId) ?? null);
	const shownId = selected ? String(selected.website.websiteId) : null;
	const needle = q.trim().toLowerCase();
	const shown = needle ? rows.filter((r) => String(r.website.domain).toLowerCase().includes(needle)) : rows;
	return (
		<>
			<FrameBilling billing={props.billing} />
			<ListDetail
				section="websites"
				label={MERCHANT.websitesTitle}
				auto={auto}
				back={{ href: routes.websites(), label: MERCHANT.websitesTitle }}
				list={
					<ListPane
						title={MERCHANT.websitesTitle}
						count={MORE.count(rows.length)}
						tools={<ListSearch label={WEBSITE.search} value={q} onChange={setQ} />}>
						{shown.length === 0 ? (
							<li>
								<EmptyState compact icon="globe" kind="website" title={WEBSITE.none} />
							</li>
						) : (
							shown.map(({ website, cards }) => (
								<ListRow
									key={website.websiteId}
									href={routes.website(website.websiteId)}
									current={String(website.websiteId) === shownId ? (auto ? 'wide' : true) : false}
									label={website.domain}
									sublabel={WEBSITE.productsCount(cards.length)}
									dot={websiteDot(cards)}
									meta={WEBSITE.perDay(formatCredits(dailyCostOf(cards)))}
								/>
							))
						)}
					</ListPane>
				}
				empty={<Welcome branding={props.branding} />}
				detail={
					selected && shownId ? (
						<>
							<WebsiteCard
								key={shownId}
								headline
								website={selected.website}
								cards={selected.cards}
								can={{ manage: false, removeWebsite: false, tokens: true, open: true }}
								setupHref={routes.websiteSetup(shownId)}
								launch={(productId) => ({ path: api.launch(props.merchantId, shownId, productId) })}
							/>
							<WebsiteSpend key={`spend-${shownId}`} merchantId={props.merchantId} website={selected.website} />
						</>
					) : auto ? null : (
						<PageProblem
							problem={{ status: 404, title: 'Not Found', detail: WEBSITE.gone }}
							back={{ href: routes.websites(), label: MERCHANT.websitesTitle }}
						/>
					)
				}
			/>
		</>
	);
}
