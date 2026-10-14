'use client';
/**
 * Merchant Overview and Websites (PLAN 0.8.2 Merchant): the balance and days left at the current spend, the 30-day
 * spend chart and the websites with product chips and Open buttons; the Websites screen — the list of websites (per
 * row the domain, a status dot and the daily cost) beside the selected website's card (on wide screens the first one
 * until another is picked; its products with Open, and Install and tokens and Usage as dialogs; no admin actions).
 * With no websites yet, the welcome with the support contact (PLAN 0.8.2 Sign-in).
 * @module
 */
import { useEffect, useState } from 'react';
import {
	BarChart,
	Button,
	ButtonLink,
	Callout,
	Card,
	EmptyState,
	Icon,
	IconBadge,
	Masonry,
	PageHeader,
	Section,
	SoftBreaks,
	Stat,
	StatGrid,
	formatCredits,
	formatDate,
	describeProblem,
	isEmptySeries,
	useToast,
} from '@ss/ui';
import { AUTH, BILLING, MERCHANT, MORE, WEBSITE } from '../../texts/console.js';
import { apiFetch } from '../client.js';
import { Link } from '../link.js';
import { api, routes } from '../paths.js';
import { BalanceHero, LocalTime, ProductStatusBadge, ReceiptsTable, creditDayBars, formatChartCredits } from './billing.js';
import { FrameBilling } from './frame-billing.js';
import { ListDetail, ListPane, ListRow, ListSearch, PageProblem, openDashboard } from './common.js';
import { ActivityTable } from './login-settings.js';
import { contactLine } from './sign-in.js';
import { WebsiteCard, dailyCostOf, websiteDot } from './website.js';

/** @typedef {import('./website.js').ProductCard} ProductCard */
/** @typedef {{ support?: { email: string | null, phone: string | null, whatsapp: string | null } | null }} BrandingSupport */

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
 * The merchant's Overview.
 * @param {any} props loader result of `loadOverview` plus `branding`
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
		const result = await openDashboard(apiFetch, api.launch(props.merchantId, website.websiteId, card.productId));
		setOpening(null);
		if (!result.ok) toast.show({ tone: 'danger', title: describeProblem(result.problem) });
	};
	const billing = props.billing;
	const productCount = rows.reduce((n, r) => n + r.cards.length, 0);
	return (
		<div className="space-y-6">
			<FrameBilling billing={billing} />
			<PageHeader title={MERCHANT.overviewTitle} subtitle={MERCHANT.overviewIntro} />
			{billing ? (
				<BalanceHero
					summary={billing}
					days={props.usage?.days}
					label={MERCHANT.balanceLink}
					chartLabel={MERCHANT.spendChart}
				/>
			) : (
				<Card title={MERCHANT.spendChart} subtitle={props.usage ? formatCredits(props.usage.total ?? 0) : undefined}>
					<BarChart label={MERCHANT.spendChart} data={creditDayBars(props.usage?.days)} format={formatChartCredits} />
				</Card>
			)}
			<StatGrid>
				{billing ? (
					<>
						<Stat label={BILLING.dailySpend} value={formatCredits(billing.dailySpend)} icon="trendingUp" kind="credit" />
						<Stat
							label={BILLING.spentThisMonth}
							value={formatCredits(billing.spentThisMonth)}
							icon="calendar"
							kind="credit"
						/>
					</>
				) : null}
				<Stat label={MERCHANT.tiles.websites} value={rows.length} icon="globe" kind="website" />
				<Stat label={MERCHANT.tiles.products} value={productCount} icon="box" kind="product" />
			</StatGrid>
			<Section id="overview-websites" title={MERCHANT.websitesTitle} description={MERCHANT.websitesIntro}>
				{rows.length === 0 ? (
					<Welcome branding={props.branding} />
				) : (
					<Masonry as="ul" label={MERCHANT.websitesTitle}>
						{rows.map(({ website, cards }) => (
							<li key={website.websiteId}>
								<Card
									title={
										<span className="flex min-w-0 items-center gap-3">
											<IconBadge icon="globe" kind="website" size="sm" />
											<Link
												href={routes.website(website.websiteId)}
												title={website.domain}
												className="line-clamp-2 min-w-0 break-words text-fg hover:text-primary hover:underline">
												<SoftBreaks text={website.domain} />
											</Link>
										</span>
									}
									subtitle={WEBSITE.perDay(formatCredits(dailyCostOf(cards)))}>
									{cards.length === 0 ? (
										<p className="text-sm text-muted">{WEBSITE.noProductsMerchant}</p>
									) : (
										<ul className="divide-y divide-line-soft">
											{cards.map((card) => (
												<li key={card.productId} className="flex flex-wrap items-center justify-between gap-2 py-2">
													<span className="flex min-w-0 flex-wrap items-center gap-2">
														<span className="truncate text-sm font-semibold text-fg">{card.name}</span>
														<ProductStatusBadge status={card.status} featuresOn={card.featuresOn} />
													</span>
													<Button
														size="sm"
														variant="secondary"
														loading={opening === `${website.websiteId}:${card.productId}`}
														aria-label={`${WEBSITE.openLabel(card.name)} · ${website.domain}`}
														onClick={() => void open(website, card)}
														icon={<Icon name="external" size={14} />}>
														{WEBSITE.open}
													</Button>
												</li>
											))}
										</ul>
									)}
								</Card>
							</li>
						))}
					</Masonry>
				)}
			</Section>
			<div className="@container">
				<div className="grid items-start gap-5 @5xl:grid-cols-2">
					<Card
						title={MORE.recentActivity}
						subtitle={MORE.recentActivityIntro}
						actions={
							<ButtonLink as={Link} href={routes.account()} variant="secondary" size="sm">
								{MORE.viewAll}
							</ButtonLink>
						}>
						<ActivityTable items={props.activity ?? []} empty="No activity yet." />
					</Card>
					<Card
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
				</div>
			</div>
		</div>
	);
}

/**
 * The spend on one website over the last 30 UTC days (all its products), and when it was added.
 * @param {{ merchantId: string, website: any, cards: ProductCard[] }} props
 */
function WebsiteSpend({ merchantId, website, cards }) {
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
			<StatGrid>
				<Stat
					label={MORE.websiteSpend}
					value={usage ? formatCredits(usage.total ?? 0) : '—'}
					hint={MORE.websiteSpendIntro}
					icon="trendingUp"
					kind="credit"
				/>
				<Stat
					label={MORE.featuresOn}
					value={cards.reduce((n, c) => n + c.featuresOn.length, 0)}
					icon="sliders"
					kind="product"
				/>
				<Stat
					label={MORE.websiteAdded}
					value={formatDate(website.createdAt)}
					hint={<LocalTime value={website.createdAt} />}
					icon="calendar"
					kind="website"
				/>
			</StatGrid>
			{result && !result.ok ? <Callout tone="danger">{describeProblem(result.problem)}</Callout> : null}
			{usage && !isEmptySeries(bars) ? (
				<Card title={MORE.websiteSpend} subtitle={MORE.websiteSpendIntro}>
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
								fetcher={apiFetch}
								launch={(productId) => ({ path: api.launch(props.merchantId, shownId, productId) })}
							/>
							<WebsiteSpend
								key={`spend-${shownId}`}
								merchantId={props.merchantId}
								website={selected.website}
								cards={selected.cards}
							/>
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
