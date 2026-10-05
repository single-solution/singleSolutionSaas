'use client';
/**
 * Platform health at a glance: event deliveries and dead letters, unhealthy service apps (stale or failing
 * heartbeats), reconciliation runs and finance alerts, cron runs, the job queue and the last audit hash-chain
 * verification (`GET /v1/admin/system/health`).
 * @module
 */
import {
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
} from '@ss/ui';
import { Link } from '../../link.js';
import { adminRoutes } from '../paths.js';
import { AdminProblem, IdChip } from './common.js';

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
					hint={unhealthy.length > 0 ? 'Stale or failing heartbeat' : 'Every service app reports in'}
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
				<Card title="Cron jobs" subtitle="Last run of every scheduled job.">
					{health.problem ? (
						<p className="text-sm text-danger">{describeProblem(health.problem)}</p>
					) : (
						<Table
							caption="Cron jobs"
							dense
							rows={/** @type {any[]} */ (h?.crons ?? [])}
							rowKey={(c) => c.name}
							empty="No cron has run yet."
							columns={[
								{
									key: 'name',
									header: 'Cron',
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
													<span
														className="block max-w-xs truncate text-xs text-danger"
														title={c.lastRun.error.message}>
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
									key: 'ms',
									header: 'Duration',
									align: 'right',
									render: (c) => (c.lastRun ? `${formatNumber(c.lastRun.durationMs)} ms` : '—'),
								},
							]}
						/>
					)}
				</Card>
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
					subtitle="Heartbeat older than the stale window or a status other than ok."
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
								{ key: 'last', header: 'Last heartbeat', render: (a) => formatDateTime(a.health.lastHeartbeatAt) },
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
				subtitle="Nightly comparison of usage, settlement and the ledger."
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
