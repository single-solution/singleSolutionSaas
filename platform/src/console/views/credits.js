'use client';
/**
 * Merchant-wide money: credits (balance, meter, hours remaining, statement with filters, low-balance warning)
 * and spend policies (daily/monthly caps per merchant or website). Everything is shown in credits from integer
 * millicredits; amounts typed by people are parsed with at most 3 decimals.
 * @module
 */
import { useState } from 'react';
import {
	Button,
	Callout,
	Card,
	ConfirmDialog,
	Dialog,
	EmptyState,
	FormError,
	Icon,
	Input,
	PageHeader,
	RadioGroup,
	Select,
	Stat,
	Table,
	creditsNumber,
	describeProblem,
	fieldErrors,
	formatCredits,
	formatCreditsPerHour,
	formatDateTime,
	formatHours,
	humanize,
	parseCredits,
	useToast,
} from '@ss/ui';
import { apiFetch, useResource } from '../client.js';
import { api } from '../paths.js';
import { balanceState } from './shell.js';
import { PageProblem, productName, websiteLabel } from './common.js';

/** @typedef {import('@ss/ui').Problem} Problem */

/**
 * @param {any} props loader result of `loadCredits`
 */
export function CreditsView(props) {
	if (!props.ok) return <PageProblem problem={props.problem} />;
	const { balance, meter, statement, websites, catalog, filter } = props;
	const state = balanceState(meter);
	const entries = /** @type {any[]} */ (statement?.entries ?? []);
	const totals = statement?.totals ?? {};
	return (
		<div className="space-y-6">
			<PageHeader title="Credits" subtitle="One balance for every website. Hours settle shortly after they end." />
			<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
				<Stat
					label="Balance"
					value={formatCredits(balance?.balanceMillicredits)}
					hint={`As of ${formatDateTime(balance?.at)}`}
					icon="wallet"
				/>
				<Stat
					label="Spend now"
					value={formatCreditsPerHour(meter?.burnRatePerHour)}
					hint="All running subscriptions"
					icon="activity"
				/>
				<Stat
					label="Hours remaining"
					value={formatHours(meter?.hoursRemaining)}
					tone={state === 'low' || state === 'empty' ? 'warning' : 'neutral'}
					hint="At the current spend"
					icon="clock"
				/>
				<Stat
					label="This month"
					value={formatCredits(meter?.monthToDate)}
					hint={meter ? `Projected ${formatCredits(meter.projectedMonth)}` : undefined}
					icon="activity"
				/>
			</div>
			<Callout tone="info" live={false} title="Adding credits">
				Credits are added by Single Solution staff after an offline payment. Contact your account manager with your
				organisation name; the deposit appears in the statement below with its reference.
			</Callout>
			<Card title="Statement" subtitle="Filter by period (UTC days) and website.">
				<form method="get" className="flex flex-wrap items-end gap-3">
					<Input label="From" type="date" name="from" defaultValue={filter.from ?? ''} fieldClassName="w-44" />
					<Input label="To" type="date" name="to" defaultValue={filter.to ?? ''} fieldClassName="w-44" />
					<Select
						label="Website"
						name="websiteId"
						defaultValue={filter.websiteId ?? ''}
						fieldClassName="w-56"
						options={[
							{ value: '', label: 'All websites' },
							...websites.map((/** @type {any} */ w) => ({ value: w.websiteId, label: websiteLabel(w) })),
						]}
					/>
					<Button type="submit" variant="secondary">
						Apply
					</Button>
				</form>
				{props.statementProblem ? (
					<Callout tone="danger" className="mt-4">
						{describeProblem(props.statementProblem)}
					</Callout>
				) : null}
				{statement ? (
					<dl className="mt-5 grid gap-3 text-sm sm:grid-cols-3 lg:grid-cols-6">
						{statement.openingBalanceMillicredits !== null ? (
							<Total label="Opening" value={statement.openingBalanceMillicredits} />
						) : null}
						{Object.entries(totals).map(([type, v]) => (
							<Total key={type} label={humanize(type)} value={/** @type {number} */ (v)} signed />
						))}
						{statement.closingBalanceMillicredits !== null ? (
							<Total label="Closing" value={statement.closingBalanceMillicredits} />
						) : null}
					</dl>
				) : null}
			</Card>
			<Table
				caption="Statement entries"
				rows={entries}
				rowKey={(e) => e.entryId}
				defaultSort={{ key: 'at', direction: 'desc' }}
				empty="No entries in this period."
				columns={[
					{ key: 'at', header: 'Date', sortable: true, render: (e) => formatDateTime(e.periodStart ?? e.at) },
					{ key: 'type', header: 'Type', sortable: true, render: (e) => humanize(e.type) },
					{
						key: 'what',
						header: 'Details',
						render: (e) =>
							e.appId
								? `${productName(catalog, e.appId)}${e.websiteId ? ` · ${websiteLabel(websites.find((/** @type {any} */ w) => w.websiteId === e.websiteId) ?? { domain: e.websiteId })}` : ''}`
								: (e.note ?? e.reference ?? '—'),
					},
					{
						key: 'amount',
						header: 'Amount',
						align: 'right',
						sortable: true,
						sortValue: (e) => e.amountMillicredits,
						render: (e) => (
							<span className={`tabular-nums ${e.amountMillicredits > 0 ? 'text-success' : ''}`}>
								{formatCredits(e.amountMillicredits, { signed: true })}
							</span>
						),
					},
				]}
			/>
		</div>
	);
}

/**
 * @param {{ label: string, value: number, signed?: boolean }} props
 */
function Total({ label, value, signed = false }) {
	return (
		<div className="rounded-xl border border-line bg-surface-2 px-3 py-2">
			<dt className="text-xs font-semibold uppercase tracking-wider text-muted">{label}</dt>
			<dd className="font-semibold tabular-nums text-fg">
				{signed ? formatCredits(value, { signed: true, unit: false }) : creditsNumber(value)}
			</dd>
		</div>
	);
}

/**
 * @param {any} props loader result of `loadSpendPolicies`
 */
export function SpendPoliciesView(props) {
	const toast = useToast();
	const ok = props.ok === true;
	const { data, reload } = useResource(ok ? api.spendPolicies(props.merchantId) : null, { items: ok ? props.policies : [] });
	const [editing, setEditing] = useState(/** @type {null | { policy?: any }} */ (null));
	const [form, setForm] = useState({ scope: 'merchant', websiteId: '', window: 'month', limit: '', timeZone: 'UTC' });
	const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [busy, setBusy] = useState(false);
	const [deleting, setDeleting] = useState(/** @type {any} */ (null));
	if (!ok) return <PageProblem problem={props.problem} />;
	const { merchantId, websites, meter } = props;
	const policies = /** @type {any[]} */ (data.items ?? []);
	const zones = (() => {
		try {
			return typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['UTC'];
		} catch {
			return ['UTC'];
		}
	})();

	/** @param {any} [policy] */
	const open = (policy) => {
		setErrors({});
		setProblem(null);
		setForm(
			policy
				? {
						scope: policy.scope,
						websiteId: policy.websiteId ?? '',
						window: policy.window,
						limit: creditsNumber(policy.limitMillicredits).replace(/,/g, ''),
						timeZone: policy.timeZone,
					}
				: {
						scope: 'merchant',
						websiteId: websites.find((/** @type {any} */ w) => w.env === 'live')?.websiteId ?? '',
						window: 'month',
						limit: '',
						timeZone: 'UTC',
					},
		);
		setEditing(policy ? { policy } : {});
	};
	const save = async () => {
		const amount = parseCredits(form.limit);
		/** @type {Record<string, string>} */
		const local = {};
		if (!amount.ok) local.limit = amount.message;
		if (form.scope === 'website' && !form.websiteId) local.websiteId = 'Choose a website.';
		setErrors(local);
		if (!amount.ok || Object.keys(local).length > 0) return;
		setBusy(true);
		setProblem(null);
		const policy = editing?.policy;
		const result = policy
			? await apiFetch(`${api.spendPolicies(merchantId)}/${encodeURIComponent(policy.policyId)}`, {
					method: 'PUT',
					body: { limit: amount.value, timeZone: form.timeZone },
				})
			: await apiFetch(api.spendPolicies(merchantId), {
					method: 'POST',
					body: {
						scope: form.scope,
						...(form.scope === 'website' ? { websiteId: form.websiteId } : {}),
						window: form.window,
						limit: amount.value,
						timeZone: form.timeZone,
					},
				});
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			setErrors(fieldErrors(result.problem));
			return;
		}
		setEditing(null);
		toast.show({ title: policy ? 'Cap updated' : 'Cap created' });
		await reload();
	};
	const remove = async () => {
		setBusy(true);
		const result = await apiFetch(`${api.spendPolicies(merchantId)}/${encodeURIComponent(deleting.policyId)}`, {
			method: 'DELETE',
		});
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		setDeleting(null);
		toast.show({ title: 'Cap removed' });
		await reload();
	};
	/** @param {any} p */
	const scopeLabel = (p) =>
		p.scope === 'merchant'
			? 'All websites'
			: websiteLabel(websites.find((/** @type {any} */ w) => w.websiteId === p.websiteId) ?? { domain: p.websiteId });

	return (
		<div className="space-y-6">
			<PageHeader
				title="Spend policies"
				subtitle="Caps pause subscriptions before an hour would exceed them; they resume when the window resets."
				actions={
					<Button onClick={() => open()} icon={<Icon name="plus" size={14} />}>
						Add cap
					</Button>
				}
			/>
			{meter ? (
				<p className="text-sm text-muted">
					Current spend: <strong className="text-fg">{formatCreditsPerHour(meter.burnRatePerHour)}</strong> · about{' '}
					<strong className="text-fg">{formatCredits(meter.burnRatePerHour * 24)}</strong> per day.
				</p>
			) : null}
			{problem && !editing && !deleting ? <FormError problem={problem} /> : null}
			{policies.length === 0 ? (
				<EmptyState
					icon="sliders"
					title="No caps yet"
					description="Add a daily or monthly cap for the whole organisation or a single website."
					action={<Button onClick={() => open()}>Add cap</Button>}
				/>
			) : (
				<Table
					caption="Spend caps"
					rows={policies}
					rowKey={(p) => p.policyId}
					columns={[
						{ key: 'scope', header: 'Applies to', rowHeader: true, render: scopeLabel },
						{ key: 'window', header: 'Window', render: (p) => (p.window === 'day' ? 'Per day' : 'Per month') },
						{
							key: 'limit',
							header: 'Cap',
							align: 'right',
							sortable: true,
							sortValue: (p) => p.limitMillicredits,
							render: (p) => <span className="tabular-nums">{formatCredits(p.limitMillicredits)}</span>,
						},
						{ key: 'timeZone', header: 'Time zone' },
						{
							key: 'actions',
							header: <span className="sr-only">Actions</span>,
							align: 'right',
							render: (p) => (
								<span className="inline-flex gap-1">
									<Button size="sm" variant="ghost" onClick={() => open(p)}>
										Edit
									</Button>
									<Button size="sm" variant="ghost" onClick={() => setDeleting(p)}>
										Remove
									</Button>
								</span>
							),
						},
					]}
				/>
			)}
			<Dialog
				open={Boolean(editing)}
				onClose={() => setEditing(null)}
				title={editing?.policy ? 'Edit cap' : 'Add a cap'}
				footer={
					<>
						<Button variant="secondary" onClick={() => setEditing(null)}>
							Cancel
						</Button>
						<Button onClick={() => void save()} loading={busy}>
							Save
						</Button>
					</>
				}>
				{editing?.policy ? (
					<p className="text-sm text-muted">
						{scopeLabel(editing.policy)} · {editing.policy.window === 'day' ? 'per day' : 'per month'} — only the amount and
						time zone can change.
					</p>
				) : (
					<>
						<RadioGroup
							legend="Applies to"
							inline
							value={form.scope}
							onChange={(v) => setForm((f) => ({ ...f, scope: v }))}
							options={[
								{ value: 'merchant', label: 'All websites' },
								{ value: 'website', label: 'One website' },
							]}
						/>
						{form.scope === 'website' ? (
							<Select
								label="Website"
								value={form.websiteId}
								onChange={(e) => {
									const v = e.currentTarget.value;
									setForm((f) => ({ ...f, websiteId: v }));
								}}
								options={websites.map((/** @type {any} */ w) => ({ value: w.websiteId, label: websiteLabel(w) }))}
								error={errors.websiteId}
							/>
						) : null}
						<RadioGroup
							legend="Window"
							inline
							value={form.window}
							onChange={(v) => setForm((f) => ({ ...f, window: v }))}
							options={[
								{ value: 'day', label: 'Per day' },
								{ value: 'month', label: 'Per month' },
							]}
						/>
					</>
				)}
				<Input
					label="Cap"
					inputMode="decimal"
					value={form.limit}
					onChange={(e) => {
						const v = e.currentTarget.value;
						setForm((f) => ({ ...f, limit: v }));
					}}
					suffix="credits"
					help="Up to 3 decimals. 0 pauses everything in scope."
					error={errors.limit}
					required
				/>
				<Select
					label="Time zone"
					value={form.timeZone}
					onChange={(e) => {
						const v = e.currentTarget.value;
						setForm((f) => ({ ...f, timeZone: v }));
					}}
					options={[...new Set(['UTC', ...zones])].map((z) => ({ value: z, label: z }))}
					help="When the day or month starts."
					error={errors.timeZone}
				/>
				<FormError problem={problem} fields={['limit', 'timeZone', 'websiteId', 'scope', 'window']} />
			</Dialog>
			<ConfirmDialog
				open={Boolean(deleting)}
				onClose={() => setDeleting(null)}
				onConfirm={() => void remove()}
				busy={busy}
				danger
				title="Remove this cap?"
				confirmLabel="Remove cap"
				error={problem ? describeProblem(problem) : null}>
				<p className="text-sm text-muted">
					{deleting
						? `${scopeLabel(deleting)} · ${formatCredits(deleting.limitMillicredits)} ${deleting.window === 'day' ? 'per day' : 'per month'}`
						: null}
					. Subscriptions paused only by this cap resume.
				</p>
			</ConfirmDialog>
		</div>
	);
}
