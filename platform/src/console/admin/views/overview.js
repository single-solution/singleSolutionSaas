'use client';
/**
 * Admin Overview (PLAN 0.8.2): a greeting with one sentence of what matters now;
 * "Needs you" — each item says what happens if it waits and carries its button (email sending not set up, no product
 * connected or active, merchants low on credits, in grace or stopped, with Add credits); the setup checklist while
 * the platform is new; the month's numbers; credits spent per UTC day; the first merchants with their balance; the
 * per-product numbers (websites using it, credits earned this month, 30-day chart, a More menu to view it or open it
 * as admin); and the latest activity as a timeline. Add merchant sits in the header.
 * Layout (owner 2026-10-16): an inner sidebar shows one view at a time — Needs you (with the setup checklist), Credits (the
 * month's numbers and the chart), Merchants, Products, Recent activity.
 * @module
 */
import { useState } from 'react';
import {
	ActionMenu,
	Badge,
	BarChart,
	Button,
	ButtonLink,
	Card,
	EmptyState,
	Icon,
	IconBadge,
	NeedsList,
	PageHeader,
	SectionLayout,
	SetupChecklist,
	Stat,
	StatGrid,
	describeProblem,
	formatCredits,
	useToast,
	TextLink,
	Avatar,
} from '@ss/ui';
import { ADMIN, BILLING, MORE, PRODUCTS } from '../../../texts/console.js';
import { Link } from '../../link.js';
import { useNavigation } from '../../navigation.js';
import { DaysLeft, MerchantStatusBadge, creditDayBars, formatChartCredits } from '../../views/billing.js';
import { openDashboard } from '../../views/common.js';
import { ActivityTimeline } from '../../views/login-settings.js';
import { adminApi, adminRoutes } from '../paths.js';
import { AdminProblem, adminCan } from './common.js';
import { AddCreditsDialog } from './finance.js';
import { AddMerchantDialog } from './merchants.js';

/** At most this many merchants are listed under "Needs you"; the rest are one link away. */
const NEEDS_MERCHANTS = 5;

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
	const merchants = /** @type {any[]} */ (props.merchants ?? []);
	const billing = /** @type {Record<string, any>} */ (props.billing ?? {});
	const linked = adminCan(props.admin, 'products.manage');
	const canAdd = adminCan(props.admin, 'credits.add');
	const canAddMerchant = adminCan(props.admin, 'merchants.write');
	const canSettings = adminCan(props.admin, 'portal_settings.write');
	const earned = products.reduce((n, p) => n + (p.earnedThisMonth ?? 0), 0);
	const inactive = products.filter((p) => p.status !== 'active').length;
	/** @param {any} p */
	const openAsAdmin = async (p) => {
		const result = await openDashboard(adminApi.launch(p.productId), { websiteId: null });
		if (!result.ok) toast.show({ tone: 'danger', title: describeProblem(result.problem) });
	};

	/** @type {import('@ss/ui').Need[]} */
	const needs = [];
	if (o.mailConfigured === false)
		needs.push({
			key: 'mail',
			tone: 'warning',
			title: ADMIN.needs.mail.title,
			effect: ADMIN.needs.mail.effect,
			action: canSettings ? (
				<ButtonLink as={Link} href={adminRoutes.settings()} variant="secondary" size="sm">
					{ADMIN.needs.mail.action}
				</ButtonLink>
			) : null,
		});
	if (products.length > 0 && inactive > 0)
		needs.push({
			key: 'inactive',
			tone: 'warning',
			title: ADMIN.needs.inactive.title(inactive),
			effect: ADMIN.needs.inactive.effect,
			action: linked ? (
				<ButtonLink as={Link} href={adminRoutes.products()} variant="secondary" size="sm">
					{ADMIN.needs.inactive.action}
				</ButtonLink>
			) : null,
		});
	for (const m of attention.slice(0, NEEDS_MERCHANTS))
		needs.push({
			key: `credits-${m.merchantId}`,
			tone: m.status === 'stopped' ? 'danger' : 'warning',
			title: (
				<>
					{m.merchantName ?? m.merchantId}
					<span className="font-normal text-muted">
						{' · '}
						<DaysLeft summary={m} />
					</span>
				</>
			),
			effect: ADMIN.needs.credits[/** @type {'low_balance'} */ (m.status)] ?? ADMIN.needs.credits.low_balance,
			action: canAdd ? (
				<Button size="sm" onClick={() => setCrediting(m)}>
					{ADMIN.needs.credits.action}
				</Button>
			) : null,
		});
	const needCount = needs.length + Math.max(0, attention.length - NEEDS_MERCHANTS);

	const steps = [
		{ key: 'product', done: products.length > 0, href: linked ? adminRoutes.products() : null },
		{ key: 'active', done: products.some((p) => p.status === 'active'), href: linked ? adminRoutes.products() : null },
		{ key: 'merchant', done: (o.merchants ?? 0) > 0, onClick: canAddMerchant ? () => setAdding(true) : null },
		{ key: 'website', done: (o.websites ?? 0) > 0, href: adminRoutes.merchants() },
	];
	const stepsDone = steps.filter((s) => s.done).length;
	const settingUp = stepsDone < steps.length;

	const sections = [
		{
			id: 'needs',
			label: ADMIN.needs.title,
			icon: /** @type {const} */ ('bell'),
			...(needCount > 0 ? { badge: <Badge tone="warning">{needCount}</Badge> } : {}),
			content: (
				<>
					<Card
						flow
						id="overview-needs"
						title={ADMIN.needs.title}
						subtitle={needs.length > 0 ? ADMIN.needs.intro : undefined}>
						<div className="space-y-3">
							<NeedsList items={needs} none={ADMIN.needs.none} />
							{attention.length > NEEDS_MERCHANTS ? (
								<ButtonLink as={Link} href={`${adminRoutes.finance()}#billing-attention`} variant="ghost" size="sm">
									{BILLING.billingTitle}
								</ButtonLink>
							) : null}
						</div>
					</Card>
					{settingUp ? (
						<div data-flow="card">
							<SetupChecklist
								id="overview-ready"
								title={ADMIN.ready.title}
								progress={ADMIN.ready.progress(stepsDone, steps.length)}
								labels={{ done: ADMIN.ready.done, todo: ADMIN.ready.todo }}
								linkAs={Link}
								steps={steps.map((step) => ({
									key: step.key,
									label: ADMIN.ready.steps[/** @type {'product'} */ (step.key)],
									done: step.done,
									...(step.href ? { href: step.href } : {}),
									...(step.onClick ? { onSelect: step.onClick } : {}),
								}))}
							/>
						</div>
					) : null}
				</>
			),
		},
		{
			id: 'credits',
			label: ADMIN.creditsSection,
			icon: /** @type {const} */ ('coins'),
			content: (
				<>
					<StatGrid>
						<Stat label={ADMIN.creditsThisMonth} value={formatCredits(earned)} icon="coins" kind="credit" />
						<Stat
							label={MORE.creditsAdded}
							value={typeof props.creditsAdded === 'number' ? formatCredits(props.creditsAdded) : '—'}
							icon="wallet"
							kind="credit"
						/>
					</StatGrid>
					<Card title={ADMIN.creditsChart}>
						<BarChart
							label={ADMIN.creditsChart}
							data={creditDayBars(totalDays(products))}
							format={formatChartCredits}
							height={132}
						/>
					</Card>
				</>
			),
		},
		{
			id: 'merchants',
			label: ADMIN.merchantsTitle,
			icon: /** @type {const} */ ('users'),
			content: (
				<Card
					title={ADMIN.merchantsTitle}
					subtitle={merchants.length > 0 ? ADMIN.merchantsIntro : undefined}
					actions={
						merchants.length > 0 ? (
							<ButtonLink as={Link} href={adminRoutes.merchants()} variant="secondary" size="sm">
								{ADMIN.viewMerchants}
							</ButtonLink>
						) : null
					}>
					{merchants.length === 0 ? (
						<EmptyState
							compact
							icon="users"
							kind="merchant"
							title={ADMIN.noMerchants}
							description={ADMIN.noMerchantsYetHelp}
							action={
								canAddMerchant ? (
									<Button size="sm" onClick={() => setAdding(true)} icon={<Icon name="plus" size={14} />}>
										{ADMIN.addMerchant}
									</Button>
								) : null
							}
						/>
					) : (
						<ul className="-my-2 divide-y divide-line-soft">
							{merchants.map((m) => {
								const b = billing[m.merchantId] ?? null;
								return (
									<li key={m.merchantId}>
										<Link
											href={adminRoutes.merchant(m.merchantId)}
											className="ss-motion -mx-2 flex items-center gap-3 rounded-lg px-2 py-2.5 hover:bg-surface-2">
											<Avatar name={m.name} />
											<span className="min-w-0 flex-1">
												<span className="block truncate text-sm font-semibold text-fg">{m.name}</span>
												<span className="block truncate text-xs text-muted">{m.email}</span>
											</span>
											<span className="shrink-0 text-right">
												<span className="block text-sm font-medium text-fg tabular-nums">
													{b ? formatCredits(b.balance) : '—'}
												</span>
												{b ? <MerchantStatusBadge status={b.status ?? m.status} /> : null}
											</span>
										</Link>
									</li>
								);
							})}
						</ul>
					)}
				</Card>
			),
		},
		{
			id: 'products',
			label: ADMIN.productsTitle,
			icon: /** @type {const} */ ('box'),
			content:
				products.length === 0 ? (
					<EmptyState
						compact
						icon="box"
						kind="product"
						title={ADMIN.noProducts}
						action={
							linked ? (
								<ButtonLink as={Link} href={adminRoutes.products()} variant="secondary" size="sm">
									{ADMIN.connectProduct}
								</ButtonLink>
							) : null
						}
					/>
				) : (
					products.map((p) => (
						<Card
							flow
							key={p.productId}
							title={
								<span className="flex items-center gap-3">
									<IconBadge icon="box" kind="product" size="sm" />
									{linked ? (
										<TextLink as={Link} tone="plain" href={adminRoutes.product(p.productId)}>
											{p.name}
										</TextLink>
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
							<BarChart
								label={PRODUCTS.earnedChart}
								data={creditDayBars(p.days)}
								format={formatChartCredits}
								height={96}
							/>
						</Card>
					))
				),
		},
		{
			id: 'activity',
			label: ADMIN.recentActivity,
			icon: /** @type {const} */ ('activity'),
			content: (
				<Card
					title={ADMIN.recentActivity}
					subtitle={ADMIN.recentActivityIntro}
					actions={
						<ButtonLink as={Link} href={adminRoutes.activity()} variant="secondary" size="sm">
							{MORE.viewAll}
						</ButtonLink>
					}>
					<ActivityTimeline items={o.recentActivity ?? []} empty={MORE.noActivity} />
				</Card>
			),
		},
	];

	return (
		<div className="space-y-6">
			<PageHeader
				title={ADMIN.welcome(props.admin?.name ?? '')}
				subtitle={ADMIN.summary({ merchants: o.merchants ?? 0, websites: o.websites ?? 0, needs: needCount })}
				actions={
					canAddMerchant ? (
						<Button onClick={() => setAdding(true)} icon={<Icon name="plus" size={14} />}>
							{ADMIN.addMerchant}
						</Button>
					) : null
				}
			/>
			<SectionLayout label={ADMIN.menu.overview} sections={sections} />
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
