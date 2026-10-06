'use client';
/**
 * Platform health at a glance: event deliveries and dead letters, unhealthy service apps (stale or failing
 * heartbeats), reconciliation runs and finance alerts, the on-demand operations (last run and a Run button each:
 * nothing runs on a schedule), the job queue and the last audit hash-chain verification (`GET /v1/admin/system/health`).
 * @module
 */
import { useState } from 'react';
import {
	Button,
	ButtonLink,
	Card,
	EmptyState,
	PageHeader,
	Stat,
	StatusBadge,
	Table,
	describeProblem,
	formatDateTime,
	formatNumber,
	humanize,
	useToast,
} from '@ss/ui';
import { Link } from '../../link.js';
import { adminFetch } from '../client.js';
import { adminApi, adminRoutes } from '../paths.js';
import { AdminProblem, IdChip, staffCan } from './common.js';

/**
 * @param {any} props loader result of `loadDashboard`
 */
export function DashboardView(props) {
	if (!props.ok) return <AdminProblem problem={props.problem} />;
	const { metrics, deadLetters, unhealthy, alerts, reports, health } = props;
	const d = metrics?.deliveries ?? {};
	const latest = reports[0] ?? null;
	const h = health.data;
	return (
		<div className="space-y-6">
			<PageHeader title="Platform health" subtitle="Queues, product health, money integrity and audit at a glance." />
			<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
				<Stat label="Pending deliveries" value={formatNumber(d.pending)} icon="send" />
				<Stat
					label="Retrying"
					value={formatNumber(d.retrying)}
					tone={d.retrying > 0 ? 'warning' : 'neutral'}
					hint={d.retrying > 0 ? 'Products are failing to accept events' : 'All clear'}
				/>
				<Stat
					label="Dead letters"
					value={formatNumber(metrics?.deadLetters)}
					tone={metrics?.deadLetters > 0 ? 'danger' : 'success'}
					hint={metrics?.deadLetters > 0 ? 'Replay from Integration' : 'None'}
				/>
				<Stat
					label="Unhealthy apps"
					value={formatNumber(unhealthy.length)}
					tone={unhealthy.length > 0 ? 'danger' : 'success'}
					hint={unhealthy.length > 0 ? 'Silent for a day or reporting a problem' : 'Every service app is in touch'}
				/>
				<Stat
					label="Finance alerts"
					value={formatNumber(alerts.length)}
					tone={alerts.length > 0 ? 'warning' : 'success'}
					hint={latest ? `Last reconciliation ${formatDateTime(latest.at)}` : 'No reconciliation run yet'}
				/>
			</div>
			{props.metricsProblem ? (
				<p className="text-sm text-danger">Delivery metrics: {describeProblem(props.metricsProblem)}</p>
			) : null}

			<div className="grid gap-6 xl:grid-cols-2">
				<OperationsCard health={health} canRun={staffCan(props.staff, 'platform.jobs.manage')} />
				<Card title="Job queue and audit chain">
					{health.problem ? (
						<p className="text-sm text-danger">{describeProblem(health.problem)}</p>
					) : (
						<div className="space-y-4">
							<dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
								{['queued', 'leased', 'retrying', 'dead'].map((k) => (
									<div key={k} className="rounded-xl border border-line p-3">
										<dt className="text-xs font-semibold uppercase tracking-wider text-muted">{humanize(k)}</dt>
										<dd className="text-lg font-bold tabular-nums text-fg">{formatNumber(h?.jobs?.[k])}</dd>
									</div>
								))}
							</dl>
							<AuditChainLine verification={h?.audit?.lastVerification ?? null} />
						</div>
					)}
				</Card>
			</div>

			<div className="grid gap-6 xl:grid-cols-2">
				<Card
					title="Unhealthy service apps"
					subtitle="Not seen (no call, no heartbeat) for a day, or a reported status other than ok."
					actions={
						<ButtonLink as={Link} href={adminRoutes.apps({ kind: 'service' })} size="sm" variant="ghost">
							All apps
						</ButtonLink>
					}>
					{unhealthy.length === 0 ? (
						<EmptyState compact icon="check" title="Every live service app is healthy" />
					) : (
						<Table
							caption="Unhealthy service apps"
							dense
							rows={unhealthy}
							rowKey={(a) => a.appId}
							columns={[
								{
									key: 'name',
									header: 'App',
									rowHeader: true,
									render: (a) => (
										<Link href={adminRoutes.app(a.appId)} className="font-semibold text-primary hover:underline">
											{a.name ?? a.slug}
										</Link>
									),
								},
								{
									key: 'health',
									header: 'Health',
									render: (a) => (
										<StatusBadge
											status={a.health.stale ? 'failing' : (a.health.status ?? 'unknown')}
											label={a.health.stale ? 'Stale' : humanize(a.health.status)}
										/>
									),
								},
								{ key: 'last', header: 'Last seen', render: (a) => formatDateTime(a.health.lastSeenAt) },
							]}
						/>
					)}
				</Card>
				<Card
					title="Recent dead letters"
					actions={
						<ButtonLink as={Link} href={adminRoutes.integration()} size="sm" variant="ghost">
							Integration
						</ButtonLink>
					}>
					{deadLetters.length === 0 ? (
						<EmptyState compact icon="check" title="No dead letters" />
					) : (
						<Table
							caption="Recent dead letters"
							dense
							rows={deadLetters}
							rowKey={(l) => l.deliveryId}
							columns={[
								{
									key: 'type',
									header: 'Event',
									rowHeader: true,
									render: (l) => <span className="font-mono text-xs">{l.type}</span>,
								},
								{ key: 'appId', header: 'App', render: (l) => <IdChip id={l.appId} label="app id" /> },
								{
									key: 'err',
									header: 'Error',
									render: (l) => <span className="font-mono text-xs text-danger">{l.lastErrorCode ?? '—'}</span>,
								},
								{ key: 'deadAt', header: 'Dead since', render: (l) => formatDateTime(l.deadAt) },
							]}
						/>
					)}
				</Card>
			</div>

			<Card
				title="Reconciliation"
				subtitle="On-demand comparison of usage, settlement and the ledger."
				actions={
					<ButtonLink as={Link} href={adminRoutes.finance()} size="sm" variant="ghost">
						Finance
					</ButtonLink>
				}>
				{latest ? (
					<p className="text-sm text-fg">
						Last run {formatDateTime(latest.at)} · {formatNumber(latest.subscriptions)} subscriptions ·{' '}
						{formatNumber(latest.merchants)} merchants ·{' '}
						<strong className={(latest.discrepancies ?? []).length > 0 ? 'text-danger' : 'text-success'}>
							{formatNumber((latest.discrepancies ?? []).length)} discrepancies
						</strong>
					</p>
				) : (
					<p className="text-sm text-muted">No reconciliation report yet.</p>
				)}
				{alerts.length > 0 ? (
					<ul className="mt-3 space-y-1 text-sm">
						{alerts.slice(0, 5).map((/** @type {any} */ a) => (
							<li key={a.alertId} className="flex flex-wrap items-center gap-2">
								<StatusBadge status="failing" label={humanize(a.kind)} />
								{a.merchantId ? (
									<Link
										href={adminRoutes.merchant(a.merchantId)}
										className="font-mono text-xs text-primary hover:underline">
										{a.merchantId}
									</Link>
								) : null}
								<span className="text-muted">{formatDateTime(a.at)}</span>
							</li>
						))}
					</ul>
				) : null}
			</Card>
		</div>
	);
}

/**
 * @param {{ verification: any }} props `{ at, status, scopes, broken[] }`
 */
export function AuditChainLine({ verification }) {
	if (!verification) return <p className="text-sm text-muted">The audit chains have not been verified yet.</p>;
	const broken = /** @type {any[]} */ (verification.broken ?? []);
	return (
		<div className="flex flex-wrap items-center gap-2 text-sm">
			<StatusBadge
				status={broken.length === 0 && verification.status !== 'failed' ? 'ok' : 'failed'}
				label={
					broken.length > 0
						? 'Audit chain broken'
						: verification.status === 'failed'
							? 'Verification run failed'
							: 'Audit chains intact'
				}
			/>
			<span className="text-muted">
				{formatNumber(verification.scopes)} scopes verified {formatDateTime(verification.at)}
			</span>
			{broken.map((b) => (
				<Link key={b.scope} href={adminRoutes.audit({ scope: b.scope })} className="font-mono text-xs text-danger underline">
					{b.scope} (seq {b.seq ?? '?'})
				</Link>
			))}
		</div>
	);
}

/**
 * The on-demand admin operations: last run of each, and a Run button (Continue when the last run stopped at its
 * deadline and returned a cursor). Nothing runs on a schedule (PLAN F.19).
 * @param {{ health: { data: any, problem: any }, canRun: boolean }} props
 */
function OperationsCard({ health, canRun }) {
	const toast = useToast();
	const [rows, setRows] = useState(/** @type {any[]} */ (health.data?.operations ?? []));
	const [running, setRunning] = useState(/** @type {string | null} */ (null));
	const [error, setError] = useState(/** @type {string | null} */ (null));
	/** @param {any} op */
	const run = async (op) => {
		const after = op.lastRun?.stats?.resumeAfter;
		setRunning(op.name);
		setError(null);
		const result = await adminFetch(adminApi.operation(op.name), {
			method: 'POST',
			body: typeof after === 'string' ? { after } : {},
		});
		setRunning(null);
		if (!result.ok) {
			setError(describeProblem(result.problem));
			return;
		}
		const at = new Date().toISOString();
		setRows((current) =>
			current.map((row) =>
				row.name === op.name
					? {
							...row,
							status: result.data.status,
							lastRun: { status: result.data.status, finishedAt: at, durationMs: null, stats: result.data.stats ?? null },
						}
					: row,
			),
		);
		toast.show({ title: `${humanize(op.name)}: ${humanize(result.data.status)}` });
	};
	return (
		<Card title="Operations" subtitle="Run on demand; nothing runs on a schedule. Long runs continue where they stopped.">
			{health.problem ? (
				<p className="text-sm text-danger">{describeProblem(health.problem)}</p>
			) : (
				<>
					{error ? <p className="mb-2 text-sm text-danger">{error}</p> : null}
					<Table
						caption="Operations"
						dense
						rows={rows}
						rowKey={(c) => c.name}
						empty="No operation is registered."
						columns={[
							{
								key: 'name',
								header: 'Operation',
								rowHeader: true,
								render: (c) => <span className="font-mono text-xs">{c.name}</span>,
							},
							{
								key: 'status',
								header: 'Last run',
								render: (c) =>
									c.lastRun ? (
										<span className="space-y-0.5">
											<StatusBadge status={c.lastRun.status} />
											{c.lastRun.error?.message ? (
												<span className="block max-w-xs truncate text-xs text-danger" title={c.lastRun.error.message}>
													{c.lastRun.error.message}
												</span>
											) : null}
										</span>
									) : (
										<span className="text-muted">Never</span>
									),
							},
							{ key: 'at', header: 'Finished', render: (c) => formatDateTime(c.lastRun?.finishedAt) },
							{
								key: 'run',
								header: '',
								align: 'right',
								render: (c) =>
									canRun ? (
										<Button size="sm" variant="secondary" loading={running === c.name} onClick={() => void run(c)}>
											{typeof c.lastRun?.stats?.resumeAfter === 'string' ? 'Continue' : 'Run'}
										</Button>
									) : null,
							},
						]}
					/>
				</>
			)}
		</Card>
	);
}
