'use client';
/**
 * Merchant Overview and Websites (PLAN 0.8.2 Merchant): the balance and days left at the current spend, the 30-day
 * spend chart and the websites with product chips and Open buttons; the Websites page — a table of the websites
 * (domain, status, products, daily cost) whose row opens the website's own page (`website-page.js`; no admin actions).
 * With no websites yet, the welcome with the support contact (PLAN 0.8.2 Sign-in).
 * Layout: the Overview is one page (the greeting behind the (i), the key numbers in the header, then its cards).
 * @module
 */
import { useLayoutEffect, useState } from 'react';
import {
	BarChart,
	Button,
	ButtonLink,
	Card,
	DataTable,
	EmptyState,
	Icon,
	IconBadge,
	ListColumn,
	NeedsList,
	Page,
	Stat,
	StatGrid,
	describeProblem,
	formatCredits,
	useToast,
	TextLink,
} from '@ss/ui';
import { AUTH, BILLING, MERCHANT, MORE, WEBSITE } from '../../texts/console.js';
import { Link } from '../link.js';
import { useNavigation } from '../navigation.js';
import { api, routes } from '../paths.js';
import {
	DaysLeft,
	ProductStatusBadge,
	creditDayBars,
	formatChartCredits,
	receiptColumns,
	productStatusLabel,
	productTone,
} from './billing.js';
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

/** How a website's worst product status reads in the list and the header. */
const SITE_PILLS = /** @type {const} */ ({
	success: { status: 'active', label: MERCHANT.websiteStatus.success },
	warning: { status: 'warning', label: MERCHANT.websiteStatus.warning },
	danger: { status: 'error', label: MERCHANT.websiteStatus.danger },
	neutral: { status: 'off', label: MERCHANT.websiteStatus.neutral },
});

/** The order of the status chips above the list. */
const DOT_ORDER = /** @type {const} */ (['success', 'warning', 'danger', 'neutral']);

/**
 * Whether the window is a phone (the kit's breakpoint); false until the page is in the browser. On a phone the list
 * stands alone until a website is picked.
 */
const usePhone = () => {
	const [phone, setPhone] = useState(false);
	useLayoutEffect(() => {
		if (!window.matchMedia) return undefined;
		const media = window.matchMedia('(max-width: 639px)');
		const read = () => setPhone(media.matches);
		read();
		media.addEventListener('change', read);
		return () => media.removeEventListener('change', read);
	}, []);
	return phone;
};

/**
 * The one thing a website still needs, for its row: a stopped or suspended product, one in grace, a product with no
 * feature on yet, or no product at all; null when nothing is left.
 * @param {ProductCard[]} cards
 * @returns {{ tone: 'warning' | 'danger', text: string } | null}
 */
const troubleOf = (cards) => {
	if (cards.length === 0) return { tone: 'warning', text: WEBSITE.noProductsYet };
	const stopped = cards.find((card) => productTone(card) === 'danger');
	if (stopped) return { tone: 'danger', text: WEBSITE.productTrouble(stopped.name, productStatusLabel(stopped)) };
	const grace = cards.find((card) => productTone(card) === 'warning');
	if (grace) return { tone: 'warning', text: WEBSITE.productTrouble(grace.name, productStatusLabel(grace)) };
	const idle = cards.find((card) => card.status === 'active' && card.featuresOn.length === 0);
	return idle ? { tone: 'warning', text: WEBSITE.setupLeft(idle.name) } : null;
};

/**
 * The merchant's Websites screen (flat layout 2026-10-21): a column of rich rows (domain, status dot, its products or
 * what is left to do, daily cost) beside the picked website's own page (`website-page.js`). A row is a link to the
 * website's address, so the pick can be linked to and the browser's Back button works; on the list's own address
 * (`fromList`) the first website is open straight away on wide screens, and a phone shows the list alone. A search and
 * status chips narrow the list.
 * @param {{ rows: Array<{ website: any, cards: ProductCard[] }>, websiteId: string, fromList?: boolean, part?: string,
 *   settings?: any, setup?: any, merchantId: string }} props
 */
function WebsitesScreen({ rows, websiteId, fromList = false, part = '', settings = null, setup = null, merchantId }) {
	const nav = useNavigation();
	const phone = usePhone();
	const [q, setQ] = useState('');
	const [status, setStatus] = useState('all');
	const crumbs = [{ label: MERCHANT.websitesTitle, href: routes.websites() }];
	const entries = rows.map(({ website, cards }) => ({
		id: String(website.websiteId),
		domain: String(website.domain),
		cards,
		dot: websiteDot(cards),
	}));
	const needle = q.trim().toLowerCase();
	const shown = entries.filter(
		(entry) => (!needle || entry.domain.toLowerCase().includes(needle)) && (status === 'all' || entry.dot === status),
	);
	const present = DOT_ORDER.filter((dot) => entries.some((entry) => entry.dot === dot));
	const selected = fromList ? (phone ? null : (entries[0]?.id ?? null)) : websiteId;
	const list = (
		<ListColumn
			label={MERCHANT.websitesTitle}
			items={shown}
			idOf={(entry) => entry.id}
			rowOf={(entry) => {
				const trouble = troubleOf(entry.cards);
				return {
					lead: <IconBadge icon="globe" kind="website" size="sm" />,
					title: entry.domain,
					status: { tone: entry.dot, label: SITE_PILLS[entry.dot].label },
					...(trouble ? { warning: trouble } : { meta: entry.cards.map((card) => card.name) }),
					value: WEBSITE.perDay(formatCredits(dailyCostOf(entry.cards))),
					href: routes.website(entry.id),
					linkAs: Link,
				};
			}}
			selected={selected}
			onBack={() => nav.go(routes.websites())}
			search={{ value: q, onChange: setQ, placeholder: WEBSITE.search }}
			{...(present.length > 1
				? {
						filters: {
							value: status,
							onChange: setStatus,
							options: [
								{ id: 'all', label: WEBSITE.filterAll, count: entries.length },
								...present.map((dot) => ({
									id: dot,
									label: MERCHANT.websiteStatus[dot],
									count: entries.filter((entry) => entry.dot === dot).length,
								})),
							],
						},
					}
				: {})}
			empty={{ icon: 'globe', kind: 'website', title: WEBSITE.none }}
		/>
	);
	const picked = rows.find((r) => String(r.website.websiteId) === (fromList ? (entries[0]?.id ?? '') : websiteId));
	if (!picked) return <Page linkAs={Link} list={list} crumbs={[...crumbs, { label: websiteId }]} error={WEBSITE.gone} />;
	const id = String(picked.website.websiteId);
	return (
		<WebsitePageView
			key={id}
			website={picked.website}
			cards={picked.cards}
			part={part}
			crumbs={crumbs}
			hrefOf={(next) => routes.websitePart(id, next)}
			can={{ manage: false, removeWebsite: false, tokens: true, open: true, settings: true }}
			pills={SITE_PILLS}
			launch={(productId) => ({ path: api.launch(merchantId, id, productId) })}
			afterRemoved={routes.websites()}
			settings={settings}
			setup={setup}
			list={list}
		/>
	);
}

/**
 * The merchant's Websites screen: the list with the first website open beside it (or the welcome with none yet).
 * @param {any} props loader result of `loadWebsites` plus `branding`
 */
export function WebsitesView(props) {
	if (!props.ok) return <PageProblem problem={props.problem} />;
	const rows = /** @type {Array<{ website: any, cards: ProductCard[] }>} */ (props.rows);
	return (
		<>
			<FrameBilling billing={props.billing} />
			{rows.length === 0 ? (
				<Page flush crumbs={[{ label: MERCHANT.websitesTitle }]} info={MERCHANT.websitesInfo} linkAs={Link}>
					<Welcome branding={props.branding} />
				</Page>
			) : (
				<WebsitesScreen
					rows={rows}
					websiteId={String(rows[0]?.website.websiteId)}
					fromList
					settings={props.settings}
					merchantId={props.merchantId}
				/>
			)}
		</>
	);
}

/**
 * One website's own page in the merchant console (`Websites › domain`, the list of websites beside it): the merchant
 * cannot add or remove products here, the admin does (PLAN 0.2).
 * @param {any} props loader result of `loadWebsitePage`
 */
export function WebsiteView(props) {
	if (!props.ok) return <PageProblem problem={props.problem} />;
	return (
		<>
			<FrameBilling billing={props.billing} />
			<WebsitesScreen
				rows={props.rows}
				websiteId={String(props.websiteId)}
				part={props.part}
				settings={props.settings}
				setup={props.setup}
				merchantId={props.merchantId}
			/>
		</>
	);
}
