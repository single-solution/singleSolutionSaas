'use client';
/**
 * Subscription detail: elements as switches with their prices, configuration (SchemaForm, history, rollback,
 * preview diff), plan change, pause/resume/cancel and "Open in product".
 * @module
 */
import { useState } from 'react';
import {
	Badge,
	Breadcrumbs,
	Button,
	Callout,
	Card,
	ConfirmDialog,
	EmptyState,
	FormError,
	Icon,
	KeyValueList,
	PageHeader,
	StatusBadge,
	Switch,
	Tabs,
	describeProblem,
	formatCreditsPerHour,
	formatDate,
	formatDateTime,
	formatUnitPrice,
	humanize,
	useToast,
} from '@ss/ui';
import { MERCHANT } from '../../texts/console.js';
import { apiFetch } from '../client.js';
import { Link } from '../link.js';
import { api, routes } from '../paths.js';
import { PageProblem } from './common.js';
import { ConfigurePanel, diffLine } from './configure.js';
import { TextsPanel } from './texts.js';
import { PlanComparison } from './products.js';

/** @typedef {import('@ss/ui').Problem} Problem */

/** Why an element the merchant switched on is not running. */
const OFF_REASONS = /** @type {Record<string, string>} */ ({
	resource_missing: 'Waiting for a connected resource',
	dependency: 'Needs another element switched on',
	paused: 'Subscription paused',
	suspended: 'Suspended',
	cancelled: 'Cancelled',
	not_in_plan: 'Not in your plan',
	merchant_disabled: 'Switched off',
	website_disabled: 'Switched off',
	admin_disabled: 'Switched off by an admin',
	locked: 'Locked by an admin',
});

/**
 * Requested (switch) state of an element: website switch › admin switch › plan default.
 * @param {any} sub
 * @param {any} product
 * @param {string} key
 */
export const requestedOn = (sub, product, key) => {
	const website = sub.switches?.website ?? {};
	if (Object.hasOwn(website, key)) return website[key] === true;
	const admin = sub.switches?.admin ?? {};
	if (Object.hasOwn(admin, key)) return admin[key] === true;
	const plan = product?.plans?.find((/** @type {any} */ p) => p.code === sub.planCode);
	return plan ? plan.elements.includes(key) : true;
};

/**
 * Availability of an element under the subscription's plan.
 * @param {any} sub
 * @param {any} product
 * @param {string} key
 */
export const availability = (sub, product, key) => {
	const plan = product?.plans?.find((/** @type {any} */ p) => p.code === sub.planCode);
	if (!plan) return 'available';
	if (plan.elements.includes(key)) return 'included';
	if (plan.addons.includes(key)) return 'addon';
	return 'unavailable';
};

/**
 * @param {any} props loader result of `loadSubscription`
 */
export function SubscriptionView(props) {
	const toast = useToast();
	const [sub] = useState(props.ok ? props.subscription : null);
	const [overview, setOverview] = useState(props.ok ? props.overview : null);
	const [effective, setEffective] = useState(props.ok ? props.effective : null);
	const [history, setHistory] = useState(props.ok ? props.history : { items: [], nextCursor: null });
	const [tab, setTab] = useState('elements');
	const [pending, setPending] = useState(/** @type {string | null} */ (null));
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [confirm, setConfirm] = useState(/** @type {null | { rollback: number }} */ (null));
	const [loadingMore, setLoadingMore] = useState(false);
	if (!props.ok || !sub) return <PageProblem problem={props.problem} />;
	const { merchantId, website, product } = props;
	const configPath = api.config(merchantId, website.websiteId, sub.subscriptionId);
	const live = sub.status !== 'cancelled';
	const name = product?.name ?? sub.productSlug;

	const refreshConfig = async () => {
		const [o, p, h] = await Promise.all([
			apiFetch(configPath),
			apiFetch(`${configPath}/preview`, { method: 'POST', body: { change: {} } }),
			apiFetch(`${configPath}/history`),
		]);
		if (o.ok) setOverview(o.data);
		if (p.ok) setEffective(p.data.preview ?? null);
		if (h.ok) setHistory(h.data);
	};

	const launch = async () => {
		setPending('launch');
		setProblem(null);
		const result = await apiFetch(api.launch(merchantId, sub.appId), {
			method: 'POST',
			body: { websiteId: website.websiteId },
		});
		setPending(null);
		if (result.ok && typeof result.data?.url === 'string') window.location.assign(result.data.url);
		else
			setProblem(
				result.ok ? { detail: 'The product did not return a launch link.', code: 'launch_link_missing' } : result.problem,
			);
	};
	/** @param {number} version */
	const rollback = async (version) => {
		setPending('rollback');
		setProblem(null);
		const result = await apiFetch(`${configPath}/rollback`, { method: 'POST', body: { version } });
		setPending(null);
		setConfirm(null);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		toast.show({ title: version === 0 ? 'Settings restored to defaults' : `Rolled back to version ${version}` });
		await refreshConfig();
	};
	const moreHistory = async () => {
		if (!history.nextCursor) return;
		setLoadingMore(true);
		const r = await apiFetch(`${configPath}/history?cursor=${encodeURIComponent(history.nextCursor)}`);
		setLoadingMore(false);
		if (r.ok) setHistory({ ...r.data, items: [...history.items, ...(r.data.items ?? [])] });
		else setProblem(r.problem);
	};

	const elements = /** @type {any[]} */ (product?.elements ?? []);
	const plans = /** @type {any[]} */ (product?.plans ?? []);
	const adminLocks = overview?.layers?.admin?.elements ?? {};
	const canLaunch = product?.kind === 'service';

	const elementsPanel = (
		<Card title="Elements" subtitle={MERCHANT.featuresByAdmin} padded={false}>
			{elements.length === 0 ? (
				<div className="p-5">
					<EmptyState compact title="This product lists no elements" />
				</div>
			) : (
				<ul className="divide-y divide-line">
					{elements.map((el) => {
						const on = requestedOn(sub, product, el.key);
						const avail = availability(sub, product, el.key);
						const eff = effective?.elements?.[el.key];
						const locked = adminLocks[el.key]?.locked === true;
						const offReason = on && eff && eff.enabled === false ? (OFF_REASONS[eff.reason] ?? humanize(eff.reason)) : null;
						return (
							<li key={el.key} className="px-5 py-4">
								<Switch
									checked={on}
									disabled
									locked={locked}
									lockedLabel="Set by admin"
									label={el.name}
									description={
										<span className="flex flex-wrap items-center gap-x-2 gap-y-1">
											<span className="tabular-nums">{formatCreditsPerHour(el.price.hourlyMillicredits)}</span>
											{el.price.metered.map((/** @type {any} */ m) => (
												<span key={m.unit} className="tabular-nums">
													+ {formatUnitPrice(m.perUnitMillicredits, m.per, m.unit)}
												</span>
											))}
											{avail === 'included' ? <Badge tone="success">In plan</Badge> : null}
											{avail === 'addon' ? <Badge tone="info">Add-on</Badge> : null}
											{avail === 'unavailable' ? <Badge tone="warning">Not in plan</Badge> : null}
											{el.dependsOn.length > 0 ? <span>Needs {el.dependsOn.join(', ')}</span> : null}
											{el.requires.length > 0 ? <span>Uses your {el.requires.join(', ')}</span> : null}
											{(el.optionalResources ?? []).length > 0 ? (
												<span>Can use your {el.optionalResources.join(', ')}</span>
											) : null}
											{locked ? <span>Set by admin</span> : null}
										</span>
									}
									aside={
										eff ? (
											<StatusBadge
												status={eff.enabled ? 'running' : on ? 'paused' : 'disabled'}
												label={eff.enabled ? 'Running' : on ? 'Not running' : 'Off'}
											/>
										) : null
									}
								/>
								{offReason ? <p className="mt-2 text-xs font-medium text-warning">{offReason}</p> : null}
							</li>
						);
					})}
				</ul>
			)}
		</Card>
	);

	const planPanel = (
		<div className="space-y-4">
			<Card
				title="Plan"
				subtitle="Plans are presets of included elements and bounds; changing plan applies from the next hour.">
				{plans.length === 0 ? (
					<p className="text-sm text-muted">This product has no plans: every element is available at its own price.</p>
				) : (
					<div className="space-y-5">
						<PlanComparison product={product} />
					</div>
				)}
			</Card>
		</div>
	);

	const historyPanel = (
		<Card
			title="Configuration history"
			subtitle="Every saved version of this website's settings. Rolling back creates a new version."
			padded={false}
			actions={
				<Button
					size="sm"
					variant="secondary"
					onClick={() => setConfirm({ rollback: 0 })}
					disabled={!live || history.items.length === 0}>
					Restore defaults
				</Button>
			}>
			{history.items.length === 0 ? (
				<div className="p-5">
					<EmptyState
						compact
						icon="clock"
						title="No changes yet"
						description="Saved settings appear here with who changed what."
					/>
				</div>
			) : (
				<>
					<ol className="divide-y divide-line">
						{history.items.map((/** @type {any} */ v, /** @type {number} */ i) => (
							<li key={v.version} className="flex flex-wrap items-start justify-between gap-3 px-5 py-3">
								<div className="min-w-0 space-y-1">
									<p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-fg">
										Version {v.version}
										{i === 0 ? <Badge tone="success">Current</Badge> : null}
										{v.kind && v.kind !== 'change' ? <Badge>{humanize(v.kind)}</Badge> : null}
									</p>
									<p className="text-xs text-muted">
										{formatDateTime(v.at)} ·{' '}
										{v.actor?.type === 'admin' ? 'Your admin' : v.actor?.type === 'system' ? 'System' : 'You'}
										{v.reason ? ` · “${v.reason}”` : ''}
									</p>
									<ul className="space-y-0.5">
										{(v.diff ?? []).map((/** @type {any} */ d, /** @type {number} */ j) => (
											<li key={j} className="break-words font-mono text-xs text-fg">
												{diffLine(d)}
											</li>
										))}
									</ul>
								</div>
								{i === 0 ? null : (
									<Button size="sm" variant="ghost" onClick={() => setConfirm({ rollback: v.version })} disabled={!live}>
										Roll back to this
									</Button>
								)}
							</li>
						))}
					</ol>
					{history.nextCursor ? (
						<div className="flex justify-center p-4">
							<Button variant="secondary" size="sm" onClick={() => void moreHistory()} loading={loadingMore}>
								Load older versions
							</Button>
						</div>
					) : null}
				</>
			)}
		</Card>
	);

	const confirmProps =
		confirm && typeof confirm === 'object'
			? {
					title: confirm.rollback === 0 ? 'Restore defaults?' : `Roll back to version ${confirm.rollback}?`,
					body:
						confirm.rollback === 0
							? 'Every website override is removed; settings follow your plan and organisation defaults.'
							: 'The settings of that version become a new version. Nothing is deleted.',
					label: 'Roll back',
					danger: false,
					run: () => rollback(/** @type {{ rollback: number }} */ (confirm).rollback),
				}
			: null;

	return (
		<div className="space-y-6">
			<PageHeader
				breadcrumbs={
					<Breadcrumbs
						linkAs={Link}
						items={[
							{ label: 'Websites', href: routes.websites() },
							{ label: website.domain, href: routes.website(website.websiteId) },
							{ label: 'Products', href: routes.products(website.websiteId) },
							{ label: name },
						]}
					/>
				}
				title={name}
				badge={<StatusBadge status={sub.status} />}
				subtitle={`${website.domain}${website.env === 'test' ? ' (test)' : ''} · ${sub.planCode ? `plan ${sub.planCode}` : 'no plan'}`}
				actions={
					<>
						{canLaunch ? (
							<Button
								variant="secondary"
								onClick={() => void launch()}
								loading={pending === 'launch'}
								disabled={!live}
								icon={<Icon name="external" size={14} />}>
								Open in product
							</Button>
						) : null}
					</>
				}
			/>
			{problem ? <FormError problem={problem} /> : null}
			{(sub.holds ?? []).length > 0 && sub.status !== 'cancelled' ? (
				<Callout tone="warning" title="Not running">
					{(sub.holds ?? []).map((/** @type {string} */ h) => OFF_REASONS[h] ?? humanize(h)).join(' · ')}.
				</Callout>
			) : null}
			{props.configProblem ? <Callout tone="warning">{describeProblem(props.configProblem)}</Callout> : null}
			<Card>
				<KeyValueList
					columns={3}
					items={[
						{ label: 'Started', value: formatDate(sub.startedAt) },
						{ label: 'Price book', value: `v${sub.priceBookVersion}` },
						{ label: 'Product version', value: sub.productVersion },
						{ label: 'Config version', value: overview ? String(overview.version) : '—' },
					]}
				/>
			</Card>
			<Tabs
				label="Subscription sections"
				value={tab}
				onChange={setTab}
				tabs={[
					{ id: 'elements', label: 'Elements', content: elementsPanel },
					{
						id: 'configure',
						label: 'Configure',
						content: (
							<ConfigurePanel
								merchantId={merchantId}
								website={website}
								subscription={sub}
								product={product}
								overview={overview}
								effective={effective}
								onSaved={refreshConfig}
								readOnly={!live}
							/>
						),
					},
					{
						id: 'texts',
						label: 'Texts',
						content: <TextsPanel merchantId={merchantId} website={website} product={product} readOnly={!live} />,
					},
					{ id: 'plan', label: 'Plan', content: planPanel },
					{ id: 'history', label: 'History', content: historyPanel },
				]}
			/>
			<ConfirmDialog
				open={Boolean(confirmProps)}
				onClose={() => setConfirm(null)}
				onConfirm={() => void confirmProps?.run()}
				title={confirmProps?.title ?? ''}
				confirmLabel={confirmProps?.label ?? 'Confirm'}
				danger={confirmProps?.danger ?? false}
				busy={pending !== null}>
				<p className="text-sm text-muted">{confirmProps?.body}</p>
			</ConfirmDialog>
		</div>
	);
}
