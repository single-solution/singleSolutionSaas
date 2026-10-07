'use client';
/**
 * Merchant-wide money: credits (balance, meter, hours remaining, statement with filters, low-balance warning)
 * and the monthly spend cap. Everything is shown in credits from integer
 * millicredits; amounts typed by people are parsed with at most 3 decimals.
 * @module
 */
import { useState } from 'react';
import {
	Button,
	Callout,
	Card,
	ConfirmDialog,
	FormError,
	Input,
	PageHeader,
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
 * The organisation's optional monthly spend cap (UTC calendar month, all websites).
 * @param {any} props loader result of `loadSpendCap`
 */
export function SpendCapView(props) {
	const toast = useToast();
	const ok = props.ok === true;
	const { data, reload } = useResource(ok ? api.spendCap(props.merchantId) : null, ok ? props.cap : null);
	const [limit, setLimit] = useState(ok && typeof props.cap?.limit === 'number' ? plainCredits(props.cap.limit) : '');
	const [error, setError] = useState(/** @type {string | undefined} */ (undefined));
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [busy, setBusy] = useState(/** @type {null | 'save' | 'remove'} */ (null));
	const [removing, setRemoving] = useState(false);
	if (!ok) return <PageProblem problem={props.problem} />;
	const { merchantId, meter } = props;
	const cap = /** @type {any} */ (data);
	const hasCap = typeof cap?.limit === 'number';

	const save = async () => {
		const amount = parseCredits(limit);
		if (!amount.ok || amount.value <= 0) {
			setError(amount.ok ? 'Enter an amount above zero.' : amount.message);
			return;
		}
		setError(undefined);
		setBusy('save');
		setProblem(null);
		const result = await apiFetch(api.spendCap(merchantId), { method: 'PUT', body: { limit: amount.value } });
		setBusy(null);
		if (!result.ok) {
			setProblem(result.problem);
			setError(fieldErrors(result.problem).limit);
			return;
		}
		toast.show({ title: 'Spend cap saved' });
		await reload();
	};
	const remove = async () => {
		setBusy('remove');
		setProblem(null);
		const result = await apiFetch(api.spendCap(merchantId), { method: 'DELETE' });
		setBusy(null);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		setRemoving(false);
		setLimit('');
		toast.show({ title: 'Spend cap removed' });
		await reload();
	};

	return (
		<div className="space-y-6">
			<PageHeader
				title="Spend cap"
				subtitle="One optional cap per calendar month (UTC) for all websites. Reaching it pauses subscriptions until the month ends."
			/>
			<div className="grid gap-4 sm:grid-cols-3">
				<Stat label="Cap" value={hasCap ? formatCredits(cap.limit) : 'No cap'} icon="sliders" />
				<Stat
					label="Spent this month"
					value={formatCredits(cap?.spent ?? 0)}
					tone={cap?.reached ? 'warning' : 'neutral'}
					hint={cap?.periodEnd ? `Resets ${formatDateTime(cap.periodEnd)}` : undefined}
					icon="activity"
				/>
				<Stat label="Remaining" value={hasCap ? formatCredits(cap.remaining) : '—'} icon="wallet" />
			</div>
			{cap?.reached ? (
				<Callout tone="warning" title="The spend cap is reached">
					Subscriptions are paused until the month ends or the cap is raised. Paused time is never billed.
				</Callout>
			) : null}
			{meter ? (
				<p className="text-sm text-muted">
					Current spend: <strong className="text-fg">{formatCreditsPerHour(meter.burnRatePerHour)}</strong> · about{' '}
					<strong className="text-fg">{formatCredits(meter.burnRatePerHour * 24 * 30)}</strong> per month.
				</p>
			) : null}
			<Card title={hasCap ? 'Change the cap' : 'Set a cap'}>
				<form
					className="flex flex-wrap items-end gap-3"
					onSubmit={(e) => {
						e.preventDefault();
						void save();
					}}>
					<Input
						label="Monthly cap"
						inputMode="decimal"
						value={limit}
						onChange={(e) => setLimit(e.currentTarget.value)}
						suffix="credits"
						help="Up to 3 decimals."
						error={error}
						fieldClassName="w-56"
						required
					/>
					<Button type="submit" loading={busy === 'save'}>
						Save
					</Button>
					{hasCap ? (
						<Button variant="ghost" onClick={() => setRemoving(true)}>
							Remove cap
						</Button>
					) : null}
				</form>
				{problem && !removing ? <FormError problem={problem} fields={['limit']} /> : null}
			</Card>
			<ConfirmDialog
				open={removing}
				onClose={() => setRemoving(false)}
				onConfirm={() => void remove()}
				busy={busy === 'remove'}
				danger
				title="Remove the spend cap?"
				confirmLabel="Remove cap"
				error={problem ? describeProblem(problem) : null}>
				<p className="text-sm text-muted">Subscriptions paused only by the cap resume.</p>
			</ConfirmDialog>
		</div>
	);
}

/** @param {number} millicredits */
const plainCredits = (millicredits) => creditsNumber(millicredits).replace(/,/g, '');
