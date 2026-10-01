'use client';
/**
 * Event delivery log of a website (signed deliveries to products) with status filter, cursor pagination and
 * replay of failed or dead deliveries.
 * @module
 */
import { useState } from 'react';
import { Badge, Button, Callout, Select, StatusBadge, Table, describeProblem, formatDateTime, useToast } from '@ss/ui';
import { apiFetch } from '../client.js';
import { api } from '../paths.js';
import { PageProblem, WebsiteHeader, productName } from './common.js';

/** @typedef {import('@ss/ui').Problem} Problem */

export const DELIVERY_STATUSES = Object.freeze(['pending', 'retrying', 'delivered', 'dead']);
/** Only dead deliveries replay (their payload is kept sealed for 7 days). */
const REPLAYABLE = new Set(['dead']);

/**
 * @param {any} props loader result of `loadDeliveries`
 */
export function DeliveriesView(props) {
	const toast = useToast();
	const ok = props.ok === true;
	const [items, setItems] = useState(/** @type {any[]} */ (ok ? props.deliveries.items : []));
	const [cursor, setCursor] = useState(/** @type {string | null} */ (ok ? props.deliveries.nextCursor : null));
	const [status, setStatus] = useState(/** @type {string} */ (ok ? (props.status ?? '') : ''));
	const [loading, setLoading] = useState(false);
	const [replaying, setReplaying] = useState(/** @type {string | null} */ (null));
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	if (!ok) return <PageProblem problem={props.problem} />;
	const { merchantId, website, catalog } = props;

	/** @param {string} nextStatus @param {string | null} [after] */
	const load = async (nextStatus, after = null) => {
		setLoading(true);
		setProblem(null);
		const result = await apiFetch(api.deliveries(merchantId, website.websiteId, { status: nextStatus || null, cursor: after }));
		setLoading(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		setItems((list) => (after ? [...list, ...(result.data.items ?? [])] : (result.data.items ?? [])));
		setCursor(result.data.nextCursor ?? null);
	};
	/** @param {any} d */
	const replay = async (d) => {
		setReplaying(d.deliveryId);
		setProblem(null);
		const result = await apiFetch(api.replay(merchantId, website.websiteId, d.deliveryId), { method: 'POST', body: {} });
		setReplaying(null);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		toast.show({ title: 'Delivery queued again', description: `${d.type} → ${productName(catalog, d.appId)}` });
		await load(status);
	};

	return (
		<div className="space-y-6">
			<WebsiteHeader website={website} active="deliveries" />
			<div className="flex flex-wrap items-end justify-between gap-3">
				<p className="max-w-2xl text-sm text-muted">
					Events from your site and control events are delivered to subscribed products with signatures and retries. Payloads
					are not kept by the Portal; failed deliveries keep theirs sealed for 7 days so they can be replayed.
				</p>
				<Select
					label="Status"
					fieldClassName="w-48"
					value={status}
					onChange={(e) => {
						const next = e.currentTarget.value;
						setStatus(next);
						void load(next);
					}}
					options={[
						{ value: '', label: 'All' },
						...DELIVERY_STATUSES.map((s) => ({ value: s, label: s.charAt(0).toUpperCase() + s.slice(1) })),
					]}
				/>
			</div>
			{problem ? <Callout tone="danger">{describeProblem(problem)}</Callout> : null}
			<Table
				caption="Event deliveries"
				rows={items}
				rowKey={(d) => d.deliveryId}
				empty={status ? `No ${status} deliveries.` : 'No deliveries yet. They appear when events reach subscribed products.'}
				hasMore={Boolean(cursor)}
				loadingMore={loading}
				onLoadMore={() => void load(status, cursor)}
				columns={[
					{
						key: 'type',
						header: 'Event',
						rowHeader: true,
						render: (d) => (
							<span className="space-y-0.5">
								<span className="block font-mono text-xs">{d.type}</span>
								{d.kind === 'control' ? <Badge>Control</Badge> : null}
							</span>
						),
					},
					{ key: 'appId', header: 'Product', render: (d) => productName(catalog, d.appId) },
					{ key: 'status', header: 'Status', render: (d) => <StatusBadge status={d.status} /> },
					{
						key: 'attempts',
						header: 'Attempts',
						align: 'right',
						sortable: true,
						render: (d) => (
							<span className="tabular-nums">
								{d.attempts}
								{d.replays > 0 ? ` (+${d.replays} replay${d.replays === 1 ? '' : 's'})` : ''}
							</span>
						),
					},
					{
						key: 'lastErrorCode',
						header: 'Last error',
						render: (d) =>
							d.lastErrorCode || d.lastHttpStatus ? (
								<span className="font-mono text-xs text-danger">
									{d.lastErrorCode ?? ''}
									{d.lastHttpStatus ? ` HTTP ${d.lastHttpStatus}` : ''}
								</span>
							) : (
								'—'
							),
					},
					{ key: 'createdAt', header: 'Created', sortable: true, render: (d) => formatDateTime(d.createdAt) },
					{
						key: 'actions',
						header: <span className="sr-only">Actions</span>,
						align: 'right',
						render: (d) =>
							REPLAYABLE.has(d.status) ? (
								<Button size="sm" variant="secondary" onClick={() => void replay(d)} loading={replaying === d.deliveryId}>
									Replay
								</Button>
							) : null,
					},
				]}
			/>
		</div>
	);
}
