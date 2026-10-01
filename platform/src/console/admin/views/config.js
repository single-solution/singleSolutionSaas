'use client';
/**
 * Staff configuration: per-subscription admin overrides and locks (may exceed plan maxima; the highest lock
 * authority), the effective entitlement values with their source, admin and website layer history with rollback;
 * and platform policies per app (applied to every subscription of the app).
 * @module
 */
import { useState } from 'react';
import {
	Badge,
	Button,
	ButtonLink,
	Callout,
	Card,
	EmptyState,
	Icon,
	Input,
	KeyValueList,
	PageHeader,
	StatusBadge,
	Table,
	formatDate,
	formatDateTime,
	humanize,
	useToast,
} from '@ss/ui';
import { Link } from '../../link.js';
import { adminFetch, useAdminResource } from '../client.js';
import { adminApi, adminRoutes } from '../paths.js';
import { AdminProblem, Crumbs, IdChip, staffCan } from './common.js';
import { LayerEditor, LayerHistory } from './layer.js';

/** @typedef {import('@ss/ui').Problem} Problem */

/**
 * @param {any} props loader result of `loadSubscriptionLookup`
 */
export function SubscriptionLookupView(props) {
	if (!props.ok) return <AdminProblem problem={props.problem} />;
	return (
		<div className="space-y-6">
			<PageHeader
				title="Subscriptions"
				subtitle="Open a subscription by id to set admin overrides and locks. Merchant pages list their subscriptions."
			/>
			<form method="get" action="/admin/subscriptions" role="search" className="flex flex-wrap items-end gap-3">
				<Input
					label="Subscription id"
					name="id"
					defaultValue={props.id ?? ''}
					placeholder="sub_…"
					className="font-mono"
					fieldClassName="min-w-0 flex-1 sm:max-w-md"
					error={props.invalid ? 'Enter a subscription id (sub_…).' : undefined}
					autoComplete="off"
				/>
				<Button type="submit" icon={<Icon name="eye" size={14} />}>
					Open
				</Button>
			</form>
			{props.id && !props.found ? <EmptyState icon="sliders" title={`No subscription ${props.id}`} /> : null}
			{props.found ? (
				<Card
					title={<span className="font-mono">{props.found.subscriptionId}</span>}
					actions={
						<ButtonLink as={Link} href={adminRoutes.subscription(props.found.subscriptionId)} variant="primary" size="sm">
							Open
						</ButtonLink>
					}>
					<KeyValueList
						columns={3}
						items={[
							{
								label: 'Merchant',
								value: (
									<Link
										href={adminRoutes.merchant(props.found.merchantId)}
										className="font-mono text-xs text-primary hover:underline">
										{props.found.merchantId}
									</Link>
								),
							},
							{ label: 'Website', value: <IdChip id={props.found.websiteId} label="website id" /> },
							{
								label: 'App',
								value: (
									<Link
										href={adminRoutes.app(props.found.appId)}
										className="font-mono text-xs text-primary hover:underline">
										{props.found.appId}
									</Link>
								),
							},
						]}
					/>
				</Card>
			) : null}
		</div>
	);
}

/**
 * Effective feature values of the subscription's document, with where each value came from.
 * @param {any} effective
 */
export const effectiveRows = (effective) =>
	Object.entries(/** @type {Record<string, any>} */ (effective?.features ?? {}))
		.map(([key, f]) => ({ key, ...f }))
		.sort((a, b) => a.key.localeCompare(b.key));

/**
 * @param {any} props loader result of `loadSubscription` plus `staff`
 */
export function SubscriptionAdminView(props) {
	const toast = useToast();
	const ok = props.ok === true;
	const subscriptionId = ok ? props.subscription.subscriptionId : null;
	const overview = useAdminResource(subscriptionId ? adminApi.adminConfig(subscriptionId) : null, ok ? props.overview : null);
	const adminHistory = useAdminResource(
		subscriptionId ? adminApi.adminHistory(subscriptionId, { level: 'admin' }) : null,
		ok ? props.adminHistory : null,
	);
	const websiteHistory = useAdminResource(
		subscriptionId ? adminApi.adminHistory(subscriptionId, { level: 'website' }) : null,
		ok ? props.websiteHistory : null,
	);
	const [effective, setEffective] = useState(ok ? props.effective : null);
	const [version, setVersion] = useState(0);
	if (!ok)
		return (
			<AdminProblem problem={props.problem} back={{ href: adminRoutes.subscriptions(), label: 'Back to subscriptions' }} />
		);
	const { subscription: sub, app, manifest, staff } = props;
	const canWrite = staffCan(staff, 'platform.config.write');
	const layers = overview.data?.layers ?? { admin: { elements: {}, features: {} } };
	const refresh = async () => {
		await Promise.all([overview.reload(), adminHistory.reload(), websiteHistory.reload()]);
		const preview = await adminFetch(adminApi.preview(sub.merchantId, sub.websiteId, sub.subscriptionId), {
			method: 'POST',
			body: { change: {} },
		});
		if (preview.ok) setEffective(preview.data?.preview ?? null);
		setVersion((v) => v + 1);
	};
	/** @param {Record<string, unknown>} change @param {string} reason */
	const save = async (change, reason) => {
		const result = await adminFetch(adminApi.adminConfig(sub.subscriptionId), {
			method: 'PATCH',
			body: { ...change, ...(reason ? { reason } : {}) },
		});
		if (!result.ok) return { ok: false, problem: result.problem };
		toast.show({ title: 'Admin override saved', description: `Version ${result.data?.version ?? ''}; documents re-signed.` });
		await refresh();
		return { ok: true };
	};
	/** @param {'admin' | 'website'} level */
	const rollback = (level) => async (/** @type {number} */ target, /** @type {string} */ reason) => {
		const result = await adminFetch(adminApi.adminRollback(sub.subscriptionId), {
			method: 'POST',
			body: { level, version: target, ...(reason ? { reason } : {}) },
		});
		if (!result.ok) return { ok: false, problem: result.problem };
		toast.show({ title: `Rolled back to v${target}` });
		await refresh();
		return { ok: true };
	};
	const rows = effectiveRows(effective);
	return (
		<div className="space-y-6">
			<PageHeader
				breadcrumbs={
					<Crumbs
						items={[
							{ label: 'Merchants', href: adminRoutes.merchants() },
							{ label: sub.merchantId, href: adminRoutes.merchant(sub.merchantId) },
							{ label: sub.productSlug },
						]}
					/>
				}
				title={app?.name ?? sub.productSlug}
				badge={<StatusBadge status={sub.status} />}
				subtitle={<IdChip id={sub.subscriptionId} label="subscription id" />}
				actions={
					<ButtonLink as={Link} href={adminRoutes.policies(sub.appId)} icon={<Icon name="sliders" size={14} />}>
						Platform policy
					</ButtonLink>
				}
			/>
			<Card title="Subscription">
				<KeyValueList
					columns={3}
					items={[
						{
							label: 'Merchant',
							value: (
								<Link
									href={adminRoutes.merchant(sub.merchantId)}
									className="font-mono text-xs text-primary hover:underline">
									{sub.merchantId}
								</Link>
							),
						},
						{ label: 'Website', value: <IdChip id={sub.websiteId} label="website id" /> },
						{ label: 'Plan', value: sub.planCode ?? 'No plan' },
						{ label: 'Manifest', value: `v${sub.manifestVersion} (${sub.productVersion})` },
						{ label: 'Since', value: formatDate(sub.startedAt) },
						{ label: 'Settled through', value: formatDateTime(sub.settledThrough) },
						{
							label: 'Holds',
							value:
								Object.entries(sub.holds ?? {}).filter(([, v]) => v).length > 0
									? Object.entries(sub.holds ?? {})
											.filter(([, v]) => v)
											.map(([k]) => humanize(k))
											.join(', ')
									: 'None',
						},
					]}
				/>
			</Card>
			{manifest ? (
				<LayerEditor
					key={`admin-${version}`}
					title="Admin overrides and locks"
					subtitle="Highest authority: admin values may exceed plan maxima and lock out every lower level."
					manifest={manifest}
					layer={layers.admin}
					effective={effective}
					canWrite={canWrite}
					onSave={save}
				/>
			) : (
				<Callout tone="warning">The manifest version of this subscription could not be loaded.</Callout>
			)}
			<Card title="Effective configuration" subtitle="The entitlement document this subscription currently gets.">
				<Table
					caption="Effective configuration"
					dense
					rows={rows}
					rowKey={(r) => r.key}
					empty="No configurable features."
					columns={[
						{
							key: 'key',
							header: 'Feature',
							rowHeader: true,
							render: (r) => <span className="font-mono text-xs">{r.key}</span>,
						},
						{
							key: 'value',
							header: 'Value',
							render: (r) => <span className="break-all font-mono text-xs">{JSON.stringify(r.value ?? null)}</span>,
						},
						{ key: 'source', header: 'Source', render: (r) => humanize(r.source) },
						{
							key: 'flags',
							header: 'Flags',
							render: (r) => (
								<span className="flex flex-wrap gap-1">
									{r.locked ? <Badge tone="warning">Locked</Badge> : null}
									{r.reason ? <Badge tone="info">{humanize(r.reason)}</Badge> : null}
								</span>
							),
						},
					]}
				/>
			</Card>
			<div className="grid gap-6 xl:grid-cols-2">
				<LayerHistory
					title="Admin layer history"
					history={adminHistory.data}
					canWrite={canWrite}
					onRollback={rollback('admin')}
				/>
				<LayerHistory
					title="Website layer history"
					history={websiteHistory.data}
					canWrite={canWrite}
					onRollback={rollback('website')}
				/>
			</div>
		</div>
	);
}

/**
 * @param {any} props loader result of `loadPolicies` plus `staff`
 */
export function PoliciesView(props) {
	const toast = useToast();
	const ok = props.ok === true;
	const appId = ok ? props.app.appId : null;
	const layer = useAdminResource(appId ? adminApi.platformPolicy(appId) : null, ok ? props.layer : null);
	const history = useAdminResource(appId ? adminApi.platformHistory(appId) : null, ok ? props.history : null);
	const [version, setVersion] = useState(0);
	if (!ok) return <AdminProblem problem={props.problem} back={{ href: adminRoutes.apps(), label: 'Back to apps' }} />;
	const { app, manifest, staff } = props;
	const canWrite = staffCan(staff, 'platform.config.write');
	const refresh = async () => {
		await Promise.all([layer.reload(), history.reload()]);
		setVersion((v) => v + 1);
	};
	/** @param {Record<string, unknown>} change @param {string} reason */
	const save = async (change, reason) => {
		const result = await adminFetch(adminApi.platformPolicy(app.appId), {
			method: 'PATCH',
			body: { ...change, ...(reason ? { reason } : {}) },
		});
		if (!result.ok) return { ok: false, problem: result.problem };
		toast.show({ title: 'Platform policy saved', description: 'Every subscription of this app is re-resolved.' });
		await refresh();
		return { ok: true };
	};
	const rollback = async (/** @type {number} */ target, /** @type {string} */ reason) => {
		const result = await adminFetch(adminApi.platformRollback(app.appId), {
			method: 'POST',
			body: { version: target, ...(reason ? { reason } : {}) },
		});
		if (!result.ok) return { ok: false, problem: result.problem };
		toast.show({ title: `Rolled back to v${target}` });
		await refresh();
		return { ok: true };
	};
	return (
		<div className="space-y-6">
			<PageHeader
				breadcrumbs={
					<Crumbs
						items={[
							{ label: 'Apps', href: adminRoutes.apps() },
							{ label: app.name ?? app.slug, href: adminRoutes.app(app.appId) },
							{ label: 'Platform policy' },
						]}
					/>
				}
				title={`Platform policy · ${app.name ?? app.slug}`}
				subtitle={`Applies to every subscription of this app (version v${layer.data?.version ?? 0}). Lock authority 4: only admin overrides win over it.`}
			/>
			{manifest ? (
				<LayerEditor
					key={`platform-${version}`}
					title="Policy values and locks"
					manifest={manifest}
					layer={layer.data?.state ?? { elements: {}, features: {} }}
					canWrite={canWrite}
					onSave={save}
				/>
			) : (
				<EmptyState
					icon="sliders"
					title="No accepted manifest"
					description="Approve a manifest version before setting policies."
				/>
			)}
			<LayerHistory title="Policy history" history={history.data} canWrite={canWrite} onRollback={rollback} />
		</div>
	);
}
