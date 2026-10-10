'use client';
/**
 * Admin Overview (PLAN 0.8.2): totals (merchants, websites, products on websites, credits added this month), the
 * warning while e-mail sending is not set up (e-mails are skipped then, PLAN 0.5.10), the merchants that need attention
 * (with Add credits), the per-product numbers (for each connected product: the websites using it and the credits it
 * earned this month, with a 30-day chart, UTC; a More menu to view it or open it as admin) and recent activity. Add
 * merchant sits in the header.
 * @module
 */
import { useState } from 'react';
import {
	ActionMenu,
	Badge,
	BarChart,
	Button,
	ButtonLink,
	Callout,
	Card,
	EmptyState,
	HeroCard,
	Icon,
	IconBadge,
	PageHeader,
	Section,
	Stat,
	StatGrid,
	describeProblem,
	formatCredits,
	useToast,
} from '@ss/ui';
import { ADMIN, BILLING, MORE, PRODUCTS } from '../../../texts/console.js';
import { Link } from '../../link.js';
import { useNavigation } from '../../navigation.js';
import { openDashboard } from '../../views/common.js';
import { ActivityTable } from '../../views/login-settings.js';
import { adminFetch } from '../client.js';
import { adminApi, adminRoutes } from '../paths.js';
import { AdminProblem, adminCan } from './common.js';
import { AddCreditsDialog, AttentionTable } from './finance.js';
import { AddMerchantDialog } from './merchants.js';

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
	const toast = useToast();
	const nav = useNavigation();
	const [adding, setAdding] = useState(false);
	const [crediting, setCrediting] = useState(/** @type {any} */ (null));
	if (!props.ok) return <AdminProblem problem={props.problem} />;
	const o = props.overview ?? {};
	const products = /** @type {any[]} */ (o.products ?? []);
	const attention = /** @type {any[]} */ (props.attention ?? []);
	const linked = adminCan(props.admin, 'products.manage');
	const canAdd = adminCan(props.admin, 'credits.add');
	const earned = products.reduce((n, p) => n + (p.earnedThisMonth ?? 0), 0);
	const onWebsites = products.reduce((n, p) => n + (p.websites ?? 0), 0);
	/** @param {any} p */
	const openAsAdmin = async (p) => {
		const result = await openDashboard(adminFetch, adminApi.launch(p.productId), { websiteId: null });
		if (!result.ok) toast.show({ tone: 'danger', title: describeProblem(result.problem) });
	};
	return (
		<div className="space-y-8">
			<PageHeader
				title={ADMIN.overviewTitle}
				subtitle={ADMIN.overviewIntro}
				actions={
					adminCan(props.admin, 'merchants.write') ? (
						<Button onClick={() => setAdding(true)} icon={<Icon name="plus" size={14} />}>
							{ADMIN.addMerchant}
						</Button>
					) : null
				}
			/>
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
				details={[
					...(typeof props.creditsAdded === 'number'
						? [{ label: MORE.creditsAdded, value: formatCredits(props.creditsAdded) }]
						: []),
					{ label: MORE.attentionCount, value: attention.length },
				]}
				chart={{ label: ADMIN.creditsChart, data: dayBars(totalDays(products)), format: creditsOf }}
			/>
			<StatGrid>
				<Stat label={ADMIN.totals.merchants} value={o.merchants ?? 0} icon="users" kind="merchant" />
				<Stat label={ADMIN.totals.websites} value={o.websites ?? 0} icon="globe" kind="website" />
				<Stat label={MORE.productsOnWebsites} value={onWebsites} icon="box" kind="product" />
				<Stat
					label={ADMIN.totalProducts}
					value={products.length}
					hint={`${PRODUCTS.status.active}: ${products.filter((p) => p.status === 'active').length}`}
					icon="box"
					kind="product"
				/>
			</StatGrid>
			{attention.length > 0 ? (
				<Section
					id="overview-attention"
					title={BILLING.billingSections.attention.title}
					description={BILLING.billingSections.attention.help}
					actions={
						<ButtonLink as={Link} href={`${adminRoutes.finance()}#billing-attention`} variant="secondary" size="sm">
							{BILLING.billingTitle}
						</ButtonLink>
					}>
					<AttentionTable rows={attention} onAdd={canAdd ? setCrediting : null} />
				</Section>
			) : null}
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
											<span className="flex items-center gap-1">
												<Badge tone={p.status === 'active' ? 'success' : 'neutral'} dot>
													{PRODUCTS.status[/** @type {'active'} */ (p.status)] ?? p.status}
												</Badge>
												{linked ? (
													<ActionMenu
														label={MORE.productMenu(p.name)}
														items={[
															{
																label: MORE.viewProduct,
																onSelect: () => nav.go(adminRoutes.product(p.productId)),
															},
															{ label: PRODUCTS.openAsAdmin, onSelect: () => void openAsAdmin(p) },
														]}
													/>
												) : null}
											</span>
										}>
										<BarChart label={PRODUCTS.earnedChart} data={dayBars(p.days)} format={creditsOf} height={96} />
									</Card>
								</li>
							))}
						</ul>
					</div>
				)}
			</Section>
			<Card
				title={ADMIN.recentActivity}
				subtitle={ADMIN.recentActivityIntro}
				actions={
					<ButtonLink as={Link} href={adminRoutes.activity()} variant="secondary" size="sm">
						{MORE.viewAll}
					</ButtonLink>
				}>
				<ActivityTable
					items={o.recentActivity ?? []}
					empty={ADMIN.noActivity}
					showMerchant
					filterHref={(q) => adminRoutes.activity(q)}
				/>
			</Card>
			<AddMerchantDialog
				open={adding}
				onClose={() => setAdding(false)}
				onCreated={(merchant) => {
					setAdding(false);
					if (merchant?.merchantId) nav.go(adminRoutes.merchant(merchant.merchantId));
				}}
			/>
			{crediting ? (
				<AddCreditsDialog
					merchant={{ merchantId: crediting.merchantId, name: crediting.merchantName ?? crediting.merchantId }}
					balance={crediting.balance}
					onClose={() => setCrediting(null)}
					onAdded={() => window.location.reload()}
				/>
			) : null}
		</div>
	);
}
