'use client';
/**
 * Integration (Event Hub): delivery metrics, dead letters with replay (their payload is kept sealed for 7 days),
 * and the delivery log of a website or an app across merchants.
 * @module
 */
import { useState } from 'react';
import {
	Badge,
	Button,
	Card,
	EmptyState,
	Input,
	PageHeader,
	Select,
	Stat,
	StatusBadge,
	Table,
	formatDateTime,
	formatNumber,
	humanize,
	useToast,
} from '@ss/ui';
import { Link } from '../../link.js';
import { adminFetch, usePagedList } from '../client.js';
import { adminApi, adminRoutes } from '../paths.js';
import { ActionProblem, AdminProblem, IdChip, staffCan } from './common.js';

/** @typedef {import('@ss/ui').Problem} Problem */

const STATUSES = ['pending', 'retrying', 'delivered', 'dead'];

/**
 * @param {any} props loader result of `loadIntegration` plus `staff`
 */
export function IntegrationView(props) {
	const toast = useToast();
	const ok = props.ok === true;
	const f = ok ? props.filter : {};
	const scope = { websiteId: f.websiteId, appId: f.appId };
	const dead = usePagedList((cursor) => (ok ? adminApi.deadLetters({ ...scope, cursor }) : null), ok ? props.deadLetters : null);
	const log = usePagedList(
		(cursor) => (ok && (f.websiteId || f.appId) ? adminApi.deliveries({ ...scope, status: f.status, cursor }) : null),
		ok ? props.deliveries : null,
	);
	const [replaying, setReplaying] = useState(/** @type {string | null} */ (null));
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	if (!ok) return <AdminProblem problem={props.problem} />;
	const { metrics, apps, staff } = props;
	const canReplay = staffCan(staff, 'platform.jobs.manage');
	const appName = (/** @type {string} */ id) => apps.find((/** @type {any} */ a) => a.appId === id)?.name ?? id;
	const d = metrics?.deliveries ?? {};
	/** @param {any} item */
	const replay = async (item) => {
		setReplaying(item.deliveryId);
		setProblem(null);
		const result = await adminFetch(adminApi.replay(item.deliveryId), { method: 'POST', body: {} });
		setReplaying(null);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		toast.show({ title: 'Delivery queued again', description: `${item.type} → ${appName(item.appId)}` });
		await Promise.all([dead.reload(), log.reload()]);
	};
	const replayButton = (/** @type {any} */ item) =>
		canReplay ? (
			<Button size="sm" variant="secondary" onClick={() => void replay(item)} loading={replaying === item.deliveryId}>
				Replay
			</Button>
		) : null;
	const scoped = f.websiteId || f.appId;
	return (
		<div className="space-y-6">
			<PageHeader
				title="Integration"
				subtitle="Signed event deliveries to products: retries, dead letters and replay. Payloads are never stored."
			/>
			<form method="get" action="/admin/integration" className="flex flex-wrap items-end gap-3" aria-label="Filter deliveries">
				<Input
					label="Website id"
					name="websiteId"
					defaultValue={f.websiteId ?? ''}
					placeholder="web_…"
					className="font-mono"
					fieldClassName="w-64"
				/>
				<Select
					label="App"
					name="appId"
					defaultValue={f.appId ?? ''}
					fieldClassName="w-56"
					options={[
						{ value: '', label: 'Any app' },
						...apps.map((/** @type {any} */ a) => ({ value: a.appId, label: a.name ?? a.slug })),
					]}
				/>
				<Select
					label="Status"
					name="status"
					defaultValue={f.status ?? ''}
					fieldClassName="w-40"
					options={[
						{ value: '', label: 'Any' },
						...STATUSES.map((s) => ({ value: s, label: s.charAt(0).toUpperCase() + s.slice(1) })),
					]}
				/>
				<Button type="submit" variant="secondary">
					Apply
				</Button>
				{scoped ? (
					<Link href={adminRoutes.integration()} className="pb-2 text-sm font-semibold text-primary hover:underline">
						Clear
					</Link>
				) : null}
			</form>
			<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
				{STATUSES.map((s) => (
					<Stat
						key={s}
						label={humanize(s)}
						value={formatNumber(d[s])}
						tone={s === 'dead' && d[s] > 0 ? 'danger' : s === 'retrying' && d[s] > 0 ? 'warning' : 'neutral'}
					/>
				))}
				<Stat
					label="Dead letters"
					value={formatNumber(metrics?.deadLetters)}
					tone={metrics?.deadLetters > 0 ? 'danger' : 'success'}
				/>
			</div>
			<ActionProblem problem={problem} />
			<Card title="Dead letters" subtitle="Deliveries that exhausted their retries. Replay re-sends the sealed payload.">
				<Table
					caption="Dead letters"
					dense
					rows={dead.items}
					rowKey={(l) => l.deliveryId}
					empty="No dead letters."
					hasMore={Boolean(dead.cursor)}
					loadingMore={dead.loading}
					onLoadMore={() => void dead.more()}
					columns={[
						{
							key: 'type',
							header: 'Event',
							rowHeader: true,
							render: (l) => <span className="font-mono text-xs">{l.type}</span>,
						},
						{ key: 'appId', header: 'App', render: (l) => appName(l.appId) },
						{ key: 'websiteId', header: 'Website', render: (l) => <IdChip id={l.websiteId} label="website id" /> },
						{ key: 'attempts', header: 'Attempts', align: 'right', render: (l) => formatNumber(l.attempts) },
						{
							key: 'err',
							header: 'Last error',
							render: (l) => <span className="font-mono text-xs text-danger">{l.lastErrorCode ?? '—'}</span>,
						},
						{ key: 'deadAt', header: 'Dead since', render: (l) => formatDateTime(l.deadAt) },
						{ key: 'expiresAt', header: 'Payload kept until', render: (l) => formatDateTime(l.expiresAt) },
						{ key: 'actions', header: <span className="sr-only">Actions</span>, align: 'right', render: replayButton },
					]}
				/>
				<ActionProblem problem={dead.problem} />
			</Card>
			<Card title="Delivery log" subtitle={scoped ? undefined : 'Choose a website or an app to see its deliveries.'}>
				{!scoped ? (
					<EmptyState
						compact
						icon="send"
						title="Filter by website or app"
						description="The log is indexed per website and per app."
					/>
				) : (
					<>
						<ActionProblem problem={props.deliveriesProblem ?? log.problem} />
						<Table
							caption="Delivery log"
							dense
							rows={log.items}
							rowKey={(x) => x.deliveryId}
							empty={f.status ? `No ${f.status} deliveries.` : 'No deliveries.'}
							hasMore={Boolean(log.cursor)}
							loadingMore={log.loading}
							onLoadMore={() => void log.more()}
							columns={[
								{
									key: 'type',
									header: 'Event',
									rowHeader: true,
									render: (x) => (
										<span className="space-y-0.5">
											<span className="block font-mono text-xs">{x.type}</span>
											{x.kind === 'control' ? <Badge>Control</Badge> : null}
										</span>
									),
								},
								{ key: 'appId', header: 'App', render: (x) => appName(x.appId) },
								{ key: 'websiteId', header: 'Website', render: (x) => <IdChip id={x.websiteId} label="website id" /> },
								{ key: 'status', header: 'Status', render: (x) => <StatusBadge status={x.status} /> },
								{
									key: 'attempts',
									header: 'Attempts',
									align: 'right',
									render: (x) => `${x.attempts}${x.replays > 0 ? ` (+${x.replays} replays)` : ''}`,
								},
								{
									key: 'err',
									header: 'Last error',
									render: (x) =>
										x.lastErrorCode || x.lastHttpStatus ? (
											<span className="font-mono text-xs text-danger">
												{x.lastErrorCode ?? ''}
												{x.lastHttpStatus ? ` HTTP ${x.lastHttpStatus}` : ''}
											</span>
										) : (
											'—'
										),
								},
								{ key: 'createdAt', header: 'Created', render: (x) => formatDateTime(x.createdAt) },
								{
									key: 'actions',
									header: <span className="sr-only">Actions</span>,
									align: 'right',
									render: (x) => (x.status === 'dead' ? replayButton(x) : null),
								},
							]}
						/>
					</>
				)}
			</Card>
		</div>
	);
}
