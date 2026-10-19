'use client';
/**
 * Credits and billing (PLAN 0.5.8, 0.8.2): the receipt form with its confirm step (Owner and Finance), all receipts,
 * charges by day, merchant or product, the merchants that need attention, and a merchant's Credits section. Credits are
 * whole numbers on screen and integer millicredits on the wire; receipts are never edited or reversed.
 * Layout: an inner sidebar shows one view at a time — Needs attention, Receipts, Charges.
 * @module
 */
import { useMemo, useState } from 'react';
import {
	Badge,
	BarChart,
	Button,
	ButtonLink,
	Card,
	Dialog,
	EmptyState,
	Form,
	FormError,
	Icon,
	Input,
	LinkTabs,
	PageHeader,
	SectionLayout,
	Select,
	Stat,
	StatGrid,
	Table,
	Toolbar,
	describeProblem,
	fieldErrors,
	formatCredits,
	isEmptySeries,
	useToast,
	TextLink,
} from '@ss/ui';
import { BILLING, MORE } from '../../../texts/console.js';
import { FilterForm } from '../../navigation.js';
import { Link } from '../../link.js';
import { BillingStats, DaysLeft, MerchantStatusBadge, ReceiptsTable, formatChartCredits } from '../../views/billing.js';
import { RangeSelect } from '../../views/range.js';
import { apiFetch } from '../../client.js';
import { adminApi, adminRoutes } from '../paths.js';
import { AdminProblem, adminCan } from './common.js';

/** @typedef {import('@ss/ui').Problem} Problem */

const F = BILLING.receiptForm;

/** @returns {string} */
const oneTimeKey = () =>
	typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
		? crypto.randomUUID()
		: `rct-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/**
 * Add credits (PLAN 0.5.8): credits, amount paid, payment method and reference, then a confirm step that repeats the
 * merchant, the credits, the amount paid and the new balance. The form carries a one-time key, so a double submit
 * saves once.
 * @param {{ merchant: { merchantId: string, name: string }, balance: number | null | undefined, onClose: () => void,
 *   onAdded: () => void | Promise<void> }} props
 */
export function AddCreditsDialog({ merchant, balance, onClose, onAdded }) {
	const toast = useToast();
	const key = useMemo(oneTimeKey, []);
	const [form, setForm] = useState({ credits: '', amountPaid: '', method: '', reference: '' });
	const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
	const [reviewing, setReviewing] = useState(false);
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const credits = /^\d{1,10}$/.test(form.credits.trim()) ? Number(form.credits.trim()) : 0;
	/** @param {'credits' | 'amountPaid' | 'method' | 'reference'} name */
	const field = (name) => ({
		value: form[name],
		onChange: (/** @type {import('react').ChangeEvent<HTMLInputElement>} */ e) =>
			setForm({ ...form, [name]: e.currentTarget.value }),
		error: errors[`/${name}`] ?? errors[name],
	});
	const review = () => {
		/** @type {Record<string, string>} */
		const local = {};
		if (credits < 1) local.credits = F.creditsHelp;
		if (!form.amountPaid.trim()) local.amountPaid = F.amountPaidHelp;
		if (!form.method.trim()) local.method = F.method;
		setErrors(local);
		if (Object.keys(local).length === 0) setReviewing(true);
	};
	const save = async () => {
		setBusy(true);
		setProblem(null);
		const result = await apiFetch(adminApi.addReceipt(merchant.merchantId), {
			method: 'POST',
			idempotencyKey: key,
			body: {
				credits,
				amountPaid: form.amountPaid.trim(),
				method: form.method.trim(),
				...(form.reference.trim() ? { reference: form.reference.trim() } : {}),
			},
		});
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			setErrors(fieldErrors(result.problem));
			setReviewing(false);
			return;
		}
		toast.show({ title: F.added, description: `${BILLING.balance}: ${formatCredits(result.data?.summary?.balance)}` });
		await onAdded();
		onClose();
	};
	return (
		<Dialog
			open
			onClose={onClose}
			title={reviewing ? F.confirmTitle : `${BILLING.addCredits} · ${merchant.name}`}
			footer={
				reviewing ? (
					<>
						<Button variant="secondary" onClick={() => setReviewing(false)} disabled={busy}>
							{F.back}
						</Button>
						<Button onClick={() => void save()} loading={busy}>
							{F.confirm}
						</Button>
					</>
				) : (
					<Button onClick={review}>{F.review}</Button>
				)
			}>
			{reviewing ? (
				<dl className="space-y-2 text-sm">
					{[
						[BILLING.receiptColumns.merchant, merchant.name],
						[F.credits, formatCredits(credits * 1000)],
						[F.amountPaid, form.amountPaid.trim()],
						[F.method, form.method.trim()],
						...(form.reference.trim() ? [[F.reference, form.reference.trim()]] : []),
						[F.newBalance, typeof balance === 'number' ? formatCredits(balance + credits * 1000) : '—'],
					].map(([label, value]) => (
						<div key={label} className="flex justify-between gap-4">
							<dt className="text-muted">{label}</dt>
							<dd className="font-semibold text-fg">{value}</dd>
						</div>
					))}
					<p className="pt-2 text-xs text-muted">{F.permanent}</p>
				</dl>
			) : (
				<Form onSubmit={review} aria-label={BILLING.addCredits}>
					<Input label={F.credits} inputMode="numeric" help={F.creditsHelp} required {...field('credits')} />
					<Input label={F.amountPaid} help={F.amountPaidHelp} maxLength={60} required {...field('amountPaid')} />
					<Input label={F.method} maxLength={60} required {...field('method')} />
					<Input label={F.reference} maxLength={120} {...field('reference')} />
				</Form>
			)}
			<FormError problem={problem} />
		</Dialog>
	);
}

/**
 * A merchant's Credits section: the money numbers, receipts and day charges.
 * @param {{ billing: any, receipts: any[], dayCharges: any[] }} props
 */
export function MerchantCredits({ billing, receipts, dayCharges }) {
	return (
		<div className="space-y-6">
			{billing ? <BillingStats summary={billing} /> : null}
			<Card title={BILLING.receiptsTitle} subtitle={BILLING.receiptsIntro} padded={false}>
				<ReceiptsTable receipts={receipts} />
			</Card>
			<Card title={BILLING.dayChargesTitle} subtitle={BILLING.chargesNote} padded={false}>
				<Table
					caption={BILLING.dayChargesTitle}
					rows={dayCharges}
					rowKey={(d) => `${d.day}:${d.websiteId}:${d.productId}`}
					empty={<EmptyState compact icon="coins" kind="credit" title={BILLING.noUsage} />}
					columns={[
						{ key: 'day', header: BILLING.usageColumns.day, rowHeader: true, sortable: true },
						{ key: 'domain', header: BILLING.usageColumns.website, sortable: true },
						{ key: 'product', header: BILLING.usageColumns.product, sortable: true },
						{
							key: 'lines',
							header: BILLING.usageColumns.feature,
							render: (d) => d.lines.map((/** @type {any} */ l) => `${l.feature} ${l.hours} h`).join(', '),
						},
						{
							key: 'credits',
							header: BILLING.usageColumns.credits,
							align: 'right',
							sortable: true,
							render: (d) => formatCredits(d.credits),
						},
					]}
				/>
			</Card>
		</div>
	);
}

/**
 * The merchants that need attention (low, in grace or stopped; checked now), each linked to its Credits section, with
 * Add credits for those who may add them.
 * @param {{ rows: any[], onAdd?: ((merchant: any) => void) | null }} props
 */
function AttentionTable({ rows, onAdd = null }) {
	return (
		<Table
			caption={BILLING.billingSections.attention.title}
			rows={rows}
			rowKey={(m) => m.merchantId}
			empty={<EmptyState compact icon="check" kind="merchant" title={BILLING.noAttention} />}
			columns={[
				{
					key: 'merchantName',
					header: BILLING.receiptColumns.merchant,
					rowHeader: true,
					render: (m) => (
						<TextLink as={Link} href={`${adminRoutes.merchant(m.merchantId)}#merchant-credits`}>
							{m.merchantName ?? m.merchantId}
						</TextLink>
					),
				},
				{ key: 'status', header: 'Status', render: (m) => <MerchantStatusBadge status={m.status} /> },
				{ key: 'balance', header: BILLING.balance, align: 'right', render: (m) => formatCredits(m.balance) },
				{ key: 'daysLeft', header: BILLING.daysLeft, render: (m) => <DaysLeft summary={m} /> },
				...(onAdd
					? [
							{
								key: 'add',
								header: '',
								align: /** @type {const} */ ('right'),
								render: (/** @type {any} */ m) => (
									<Button size="sm" variant="secondary" onClick={() => onAdd(m)}>
										{BILLING.addCredits}
									</Button>
								),
							},
						]
					: []),
			]}
		/>
	);
}

/**
 * Add credits from Credits and billing: pick the merchant, then the receipt form opens with its balance.
 * @param {{ merchants: Array<{ value: string, label: string }>, initial?: string | null, onClose: () => void,
 *   onPicked: (merchant: { merchantId: string, merchantName: string, balance: number | null }) => void }} props
 */
function PickMerchantDialog({ merchants, initial = null, onClose, onPicked }) {
	const [merchantId, setMerchantId] = useState(initial ?? merchants[0]?.value ?? '');
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const next = async () => {
		if (!merchantId) return;
		setBusy(true);
		setProblem(null);
		const result = await apiFetch(adminApi.billing(merchantId));
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		const name = merchants.find((m) => m.value === merchantId)?.label ?? merchantId;
		onPicked({ merchantId, merchantName: name, balance: result.data?.balance ?? null });
	};
	return (
		<Dialog
			open
			onClose={onClose}
			title={BILLING.addCredits}
			description={MORE.pickMerchantHelp}
			footer={
				<Button onClick={() => void next()} loading={busy} disabled={!merchantId}>
					{MORE.next}
				</Button>
			}>
			<Select
				label={MORE.pickMerchant}
				value={merchantId}
				onChange={(e) => setMerchantId(e.currentTarget.value)}
				options={merchants}
			/>
			{problem ? <p className="mt-3 text-sm text-danger">{describeProblem(problem)}</p> : null}
		</Dialog>
	);
}

/** @param {readonly any[]} rows @param {(row: any) => number} amount */
const sumOf = (rows, amount) => rows.reduce((n, r) => n + (Number(amount(r)) || 0), 0);

/**
 * Credits and billing page (Owner and Finance; Support read-only): one page, no tabs — the merchants that need
 * attention, the receipts with their filter, and the charges by day, merchant or product.
 * @param {any} props loader result of `loadBilling` plus `admin`
 */
export function FinanceView(props) {
	const [adding, setAdding] = useState(/** @type {any} */ (null));
	const [picking, setPicking] = useState(false);
	if (props.ok !== true) return <AdminProblem problem={props.problem} />;
	const canAdd = adminCan(props.admin, 'credits.add');
	const productsLinked = adminCan(props.admin, 'products.manage');
	const { filter, receipts, charges, attention } = props;
	const merchants = /** @type {Array<{ value: string, label: string }>} */ (props.merchants ?? []);
	const S = BILLING.billingSections;
	const reload = () => window.location.reload();
	const chargeRows = /** @type {any[]} */ (charges?.rows ?? []);
	const methods = [...new Set(/** @type {any[]} */ (receipts).map((r) => String(r.method ?? '')).filter(Boolean))].sort();
	const dayBars =
		filter.by === 'day'
			? chargeRows.map((r) => ({ label: String(r.label).slice(5), value: r.credits / 1000, hint: r.label }))
			: [];
	const range = charges?.from && charges?.to ? MORE.rangeLine(charges.from, charges.to) : undefined;
	return (
		<div className="space-y-6">
			<PageHeader
				title={BILLING.billingTitle}
				subtitle={BILLING.billingIntro}
				actions={
					canAdd && merchants.length > 0 ? (
						<Button onClick={() => setPicking(true)} icon={<Icon name="plus" size={14} />}>
							{BILLING.addCredits}
						</Button>
					) : null
				}
			/>
			<StatGrid>
				<Stat
					label={MORE.creditsAddedRange}
					value={formatCredits(sumOf(receipts, (r) => r.credits))}
					hint={range}
					icon="wallet"
					kind="credit"
				/>
				<Stat
					label={MORE.chargedRange}
					value={formatCredits(sumOf(chargeRows, (r) => r.credits))}
					hint={range}
					icon="trendingUp"
					kind="credit"
				/>
			</StatGrid>
			<SectionLayout
				label={BILLING.billingTitle}
				sections={[
					{
						id: 'billing-attention',
						label: S.attention.title,
						icon: 'alert',
						...(attention.length > 0 ? { badge: <Badge tone="attention">{attention.length}</Badge> } : {}),
						content: (
							<>
								<Toolbar className="!px-0">
									<p className="min-w-0 truncate text-sm text-muted">{S.attention.help}</p>
								</Toolbar>
								<AttentionTable rows={attention} onAdd={canAdd ? setAdding : null} />
							</>
						),
					},
					{
						id: 'billing-receipts',
						label: S.receipts.title,
						icon: 'receipt',
						content: (
							<>
								<Card>
									<FilterForm label={BILLING.filters.apply} className="flex flex-wrap items-end gap-3">
										<input type="hidden" name="by" value={filter.by} />
										<Select
											label={BILLING.receiptColumns.merchant}
											name="merchantId"
											defaultValue={filter.merchantId ?? ''}
											fieldClassName="min-w-48 flex-1"
											options={[{ value: '', label: MORE.allMerchants }, ...merchants]}
										/>
										<RangeSelect
											from={filter.from}
											to={filter.to}
											emptyLabel={MORE.range.last30}
											omit="last30"
											hrefFor={(r) => adminRoutes.finance({ ...filter, ...r })}
										/>
										<Input
											label={BILLING.filters.from}
											name="from"
											type="date"
											defaultValue={filter.from ?? ''}
											fieldClassName="min-w-40"
										/>
										<Input
											label={BILLING.filters.to}
											name="to"
											type="date"
											defaultValue={filter.to ?? ''}
											fieldClassName="min-w-40"
										/>
										<Input
											label={BILLING.receiptColumns.method}
											name="method"
											list="billing-methods"
											placeholder={MORE.allMethods}
											defaultValue={filter.method ?? ''}
											fieldClassName="min-w-40 flex-1"
										/>
										<datalist id="billing-methods">
											{methods.map((m) => (
												<option key={m} value={m} />
											))}
										</datalist>
										<Button type="submit" variant="secondary">
											{BILLING.filters.apply}
										</Button>
										{filter.merchantId || filter.from || filter.to || filter.method ? (
											<ButtonLink as={Link} href={adminRoutes.finance({ by: filter.by })} variant="ghost">
												{MORE.clearFilters}
											</ButtonLink>
										) : null}
									</FilterForm>
								</Card>
								<ReceiptsTable receipts={receipts} showMerchant />
							</>
						),
					},
					{
						id: 'billing-charges',
						label: S.charges.title,
						icon: 'trendingUp',
						content: (
							<>
								<Toolbar
									className="!px-0"
									end={
										<LinkTabs
											label={S.charges.title}
											linkAs={Link}
											items={
												/** @type {const} */ (['day', 'merchant', 'product']).map((by) => ({
													href: `${adminRoutes.finance({ ...filter, by })}#billing-charges`,
													label: BILLING.chargesBy[by],
													current: filter.by === by,
												}))
											}
										/>
									}>
									<p className="min-w-0 truncate text-sm text-muted">{S.charges.help}</p>
								</Toolbar>
								{isEmptySeries(dayBars) ? null : (
									<Card title={MORE.chargesChart} subtitle={range}>
										<BarChart label={MORE.chargesChart} data={dayBars} format={formatChartCredits} height={120} />
									</Card>
								)}
								<Table
									caption={S.charges.title}
									rows={chargeRows}
									rowKey={(r) => r.key}
									empty={<EmptyState compact icon="coins" kind="credit" title={BILLING.noUsage} />}
									columns={[
										{
											key: 'label',
											header: BILLING.chargesBy[/** @type {'day'} */ (filter.by)],
											rowHeader: true,
											sortable: true,
											render: (r) =>
												filter.by === 'merchant' ? (
													<TextLink as={Link} tone="plain" href={`${adminRoutes.merchant(r.key)}#merchant-credits`}>
														{r.label}
													</TextLink>
												) : filter.by === 'product' && productsLinked ? (
													<TextLink as={Link} tone="plain" href={adminRoutes.product(r.key)}>
														{r.label}
													</TextLink>
												) : (
													r.label
												),
										},
										{
											key: 'credits',
											header: BILLING.usageColumns.credits,
											align: 'right',
											sortable: true,
											render: (r) => formatCredits(r.credits),
										},
									]}
								/>
							</>
						),
					},
				]}
			/>
			{picking ? (
				<PickMerchantDialog
					merchants={merchants}
					initial={filter.merchantId}
					onClose={() => setPicking(false)}
					onPicked={(m) => {
						setPicking(false);
						setAdding(m);
					}}
				/>
			) : null}
			{adding ? (
				<AddCreditsDialog
					merchant={{ merchantId: adding.merchantId, name: adding.merchantName ?? adding.merchantId }}
					balance={adding.balance}
					onClose={() => setAdding(null)}
					onAdded={reload}
				/>
			) : null}
		</div>
	);
}
