'use client';
/**
 * Admin Overview (PLAN 0.8.2): totals, the warning while e-mail sending is not set up (e-mails are skipped then, PLAN
 * 0.5.10), the per-product numbers (for each connected product: the websites using it and the credits it earned this
 * month, with a 30-day chart, UTC) and recent activity.
 * @module
 */
import {
	Badge,
	BarChart,
	ButtonLink,
	Callout,
	Card,
	EmptyState,
	HeroCard,
	IconBadge,
	PageHeader,
	Section,
	Stat,
	StatGrid,
	formatCredits,
} from '@ss/ui';
import { ADMIN, PRODUCTS } from '../../../texts/console.js';
import { Link } from '../../link.js';
import { ActivityTable } from '../../views/login-settings.js';
import { adminRoutes } from '../paths.js';
import { AdminProblem, adminCan } from './common.js';

/**
 * Credits per UTC day as chart bars.
 * @param {ReadonlyArray<{ day: string, amount: number }> | undefined} days
 */
export const dayBars = (days) => (days ?? []).map((d) => ({ label: d.day.slice(5), value: d.amount / 1000, hint: d.day }));

/** @param {number} v credits */
const creditsOf = (v) => formatCredits(Math.round(v * 1000));

/**
 * Credits of all products per UTC day (the sum of each product's 30 days).
 * @param {ReadonlyArray<{ days?: ReadonlyArray<{ day: string, amount: number }> }>} products
 */
const totalDays = (products) => {
	/** @type {Map<string, number>} */
	const sums = new Map();
	for (const p of products) for (const d of p.days ?? []) sums.set(d.day, (sums.get(d.day) ?? 0) + d.amount);
	return [...sums.keys()].sort().map((day) => ({ day, amount: sums.get(day) ?? 0 }));
};

/**
 * @param {any} props loader result of `loadOverview` plus `admin`
 */
export function OverviewView(props) {
	if (!props.ok) return <AdminProblem problem={props.problem} />;
	const o = props.overview ?? {};
	const products = /** @type {any[]} */ (o.products ?? []);
	const linked = adminCan(props.admin, 'products.manage');
	const earned = products.reduce((n, p) => n + (p.earnedThisMonth ?? 0), 0);
	return (
		<div className="space-y-8">
			<PageHeader title={ADMIN.overviewTitle} subtitle={ADMIN.overviewIntro} />
			{o.mailConfigured === false ? (
				<Callout
					tone="warning"
					actions={
						adminCan(props.admin, 'portal_settings.write') ? (
							<ButtonLink as={Link} href={adminRoutes.settings()} variant="secondary" size="sm">
								{ADMIN.smtpFix}
							</ButtonLink>
						) : null
					}>
					{ADMIN.smtpWarning}
				</Callout>
			) : null}
			<HeroCard
				label={ADMIN.creditsThisMonth}
				value={formatCredits(earned)}
				icon="coins"
				chart={{ label: ADMIN.creditsChart, data: dayBars(totalDays(products)), format: creditsOf }}
			/>
			<StatGrid>
				<Stat label={ADMIN.totals.merchants} value={o.merchants ?? 0} icon="users" kind="merchant" />
				<Stat label={ADMIN.totals.websites} value={o.websites ?? 0} icon="globe" kind="website" />
				<Stat label={ADMIN.totalProducts} value={products.length} icon="box" kind="product" />
			</StatGrid>
			<Section id="overview-products" title={ADMIN.productsTitle} description={ADMIN.productsIntro}>
				{products.length === 0 ? (
					<EmptyState compact icon="box" kind="product" title={ADMIN.noProducts} />
				) : (
					<div className="@container">
						<ul className="grid gap-5 @2xl:grid-cols-2 @6xl:grid-cols-3">
							{products.map((p) => (
								<li key={p.productId}>
									<Card
										className="h-full"
										title={
											<span className="flex items-center gap-3">
												<IconBadge icon="box" kind="product" size="sm" />
												{linked ? (
													<Link
														href={adminRoutes.product(p.productId)}
														className="text-fg hover:text-primary hover:underline">
														{p.name}
													</Link>
												) : (
													p.name
												)}
											</span>
										}
										subtitle={`${ADMIN.productWebsites(p.websites ?? 0)} · ${ADMIN.productEarned(formatCredits(p.earnedThisMonth ?? 0))}`}
										actions={
											<Badge tone={p.status === 'active' ? 'success' : 'neutral'} dot>
												{PRODUCTS.status[/** @type {'active'} */ (p.status)] ?? p.status}
											</Badge>
										}>
										<BarChart label={PRODUCTS.earnedChart} data={dayBars(p.days)} format={creditsOf} height={96} />
									</Card>
								</li>
							))}
						</ul>
					</div>
				)}
			</Section>
			<Card title={ADMIN.recentActivity} subtitle={ADMIN.recentActivityIntro}>
				<ActivityTable items={o.recentActivity ?? []} empty={ADMIN.noActivity} showMerchant />
			</Card>
		</div>
	);
}
