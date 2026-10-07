'use client';
/**
 * Admin Overview (PLAN 0.8.2): totals, the warning while e-mail sending is not set up (e-mails are skipped then, PLAN
 * 0.5.10), the per-product numbers (for each connected product: the websites using it and the credits it earned this
 * month, with a 30-day chart, UTC) and recent activity.
 * @module
 */
import { Badge, BarChart, ButtonLink, Callout, Card, EmptyState, PageHeader, Stat, formatCredits } from '@ss/ui';
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
 * @param {any} props loader result of `loadOverview` plus `admin`
 */
export function OverviewView(props) {
	if (!props.ok) return <AdminProblem problem={props.problem} />;
	const o = props.overview ?? {};
	const products = /** @type {any[]} */ (o.products ?? []);
	const linked = adminCan(props.admin, 'products.manage');
	return (
		<div className="space-y-6">
			<PageHeader title={ADMIN.overviewTitle} />
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
			<div className="grid gap-4 sm:grid-cols-2">
				<Stat label={ADMIN.totals.merchants} value={o.merchants ?? 0} icon="users" />
				<Stat label={ADMIN.totals.websites} value={o.websites ?? 0} icon="globe" />
			</div>
			<section className="space-y-3" aria-labelledby="overview-products">
				<h2 id="overview-products" className="text-base font-bold text-fg">
					{ADMIN.productsTitle}
				</h2>
				{products.length === 0 ? (
					<EmptyState compact icon="box" title={ADMIN.noProducts} />
				) : (
					<ul className="grid gap-4 lg:grid-cols-2">
						{products.map((p) => (
							<li key={p.productId}>
								<Card
									title={
										linked ? (
											<Link href={adminRoutes.product(p.productId)} className="text-primary hover:underline">
												{p.name}
											</Link>
										) : (
											p.name
										)
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
				)}
			</section>
			<Card title={ADMIN.recentActivity}>
				<ActivityTable items={o.recentActivity ?? []} empty={ADMIN.noActivity} showMerchant />
			</Card>
		</div>
	);
}
