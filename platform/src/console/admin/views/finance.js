'use client';
/**
 * Finance: credits, adjustments and refunds (reference + note, confirmation dialog; idempotent by reference),
 * the hash-chained ledger of a merchant with chain verification, forced settlement, reconciliation runs and
 * reports, and finance alerts. Amounts are integer millicredits on the wire (PLAN F.1), credits on screen.
 * @module
 */
import { useState } from 'react';
import {
	Badge,
	Button,
	Callout,
	Card,
	ConfirmDialog,
	Form,
	FormActions,
	FormError,
	Icon,
	Input,
	PageHeader,
	RadioGroup,
	Stat,
	StatusBadge,
	Table,
	TextArea,
	describeProblem,
	fieldErrors,
	formatCredits,
	formatDateTime,
	formatNumber,
	humanize,
	useToast,
} from '@ss/ui';
import { Link } from '../../link.js';
import { adminFetch, useAdminResource, usePagedList } from '../client.js';
import { ID, adminApi, adminRoutes } from '../paths.js';
import { ActionProblem, AdminProblem, Crumbs, IdChip, localProblem, parseSignedCredits, staffCan } from './common.js';

/** @typedef {import('@ss/ui').Problem} Problem */

/** Credit operations and their API segment. */
export const CREDIT_KINDS = Object.freeze({
	credits: { label: 'Add credits', verb: 'Add', help: 'A payment received (bank transfer, invoice).' },
	adjustments: { label: 'Adjustment', verb: 'Adjust', help: 'A correction; may be negative (prefix with -).' },
	refunds: { label: 'Refund', verb: 'Refund', help: 'Credits returned to the merchant.' },
});

/**
 * @param {any} props loader result of `loadFinance` plus `staff`
 */
export function FinanceView(props) {
	const toast = useToast();
	const ok = props.ok === true;
	const reports = useAdminResource(ok ? adminApi.reconciliation() : null, { items: ok ? props.reports : [] });
	const [merchantId, setMerchantId] = useState('');
	const [lookupError, setLookupError] = useState(/** @type {string | null} */ (null));
	const [confirm, setConfirm] = useState(/** @type {null | 'settlement' | 'reconciliation'} */ (null));
	const [settleScope, setSettleScope] = useState('');
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [stats, setStats] = useState(/** @type {any} */ (null));
	if (!ok) return <AdminProblem problem={props.problem} />;
	const { staff, alerts } = props;
	const canRun = staffCan(staff, 'platform.jobs.manage');
	const items = /** @type {any[]} */ (reports.data?.items ?? []);
	const run = async () => {
		if (confirm === 'settlement' && settleScope.trim() && !ID.merchant.test(settleScope.trim())) {
			setProblem(localProblem('Invalid merchant id', 'Enter a merchant id (mer_…) or leave empty for every merchant.'));
			return;
		}
		setBusy(true);
		setProblem(null);
		const result = await adminFetch(confirm === 'settlement' ? adminApi.settlement() : adminApi.reconciliation(), {
			method: 'POST',
			body: confirm === 'settlement' && settleScope.trim() ? { merchantId: settleScope.trim() } : {},
		});
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		setStats({ kind: confirm, stats: result.data?.stats ?? null });
		toast.show({ title: confirm === 'settlement' ? 'Settlement ran' : 'Reconciliation ran' });
		setConfirm(null);
		await reports.reload();
	};
	return (
		<div className="space-y-6">
			<PageHeader title="Finance" subtitle="Credits, ledgers, settlement and reconciliation." />
			<Card
				title="Merchant ledger and credits"
				subtitle="Credit operations and the ledger live on the merchant's finance page.">
				<form
					className="flex flex-wrap items-end gap-3"
					onSubmit={(e) => {
						e.preventDefault();
						const id = merchantId.trim();
						if (!ID.merchant.test(id)) setLookupError('Enter a merchant id (mer_…).');
						else window.location.assign(adminRoutes.ledger(id));
					}}>
					<Input
						label="Merchant id"
						value={merchantId}
						onChange={(e) => setMerchantId(e.currentTarget.value)}
						error={lookupError}
						className="font-mono"
						placeholder="mer_…"
						fieldClassName="min-w-0 flex-1 sm:max-w-sm"
					/>
					<Button type="submit" icon={<Icon name="wallet" size={14} />}>
						Open
					</Button>
				</form>
			</Card>
			<div className="grid gap-6 lg:grid-cols-2">
				<Card title="Settlement" subtitle="Settles every complete UTC hour that is due (idempotent per hour).">
					<p className="text-sm text-muted">Runs hourly by cron; force it after an incident or before reconciliation.</p>
					{canRun ? (
						<Button className="mt-3" variant="secondary" onClick={() => setConfirm('settlement')}>
							Force settlement
						</Button>
					) : null}
					{stats?.kind === 'settlement' && stats.stats ? <StatsLine stats={stats.stats} /> : null}
				</Card>
				<Card title="Reconciliation" subtitle="Compares usage, settlement and the ledger; discrepancies raise alerts.">
					<p className="text-sm text-muted">Runs nightly; a run resumes where the previous chunk stopped.</p>
					{canRun ? (
						<Button className="mt-3" variant="secondary" onClick={() => setConfirm('reconciliation')}>
							Run reconciliation
						</Button>
					) : null}
					{stats?.kind === 'reconciliation' && stats.stats ? <StatsLine stats={stats.stats} /> : null}
				</Card>
			</div>
			<Card title="Reconciliation reports">
				<Table
					caption="Reconciliation reports"
					dense
					rows={items}
					rowKey={(r) => r.reportId}
					empty="No reconciliation report yet."
					columns={[
						{ key: 'at', header: 'Run', rowHeader: true, render: (r) => formatDateTime(r.at) },
						{
							key: 'phase',
							header: 'Phase',
							render: (r) => <StatusBadge status={r.phase === 'done' ? 'ok' : 'running'} label={humanize(r.phase)} />,
						},
						{ key: 'subscriptions', header: 'Subscriptions', align: 'right', render: (r) => formatNumber(r.subscriptions) },
						{ key: 'merchants', header: 'Merchants', align: 'right', render: (r) => formatNumber(r.merchants) },
						{
							key: 'discrepancies',
							header: 'Discrepancies',
							render: (r) => {
								const list = /** @type {any[]} */ (r.discrepancies ?? []);
								if (list.length === 0) return <Badge tone="success">None</Badge>;
								return (
									<details>
										<summary className="cursor-pointer text-sm font-semibold text-danger">{list.length} found</summary>
										<ul className="mt-2 space-y-1 text-xs">
											{list.slice(0, 50).map((d, i) => (
												<li key={i} className="font-mono">
													{d.kind ?? 'discrepancy'} {d.merchantId ?? ''} {d.subscriptionId ?? ''} {d.message ?? ''}
												</li>
											))}
										</ul>
									</details>
								);
							},
						},
					]}
				/>
			</Card>
			<AlertsCard alerts={alerts} />
			<ConfirmDialog
				open={confirm !== null}
				onClose={() => setConfirm(null)}
				onConfirm={() => void run()}
				busy={busy}
				title={confirm === 'settlement' ? 'Force settlement now?' : 'Run reconciliation now?'}
				confirmLabel={confirm === 'settlement' ? 'Settle' : 'Run'}
				error={problem ? describeProblem(problem) : null}>
				{confirm === 'settlement' ? (
					<Input
						label="Only this merchant (optional)"
						value={settleScope}
						onChange={(e) => setSettleScope(e.currentTarget.value)}
						className="font-mono"
						placeholder="mer_… (empty = every merchant)"
					/>
				) : (
					<p className="text-sm text-muted">It can take a while on large fleets; it never moves money.</p>
				)}
			</ConfirmDialog>
		</div>
	);
}

/** @param {{ stats: Record<string, unknown> }} props */
function StatsLine({ stats }) {
	return (
		<p className="mt-3 flex flex-wrap gap-2 text-xs text-muted">
			{Object.entries(stats)
				.filter(([, v]) => typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string')
				.map(([k, v]) => (
					<span key={k} className="rounded bg-surface-2 px-1.5 py-0.5">
						{humanize(k)}: <strong className="text-fg">{String(v)}</strong>
					</span>
				))}
		</p>
	);
}

/** @param {{ alerts: any[] }} props */
export function AlertsCard({ alerts }) {
	return (
		<Card title="Finance alerts" subtitle="Unpriced hours, reconciliation discrepancies and other money anomalies.">
			<Table
				caption="Finance alerts"
				dense
				rows={alerts}
				rowKey={(a) => a.alertId}
				empty="No alerts."
				columns={[
					{
						key: 'kind',
						header: 'Alert',
						rowHeader: true,
						render: (a) => <StatusBadge status="failing" label={humanize(a.kind)} />,
					},
					{ key: 'at', header: 'When', render: (a) => formatDateTime(a.at) },
					{
						key: 'merchantId',
						header: 'Merchant',
						render: (a) =>
							a.merchantId ? (
								<Link href={adminRoutes.ledger(a.merchantId)} className="font-mono text-xs text-primary hover:underline">
									{a.merchantId}
								</Link>
							) : (
								'—'
							),
					},
					{
						key: 'subscriptionId',
						header: 'Subscription',
						render: (a) =>
							a.subscriptionId ? (
								<Link
									href={adminRoutes.subscription(a.subscriptionId)}
									className="font-mono text-xs text-primary hover:underline">
									{a.subscriptionId}
								</Link>
							) : (
								'—'
							),
					},
					{
						key: 'details',
						header: 'Details',
						render: (a) => (
							<span className="break-all font-mono text-[11px] text-muted">
								{a.details ? JSON.stringify(a.details) : '—'}
							</span>
						),
					},
				]}
			/>
		</Card>
	);
}

/**
 * @param {any} props loader result of `loadLedger` plus `staff`
 */
export function LedgerView(props) {
	const toast = useToast();
	const ok = props.ok === true;
	const merchantId = ok ? props.merchant.merchantId : null;
	const balance = useAdminResource(merchantId ? adminApi.balance(merchantId) : null, ok ? props.balance : null);
	const ledger = usePagedList(
		(cursor) => (merchantId ? adminApi.ledger(merchantId, { cursor, limit: 100 }) : null),
		ok ? props.ledger : null,
	);
	const [kind, setKind] = useState(/** @type {'credits' | 'adjustments' | 'refunds'} */ ('credits'));
	const [amount, setAmount] = useState('');
	const [reference, setReference] = useState('');
	const [note, setNote] = useState('');
	const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
	const [pending, setPending] = useState(/** @type {null | { amountMillicredits: number }} */ (null));
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [verification, setVerification] = useState(/** @type {any} */ (null));
	const [verifying, setVerifying] = useState(false);
	const [verifyProblem, setVerifyProblem] = useState(/** @type {Problem | null} */ (null));
	if (!ok) return <AdminProblem problem={props.problem} back={{ href: adminRoutes.finance(), label: 'Back to finance' }} />;
	const { merchant, staff } = props;
	const canAdjust = staffCan(staff, 'platform.credits.adjust');

	const review = () => {
		/** @type {Record<string, string>} */
		const local = {};
		const parsed = parseSignedCredits(amount, { allowNegative: kind === 'adjustments' });
		if (!parsed.ok) local.amountMillicredits = parsed.message;
		if (!/^[\x21-\x7e]{1,120}$/.test(reference.trim()))
			local.reference = 'A reference of 1–120 visible characters, no spaces (e.g. bank-2026-10-01).';
		if (!note.trim()) local.note = 'Explain the operation (shown in the merchant statement).';
		setErrors(local);
		if (Object.keys(local).length > 0 || !parsed.ok) return;
		setProblem(null);
		setPending({ amountMillicredits: parsed.value });
	};
	const submit = async () => {
		if (!pending) return;
		setBusy(true);
		setProblem(null);
		const result = await adminFetch(adminApi.credit(merchant.merchantId, kind), {
			method: 'POST',
			body: { amountMillicredits: pending.amountMillicredits, reference: reference.trim(), note: note.trim() },
		});
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			setErrors(fieldErrors(result.problem));
			return;
		}
		toast.show({
			title: result.data?.duplicate ? 'Already booked' : `${CREDIT_KINDS[kind].label} booked`,
			description: result.data?.duplicate
				? `Reference ${reference.trim()} was booked before; nothing changed.`
				: `New balance ${formatCredits(result.data?.balanceMillicredits)}.`,
		});
		setPending(null);
		setAmount('');
		setReference('');
		setNote('');
		await Promise.all([balance.reload(), ledger.reload()]);
	};
	const verify = async () => {
		setVerifying(true);
		setVerifyProblem(null);
		const result = await adminFetch(adminApi.ledgerVerification(merchant.merchantId));
		setVerifying(false);
		if (result.ok) setVerification(result.data);
		else setVerifyProblem(result.problem);
	};
	return (
		<div className="space-y-6">
			<PageHeader
				breadcrumbs={
					<Crumbs
						items={[
							{ label: 'Finance', href: adminRoutes.finance() },
							{ label: merchant.name, href: adminRoutes.merchant(merchant.merchantId) },
							{ label: 'Ledger' },
						]}
					/>
				}
				title={`Ledger · ${merchant.name}`}
				badge={<StatusBadge status={merchant.status} />}
				subtitle={<IdChip id={merchant.merchantId} label="merchant id" />}
				actions={
					<Button
						variant="secondary"
						onClick={() => void verify()}
						loading={verifying}
						icon={<Icon name="shield" size={14} />}>
						Verify chain
					</Button>
				}
			/>
			{verification ? (
				<Callout
					tone={verification.ok ? 'success' : 'danger'}
					title={verification.ok ? 'Ledger chain intact' : 'Ledger chain broken'}>
					{formatNumber(verification.entries)} entries up to seq {formatNumber(verification.seq)} · ledger sum{' '}
					{formatCredits(verification.balance)} · head{' '}
					<span className="break-all font-mono text-xs">{verification.headHash}</span>
					{(verification.problems ?? []).length > 0 ? (
						<ul className="mt-2 list-disc pl-5 text-sm">
							{verification.problems.map((/** @type {any} */ p, /** @type {number} */ i) => (
								<li key={i}>
									{p.seq !== null && p.seq !== undefined ? `seq ${p.seq}: ` : ''}
									{p.message}
								</li>
							))}
						</ul>
					) : null}
				</Callout>
			) : null}
			<ActionProblem problem={verifyProblem} />
			<div className="grid gap-4 sm:grid-cols-2">
				<Stat label="Balance" value={formatCredits(balance.data?.balanceMillicredits)} icon="wallet" />
				<Stat
					label="Entries loaded"
					value={formatNumber(ledger.items.length)}
					hint={ledger.cursor ? 'More below' : 'All entries'}
				/>
			</div>
			{canAdjust ? (
				<Card title="Credit operation" subtitle="Booked once per reference: repeating a reference never books twice.">
					<Form onSubmit={review} aria-label="Credit operation">
						<RadioGroup
							legend="Operation"
							inline
							value={kind}
							onChange={(v) => setKind(/** @type {any} */ (v))}
							options={Object.entries(CREDIT_KINDS).map(([value, k]) => ({ value, label: k.label }))}
							help={CREDIT_KINDS[kind].help}
						/>
						<div className="grid gap-4 sm:grid-cols-2">
							<Input
								label="Amount (credits)"
								inputMode="decimal"
								value={amount}
								onChange={(e) => setAmount(e.currentTarget.value)}
								error={errors.amountMillicredits}
								placeholder={kind === 'adjustments' ? '-12.5 or 12.5' : '100'}
								suffix="credits"
								required
							/>
							<Input
								label="Reference"
								value={reference}
								onChange={(e) => setReference(e.currentTarget.value)}
								error={errors.reference}
								placeholder="bank-2026-10-01-0042"
								className="font-mono"
								maxLength={120}
								required
							/>
						</div>
						<TextArea
							label="Note"
							rows={2}
							maxLength={500}
							value={note}
							onChange={(e) => setNote(e.currentTarget.value)}
							error={errors.note}
							required
						/>
						<FormActions>
							<Button type="submit">Review</Button>
						</FormActions>
					</Form>
				</Card>
			) : null}
			<Card title="Ledger entries" subtitle="Append-only and hash-chained, oldest first.">
				<Table
					caption="Ledger entries"
					dense
					rows={ledger.items}
					rowKey={(l) => l.entryId}
					empty="No ledger entries yet."
					hasMore={Boolean(ledger.cursor)}
					loadingMore={ledger.loading}
					onLoadMore={() => void ledger.more()}
					columns={[
						{
							key: 'seq',
							header: 'Seq',
							rowHeader: true,
							align: 'right',
							render: (l) => <span className="tabular-nums">{l.seq}</span>,
						},
						{ key: 'at', header: 'When', render: (l) => formatDateTime(l.at) },
						{ key: 'type', header: 'Type', render: (l) => <Badge>{humanize(l.type)}</Badge> },
						{
							key: 'amount',
							header: 'Amount',
							align: 'right',
							render: (l) => (
								<span className={`tabular-nums ${l.amountMillicredits < 0 ? 'text-danger' : 'text-success'}`}>
									{formatCredits(l.amountMillicredits, { signed: true })}
								</span>
							),
						},
						{
							key: 'ref',
							header: 'Reference / note',
							render: (l) => (
								<span className="block text-xs">
									{l.reference ? <span className="block font-mono">{l.reference}</span> : null}
									{l.note ? <span className="block text-muted">{l.note}</span> : null}
									{l.periodKey ? <span className="block font-mono text-muted">{l.periodKey}</span> : null}
								</span>
							),
						},
						{
							key: 'hash',
							header: 'Hash',
							render: (l) => (
								<span className="font-mono text-[11px] text-muted" title={l.hash}>
									{String(l.hash).slice(0, 12)}…
								</span>
							),
						},
					]}
				/>
				<ActionProblem problem={ledger.problem} />
			</Card>
			<ConfirmDialog
				open={pending !== null}
				onClose={() => setPending(null)}
				onConfirm={() => void submit()}
				busy={busy}
				danger={kind !== 'credits'}
				title={`${CREDIT_KINDS[kind].verb} ${formatCredits(pending?.amountMillicredits ?? 0, { signed: kind === 'adjustments' })} for ${merchant.name}?`}
				confirmLabel={`${CREDIT_KINDS[kind].verb} credits`}
				error={problem ? describeProblem(problem) : null}>
				<dl className="space-y-1 text-sm">
					<div className="flex justify-between gap-4">
						<dt className="text-muted">Operation</dt>
						<dd>{CREDIT_KINDS[kind].label}</dd>
					</div>
					<div className="flex justify-between gap-4">
						<dt className="text-muted">Reference</dt>
						<dd className="font-mono">{reference.trim()}</dd>
					</div>
					<div className="flex justify-between gap-4">
						<dt className="text-muted">Balance now</dt>
						<dd>{formatCredits(balance.data?.balanceMillicredits)}</dd>
					</div>
				</dl>
				<p className="text-sm text-muted">“{note.trim()}” — ledger entries cannot be edited or deleted.</p>
			</ConfirmDialog>
		</div>
	);
}
