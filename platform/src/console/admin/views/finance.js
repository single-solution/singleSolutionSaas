'use client';
/**
 * Credits and billing (PLAN 0.5.8, 0.8.2): the receipt form with its confirm step (Owner and Finance), all receipts,
 * charges by day, merchant or product, the merchants that need attention, and a merchant's Credits tab. Credits are
 * whole numbers on screen and integer millicredits on the wire; receipts are never edited or reversed.
 * @module
 */
import { useMemo, useState } from 'react';
import {
	Button,
	Card,
	Dialog,
	EmptyState,
	Form,
	FormActions,
	FormError,
	Input,
	PageHeader,
	Table,
	Tabs,
	fieldErrors,
	formatCredits,
	useToast,
} from '@ss/ui';
import { BILLING } from '../../../texts/console.js';
import { Link } from '../../link.js';
import { BillingStats, DaysLeft, MerchantStatusBadge, ReceiptsTable } from '../../views/billing.js';
import { adminFetch } from '../client.js';
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
		const result = await adminFetch(adminApi.addReceipt(merchant.merchantId), {
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
 * A merchant's Credits tab: the money numbers, receipts and day charges.
 * @param {{ billing: any, receipts: any[], dayCharges: any[] }} props
 */
export function MerchantCredits({ billing, receipts, dayCharges }) {
	return (
		<div className="space-y-6">
			{billing ? <BillingStats summary={billing} /> : null}
			<Card title={BILLING.receiptsTitle} padded={false}>
				<ReceiptsTable receipts={receipts} />
			</Card>
			<Card title={BILLING.dayChargesTitle} subtitle={BILLING.chargesNote} padded={false}>
				<Table
					caption={BILLING.dayChargesTitle}
					rows={dayCharges}
					rowKey={(d) => `${d.day}:${d.websiteId}:${d.appId}`}
					empty={<EmptyState compact title={BILLING.noUsage} />}
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
 * Credits and billing page (Owner and Finance; Support read-only).
 * @param {any} props loader result of `loadBilling` plus `admin`
 */
export function FinanceView(props) {
	const [adding, setAdding] = useState(/** @type {any} */ (null));
	if (props.ok !== true) return <AdminProblem problem={props.problem} />;
	const canAdd = adminCan(props.admin, 'credits.add');
	const { filter, receipts, charges, attention } = props;
	const reload = () => window.location.reload();
	return (
		<div className="space-y-6">
			<PageHeader title={BILLING.billingTitle} />
			<Tabs
				label={BILLING.billingTitle}
				tabs={[
					{
						id: 'attention',
						label: BILLING.billingTabs.attention,
						content: (
							<Table
								caption={BILLING.billingTabs.attention}
								rows={attention}
								rowKey={(m) => m.merchantId}
								empty={<EmptyState compact title={BILLING.noAttention} />}
								columns={[
									{
										key: 'merchantName',
										header: BILLING.receiptColumns.merchant,
										rowHeader: true,
										render: (m) => (
											<Link
												href={adminRoutes.merchant(m.merchantId, 'credits')}
												className="font-semibold text-primary hover:underline">
												{m.merchantName ?? m.merchantId}
											</Link>
										),
									},
									{ key: 'status', header: 'Status', render: (m) => <MerchantStatusBadge status={m.status} /> },
									{ key: 'balance', header: BILLING.balance, align: 'right', render: (m) => formatCredits(m.balance) },
									{ key: 'daysLeft', header: BILLING.daysLeft, render: (m) => <DaysLeft summary={m} /> },
									...(canAdd
										? [
												{
													key: 'add',
													header: '',
													render: (/** @type {any} */ m) => (
														<Button size="sm" variant="secondary" onClick={() => setAdding(m)}>
															{BILLING.addCredits}
														</Button>
													),
												},
											]
										: []),
								]}
							/>
						),
					},
					{
						id: 'receipts',
						label: BILLING.billingTabs.receipts,
						content: (
							<div className="space-y-4">
								<form method="get" className="flex flex-wrap items-end gap-3">
									<Input
										label={BILLING.receiptColumns.merchant}
										name="merchantId"
										defaultValue={filter.merchantId ?? ''}
										placeholder="mer_…"
									/>
									<Input label={BILLING.filters.from} name="from" type="date" defaultValue={filter.from ?? ''} />
									<Input label={BILLING.filters.to} name="to" type="date" defaultValue={filter.to ?? ''} />
									<Input label={BILLING.receiptColumns.method} name="method" defaultValue={filter.method ?? ''} />
									<FormActions>
										<Button type="submit" variant="secondary">
											{BILLING.filters.apply}
										</Button>
									</FormActions>
								</form>
								<ReceiptsTable receipts={receipts} showMerchant />
							</div>
						),
					},
					{
						id: 'charges',
						label: BILLING.billingTabs.charges,
						content: (
							<div className="space-y-4">
								<p className="text-sm text-muted">{BILLING.chargesNote}</p>
								<nav className="flex flex-wrap gap-2" aria-label={BILLING.billingTabs.charges}>
									{
										/** @type {const} */ (['day', 'merchant', 'product']).map((by) => (
											<Link
												key={by}
												href={adminRoutes.finance({ by, from: filter.from, to: filter.to })}
												aria-current={filter.by === by ? 'page' : undefined}
												className={`rounded-xl border px-3 py-1.5 text-sm font-semibold ${filter.by === by ? 'border-primary text-primary' : 'border-line text-fg'}`}>
												{BILLING.chargesBy[by]}
											</Link>
										))
									}
								</nav>
								<Table
									caption={BILLING.billingTabs.charges}
									rows={/** @type {any[]} */ (charges?.rows ?? [])}
									rowKey={(r) => r.key}
									empty={<EmptyState compact title={BILLING.noUsage} />}
									columns={[
										{
											key: 'label',
											header: BILLING.chargesBy[/** @type {'day'} */ (filter.by)],
											rowHeader: true,
											sortable: true,
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
							</div>
						),
					},
				]}
			/>
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
