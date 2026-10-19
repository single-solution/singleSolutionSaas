'use client';
/**
 * Merchant Overview and Websites (PLAN 0.8.2 Merchant): the balance and days left at the current spend, the 30-day
 * spend chart and the websites with product chips and Open buttons; the Websites page — a table of the websites
 * (domain, status, products, daily cost) whose row opens the website's own page (`website-page.js`; no admin actions).
 * With no websites yet, the welcome with the support contact (PLAN 0.8.2 Sign-in).
 * Layout: the Overview is one page (the greeting behind the (i), the key numbers in the header, then its cards).
 * @module
 */
import { useState } from 'react';
import {
	BarChart,
	Button,
	ButtonLink,
	Card,
	DataTable,
	EmptyState,
	Icon,
	NeedsList,
	Page,
	Stat,
	StatGrid,
	Toolbar,
	describeProblem,
	formatCredits,
	useToast,
	TextLink,
} from '@ss/ui';
import { AUTH, BILLING, MERCHANT, MORE, WEBSITE } from '../../texts/console.js';
import { Link } from '../link.js';
import { useNavigation } from '../navigation.js';
import { api, routes } from '../paths.js';
import { DaysLeft, ProductStatusBadge, creditDayBars, formatChartCredits, receiptColumns } from './billing.js';
import { FrameBilling } from './frame-billing.js';
import { PageProblem, openDashboard } from './common.js';
import { ActivityTimeline } from './login-settings.js';
import { contactLine } from './sign-in.js';
import { dailyCostOf, websiteDot } from './website.js';
import { WebsitePageView } from './website-page.js';

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

	/** One row per product on a website; a website with none has one row that says so. */
	/** @type {Array<{ key: string, website: any, card: ProductCard | null }>} */
	const productRows = [];
	for (const { website, cards } of rows) {
		if (cards.length === 0) productRows.push({ key: `${website.websiteId}:-`, website, card: null });
		for (const card of cards) productRows.push({ key: `${website.websiteId}:${card.productId}`, website, card });
	}

	return (
		<>
			<FrameBilling billing={billing} />
			<Page
				linkAs={Link}
				crumbs={[{ label: MERCHANT.overviewTitle }]}
				info={
					<>
						<span className="block font-medium text-fg">{MERCHANT.welcome(name)}</span>
						{MERCHANT.summary({ websites: rows.length, products: productCount, needs: needs.length })}
					</>
				}
				facts={[
					{ label: MERCHANT.tiles.websites, value: rows.length, href: routes.websites() },
					...(needs.length > 0
						? [{ label: MERCHANT.needs.title, value: needs.length, tone: /** @type {const} */ ('warning') }]
						: []),
					...(billing
						? [
								{ label: BILLING.balance, value: formatCredits(billing.balance), href: routes.credits() },
								{ label: BILLING.daysLeft, value: <DaysLeft summary={billing} />, href: routes.credits() },
							]
						: []),
				]}>
				{rows.length === 0 ? (
					<Welcome branding={props.branding} />
				) : (
					<div className="space-y-4">
						<Card title={MERCHANT.needs.title} subtitle={needs.length > 0 ? MERCHANT.needs.intro : undefined}>
							<NeedsList items={needs} none={MERCHANT.needs.none} />
						</Card>
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
						<Card
							padded={false}
							title={MERCHANT.websitesTitle}
							actions={
								<ButtonLink as={Link} href={routes.websites()} variant="secondary" size="sm">
									{MORE.viewAll}
								</ButtonLink>
							}>
							<DataTable
								caption={MERCHANT.websitesTitle}
								rows={productRows}
								rowKey={(r) => r.key}
								empty={WEBSITE.noProductsMerchant}
								columns={[
									{
										key: 'domain',
										header: MERCHANT.websiteColumns.website,
										render: (r) => (
											<TextLink
												as={Link}
												tone="plain"
												href={routes.website(r.website.websiteId)}
												title={r.website.domain}>
												{r.website.domain}
											</TextLink>
										),
									},
									{
										key: 'product',
										header: MERCHANT.websiteColumns.products,
										wrap: true,
										render: (r) => r.card?.name ?? <span className="text-muted">{WEBSITE.noProductsMerchant}</span>,
									},
									{
										key: 'status',
										header: MERCHANT.websiteColumns.status,
										kind: 'status',
										render: (r) =>
											r.card ? <ProductStatusBadge status={r.card.status} featuresOn={r.card.featuresOn} /> : null,
									},
									{
										key: 'open',
										header: WEBSITE.open,
										align: 'right',
										render: (r) => (r.card ? openButton(r.website, r.card) : null),
									},
								]}
							/>
						</Card>
						<Card
							flow
							title={MORE.recentActivity}
							actions={
								<ButtonLink as={Link} href={routes.account()} variant="secondary" size="sm">
									{MORE.viewAll}
								</ButtonLink>
							}>
							<ActivityTimeline items={props.activity ?? []} empty={MORE.noActivity} showMerchant={false} />
						</Card>
						<Card
							flow
							padded={false}
							title={MORE.latestReceipts}
							actions={
								<ButtonLink as={Link} href={routes.creditsReceipts()} variant="secondary" size="sm">
									{MORE.viewAll}
								</ButtonLink>
							}>
							<DataTable
								caption={MORE.latestReceipts}
								rows={props.receipts ?? []}
								rowKey={(r) => r.receiptId}
								empty={<EmptyState compact icon="receipt" kind="credit" title={BILLING.noReceipts} />}
								columns={receiptColumns({ receipts: props.receipts ?? [] })}
							/>
						</Card>
					</div>
				)}
			</Page>
		</>
	);
}

/** How a website's worst product status reads in the table. */
const SITE_PILLS = /** @type {const} */ ({
	success: { status: 'active', label: MERCHANT.websiteStatus.success },
	warning: { status: 'warning', label: MERCHANT.websiteStatus.warning },
	danger: { status: 'error', label: MERCHANT.websiteStatus.danger },
	neutral: { status: 'off', label: MERCHANT.websiteStatus.neutral },
});

/**
 * The merchant's Websites page: a table (website, status, products, daily cost) with a search, whose row opens the
 * website's own page. With no websites yet, the welcome.
 * @param {{ rows: Array<{ website: any, cards: ProductCard[] }>, branding?: BrandingSupport }} props
 */
function WebsitesPage({ rows, branding }) {
	const nav = useNavigation();
	const [q, setQ] = useState('');
	const needle = q.trim().toLowerCase();
	const sites = rows
		.filter((r) => !needle || String(r.website.domain).toLowerCase().includes(needle))
		.map(({ website, cards }) => ({
			id: String(website.websiteId),
			domain: String(website.domain),
			products: cards.length,
			cost: dailyCostOf(cards),
			dot: websiteDot(cards),
		}));
	return (
		<Page
			flush
			crumbs={[{ label: MERCHANT.websitesTitle }]}
			info={MERCHANT.websitesInfo}
			linkAs={Link}
			{...(rows.length > 0
				? {
						toolbar: (
							<Toolbar
								label={MERCHANT.websitesTitle}
								search={{ value: q, onSearch: setQ, label: WEBSITE.search, placeholder: WEBSITE.search }}
								range={MORE.count(sites.length)}
							/>
						),
					}
				: {})}>
			{rows.length === 0 ? (
				<Welcome branding={branding} />
			) : (
				<DataTable
					caption={MERCHANT.websitesTitle}
					rows={sites}
					rowKey={(s) => s.id}
					rowLabel={(s) => s.domain}
					onRowClick={(s) => nav.go(routes.website(s.id))}
					empty={<EmptyState compact icon="globe" kind="website" title={WEBSITE.none} />}
					columns={[
						{
							key: 'domain',
							header: MERCHANT.websiteColumns.website,
							sortable: true,
							render: (s) => (
								<Link href={routes.website(s.id)} className="font-medium text-fg hover:underline">
									{s.domain}
								</Link>
							),
						},
						{ key: 'status', header: MERCHANT.websiteColumns.status, kind: 'status', pill: (s) => SITE_PILLS[s.dot] },
						{ key: 'products', header: MERCHANT.websiteColumns.products, kind: 'number', sortable: true },
						{
							key: 'cost',
							header: MERCHANT.websiteColumns.dailyCost,
							kind: 'money',
							sortable: true,
							render: (s) => WEBSITE.perDay(formatCredits(s.cost)),
						},
					]}
				/>
			)}
		</Page>
	);
}

/**
 * The merchant's Websites screen: the table of websites (or the welcome with none yet).
 * @param {any} props loader result of `loadWebsites` plus `branding`
 */
export function WebsitesView(props) {
	if (!props.ok) return <PageProblem problem={props.problem} />;
	return (
		<>
			<FrameBilling billing={props.billing} />
			<WebsitesPage rows={props.rows} branding={props.branding} />
		</>
	);
}

/**
 * One website's own page in the merchant console (`Websites › domain`, its parts as inner navigation): the merchant
 * cannot add or remove products here, the admin does (PLAN 0.2).
 * @param {any} props loader result of `loadWebsitePage`
 */
export function WebsiteView(props) {
	if (!props.ok) return <PageProblem problem={props.problem} />;
	const rows = /** @type {Array<{ website: any, cards: ProductCard[] }>} */ (props.rows);
	const websiteId = String(props.websiteId);
	const selected = rows.find((r) => String(r.website.websiteId) === websiteId) ?? null;
	const crumbs = [{ label: MERCHANT.websitesTitle, href: routes.websites() }];
	return (
		<>
			<FrameBilling billing={props.billing} />
			{selected ? (
				<WebsitePageView
					key={websiteId}
					website={selected.website}
					cards={selected.cards}
					part={props.part}
					crumbs={crumbs}
					hrefOf={(part) => routes.websitePart(websiteId, part)}
					can={{ manage: false, removeWebsite: false, tokens: true, open: true, settings: true }}
					pills={SITE_PILLS}
					launch={(productId) => ({ path: api.launch(props.merchantId, websiteId, productId) })}
					afterRemoved={routes.websites()}
					settings={props.settings}
					setup={props.setup}
				/>
			) : (
				<Page linkAs={Link} crumbs={[...crumbs, { label: websiteId }]} error={WEBSITE.gone} />
			)}
		</>
	);
}
