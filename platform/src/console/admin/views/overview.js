'use client';
/**
 * Admin Overview (PLAN 0.8.2; layout contract 2026-10-17): one Page. The header carries the title with the greeting and
 * the one sentence of what matters now behind its (i), the numbers (merchants, websites, what needs you) and Add
 * merchant. The body: "Needs you" — each item says what happens if it waits and carries its button (email sending not
 * set up, no product connected or active, merchants low on credits, in grace or stopped, with Add credits); the setup
 * checklist while the platform is new; the month's numbers and credits spent per UTC day; the first merchants and the
 * connected products as tables; and the latest activity as a timeline.
 * @module
 */
import { useState } from 'react';
import {
	ActionMenu,
	BarChart,
	Button,
	ButtonLink,
	Card,
	EmptyState,
	Icon,
	IconBadge,
	NeedsList,
	Page,
	Row,
	SetupChecklist,
	Stat,
	StatGrid,
	describeProblem,
	formatCredits,
	useToast,
	TextLink,
} from '@ss/ui';
import { ADMIN, BILLING, MORE, PRODUCTS } from '../../../texts/console.js';
import { Link } from '../../link.js';
import { useNavigation } from '../../navigation.js';
import { DaysLeft, creditDayBars, formatChartCredits, merchantPill } from '../../views/billing.js';
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

	const needsMore = attention.length > NEEDS_MERCHANTS;
	const website = o.websites ?? 0;

	return (
		<>
			<Page
				linkAs={Link}
				crumbs={[{ label: ADMIN.menu.overview }]}
				info={
					<>
						<span className="block font-medium text-fg">{ADMIN.welcome(props.admin?.name ?? '')}</span>
						{ADMIN.summary({ merchants: o.merchants ?? 0, websites: website, needs: needCount })}
					</>
				}
				facts={[
					...(needCount > 0 ? [{ label: ADMIN.needs.title, value: needCount, tone: /** @type {const} */ ('warning') }] : []),
					{ label: ADMIN.merchantsTitle, value: o.merchants ?? 0, href: adminRoutes.merchants() },
					{ label: ADMIN.websitesLabel, value: website },
				]}
				{...(canAddMerchant
					? {
							actions: {
								primary: {
									label: ADMIN.addMerchant,
									icon: /** @type {const} */ ('plus'),
									onClick: () => setAdding(true),
								},
							},
						}
					: {})}>
				<div className="space-y-4">
					<Card title={ADMIN.needs.title} subtitle={needs.length > 0 ? ADMIN.needs.intro : undefined}>
						<div className="space-y-3">
							<NeedsList items={needs} none={ADMIN.needs.none} />
							{needsMore ? (
								<ButtonLink as={Link} href={adminRoutes.financePart('attention')} variant="ghost" size="sm">
									{BILLING.billingTitle}
								</ButtonLink>
							) : null}
						</div>
					</Card>
					{settingUp ? (
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
					) : null}
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
					<Card
						padded={false}
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
							<div className="divide-y divide-line-soft">
								{merchants.map((m) => {
									const b = billing[m.merchantId] ?? null;
									const pill = merchantPill(b?.status ?? m.status);
									return (
										<Row
											key={m.merchantId}
											linkAs={Link}
											href={adminRoutes.merchant(m.merchantId)}
											lead={{ avatar: m.name }}
											title={m.name}
											meta={m.email}
											status={{
												tone: pill.status === 'active' ? 'success' : pill.status === 'error' ? 'danger' : 'warning',
												label: pill.label,
											}}
											value={b ? formatCredits(b.balance) : '—'}
										/>
									);
								})}
							</div>
						)}
					</Card>
					<Card
						padded={false}
						title={ADMIN.productsTitle}
						subtitle={products.length > 0 ? ADMIN.productColumns.earned : undefined}
						actions={
							linked && products.length > 0 ? (
								<ButtonLink as={Link} href={adminRoutes.products()} variant="secondary" size="sm">
									{ADMIN.viewMerchants}
								</ButtonLink>
							) : null
						}>
						{products.length === 0 ? (
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
							<div className="divide-y divide-line-soft">
								{products.map((p) => (
									<Row
										key={p.productId}
										linkAs={Link}
										href={linked ? adminRoutes.product(p.productId) : undefined}
										lead={<IconBadge product={p.productId} size="sm" />}
										title={p.name}
										meta={p.websites ? `${p.websites} ${ADMIN.productColumns.websites.toLowerCase()}` : undefined}
										status={{
											tone: p.status === 'active' ? 'success' : 'neutral',
											label: PRODUCTS.status[/** @type {'active'} */ (p.status)] ?? p.status,
										}}
										value={formatCredits(p.earnedThisMonth ?? 0)}
										trailing={
											linked ? (
												<ActionMenu
													floating
													label={`Actions for ${p.name}`}
													items={[
														{ label: MORE.viewProduct, onSelect: () => nav.go(adminRoutes.product(p.productId)) },
														{ label: PRODUCTS.openAsAdmin, onSelect: () => void openAsAdmin(p) },
													]}
												/>
											) : null
										}
									/>
								))}
							</div>
						)}
					</Card>
					<Card
						flow
						title={ADMIN.recentActivity}
						subtitle={ADMIN.recentActivityIntro}
						actions={
							<ButtonLink as={Link} href={adminRoutes.activity()} variant="secondary" size="sm">
								{MORE.viewAll}
							</ButtonLink>
						}>
						<ActivityTimeline items={o.recentActivity ?? []} empty={MORE.noActivity} />
					</Card>
				</div>
			</Page>
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
		</>
	);
}
