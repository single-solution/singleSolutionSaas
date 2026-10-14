'use client';
/**
 * Admin Overview (PLAN 0.8.2): a greeting with one sentence of what matters now;
 * "Needs you" — each item says what happens if it waits and carries its button (email sending not set up, no product
 * connected or active, merchants low on credits, in grace or stopped, with Add credits); the setup checklist while
 * the platform is new; the month's numbers; credits spent per UTC day; the first merchants with their balance; the
 * per-product numbers (websites using it, credits earned this month, 30-day chart, a More menu to view it or open it
 * as admin); and the latest activity as a timeline. Add merchant sits in the header.
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
	PageHeader,
	Section,
	Stat,
	StatGrid,
	cx,
	describeProblem,
	formatCredits,
	useToast,
} from '@ss/ui';
import { ADMIN, BILLING, MORE, PRODUCTS } from '../../../texts/console.js';
import { Link } from '../../link.js';
import { useNavigation } from '../../navigation.js';
import { DaysLeft, MerchantStatusBadge } from '../../views/billing.js';
import { NeedItem, NothingNeeded, openDashboard } from '../../views/common.js';
import { ActivityTimeline, initialsOf } from '../../views/login-settings.js';
import { adminFetch } from '../client.js';
import { adminApi, adminRoutes } from '../paths.js';
import { AdminProblem, adminCan } from './common.js';
import { AddCreditsDialog } from './finance.js';
import { AddMerchantDialog } from './merchants.js';

/**
 * Credits per UTC day as chart bars.
 * @param {ReadonlyArray<{ day: string, amount: number }> | undefined} days
 */
export const dayBars = (days) => (days ?? []).map((d) => ({ label: d.day.slice(5), value: d.amount / 1000, hint: d.day }));

/** @param {number} v credits */
const creditsOf = (v) => formatCredits(Math.round(v * 1000));

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
 * One step of the setup checklist: a check mark when done, a dashed ring while to do (with its link).
 * @param {{ done: boolean, label: string, href?: string | null, onClick?: (() => void) | null }} props
 */
function ReadyStep({ done, label, href, onClick }) {
	const text = done ? (
		<span className="text-muted line-through decoration-line-strong">{label}</span>
	) : href ? (
		<Link href={href} className="font-medium text-fg hover:text-primary hover:underline">
			{label}
		</Link>
	) : onClick ? (
		<button type="button" onClick={onClick} className="font-medium text-fg hover:text-primary hover:underline">
			{label}
		</button>
	) : (
		<span className="font-medium text-fg">{label}</span>
	);
	return (
		<li className="flex items-center gap-3 text-sm">
			<span
				className={cx(
					'flex size-5 shrink-0 items-center justify-center rounded-full',
					done ? 'bg-success-soft text-on-success-soft' : 'border-[1.5px] border-dashed border-line-strong',
				)}>
				{done ? <Icon name="check" size={12} /> : null}
				<span className="sr-only">{done ? ADMIN.ready.done : ADMIN.ready.todo}</span>
			</span>
			{text}
		</li>
	);
}

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
		const result = await openDashboard(adminFetch, adminApi.launch(p.productId), { websiteId: null });
		if (!result.ok) toast.show({ tone: 'danger', title: describeProblem(result.problem) });
	};

	/** @type {Array<{ key: string, tone: 'warning' | 'danger', title: import('react').ReactNode, effect: string, action?: import('react').ReactNode }>} */
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
	if (products.length === 0)
		needs.push({
			key: 'no-product',
			tone: 'warning',
			title: ADMIN.needs.noProduct.title,
			effect: ADMIN.needs.noProduct.effect,
			action: linked ? (
				<ButtonLink as={Link} href={adminRoutes.products()} variant="secondary" size="sm">
					{ADMIN.needs.noProduct.action}
				</ButtonLink>
			) : null,
		});
	else if (inactive > 0)
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
		{ key: 'mail', done: o.mailConfigured !== false, href: canSettings ? adminRoutes.settings() : null },
	];
	const stepsDone = steps.filter((s) => s.done).length;
	const settingUp = stepsDone < steps.length;

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
			<div className="@container">
				<div className={cx('grid gap-6', settingUp && '@4xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]')}>
					<Card id="overview-needs" title={ADMIN.needs.title} subtitle={needs.length > 0 ? ADMIN.needs.intro : undefined}>
						{needs.length === 0 ? (
							<NothingNeeded>{ADMIN.needs.none}</NothingNeeded>
						) : (
							<div className="@container space-y-3">
								<ul className="space-y-2.5">
									{needs.map(({ key, ...need }) => (
										<NeedItem key={key} {...need} />
									))}
								</ul>
								{attention.length > NEEDS_MERCHANTS ? (
									<ButtonLink as={Link} href={`${adminRoutes.finance()}#billing-attention`} variant="ghost" size="sm">
										{BILLING.billingTitle}
									</ButtonLink>
								) : null}
							</div>
						)}
					</Card>
					{settingUp ? (
						<Card id="overview-ready" title={ADMIN.ready.title} subtitle={ADMIN.ready.progress(stepsDone, steps.length)}>
							<div
								className="mb-4 h-2 overflow-hidden rounded-full bg-surface-3"
								role="progressbar"
								aria-label={ADMIN.ready.title}
								aria-valuemin={0}
								aria-valuemax={steps.length}
								aria-valuenow={stepsDone}>
								<div
									className="h-full rounded-full bg-primary transition-[width] duration-(--ss-motion-slow) ease-ss"
									style={{ width: `${Math.round((stepsDone / steps.length) * 100)}%` }}
								/>
							</div>
							<ul className="space-y-2.5">
								{steps.map((s) => (
									<ReadyStep
										key={s.key}
										done={s.done}
										label={ADMIN.ready.steps[/** @type {'product'} */ (s.key)]}
										href={s.href ?? null}
										onClick={s.onClick ?? null}
									/>
								))}
							</ul>
						</Card>
					) : null}
				</div>
			</div>
			<StatGrid>
				<Stat label={ADMIN.creditsThisMonth} value={formatCredits(earned)} icon="coins" kind="credit" />
				<Stat
					label={MORE.creditsAdded}
					value={typeof props.creditsAdded === 'number' ? formatCredits(props.creditsAdded) : '—'}
					icon="wallet"
					kind="credit"
				/>
				<Stat label={ADMIN.totals.merchants} value={o.merchants ?? 0} icon="users" kind="merchant" />
				<Stat label={ADMIN.totals.websites} value={o.websites ?? 0} icon="globe" kind="website" />
			</StatGrid>
			<div className="@container">
				<div className="grid gap-6 @4xl:grid-cols-2">
					<Card title={ADMIN.creditsChart}>
						<BarChart label={ADMIN.creditsChart} data={dayBars(totalDays(products))} format={creditsOf} height={132} />
					</Card>
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
												<span
													aria-hidden="true"
													className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-primary-soft text-xs font-bold text-on-primary-soft">
													{initialsOf(m.name)}
												</span>
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
				</div>
			</div>
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
				<ActivityTimeline items={o.recentActivity ?? []} empty={MORE.noActivity} />
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
