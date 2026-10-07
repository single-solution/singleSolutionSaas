'use client';
/**
 * Admin Merchants (PLAN 0.8.2, 0.6): the table (search by business name, owner e-mail or domain; status filter; paged
 * at 50; bulk Suspend / Resume with one reason and Resend setup link) with Add merchant, and the merchant page — an
 * inner sidebar with the searchable list, a header (name, status, balance, actions: Suspend / Resume, Resend or Copy
 * setup link, Turn off two-step, Delete) and the tabs Websites · Credits · Details · Activity. Rights follow the role
 * (PLAN 0.2); the API checks them again.
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
	PageHeader,
	Select,
	StatusBadge,
	Table,
	Tabs,
	TextArea,
	TypedConfirmDialog,
	describeProblem,
	fieldErrors,
	formatCredits,
	formatDate,
	formatDateTime,
	useToast,
} from '@ss/ui';
import { ADMIN, MERCHANT_FIELDS } from '../../../texts/console.js';
import { Link } from '../../link.js';
import { MerchantFieldsForm, countryOptions } from '../../views/account.js';
import { ActivityTable } from '../../views/login-settings.js';
import { SubscribeDialog } from '../../views/products.js';
import { AddWebsiteForm } from '../../views/websites.js';
import { adminFetch, usePagedList } from '../client.js';
import { adminApi, adminRoutes } from '../paths.js';
import { AdminProblem, adminCan } from './common.js';

/** @typedef {import('@ss/ui').Problem} Problem */

/**
 * Status badge of a merchant, plus Setup pending (a separate grey badge, PLAN 0.6).
 * @param {{ merchant: any }} props
 */
export function MerchantStatus({ merchant }) {
	return (
		<span className="inline-flex flex-wrap items-center gap-1">
			<StatusBadge
				status={merchant.status}
				label={ADMIN.status[/** @type {'active'} */ (merchant.status)] ?? merchant.status}
			/>
			{merchant.setupPending ? <Badge tone="neutral">{ADMIN.setupPending}</Badge> : null}
		</span>
	);
}

/**
 * The setup link shown once to copy (PLAN 0.2: shown once, only to that admin, logged).
 * @param {{ link: string | null, onClose: () => void }} props
 */
function CopyLinkDialog({ link, onClose }) {
	return (
		<Dialog open={Boolean(link)} onClose={onClose} title={ADMIN.copySetupLink} description={ADMIN.setupLinkCopy}>
			{link ? <CodeBlock code={link} label={ADMIN.copySetupLink} secret wrap /> : null}
		</Dialog>
	);
}

/**
 * Add merchant: the merchant fields; saving e-mails the setup link (or offers to copy it).
 * @param {{ open: boolean, onClose: () => void, onCreated: (merchant: any) => void }} props
 */
function AddMerchantDialog({ open, onClose, onCreated }) {
	const toast = useToast();
	const [form, setForm] = useState({ name: '', ownerName: '', email: '', phone: '', address: '', country: '' });
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	/** @param {keyof typeof form} key @param {string} value */
	const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
	const submit = async () => {
		setBusy(true);
		setProblem(null);
		/** @type {Record<string, string>} */
		const body = { name: form.name.trim(), ownerName: form.ownerName.trim(), email: form.email.trim() };
		for (const key of /** @type {const} */ (['phone', 'address', 'country']))
			if (form[key].trim()) body[key] = form[key].trim();
		const result = await adminFetch(adminApi.createMerchant(), { method: 'POST', body });
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		toast.show({
			title: ADMIN.merchantCreated,
			description: result.data?.setup?.mailed ? ADMIN.setupMailed : ADMIN.setupNotMailed,
		});
		setForm({ name: '', ownerName: '', email: '', phone: '', address: '', country: '' });
		onCreated(result.data?.merchant);
	};
	const errors = fieldErrors(problem);
	return (
		<Dialog open={open} onClose={onClose} title={ADMIN.addMerchant} size="lg">
			<Form onSubmit={submit} busy={busy} aria-label={ADMIN.addMerchant}>
				<div className="grid gap-4 md:grid-cols-2">
					<Input
						label={MERCHANT_FIELDS.name}
						value={form.name}
						onChange={(e) => set('name', e.currentTarget.value)}
						error={errors.name}
						required
						maxLength={120}
					/>
					<Input
						label={MERCHANT_FIELDS.ownerName}
						value={form.ownerName}
						onChange={(e) => set('ownerName', e.currentTarget.value)}
						error={errors.ownerName}
						required
						maxLength={120}
					/>
					<Input
						label={MERCHANT_FIELDS.email}
						type="email"
						value={form.email}
						onChange={(e) => set('email', e.currentTarget.value)}
						error={errors.email}
						required
					/>
					<Input
						label={MERCHANT_FIELDS.phone}
						help={MERCHANT_FIELDS.phoneHelp}
						value={form.phone}
						onChange={(e) => set('phone', e.currentTarget.value)}
						error={errors.phone}
						maxLength={40}
					/>
					<Select
						label={MERCHANT_FIELDS.country}
						value={form.country}
						onChange={(e) => set('country', e.currentTarget.value)}
						error={errors.country}
						options={countryOptions(MERCHANT_FIELDS.countryNone)}
					/>
					<Input
						label={MERCHANT_FIELDS.address}
						value={form.address}
						onChange={(e) => set('address', e.currentTarget.value)}
						error={errors.address}
						maxLength={300}
					/>
				</div>
				<FormError problem={problem} fields={['name', 'ownerName', 'email', 'phone', 'address', 'country']} />
				<Button type="submit" loading={busy}>
					{ADMIN.addMerchant}
				</Button>
			</Form>
		</Dialog>
	);
}

/**
 * The Merchants table.
 * @param {any} props loader result of `loadMerchants` plus `admin`
 */
export function MerchantsView(props) {
	const toast = useToast();
	const ok = props.ok === true;
	const filter = ok ? props.filter : { status: null, q: null };
	const [q, setQ] = useState(filter.q ?? '');
	const [status, setStatus] = useState(filter.status ?? '');
	const list = usePagedList(
		(cursor) => (ok ? adminApi.merchants({ status: filter.status, q: filter.q, cursor, limit: 50 }) : null),
		ok ? props.page : null,
	);
	const [selected, setSelected] = useState(/** @type {Set<string>} */ (new Set()));
	const [adding, setAdding] = useState(false);
	const [bulk, setBulk] = useState(/** @type {null | 'suspend' | 'resume' | 'resend_setup_link'} */ (null));
	const [reason, setReason] = useState('');
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	if (!ok) return <AdminProblem problem={props.problem} />;
	const admin = props.admin;
	const canWrite = adminCan(admin, 'merchants.write');
	const canSuspend = adminCan(admin, 'merchants.suspend');
	const canLink = adminCan(admin, 'merchants.setup_link');
	const canBulk = canSuspend || canLink;
	const apply = () => window.location.assign(adminRoutes.merchants({ q: q.trim() || null, status: status || null }));
	/** @param {string} id */
	const toggle = (id) =>
		setSelected((s) => {
			const next = new Set(s);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	const runBulk = async () => {
		if (!bulk) return;
		setBusy(true);
		setProblem(null);
		const result = await adminFetch(adminApi.bulk(), {
			method: 'POST',
			body: { action: bulk, merchantIds: [...selected], ...(bulk === 'suspend' ? { reason: reason.trim() } : {}) },
		});
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		const results = /** @type {any[]} */ (result.data?.results ?? []);
		toast.show({ title: ADMIN.bulk.done(results.filter((r) => r.ok).length, results.filter((r) => !r.ok).length) });
		setBulk(null);
		setReason('');
		setSelected(new Set());
		await list.reload();
	};
	return (
		<div className="space-y-6">
			<PageHeader
				title={ADMIN.merchantsTitle}
				actions={
					canWrite ? (
						<Button onClick={() => setAdding(true)} icon={<Icon name="plus" size={14} />}>
							{ADMIN.addMerchant}
						</Button>
					) : null
				}
			/>
			<Card>
				<Form onSubmit={apply} aria-label={ADMIN.searchMerchants}>
					<div className="grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
						<Input
							label={ADMIN.searchMerchants}
							hideLabel
							placeholder={ADMIN.searchMerchants}
							value={q}
							onChange={(e) => setQ(e.currentTarget.value)}
						/>
						<Select
							label={ADMIN.columns.status}
							hideLabel
							value={status}
							onChange={(e) => setStatus(e.currentTarget.value)}
							options={[
								{ value: '', label: ADMIN.allStatuses },
								{ value: 'active', label: ADMIN.status.active },
								{ value: 'suspended', label: ADMIN.status.suspended },
							]}
						/>
						<Button type="submit" variant="secondary">
							{ADMIN.filters.apply}
						</Button>
					</div>
				</Form>
			</Card>
			{canBulk && selected.size > 0 ? (
				<div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface-2 p-3 text-sm">
					<span className="font-semibold">{ADMIN.bulk.selected(selected.size)}</span>
					{canSuspend ? (
						<>
							<Button size="sm" variant="secondary" onClick={() => setBulk('suspend')}>
								{ADMIN.bulk.suspend}
							</Button>
							<Button size="sm" variant="secondary" onClick={() => setBulk('resume')}>
								{ADMIN.bulk.resume}
							</Button>
						</>
					) : null}
					{canLink ? (
						<Button size="sm" variant="secondary" onClick={() => setBulk('resend_setup_link')}>
							{ADMIN.bulk.resend}
						</Button>
					) : null}
				</div>
			) : null}
			{list.problem ? <Callout tone="danger">{describeProblem(list.problem)}</Callout> : null}
			<Table
				caption={ADMIN.merchantsTitle}
				captionHidden
				rows={list.items}
				rowKey={(m) => m.merchantId}
				hasMore={Boolean(list.cursor)}
				loadingMore={list.loading}
				onLoadMore={() => void list.more()}
				empty={<EmptyState icon="users" title={ADMIN.merchantsTitle} description="—" />}
				columns={[
					...(canBulk
						? [
								{
									key: 'select',
									header: <span className="sr-only">Select</span>,
									render: (/** @type {any} */ m) => (
										<input
											type="checkbox"
											aria-label={`Select ${m.name}`}
											checked={selected.has(m.merchantId)}
											onChange={() => toggle(m.merchantId)}
										/>
									),
								},
							]
						: []),
					{
						key: 'name',
						header: ADMIN.columns.name,
						sortable: true,
						rowHeader: true,
						render: (m) => (
							<span className="block min-w-0">
								<Link href={adminRoutes.merchant(m.merchantId)} className="font-semibold text-primary hover:underline">
									{m.name}
								</Link>
								<span className="block truncate text-xs text-muted">{m.email}</span>
							</span>
						),
					},
					{ key: 'status', header: ADMIN.columns.status, render: (m) => <MerchantStatus merchant={m} /> },
					{ key: 'createdAt', header: ADMIN.columns.created, sortable: true, render: (m) => formatDate(m.createdAt) },
					{ key: 'lastSignInAt', header: ADMIN.columns.lastSignIn, render: (m) => formatDateTime(m.lastSignInAt) },
				]}
			/>
			<AddMerchantDialog
				open={adding}
				onClose={() => setAdding(false)}
				onCreated={(merchant) => {
					setAdding(false);
					if (merchant?.merchantId) window.location.assign(adminRoutes.merchant(merchant.merchantId));
				}}
			/>
			<ConfirmDialog
				open={bulk !== null}
				onClose={() => setBulk(null)}
				onConfirm={() => void runBulk()}
				busy={busy}
				danger={bulk === 'suspend'}
				confirmLabel={bulk === 'suspend' ? ADMIN.bulk.suspend : bulk === 'resume' ? ADMIN.bulk.resume : ADMIN.bulk.resend}
				title={ADMIN.bulk.selected(selected.size)}
				error={problem ? describeProblem(problem) : null}>
				{bulk === 'suspend' ? (
					<div className="space-y-3">
						<p className="text-sm text-muted">{ADMIN.suspendHelp}</p>
						<TextArea
							label={ADMIN.reason}
							value={reason}
							onChange={(e) => setReason(e.currentTarget.value)}
							required
							maxLength={500}
						/>
					</div>
				) : bulk === 'resume' ? (
					<p className="text-sm text-muted">{ADMIN.resumeHelp}</p>
				) : null}
			</ConfirmDialog>
		</div>
	);
}

/**
 * The inner sidebar of the merchant page: the searchable list (name + status dot). Below 1024 px the list page is the
 * Merchants table and the merchant page shows a Back link instead (PLAN 0.6 Phones and tablets).
 * @param {{ currentId: string }} props
 */
function InnerList({ currentId }) {
	const [q, setQ] = useState('');
	const list = usePagedList((cursor) => adminApi.merchants({ q: q.trim() || null, cursor, limit: 50 }), null);
	const { reload } = list;
	// load once when the page opens (`reload` is a new function every render); later searches reload from the form
	useEffect(() => {
		void reload();
	}, []);
	return (
		<aside className="hidden w-64 shrink-0 space-y-3 lg:block" aria-label={ADMIN.merchantsTitle}>
			<Form onSubmit={() => void list.reload()} aria-label={ADMIN.searchMerchants}>
				<Input
					label={ADMIN.searchMerchants}
					hideLabel
					placeholder={ADMIN.searchMerchants}
					value={q}
					onChange={(e) => setQ(e.currentTarget.value)}
				/>
			</Form>
			<ul className="max-h-[70vh] space-y-0.5 overflow-y-auto">
				{list.items.map((m) => (
					<li key={m.merchantId}>
						<Link
							href={adminRoutes.merchant(m.merchantId)}
							className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${m.merchantId === currentId ? 'bg-primary-soft font-semibold text-on-primary-soft' : 'text-fg hover:bg-surface-2'}`}>
							<span
								aria-hidden="true"
								className={`size-2 shrink-0 rounded-full ${m.status === 'active' ? 'bg-success' : 'bg-danger'}`}
							/>
							<span className="truncate">{m.name}</span>
						</Link>
					</li>
				))}
			</ul>
		</aside>
	);
}

/**
 * The merchant page.
 * @param {any} props loader result of `loadMerchant` plus `admin` and `tab`
 */
export function MerchantView(props) {
	const toast = useToast();
	const [merchant, setMerchant] = useState(props.ok ? props.merchant : null);
	const [websites, setWebsites] = useState(/** @type {any[]} */ (props.ok ? props.websites : []));
	const [tab, setTab] = useState(props.tab ?? 'websites');
	const [dialog, setDialog] = useState(/** @type {null | 'suspend' | 'resume' | 'twoStep' | 'delete' | 'addWebsite'} */ (null));
	const [removing, setRemoving] = useState(/** @type {any} */ (null));
	const [addingTo, setAddingTo] = useState(/** @type {any} */ (null));
	const [subs, setSubs] = useState(/** @type {any[]} */ (props.ok ? props.subscriptions : []));
	const [reason, setReason] = useState('');
	const [link, setLink] = useState(/** @type {string | null} */ (null));
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	if (!props.ok || !merchant) return <AdminProblem problem={props.problem} />;
	const admin = props.admin;
	const merchantId = merchant.merchantId;
	/** @param {any} w */
	const productsOn = (w) =>
		subs.filter((s) => (s.websiteId === w.websiteId || s.websiteId === w.twinId) && s.status !== 'cancelled');
	const can = (/** @type {string} */ p) => adminCan(admin, p);
	const balance = props.balance?.balanceMillicredits;

	/**
	 * @param {string} path
	 * @param {Record<string, unknown>} [body]
	 * @param {string} [method]
	 */
	const act = async (path, body, method = 'POST') => {
		setBusy(true);
		setProblem(null);
		const result = await adminFetch(path, { method, ...(body ? { body } : {}) });
		setBusy(false);
		if (!result.ok) setProblem(result.problem);
		return result;
	};
	const suspendOrResume = async () => {
		const suspend = dialog === 'suspend';
		const result = await act(
			suspend ? adminApi.suspend(merchantId) : adminApi.resume(merchantId),
			suspend ? { reason: reason.trim() } : {},
		);
		if (!result.ok) return;
		setMerchant(result.data);
		setDialog(null);
		setReason('');
	};
	const setupLink = async (/** @type {boolean} */ copy) => {
		const result = await act(adminApi.setupLink(merchantId), { copy });
		if (!result.ok) {
			toast.show({ tone: 'danger', title: describeProblem(result.problem) });
			return;
		}
		if (copy) setLink(result.data?.link ?? null);
		else toast.show({ title: result.data?.mailed ? ADMIN.setupLinkSent : ADMIN.setupNotMailed });
	};
	const turnOffTwoStep = async () => {
		const result = await act(adminApi.merchantTwoStepOff(merchantId), {});
		if (!result.ok) return;
		setMerchant(result.data);
		setDialog(null);
	};
	const remove = async () => {
		const result = await act(adminApi.merchant(merchantId), { confirm: merchant.name }, 'DELETE');
		if (result.ok) window.location.assign(adminRoutes.merchants());
	};
	const removeWebsite = async () => {
		if (!removing) return;
		const result = await act(adminApi.website(merchantId, removing.websiteId), { confirm: removing.domain }, 'DELETE');
		if (!result.ok) return;
		setWebsites((list) => list.filter((w) => w.websiteId !== removing.websiteId));
		setRemoving(null);
	};

	const actions = (
		<div className="flex flex-wrap gap-2">
			{can('merchants.suspend') ? (
				merchant.status === 'suspended' ? (
					<Button variant="secondary" onClick={() => setDialog('resume')}>
						{ADMIN.resume}
					</Button>
				) : (
					<Button variant="secondary" onClick={() => setDialog('suspend')}>
						{ADMIN.suspend}
					</Button>
				)
			) : null}
			{can('merchants.setup_link') && merchant.setupPending ? (
				<>
					<Button variant="secondary" onClick={() => void setupLink(false)} loading={busy}>
						{ADMIN.resendSetupLink}
					</Button>
					<Button variant="secondary" onClick={() => void setupLink(true)} loading={busy}>
						{ADMIN.copySetupLink}
					</Button>
				</>
			) : null}
			{can('two_step.turn_off') && merchant.twoStep?.enabled ? (
				<Button variant="secondary" onClick={() => setDialog('twoStep')}>
					{ADMIN.turnOffTwoStep}
				</Button>
			) : null}
			{can('merchants.delete') ? (
				<Button
					variant="danger"
					onClick={() => setDialog('delete')}
					disabled={websites.length > 0}
					title={websites.length > 0 ? ADMIN.deleteBlocked : undefined}>
					{ADMIN.deleteMerchant}
				</Button>
			) : null}
		</div>
	);

	return (
		<div className="flex gap-6">
			<InnerList currentId={merchantId} />
			<div className="min-w-0 flex-1 space-y-6">
				<Link href={adminRoutes.merchants()} className="text-sm font-semibold text-primary hover:underline lg:hidden">
					← {ADMIN.merchantsTitle}
				</Link>
				<PageHeader
					title={merchant.name}
					badge={<MerchantStatus merchant={merchant} />}
					subtitle={typeof balance === 'number' ? formatCredits(balance) : undefined}
					actions={actions}
				/>
				{merchant.suspension ? <Callout tone="danger">{ADMIN.suspendedBecause(merchant.suspension.reason)}</Callout> : null}
				<Tabs
					label={merchant.name}
					value={tab}
					onChange={setTab}
					tabs={[
						{
							id: 'websites',
							label: ADMIN.tabs.websites,
							content: (
								<div className="space-y-4">
									{can('websites.write') ? (
										<Button onClick={() => setDialog('addWebsite')} icon={<Icon name="plus" size={14} />}>
											{ADMIN.addWebsite}
										</Button>
									) : null}
									<Table
										caption={ADMIN.tabs.websites}
										captionHidden
										rows={websites}
										rowKey={(w) => w.websiteId}
										empty={<EmptyState icon="globe" title={ADMIN.tabs.websites} description="—" />}
										columns={[
											{ key: 'domain', header: ADMIN.domain, rowHeader: true, render: (w) => w.domain },
											{
												key: 'products',
												header: 'Products',
												render: (w) => (
													<span className="flex flex-wrap gap-1">
														{productsOn(w).map((s) => (
															<StatusBadge
																key={s.subscriptionId}
																status={s.status}
																label={s.productSlug ?? s.appId}
															/>
														))}
													</span>
												),
											},
											{ key: 'createdAt', header: ADMIN.columns.created, render: (w) => formatDate(w.createdAt) },
											...(can('websites.write')
												? [
														{
															key: 'actions',
															header: <span className="sr-only">Actions</span>,
															align: /** @type {const} */ ('right'),
															render: (/** @type {any} */ w) => (
																<span className="flex flex-wrap justify-end gap-1">
																	{can('products_on_websites.write') ? (
																		<Button size="sm" variant="ghost" onClick={() => setAddingTo(w)}>
																			{ADMIN.addProduct}
																		</Button>
																	) : null}
																	<Button
																		size="sm"
																		variant="ghost"
																		disabled={productsOn(w).length > 0}
																		title={productsOn(w).length > 0 ? ADMIN.removeProductsFirst : undefined}
																		onClick={() => setRemoving(w)}>
																		{ADMIN.removeWebsite}
																	</Button>
																</span>
															),
														},
													]
												: []),
										]}
									/>
								</div>
							),
						},
						{
							id: 'credits',
							label: ADMIN.tabs.credits,
							content: (
								<Card>
									<p className="text-sm text-muted">{typeof balance === 'number' ? formatCredits(balance) : '—'}</p>
									{can('billing.read') ? (
										<ButtonLink as={Link} href={adminRoutes.ledger(merchantId)} variant="secondary" className="mt-3">
											{ADMIN.menu.billing}
										</ButtonLink>
									) : null}
								</Card>
							),
						},
						{
							id: 'details',
							label: ADMIN.tabs.details,
							content: (
								<Card>
									<MerchantFieldsForm
										merchant={merchant}
										path={adminApi.merchant(merchantId)}
										withEmail
										emailLocked={!merchant.setupPending}
										emailLockedHelp={ADMIN.emailLocked}
										readOnly={!can('merchants.write')}
										onSaved={(m) => setMerchant(m)}
										fetcher={adminFetch}
									/>
								</Card>
							),
						},
						{
							id: 'activity',
							label: ADMIN.tabs.activity,
							content: <ActivityTable items={props.activity?.items ?? []} empty={ADMIN.noActivity} />,
						},
					]}
				/>
			</div>
			<ConfirmDialog
				open={dialog === 'suspend' || dialog === 'resume'}
				onClose={() => setDialog(null)}
				onConfirm={() => void suspendOrResume()}
				busy={busy}
				danger={dialog === 'suspend'}
				confirmLabel={dialog === 'suspend' ? ADMIN.suspend : ADMIN.resume}
				title={dialog === 'suspend' ? ADMIN.suspendTitle : ADMIN.resume}
				error={problem ? describeProblem(problem) : null}>
				{dialog === 'suspend' ? (
					<div className="space-y-3">
						<p className="text-sm text-muted">{ADMIN.suspendHelp}</p>
						<TextArea
							label={ADMIN.reason}
							value={reason}
							onChange={(e) => setReason(e.currentTarget.value)}
							required
							maxLength={500}
						/>
					</div>
				) : (
					<p className="text-sm text-muted">{ADMIN.resumeHelp}</p>
				)}
			</ConfirmDialog>
			<ConfirmDialog
				open={dialog === 'twoStep'}
				onClose={() => setDialog(null)}
				onConfirm={() => void turnOffTwoStep()}
				busy={busy}
				danger
				confirmLabel={ADMIN.turnOffTwoStep}
				title={ADMIN.turnOffTwoStep}
				error={problem ? describeProblem(problem) : null}>
				<p className="text-sm text-muted">{ADMIN.turnOffTwoStepHelp}</p>
			</ConfirmDialog>
			<TypedConfirmDialog
				open={dialog === 'delete'}
				onClose={() => setDialog(null)}
				onConfirm={() => void remove()}
				expected={merchant.name}
				busy={busy}
				danger
				confirmLabel={ADMIN.deleteMerchant}
				title={`${ADMIN.deleteMerchant} ${merchant.name}`}
				error={problem ? describeProblem(problem) : null}>
				<p className="text-sm text-muted">{ADMIN.deleteHelp(typeof balance === 'number' ? formatCredits(balance) : '—')}</p>
			</TypedConfirmDialog>
			<TypedConfirmDialog
				open={Boolean(removing)}
				onClose={() => setRemoving(null)}
				onConfirm={() => void removeWebsite()}
				expected={removing?.domain ?? ''}
				busy={busy}
				danger
				confirmLabel={ADMIN.removeWebsite}
				title={`${ADMIN.removeWebsite} ${removing?.domain ?? ''}`}
				error={problem ? describeProblem(problem) : null}>
				<p className="text-sm text-muted">{ADMIN.removeWebsiteHelp}</p>
			</TypedConfirmDialog>
			<Dialog
				open={dialog === 'addWebsite'}
				onClose={() => setDialog(null)}
				title={ADMIN.addWebsite}
				description={ADMIN.domainHelp}>
				<AddWebsiteForm
					merchantId={merchantId}
					autoFocus
					fetcher={adminFetch}
					onAdded={(w) => {
						setDialog(null);
						setWebsites((list) => [...list, w]);
					}}
				/>
			</Dialog>
			<CopyLinkDialog link={link} onClose={() => setLink(null)} />
			{addingTo ? (
				<SubscribeDialog
					merchantId={merchantId}
					website={addingTo}
					products={(props.catalog ?? []).filter(
						(/** @type {any} */ p) => !productsOn(addingTo).some((s) => s.appId === p.appId),
					)}
					balanceMillicredits={typeof balance === 'number' ? balance : null}
					fetcher={adminFetch}
					creditsHref={null}
					onClose={() => setAddingTo(null)}
					onSubscribed={(sub) => {
						setSubs((list) => [...list, sub]);
						setAddingTo(null);
					}}
				/>
			) : null}
		</div>
	);
}
