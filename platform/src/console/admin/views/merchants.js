'use client';
/**
 * Admin Merchants (PLAN 0.8.2, 0.6): one list-and-detail screen. The list (search by business name, owner e-mail or
 * domain; status filter; paged at 50; per row the name, a status dot and the balance; bulk Suspend / Resume with one
 * reason and Resend setup link) sits beside the selected merchant — a header (name, status, balance; actions Add
 * credits, Edit merchant, Suspend / Resume, Resend or Copy setup link, Turn off two-step, Delete, all as dialogs), a
 * grid of website cards (products with Add product, tokens and usage in dialogs; Add website) and the Credits and
 * Activity sections. Rights follow the role (PLAN 0.2); the API checks them again.
 * @module
 */
import { useState } from 'react';
import {
	Badge,
	Button,
	Callout,
	CodeBlock,
	ConfirmDialog,
	Dialog,
	EmptyState,
	Form,
	FormError,
	Icon,
	Input,
	PageHeader,
	Section,
	Select,
	StatusBadge,
	TextArea,
	TypedConfirmDialog,
	describeProblem,
	fieldErrors,
	formatCredits,
	useToast,
} from '@ss/ui';
import { ADMIN, BILLING, MERCHANT_FIELDS, WEBSITE } from '../../../texts/console.js';
import { api } from '../../paths.js';
import { MerchantStatusBadge } from '../../views/billing.js';
import { MerchantFieldsForm, countryOptions } from '../../views/account.js';
import { ListDetail, ListPane, ListRow, ListSearch } from '../../views/common.js';
import { ActivityTable } from '../../views/login-settings.js';
import { AddWebsiteDialog, WebsiteCard } from '../../views/website.js';
import { adminFetch, usePagedList } from '../client.js';
import { adminApi, adminRoutes } from '../paths.js';
import { AdminProblem, adminCan } from './common.js';
import { AddCreditsDialog, MerchantCredits } from './finance.js';

/** @typedef {import('@ss/ui').Problem} Problem */

/** Status dot of a merchant in the list (PLAN 0.6 status colours). */
const STATUS_DOTS = /** @type {Record<string, 'success' | 'warning' | 'danger'>} */ ({
	active: 'success',
	low_balance: 'warning',
	grace: 'warning',
	stopped: 'danger',
	suspended: 'danger',
});

/**
 * The merchant's status: suspended first, else the billing status from the check (PLAN 0.5.5).
 * @param {any} merchant
 * @param {any} billing
 * @returns {string}
 */
const statusOf = (merchant, billing) => (merchant.status === 'suspended' ? 'suspended' : (billing?.status ?? merchant.status));

/** @param {string} status */
const statusLabel = (status) => ADMIN.status[/** @type {'active'} */ (status)] ?? status;

/**
 * Status badge of a merchant, plus Setup pending (a separate grey badge, PLAN 0.6).
 * @param {{ merchant: any, billing?: any }} props
 */
function MerchantStatus({ merchant, billing = null }) {
	const status = statusOf(merchant, billing);
	return (
		<span className="inline-flex flex-wrap items-center gap-1">
			{status in BILLING.merchantStatus ? (
				<MerchantStatusBadge status={status} />
			) : (
				<StatusBadge status={status} label={statusLabel(status)} />
			)}
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
					wide
				/>
				<FormError problem={problem} fields={['name', 'ownerName', 'email', 'phone', 'address', 'country']} />
				<Button type="submit" loading={busy}>
					{ADMIN.addMerchant}
				</Button>
			</Form>
		</Dialog>
	);
}

/**
 * The Merchants list pane.
 * @param {{ props: any, admin: any, selectedId: string | null }} input
 */
function MerchantList({ props, admin, selectedId }) {
	const toast = useToast();
	const filter = props.filter;
	/** @param {string} id @returns {any} */
	const billingOf = (id) => props.billing?.[id] ?? null;
	const [q, setQ] = useState(filter.q ?? '');
	const [status, setStatus] = useState(filter.status ?? '');
	const list = usePagedList(
		(cursor) => adminApi.merchants({ status: filter.status, q: filter.q, cursor, limit: 50 }),
		props.page,
	);
	const [selected, setSelected] = useState(/** @type {Set<string>} */ (new Set()));
	const [adding, setAdding] = useState(false);
	const [bulk, setBulk] = useState(/** @type {null | 'suspend' | 'resume' | 'resend_setup_link'} */ (null));
	const [reason, setReason] = useState('');
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const canWrite = adminCan(admin, 'merchants.write');
	const canSuspend = adminCan(admin, 'merchants.suspend');
	const canLink = adminCan(admin, 'merchants.setup_link');
	const canBulk = canSuspend || canLink;
	const keep = { q: filter.q, status: filter.status };
	const search = () => {
		const next = { q: q.trim() || null, status: status || null };
		window.location.assign(selectedId ? adminRoutes.merchant(selectedId, next) : adminRoutes.merchants(next));
	};
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
	/** @param {any} m balance of the merchants checked on load (later pages show none) */
	const balanceOf = (m) => {
		const b = billingOf(m.merchantId);
		return b ? formatCredits(b.balance) : undefined;
	};
	return (
		<>
			<ListPane
				title={ADMIN.merchantsTitle}
				action={
					canWrite ? (
						<Button size="sm" onClick={() => setAdding(true)} icon={<Icon name="plus" size={14} />}>
							{ADMIN.addMerchant}
						</Button>
					) : null
				}
				tools={
					<ListSearch label={ADMIN.searchMerchants} value={q} onChange={setQ} onSearch={search}>
						<Select
							label={ADMIN.columns.status}
							hideLabel
							value={status}
							fieldClassName="min-w-0 flex-1"
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
					</ListSearch>
				}
				footer={
					<>
						{list.problem ? <Callout tone="danger">{describeProblem(list.problem)}</Callout> : null}
						{list.cursor ? (
							<Button variant="ghost" size="sm" loading={list.loading} onClick={() => void list.more()}>
								{ADMIN.loadMore}
							</Button>
						) : null}
						{canBulk && selected.size > 0 ? (
							<div className="flex flex-wrap items-center gap-2 rounded-2xl bg-primary-soft p-3 text-sm text-on-primary-soft">
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
					</>
				}>
				{list.items.length === 0 ? (
					<li>
						<EmptyState compact icon="users" kind="merchant" title={ADMIN.noMerchants} />
					</li>
				) : (
					list.items.map((m) => {
						const status = statusOf(m, billingOf(m.merchantId));
						return (
							<ListRow
								key={m.merchantId}
								href={adminRoutes.merchant(m.merchantId, keep)}
								current={m.merchantId === selectedId}
								label={m.name}
								sublabel={m.email}
								dot={STATUS_DOTS[status] ?? 'neutral'}
								dotLabel={statusLabel(status)}
								meta={balanceOf(m)}
								leading={
									canBulk ? (
										<input
											type="checkbox"
											aria-label={ADMIN.selectMerchant(m.name)}
											checked={selected.has(m.merchantId)}
											onChange={() => toggle(m.merchantId)}
											className="size-4 cursor-pointer accent-primary"
										/>
									) : undefined
								}
							/>
						);
					})
				)}
			</ListPane>
			<AddMerchantDialog
				open={adding}
				onClose={() => setAdding(false)}
				onCreated={(merchant) => {
					setAdding(false);
					if (merchant?.merchantId) window.location.assign(adminRoutes.merchant(merchant.merchantId, keep));
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
		</>
	);
}

/**
 * The selected merchant: header with the actions, website cards, credits and activity.
 * @param {{ detail: any, admin: any, back: string }} props `back`: the list's URL (after a delete)
 */
function MerchantDetail({ detail, admin, back }) {
	const toast = useToast();
	const [merchant, setMerchant] = useState(detail.merchant);
	const [rows, setRows] = useState(/** @type {Array<{ website: any, cards: any[] }>} */ (detail.rows));
	const [dialog, setDialog] = useState(
		/** @type {null | 'suspend' | 'resume' | 'twoStep' | 'delete' | 'addWebsite' | 'edit' | 'credits'} */ (null),
	);
	const [reason, setReason] = useState('');
	const [link, setLink] = useState(/** @type {string | null} */ (null));
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const merchantId = merchant.merchantId;
	const can = (/** @type {string} */ p) => adminCan(admin, p);
	const billing = detail.billing ?? null;
	const balance = billing?.balance;

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
	/** @param {typeof dialog} next */
	const openDialog = (next) => {
		setProblem(null);
		setDialog(next);
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
		if (result.ok) window.location.assign(back);
	};

	const websiteRights = {
		manage: can('products_on_websites.write'),
		removeWebsite: can('websites.write'),
		tokens: can('tokens.manage'),
		open: can('dashboards.open'),
	};

	const actions = (
		<div className="flex flex-wrap gap-2">
			{can('credits.add') ? (
				<Button onClick={() => openDialog('credits')} icon={<Icon name="plus" size={14} />}>
					{BILLING.addCredits}
				</Button>
			) : null}
			{can('merchants.write') ? (
				<Button variant="secondary" onClick={() => openDialog('edit')}>
					{ADMIN.editMerchant}
				</Button>
			) : null}
			{can('merchants.suspend') ? (
				merchant.status === 'suspended' ? (
					<Button variant="secondary" onClick={() => openDialog('resume')}>
						{ADMIN.resume}
					</Button>
				) : (
					<Button variant="secondary" onClick={() => openDialog('suspend')}>
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
				<Button variant="secondary" onClick={() => openDialog('twoStep')}>
					{ADMIN.turnOffTwoStep}
				</Button>
			) : null}
			{can('merchants.delete') ? (
				<Button
					variant="danger"
					onClick={() => openDialog('delete')}
					disabled={rows.length > 0}
					title={rows.length > 0 ? ADMIN.deleteBlocked : undefined}>
					{ADMIN.deleteMerchant}
				</Button>
			) : null}
		</div>
	);

	return (
		<>
			<PageHeader
				level={2}
				title={merchant.name}
				badge={<MerchantStatus merchant={merchant} billing={billing} />}
				subtitle={
					<span className="flex flex-wrap gap-x-4 gap-y-1">
						<span>
							{merchant.ownerName ? `${merchant.ownerName} · ` : ''}
							{merchant.email}
						</span>
						{typeof balance === 'number' ? (
							<span>
								{BILLING.balance}: <strong className="tabular-nums text-fg">{formatCredits(balance)}</strong>
								{typeof billing?.dailySpend === 'number' ? ` · ${WEBSITE.perDay(formatCredits(billing.dailySpend))}` : ''}
							</span>
						) : null}
					</span>
				}
				actions={actions}
			/>
			{merchant.suspension ? <Callout tone="danger">{ADMIN.suspendedBecause(merchant.suspension.reason)}</Callout> : null}
			<Section
				id="merchant-websites"
				title={ADMIN.websitesTitle}
				description={ADMIN.websitesIntro}
				actions={
					can('websites.write') ? (
						<Button variant="secondary" onClick={() => openDialog('addWebsite')} icon={<Icon name="plus" size={14} />}>
							{WEBSITE.addWebsite}
						</Button>
					) : null
				}>
				{rows.length === 0 ? (
					<EmptyState compact icon="globe" kind="website" title={WEBSITE.none} />
				) : (
					<ul className="grid gap-5 xl:grid-cols-2">
						{rows.map((row) => (
							<li key={row.website.websiteId} className="min-w-0">
								<WebsiteCard
									website={row.website}
									cards={row.cards}
									can={websiteRights}
									fetcher={adminFetch}
									addable={detail.addable}
									launch={(productId) => ({
										path: api.adminLaunch(productId),
										body: { websiteId: String(row.website.websiteId) },
									})}
									onCardsChange={(cards) =>
										setRows((list) =>
											list.map((r) => (r.website.websiteId === row.website.websiteId ? { ...r, cards } : r)),
										)
									}
									onRemoved={() => setRows((list) => list.filter((r) => r.website.websiteId !== row.website.websiteId))}
								/>
							</li>
						))}
					</ul>
				)}
			</Section>
			<Section id="merchant-credits" title={ADMIN.creditsTitle} description={ADMIN.creditsIntro}>
				<MerchantCredits billing={billing} receipts={detail.receipts ?? []} dayCharges={detail.dayCharges ?? []} />
			</Section>
			<Section id="merchant-activity" title={ADMIN.activityTitle}>
				<ActivityTable items={detail.activity?.items ?? []} empty={ADMIN.noActivity} />
			</Section>
			<Dialog open={dialog === 'edit'} onClose={() => setDialog(null)} title={ADMIN.editMerchant} size="lg">
				<MerchantFieldsForm
					merchant={merchant}
					path={adminApi.merchant(merchantId)}
					withEmail
					emailLocked={!merchant.setupPending}
					emailLockedHelp={ADMIN.emailLocked}
					onSaved={(m) => {
						setMerchant(m);
						setDialog(null);
					}}
					fetcher={adminFetch}
				/>
			</Dialog>
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
			<AddWebsiteDialog
				open={dialog === 'addWebsite'}
				merchantId={merchantId}
				fetcher={adminFetch}
				onClose={() => setDialog(null)}
				onAdded={(website) => {
					setDialog(null);
					setRows((list) => [...list, { website, cards: [] }]);
				}}
			/>
			<CopyLinkDialog link={link} onClose={() => setLink(null)} />
			{dialog === 'credits' ? (
				<AddCreditsDialog
					merchant={{ merchantId, name: merchant.name }}
					balance={balance}
					onClose={() => setDialog(null)}
					onAdded={() => window.location.reload()}
				/>
			) : null}
		</>
	);
}

/**
 * The Merchants screen: the list beside the selected merchant (or a short empty state).
 * @param {any} props loader result of `loadMerchants` plus `admin` and, with a merchant selected, `detail` (the
 *   result of `loadMerchant`)
 */
export function MerchantsView(props) {
	if (!props.ok) return <AdminProblem problem={props.problem} />;
	const admin = props.admin;
	const detail = props.detail ?? null;
	const selectedId = detail ? (detail.ok ? String(detail.merchant.merchantId) : (props.selectedId ?? null)) : null;
	const back = adminRoutes.merchants({ q: props.filter.q, status: props.filter.status });
	return (
		<ListDetail
			label={ADMIN.merchantsTitle}
			back={{ href: back, label: ADMIN.merchantsTitle }}
			list={<MerchantList props={props} admin={admin} selectedId={selectedId} />}
			empty={
				<EmptyState icon="users" kind="merchant" title={ADMIN.selectMerchantTitle} description={ADMIN.selectMerchantHelp} />
			}
			detail={
				detail === null ? null : detail.ok ? (
					<MerchantDetail key={selectedId} detail={detail} admin={admin} back={back} />
				) : (
					<AdminProblem problem={detail.problem} back={{ href: back, label: ADMIN.merchantsTitle }} />
				)
			}
		/>
	);
}
