'use client';
/**
 * Operations pages: connector status across merchants (status and check reports only — the staff API never
 * returns credentials or masked previews) and the audit log search.
 * @module
 */
import { Badge, Button, Input, PageHeader, Select, StatusBadge, Table, formatDateTime, formatNumber, humanize } from '@ss/ui';
import { Link } from '../../link.js';
import { usePagedList } from '../client.js';
import { adminApi, adminRoutes } from '../paths.js';
import { CONNECTOR_KINDS, CONNECTOR_STATUSES } from '../loaders.js';
import { ActionProblem, ActorLabel, AdminProblem, IdChip } from './common.js';

/**
 * Short summary of a connector check report (`checks[]` of `{ name, ok, code? }`): passed count and failing steps.
 * @param {any} report
 */
export const checkSummary = (report) => {
	const steps = /** @type {any[]} */ (report?.checks ?? []);
	if (steps.length === 0) return null;
	const failing = steps.filter((s) => s.ok !== true).map((s) => (s.code ? `${s.name} (${s.code})` : s.name));
	return {
		passed: steps.length - failing.length,
		total: steps.length,
		failing,
		warnings: /** @type {string[]} */ (report.warnings ?? []),
	};
};

/**
 * @param {any} props loader result of `loadConnectors`
 */
export function ConnectorsAdminView(props) {
	const ok = props.ok === true;
	const f = ok ? props.filter : {};
	const list = usePagedList((cursor) => (ok ? adminApi.connectors({ ...f, cursor }) : null), ok ? props.page : null);
	if (!ok) return <AdminProblem problem={props.problem} />;
	return (
		<div className="space-y-6">
			<PageHeader
				title="Connectors"
				subtitle="Client-owned resources (databases, storage, AI, messaging …). Status only: credentials are never shown to staff."
			/>
			<form method="get" action="/admin/connectors" className="flex flex-wrap items-end gap-3" aria-label="Filter connectors">
				<Input
					label="Merchant id"
					name="merchantId"
					defaultValue={f.merchantId ?? ''}
					placeholder="mer_…"
					className="font-mono"
					fieldClassName="w-64"
				/>
				<Select
					label="Kind"
					name="kind"
					defaultValue={f.kind ?? ''}
					fieldClassName="w-40"
					options={[{ value: '', label: 'Any' }, ...CONNECTOR_KINDS.map((k) => ({ value: k, label: humanize(k) }))]}
				/>
				<Select
					label="Status"
					name="status"
					defaultValue={f.status ?? ''}
					fieldClassName="w-40"
					options={[{ value: '', label: 'Any' }, ...CONNECTOR_STATUSES.map((s) => ({ value: s, label: humanize(s) }))]}
				/>
				<Button type="submit" variant="secondary">
					Apply
				</Button>
			</form>
			<Table
				caption="Connectors"
				rows={list.items}
				rowKey={(c) => c.connectorId}
				empty="No connectors match."
				hasMore={Boolean(list.cursor)}
				loadingMore={list.loading}
				onLoadMore={() => void list.more()}
				columns={[
					{
						key: 'label',
						header: 'Connector',
						rowHeader: true,
						render: (c) => (
							<span className="space-y-0.5">
								<span className="block font-semibold">{c.label ?? `${humanize(c.kind)} · ${c.provider}`}</span>
								<IdChip id={c.connectorId} label="connector id" />
							</span>
						),
					},
					{
						key: 'merchantId',
						header: 'Merchant',
						render: (c) => (
							<Link href={adminRoutes.merchant(c.merchantId)} className="font-mono text-xs text-primary hover:underline">
								{c.merchantId}
							</Link>
						),
					},
					{
						key: 'kind',
						header: 'Kind',
						render: (c) => (
							<span className="space-x-1">
								<Badge>{c.kind}</Badge>
								<span className="text-xs text-muted">{c.provider}</span>
							</span>
						),
					},
					{ key: 'websites', header: 'Websites', align: 'right', render: (c) => formatNumber((c.websiteIds ?? []).length) },
					{ key: 'status', header: 'Status', render: (c) => <StatusBadge status={c.status} /> },
					{
						key: 'check',
						header: 'Last check',
						render: (c) => {
							const s = checkSummary(c.lastCheckReport);
							return (
								<span className="block text-xs">
									<span className="block">{formatDateTime(c.lastCheckAt)}</span>
									{s ? (
										<span className={s.failing.length > 0 ? 'text-danger' : 'text-muted'}>
											{s.passed}/{s.total} checks passed{s.failing.length > 0 ? ` · ${s.failing.join(', ')}` : ''}
										</span>
									) : null}
								</span>
							);
						},
					},
				]}
			/>
			<ActionProblem problem={list.problem} />
		</div>
	);
}

/**
 * @param {any} props loader result of `loadAudit`
 */
export function AuditView(props) {
	const ok = props.ok === true;
	const f = ok ? props.filter : {};
	const list = usePagedList((cursor) => (ok ? adminApi.audit({ ...f, cursor }) : null), ok ? props.page : null);
	if (!ok) return <AdminProblem problem={props.problem} />;
	return (
		<div className="space-y-6">
			<PageHeader title="Audit log" subtitle="Append-only record of every staff and merchant action." />
			<form method="get" action="/admin/audit" className="flex flex-wrap items-end gap-3" aria-label="Filter the audit log">
				<Input label="Actor id" name="actorId" defaultValue={f.actorId ?? ''} className="font-mono" fieldClassName="w-48" />
				<Input
					label="Target id"
					name="targetId"
					defaultValue={f.targetId ?? ''}
					className="font-mono"
					fieldClassName="w-48"
				/>
				<Input
					label="Action"
					name="action"
					defaultValue={f.action ?? ''}
					placeholder="credits.added · credits.*"
					className="font-mono"
					fieldClassName="w-48"
				/>
				<Button type="submit" variant="secondary">
					Search
				</Button>
			</form>
			<Table
				caption="Audit entries"
				rows={list.items}
				rowKey={(a) => a.auditId}
				empty="No entries match."
				hasMore={Boolean(list.cursor)}
				loadingMore={list.loading}
				onLoadMore={() => void list.more()}
				columns={[
					{ key: 'at', header: 'When', rowHeader: true, render: (a) => formatDateTime(a.at) },
					{ key: 'action', header: 'Action', render: (a) => <span className="font-mono text-xs">{a.action}</span> },
					{ key: 'actor', header: 'Actor', render: (a) => <ActorLabel actor={a.actor} /> },
					{
						key: 'target',
						header: 'Target',
						render: (a) => (
							<span className="text-xs">
								{a.target?.type} <span className="font-mono">{a.target?.id}</span>
							</span>
						),
					},
					{ key: 'reason', header: 'Reason', render: (a) => a.reason ?? '—' },
				]}
			/>
			<ActionProblem problem={list.problem} />
		</div>
	);
}
