'use client';
/**
 * Merchants: search (id, domain, name or member e-mail prefix) and status filter; create a merchant (owner gets a
 * one-time set-password link); merchant detail with websites (add, open: subscriptions and install code, remove),
 * subscriptions (subscribe, change plan, cancel), balance and credit operations, team, notes and alerts; suspend /
 * resume with a reason (typed confirmation). Website, subscribe and credit components are the Merchant Console's and
 * the ledger's, called with the staff client.
 * @module
 */
import { useEffect, useState } from 'react';
import {
	Badge,
	Button,
	ButtonLink,
	Callout,
	Card,
	CodeBlock,
	ConfirmDialog,
	Dialog,
	EmptyState,
	Form,
	FormError,
	Icon,
	Input,
	KeyValueList,
	PageHeader,
	RadioGroup,
	Select,
	Stat,
	StatusBadge,
	Table,
	TextArea,
	TypedConfirmDialog,
	describeProblem,
	fieldErrors,
	formatCredits,
	formatCreditsPerHour,
	formatDate,
	formatDateTime,
	formatHours,
	humanize,
	useToast,
} from '@ss/ui';
import { Link } from '../../link.js';
import { api } from '../../paths.js';
import { AddWebsiteForm, InstallCodeCard } from '../../views/websites.js';
import { PlanComparison, SubscribeDialog, hourlyEstimate } from '../../views/products.js';
import { subscriptionCalls } from '../../views/subscription.js';
import { adminFetch, useAdminResource, usePagedList } from '../client.js';
import { adminApi, adminRoutes } from '../paths.js';
import { AdminProblem, Crumbs, IdChip, staffCan } from './common.js';
import { CreditOperationCard } from './finance.js';

/** @typedef {import('@ss/ui').Problem} Problem */

/**
 * @param {any} props loader result of `loadMerchants` plus `staff`
 */
export function MerchantsView(props) {
	const [creating, setCreating] = useState(false);
	const ok = props.ok === true;
	const filter = ok ? props.filter : { status: null, q: null };
	const list = usePagedList(
		(cursor) =>
			ok && (props.mode === 'all' || props.mode === 'search')
				? adminApi.merchants({ status: filter.status, q: props.mode === 'search' ? filter.q : null, cursor, limit: 100 })
				: null,
		ok ? props.page : null,
	);
	if (!ok) return <AdminProblem problem={props.problem} />;
	const rows = list.items;
	return (
		<div className="space-y-6">
			<PageHeader
				title="Merchants"
				subtitle="Find an organisation by id, website domain or name."
				actions={
					staffCan(props.staff, 'platform.merchants.write') ? (
						<Button icon={<Icon name="plus" size={14} />} onClick={() => setCreating(true)}>
							Create merchant
						</Button>
					) : null
				}
			/>
			{creating ? <CreateMerchantDialog onClose={() => setCreating(false)} /> : null}
			<form method="get" action="/admin/merchants" className="flex flex-wrap items-end gap-3" role="search">
				<Input
					label="Search"
					name="q"
					defaultValue={filter.q ?? ''}
					placeholder="mer_… · shop.example.com · name or e-mail prefix"
					fieldClassName="min-w-0 flex-1 sm:max-w-md"
				/>
				<Select
					label="Status"
					name="status"
					defaultValue={filter.status ?? ''}
					fieldClassName="w-40"
					options={[
						{ value: '', label: 'Any' },
						{ value: 'active', label: 'Active' },
						{ value: 'suspended', label: 'Suspended' },
					]}
				/>
				<Button type="submit" icon={<Icon name="eye" size={14} />}>
					Search
				</Button>
			</form>

			{props.mode === 'id' || props.mode === 'domain' ? (
				props.matches.length === 0 ? (
					<EmptyState
						icon="users"
						title="No merchant found"
						description={props.mode === 'domain' ? `No website ${filter.q} is registered.` : `No merchant ${filter.q}.`}
					/>
				) : (
					<MerchantTable rows={props.matches} caption="Matching merchants" />
				)
			) : (
				<MerchantTable
					rows={rows}
					caption="Merchants"
					hasMore={Boolean(list.cursor)}
					loadingMore={list.loading}
					onLoadMore={() => void list.more()}
					empty={props.mode === 'search' ? `No merchant matches “${filter.q}”.` : 'No merchants yet.'}
				/>
			)}
			{list.problem ? <Callout tone="danger">{describeProblem(list.problem)}</Callout> : null}
		</div>
	);
}

/**
 * Create a merchant and its owner (`POST /v1/admin/merchants`); then show the one-time set-password link to copy.
 * @param {{ onClose: () => void }} props
 */
function CreateMerchantDialog({ onClose }) {
	const [name, setName] = useState('');
	const [ownerEmail, setOwnerEmail] = useState('');
	const [ownerName, setOwnerName] = useState('');
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [created, setCreated] = useState(/** @type {any} */ (null));
	const submit = async () => {
		setBusy(true);
		setProblem(null);
		const result = await adminFetch(adminApi.createMerchant(), {
			method: 'POST',
			body: { name: name.trim(), ownerEmail: ownerEmail.trim(), ...(ownerName.trim() ? { ownerName: ownerName.trim() } : {}) },
		});
		setBusy(false);
		if (result.ok) setCreated(result.data);
		else setProblem(result.problem);
	};
	const errors = fieldErrors(problem);
	return (
		<Dialog
			open
			onClose={onClose}
			title={created ? `${created.merchant.name} created` : 'Create merchant'}
			description={created ? undefined : 'The owner gets a link to choose a password.'}
			footer={
				created ? (
					<>
						<Button variant="secondary" onClick={onClose}>
							Done
						</Button>
						<ButtonLink as={Link} href={adminRoutes.merchant(created.merchant.merchantId)} variant="primary">
							Open merchant
						</ButtonLink>
					</>
				) : (
					<>
						<Button variant="secondary" onClick={onClose}>
							Cancel
						</Button>
						<Button onClick={() => void submit()} loading={busy} disabled={!name.trim() || !ownerEmail.trim()}>
							Create merchant
						</Button>
					</>
				)
			}>
			{created ? (
				<div className="space-y-3">
					{created.setupLink ? (
						<>
							<CodeBlock code={created.setupLink} label="Set-password link" secret />
							<p className="text-sm text-muted">
								Send it to {created.owner.email}. It works once and expires {formatDateTime(created.setupLinkExpiresAt)}
								{created.mailed ? '; it was also e-mailed.' : '; mail is not configured, so it was not e-mailed.'}
							</p>
						</>
					) : (
						<Callout tone="info">
							{created.owner.email} already has an account and is now the owner; they sign in with their own password.
						</Callout>
					)}
				</div>
			) : (
				<Form onSubmit={submit} busy={busy} aria-label="Create merchant">
					<Input
						label="Merchant name"
						value={name}
						maxLength={120}
						onChange={(e) => setName(e.currentTarget.value)}
						error={errors.name}
						required
					/>
					<Input
						label="Owner e-mail"
						type="email"
						value={ownerEmail}
						onChange={(e) => setOwnerEmail(e.currentTarget.value)}
						error={errors.ownerEmail}
						required
					/>
					<Input
						label="Owner name (optional)"
						value={ownerName}
						maxLength={120}
						onChange={(e) => setOwnerName(e.currentTarget.value)}
						error={errors.ownerName}
					/>
					<FormError problem={problem} fields={['name', 'ownerEmail', 'ownerName']} />
				</Form>
			)}
		</Dialog>
	);
}

/**
 * @param {{ rows: any[], caption: string, hasMore?: boolean, loadingMore?: boolean, onLoadMore?: () => void, empty?: string }} props
 */
function MerchantTable({ rows, caption, hasMore = false, loadingMore = false, onLoadMore, empty }) {
	return (
		<Table
			caption={caption}
			rows={rows}
			rowKey={(m) => m.merchantId}
			empty={empty ?? 'Nothing to show.'}
			hasMore={hasMore}
			loadingMore={loadingMore}
			{...(onLoadMore ? { onLoadMore } : {})}
			columns={[
				{
					key: 'name',
					header: 'Merchant',
					rowHeader: true,
					sortable: true,
					render: (m) => (
						<span className="space-y-0.5">
							<Link href={adminRoutes.merchant(m.merchantId)} className="block font-semibold text-primary hover:underline">
								{m.name}
							</Link>
							<IdChip id={m.merchantId} label="merchant id" />
						</span>
					),
				},
				{ key: 'status', header: 'Status', render: (m) => <StatusBadge status={m.status} /> },
				{
					key: 'suspension',
					header: 'Suspension',
					render: (m) => (m.suspension ? <span className="text-sm">{m.suspension.reason}</span> : '—'),
				},
				{ key: 'createdAt', header: 'Created', sortable: true, render: (m) => formatDate(m.createdAt) },
			]}
		/>
	);
}

/**
 * @param {any} props loader result of `loadMerchant` plus `staff`
 */
export function MerchantView(props) {
	const toast = useToast();
	const ok = props.ok === true;
	const merchantId = ok ? props.merchant.merchantId : null;
	const { data: merchant, reload } = useAdminResource(
		merchantId ? adminApi.merchant(merchantId) : null,
		ok ? props.merchant : null,
	);
	const subs = useAdminResource(merchantId ? adminApi.subscriptions(merchantId) : null, {
		items: ok ? props.subscriptions : [],
	});
	const balanceRes = useAdminResource(merchantId ? adminApi.balance(merchantId) : null, ok ? props.balance : null);
	const [statusChange, setStatusChange] = useState(/** @type {null | 'suspend' | 'resume'} */ (null));
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [adding, setAdding] = useState(false);
	const [openId, setOpenId] = useState(/** @type {string | null} */ (null));
	if (!ok) return <AdminProblem problem={props.problem} back={{ href: adminRoutes.merchants(), label: 'Back to merchants' }} />;
	const { staff, members, invites, meter, alerts, notes } = props;
	const subscriptions = /** @type {any[]} */ (subs.data?.items ?? []);
	const balance = balanceRes.data;
	const websites = /** @type {any[]} */ (merchant?.websites ?? props.websites);
	const opened = websites.find((w) => w.websiteId === openId && !w.deletedAt) ?? null;
	const canWrite = staffCan(staff, 'platform.merchants.write');
	const domainOf = (/** @type {string} */ id) => websites.find((w) => w.websiteId === id)?.domain ?? id;

	const changeStatus = async (/** @type {{ reason: string }} */ { reason }) => {
		if (!statusChange) return;
		setBusy(true);
		setProblem(null);
		const result = await adminFetch(
			statusChange === 'suspend' ? adminApi.suspend(merchant.merchantId) : adminApi.resume(merchant.merchantId),
			{
				method: 'POST',
				body: { reason },
			},
		);
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		toast.show({
			title: statusChange === 'suspend' ? `${merchant.name} suspended` : `${merchant.name} resumed`,
			description:
				statusChange === 'suspend' ? 'Billing and products pause for every website.' : 'Billing and products resume.',
		});
		setStatusChange(null);
		await reload();
	};

	return (
		<div className="space-y-6">
			<PageHeader
				breadcrumbs={<Crumbs items={[{ label: 'Merchants', href: adminRoutes.merchants() }, { label: merchant.name }]} />}
				title={merchant.name}
				badge={<StatusBadge status={merchant.status} />}
				subtitle={<IdChip id={merchant.merchantId} label="merchant id" />}
				actions={
					<>
						{staffCan(staff, 'platform.finance.read') ? (
							<ButtonLink as={Link} href={adminRoutes.ledger(merchant.merchantId)} icon={<Icon name="wallet" size={14} />}>
								Ledger & credits
							</ButtonLink>
						) : null}
						{canWrite ? (
							merchant.status === 'suspended' ? (
								<Button variant="secondary" onClick={() => setStatusChange('resume')}>
									Resume
								</Button>
							) : (
								<Button variant="danger" onClick={() => setStatusChange('suspend')}>
									Suspend
								</Button>
							)
						) : null}
					</>
				}
			/>
			{merchant.status === 'suspended' && merchant.suspension ? (
				<Callout tone="danger" title={`Suspended ${formatDateTime(merchant.suspension.at)}`}>
					{merchant.suspension.reason} <span className="text-xs">(by {merchant.suspension.by})</span>
				</Callout>
			) : null}
			<div className="grid gap-4 sm:grid-cols-3">
				<Stat label="Balance" value={formatCredits(balance?.balanceMillicredits)} icon="wallet" />
				<Stat label="Spend now" value={formatCreditsPerHour(meter?.burnRatePerHour)} icon="activity" />
				<Stat
					label="Runway"
					value={formatHours(meter?.hoursRemaining)}
					tone={typeof meter?.hoursRemaining === 'number' && meter.hoursRemaining < 24 ? 'warning' : 'neutral'}
				/>
			</div>
			<Card title="Profile">
				<KeyValueList
					columns={3}
					items={[
						{ label: 'Created', value: formatDateTime(merchant.createdAt) },
						{ label: 'Owner user', value: <IdChip id={merchant.ownerUserId} label="user id" /> },
						{ label: 'Websites', value: websites.filter((w) => w.env === 'live' && !w.deletedAt).length },
					]}
				/>
			</Card>

			<Card
				title="Websites"
				subtitle="Live websites and their test twins."
				actions={
					staffCan(staff, 'websites.create') ? (
						<Button size="sm" icon={<Icon name="plus" size={14} />} onClick={() => setAdding(true)}>
							Add website
						</Button>
					) : null
				}>
				<Table
					caption="Websites"
					dense
					rows={websites}
					rowKey={(w) => w.websiteId}
					empty="No websites."
					columns={[
						{
							key: 'domain',
							header: 'Domain',
							rowHeader: true,
							sortable: true,
							render: (w) => (
								<span className="space-y-0.5">
									<span className="block font-semibold">{w.domain}</span>
									<IdChip id={w.websiteId} label="website id" />
								</span>
							),
						},
						{
							key: 'env',
							header: 'Env',
							render: (w) => <Badge tone={w.env === 'test' ? 'warning' : 'success'}>{w.env}</Badge>,
						},
						{ key: 'status', header: 'Status', render: (w) => <StatusBadge status={w.deletedAt ? 'deleted' : w.status} /> },
						{
							key: 'actions',
							header: <span className="sr-only">Actions</span>,
							align: 'right',
							render: (w) =>
								w.env === 'live' && !w.deletedAt ? (
									<span className="flex justify-end gap-1">
										<Button size="sm" variant="secondary" onClick={() => setOpenId(w.websiteId)}>
											Open
										</Button>
										<ButtonLink as={Link} size="sm" variant="ghost" href={adminRoutes.websites({ domain: w.domain })}>
											Transfer
										</ButtonLink>
									</span>
								) : null,
						},
					]}
				/>
			</Card>
			{opened ? (
				<WebsitePanel
					key={opened.websiteId}
					merchantId={merchant.merchantId}
					website={opened}
					catalog={props.catalog ?? []}
					subscriptions={subscriptions.filter((s) => s.websiteId === opened.websiteId || s.websiteId === opened.twinId)}
					balanceMillicredits={balance?.balanceMillicredits ?? null}
					staff={staff}
					onClose={() => setOpenId(null)}
					onChanged={async () => {
						await Promise.all([reload(), subs.reload(), balanceRes.reload()]);
					}}
				/>
			) : null}
			<Dialog open={adding} onClose={() => setAdding(false)} title="Add website" description={`For ${merchant.name}.`}>
				<AddWebsiteForm
					merchantId={merchant.merchantId}
					fetcher={adminFetch}
					autoFocus
					onAdded={(w) => {
						setAdding(false);
						toast.show({ title: `${w.domain} added`, description: 'A test twin was created with it.' });
						setOpenId(w.websiteId);
						void reload();
					}}
				/>
			</Dialog>

			<Card title="Subscriptions">
				<Table
					caption="Subscriptions"
					dense
					rows={subscriptions}
					rowKey={(s) => s.subscriptionId}
					empty="No subscriptions."
					columns={[
						{
							key: 'productSlug',
							header: 'Product',
							rowHeader: true,
							sortable: true,
							render: (s) => (
								<Link
									href={adminRoutes.subscription(s.subscriptionId)}
									className="font-semibold text-primary hover:underline">
									{s.productSlug}
								</Link>
							),
						},
						{ key: 'websiteId', header: 'Website', render: (s) => domainOf(s.websiteId) },
						{ key: 'planCode', header: 'Plan', render: (s) => s.planCode ?? '—' },
						{ key: 'status', header: 'Status', render: (s) => <StatusBadge status={s.status} /> },
						{ key: 'startedAt', header: 'Since', sortable: true, render: (s) => formatDate(s.startedAt) },
					]}
				/>
			</Card>

			<Card title="Team">
				<Table
					caption="Team members"
					dense
					rows={members}
					rowKey={(m) => m.userId}
					empty="No members."
					columns={[
						{
							key: 'email',
							header: 'Member',
							rowHeader: true,
							render: (m) => (
								<span className="space-y-0.5">
									<span className="block font-semibold">{m.email ?? m.userId}</span>
									{m.name ? <span className="block text-xs text-muted">{m.name}</span> : null}
								</span>
							),
						},
						{
							key: 'roles',
							header: 'Roles',
							render: (m) => (
								<span className="flex flex-wrap gap-1">
									{m.roles.map((/** @type {string} */ r) => (
										<Badge key={r}>{r}</Badge>
									))}
									{m.grants.length > 0 ? <Badge tone="info">{m.grants.length} website grants</Badge> : null}
								</span>
							),
						},
						{ key: 'status', header: 'Status', render: (m) => <StatusBadge status={m.status} /> },
					]}
				/>
				{invites.length > 0 ? (
					<p className="mt-3 text-xs text-muted">
						Pending invites:{' '}
						{invites
							.filter((/** @type {any} */ i) => i.status === 'pending')
							.map((/** @type {any} */ i) => i.email)
							.join(', ') || 'none'}
					</p>
				) : null}
			</Card>

			{staffCan(staff, 'platform.credits.adjust') ? (
				<CreditOperationCard
					merchant={merchant}
					balanceMillicredits={balance?.balanceMillicredits}
					onBooked={async () => {
						await balanceRes.reload();
					}}
				/>
			) : null}

			<NotesCard merchantId={merchant.merchantId} notes={notes} canWrite={canWrite} />

			{alerts.length > 0 ? (
				<Card title="Finance alerts">
					<ul className="space-y-1 text-sm">
						{alerts.map((/** @type {any} */ a) => (
							<li key={a.alertId} className="flex flex-wrap items-center gap-2">
								<StatusBadge status="failing" label={humanize(a.kind)} />
								<span className="text-muted">{formatDateTime(a.at)}</span>
								{a.subscriptionId ? (
									<Link
										href={adminRoutes.subscription(a.subscriptionId)}
										className="font-mono text-xs text-primary hover:underline">
										{a.subscriptionId}
									</Link>
								) : null}
							</li>
						))}
					</ul>
				</Card>
			) : null}

			<TypedConfirmDialog
				open={statusChange !== null}
				onClose={() => setStatusChange(null)}
				onConfirm={(input) => void changeStatus(input)}
				busy={busy}
				danger={statusChange === 'suspend'}
				title={statusChange === 'suspend' ? `Suspend ${merchant.name}?` : `Resume ${merchant.name}?`}
				expected={merchant.name}
				confirmLabel={statusChange === 'suspend' ? 'Suspend merchant' : 'Resume merchant'}
				reason={{ required: true, label: 'Reason (audited, shown to staff)' }}
				error={problem ? describeProblem(problem) : null}>
				<p className="text-sm text-muted">
					{statusChange === 'suspend'
						? 'Every subscription pauses (paused time is never billed), products stop serving and the team can no longer change anything.'
						: 'Subscriptions resume billing and products serve again.'}
				</p>
			</TypedConfirmDialog>
		</div>
	);
}

/**
 * One website of the merchant: its subscriptions (subscribe, change plan, cancel), install code and removal — the
 * merchant APIs (staff may call them), through the Merchant Console's components.
 * @param {{ merchantId: string, website: any, catalog: any[], subscriptions: any[], balanceMillicredits: number | null,
 *   staff: any, onClose: () => void, onChanged: () => Promise<void> }} props
 */
function WebsitePanel({ merchantId, website, catalog, subscriptions, balanceMillicredits, staff, onClose, onChanged }) {
	const toast = useToast();
	const snippet = useAdminResource(api.snippet(merchantId, website.websiteId), null);
	const [subscribing, setSubscribing] = useState(false);
	const [planOf, setPlanOf] = useState(/** @type {any} */ (null));
	const [planChoice, setPlanChoice] = useState('');
	const [cancelling, setCancelling] = useState(/** @type {any} */ (null));
	const [removing, setRemoving] = useState(false);
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const { reload: loadSnippet } = snippet;
	useEffect(() => {
		void loadSnippet();
	}, [loadSnippet]);
	const canManage = staffCan(staff, 'subscriptions.manage');
	const live = subscriptions.filter((s) => s.status !== 'cancelled');
	const productOf = (/** @type {string} */ appId) => catalog.find((p) => p.appId === appId) ?? null;
	const planProduct = planOf ? productOf(planOf.appId) : null;

	/** @param {() => Promise<{ ok: boolean, problem?: any }>} call @param {string} title */
	const run = async (call, title) => {
		setBusy(true);
		setProblem(null);
		const result = await call();
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem ?? null);
			return false;
		}
		toast.show({ title });
		await onChanged();
		return true;
	};
	const changePlan = async () => {
		if (!planOf) return;
		const done = await run(
			() => subscriptionCalls(adminFetch, merchantId, planOf.subscriptionId).changePlan(planChoice),
			'Plan changed',
		);
		if (done) setPlanOf(null);
	};
	const cancel = async () => {
		if (!cancelling) return;
		const done = await run(
			() => subscriptionCalls(adminFetch, merchantId, cancelling.subscriptionId).lifecycle('cancel'),
			'Subscription cancelled',
		);
		if (done) setCancelling(null);
	};
	const remove = async () => {
		const done = await run(
			() => adminFetch(api.website(merchantId, website.websiteId), { method: 'DELETE' }),
			`${website.domain} removed`,
		);
		if (done) {
			setRemoving(false);
			onClose();
		}
	};

	return (
		<Card
			title={website.domain}
			subtitle="Subscriptions and install code of this website."
			actions={
				<span className="flex flex-wrap gap-2">
					{canManage ? (
						<Button size="sm" onClick={() => setSubscribing(true)}>
							Subscribe
						</Button>
					) : null}
					{staffCan(staff, 'websites.delete') ? (
						<Button size="sm" variant="danger" onClick={() => setRemoving(true)}>
							Remove website
						</Button>
					) : null}
					<Button size="sm" variant="ghost" onClick={onClose}>
						Close
					</Button>
				</span>
			}>
			<div className="space-y-4">
				{problem && !planOf && !cancelling && !removing ? <Callout tone="danger">{describeProblem(problem)}</Callout> : null}
				<Table
					caption={`Subscriptions of ${website.domain}`}
					dense
					rows={live}
					rowKey={(s) => s.subscriptionId}
					empty="No products yet."
					columns={[
						{
							key: 'product',
							header: 'Product',
							rowHeader: true,
							render: (s) => (
								<Link
									href={adminRoutes.subscription(s.subscriptionId)}
									className="font-semibold text-primary hover:underline">
									{productOf(s.appId)?.name ?? s.productSlug}
								</Link>
							),
						},
						{ key: 'planCode', header: 'Plan', render: (s) => s.planCode ?? '—' },
						{ key: 'status', header: 'Status', render: (s) => <StatusBadge status={s.status} /> },
						{
							key: 'actions',
							header: <span className="sr-only">Actions</span>,
							align: 'right',
							render: (s) =>
								canManage ? (
									<span className="flex justify-end gap-1">
										{(productOf(s.appId)?.plans ?? []).length > 0 ? (
											<Button
												size="sm"
												variant="secondary"
												onClick={() => {
													setProblem(null);
													setPlanChoice(s.planCode ?? '');
													setPlanOf(s);
												}}>
												Change plan
											</Button>
										) : null}
										<Button
											size="sm"
											variant="ghost"
											onClick={() => {
												setProblem(null);
												setCancelling(s);
											}}>
											Cancel
										</Button>
									</span>
								) : null,
						},
					]}
				/>
				<InstallCodeCard snippet={snippet.data} />
			</div>
			{subscribing ? (
				<SubscribeDialog
					merchantId={merchantId}
					website={website}
					products={catalog}
					balanceMillicredits={balanceMillicredits}
					fetcher={adminFetch}
					creditsHref={null}
					onClose={() => setSubscribing(false)}
					onSubscribed={(sub) => {
						setSubscribing(false);
						toast.show({ title: `Subscribed to ${productOf(sub.appId)?.name ?? sub.productSlug}` });
						void onChanged();
					}}
				/>
			) : null}
			<Dialog
				open={Boolean(planOf)}
				onClose={() => setPlanOf(null)}
				size="lg"
				title={planProduct ? `Change the plan of ${planProduct.name}` : 'Change plan'}
				description="Applies from the next hour."
				footer={
					<>
						<Button variant="secondary" onClick={() => setPlanOf(null)}>
							Cancel
						</Button>
						<Button
							onClick={() => void changePlan()}
							loading={busy}
							disabled={!planOf || planChoice === (planOf.planCode ?? '')}>
							Change plan
						</Button>
					</>
				}>
				{planProduct ? (
					<div className="space-y-4">
						<PlanComparison product={planProduct} />
						<RadioGroup
							legend="Plan"
							value={planChoice}
							onChange={setPlanChoice}
							options={planProduct.plans.map((/** @type {any} */ p) => ({
								value: p.code,
								label: `${p.name ?? p.code} — ${formatCreditsPerHour(hourlyEstimate(planProduct, p.code))}`,
							}))}
						/>
					</div>
				) : null}
				<FormError problem={problem} />
			</Dialog>
			<ConfirmDialog
				open={Boolean(cancelling)}
				onClose={() => setCancelling(null)}
				onConfirm={() => void cancel()}
				busy={busy}
				danger
				title={`Cancel ${cancelling ? (productOf(cancelling.appId)?.name ?? cancelling.productSlug) : ''} on ${website.domain}?`}
				confirmLabel="Cancel subscription"
				error={problem ? describeProblem(problem) : null}>
				<p className="text-sm text-muted">All elements stop at once and billing ends with the current hour.</p>
			</ConfirmDialog>
			<TypedConfirmDialog
				open={removing}
				onClose={() => setRemoving(false)}
				onConfirm={() => void remove()}
				busy={busy}
				danger
				title={`Remove ${website.domain}?`}
				expected={website.domain}
				confirmLabel="Remove website"
				error={problem ? describeProblem(problem) : null}>
				<p className="text-sm text-muted">Its test twin, keys and subscriptions go with it.</p>
			</TypedConfirmDialog>
		</Card>
	);
}

/**
 * Staff notes on a merchant (append-only; `GET` / `POST /v1/admin/merchants/:merchantId/notes`).
 * @param {{ merchantId: string, notes: { data: any, problem: Problem | null }, canWrite: boolean }} props
 */
function NotesCard({ merchantId, notes, canWrite }) {
	const { data, reload } = useAdminResource(adminApi.notes(merchantId), notes.data ?? { items: [] });
	const [body, setBody] = useState('');
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const items = /** @type {any[]} */ (data?.items ?? []);
	const add = async () => {
		if (!body.trim()) return;
		setBusy(true);
		setProblem(null);
		const result = await adminFetch(adminApi.notes(merchantId), { method: 'POST', body: { body: body.trim() } });
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		setBody('');
		await reload();
	};
	return (
		<Card title="Staff notes" subtitle="Internal, visible to staff only.">
			{
				<div className="space-y-4">
					{notes.problem ? <p className="text-sm text-danger">{describeProblem(notes.problem)}</p> : null}
					{items.length === 0 ? (
						<p className="text-sm text-muted">No notes yet.</p>
					) : (
						<ul className="space-y-3">
							{items.map((n) => (
								<li key={n.noteId} className="rounded-xl border border-line p-3 text-sm">
									<p className="whitespace-pre-wrap text-fg">{n.body}</p>
									<p className="mt-1 text-xs text-muted">
										{n.by?.name ?? n.by?.email ?? n.by?.staffId} · {formatDateTime(n.at)}
									</p>
								</li>
							))}
						</ul>
					)}
					{canWrite ? (
						<Form onSubmit={add} busy={busy} aria-label="Add a note">
							<TextArea
								label="New note"
								rows={2}
								maxLength={2000}
								value={body}
								onChange={(e) => setBody(e.currentTarget.value)}
							/>
							<FormError problem={problem} fields={['body']} />
							<Button type="submit" size="sm" loading={busy} disabled={!body.trim()}>
								Add note
							</Button>
						</Form>
					) : null}
				</div>
			}
		</Card>
	);
}
