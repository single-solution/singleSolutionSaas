'use client';
/**
 * Admin Merchants (PLAN 0.8.2, 0.6; layout contract 2026-10-17): the Merchants page is a table (search by business name,
 * owner email or domain; a status filter; paged at 50; Select starts the bulk bar: Suspend, Resume, Resend setup link;
 * Add merchant in a drawer) whose row opens the merchant's page. The merchant's page: a header (name, status pill,
 * balance, daily cost and websites as numbers; Add credits, Edit merchant and a More menu with Suspend / Resume, Resend
 * or Copy setup link, Turn off two-step, Delete and the usage of all its websites, all as dialogs) and its parts in the
 * inner navigation, each its own address: Websites (a table; a row opens the website's own page, with the website
 * card), Credits, Details and Activity (paged). Rights follow the role (PLAN 0.2); the API checks them again.
 * @module
 */
import { useId, useState } from 'react';
import {
	Button,
	Callout,
	Card,
	CodeBlock,
	ConfirmDialog,
	DataTable,
	Dialog,
	Drawer,
	EmptyState,
	Form,
	FormError,
	Icon,
	Input,
	KeyValueList,
	LocalTime,
	Page,
	Pagination,
	Select,
	TextArea,
	Toolbar,
	describeProblem,
	fieldErrors,
	formatCredits,
	useRowSelection,
	useToast,
} from '@ss/ui';
import { ADMIN, BILLING, MERCHANT_FIELDS, MORE, TWO_STEP, WEBSITE } from '../../../texts/console.js';
import { withCursor } from '../../paths.js';
import { DaysLeft } from '../../views/billing.js';
import { MerchantFieldsForm, countryOptions } from '../../views/account.js';
import { COUNTRY_NAMES } from '../../../modules/identity/core/countries.js';
import { Link } from '../../link.js';
import { ConfirmChange } from '../../views/confirm-change.js';
import { ActivityTable } from '../../views/login-settings.js';
import { useListPages } from '../../views/paging.js';
import { AddWebsiteDialog, MerchantUsageDialog, dailyCostOf, websiteDot } from '../../views/website.js';
import { useNavigation } from '../../navigation.js';
import { apiConfirm, apiFetch, usePagedList } from '../../client.js';
import { adminApi, adminRoutes, merchantFilter } from '../paths.js';
import { AdminProblem, adminCan } from './common.js';
import { SITE_PILLS } from './website.js';
import { AddCreditsDialog, MerchantCredits } from './finance.js';

/** @typedef {import('@ss/ui').Problem} Problem */

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
 * The setup link shown once to copy (PLAN 0.2: shown once, only to that admin, logged).
 * @param {{ link: string | null, onClose: () => void }} props
 */
function CopyLinkDialog({ link, onClose }) {
	return (
		<Dialog
			open={Boolean(link)}
			onClose={onClose}
			title={ADMIN.copySetupLink}
			description={ADMIN.setupLinkCopy}
			placement="center">
			{link ? <CodeBlock code={link} label={ADMIN.copySetupLink} secret wrap /> : null}
		</Dialog>
	);
}

/**
 * Add merchant: the merchant fields; saving emails the setup link (or offers to copy it).
 * @param {{ open: boolean, onClose: () => void, onCreated: (merchant: any) => void }} props
 */
export function AddMerchantDialog({ open, onClose, onCreated }) {
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
		const result = await apiFetch(adminApi.createMerchant(), { method: 'POST', body });
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
	const formId = useId();
	return (
		<Drawer
			open={open}
			onClose={onClose}
			title={ADMIN.addMerchant}
			footer={
				<>
					<Button variant="secondary" onClick={onClose}>
						{MORE.cancel}
					</Button>
					<Button type="submit" form={formId} loading={busy}>
						{ADMIN.addMerchant}
					</Button>
				</>
			}>
			<Form id={formId} onSubmit={submit} busy={busy} aria-label={ADMIN.addMerchant}>
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
			</Form>
		</Drawer>
	);
}

/** How the status of a merchant looks as a pill. */
const STATUS_PILLS = /** @type {Record<string, 'active' | 'warning' | 'error' | 'setup'>} */ ({
	active: 'active',
	low_balance: 'warning',
	grace: 'warning',
	stopped: 'error',
	suspended: 'error',
	setup: 'setup',
});

/** Merchants per page of the table. */
const PAGE_SIZE = 50;

/**
 * The pill of a merchant: Setup pending until the password is set, else the status.
 * @param {any} merchant
 * @param {any} billing
 * @returns {{ status: 'active' | 'warning' | 'error' | 'setup', label: string }}
 */
const pillOf = (merchant, billing) => {
	const status = statusOf(merchant, billing);
	return merchant.setupPending && status === 'active'
		? { status: 'setup', label: ADMIN.setupPending }
		: { status: STATUS_PILLS[status] ?? 'active', label: statusLabel(status) };
};

/**
 * The Merchants page: a table (search by name, owner email or domain; a status filter; paged at 50) whose row opens the
 * merchant's page. Select starts the bulk bar (Suspend, Resume, Resend setup link) for the rights that allow it.
 * @param {{ props: any, admin: any }} input
 */
function MerchantsPage({ props, admin }) {
	const toast = useToast();
	const nav = useNavigation();
	const filter = props.filter ?? {};
	const list = usePagedList(
		(cursor) => adminApi.merchants({ ...merchantFilter(filter.status), q: filter.q, cursor, limit: PAGE_SIZE }),
		props.page,
	);
	const [pageNo, setPageNo] = useState(0);
	const [adding, setAdding] = useState(false);
	const [bulk, setBulk] = useState(/** @type {null | 'suspend' | 'resume' | 'resend_setup_link'} */ (null));
	const [reason, setReason] = useState('');
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const canSuspend = adminCan(admin, 'merchants.suspend');
	const canLink = adminCan(admin, 'merchants.setup_link');
	const canBulk = canSuspend || canLink;
	const start = pageNo * PAGE_SIZE;
	// the balances were checked for the first page only (later pages show none)
	const rows = list.items.slice(start, start + PAGE_SIZE).map((m) => {
		const billing = props.billing?.[m.merchantId] ?? null;
		return { ...m, billing, pill: pillOf(m, billing) };
	});
	const selection = useRowSelection(rows, (m) => String(m.merchantId));
	/** @param {{ q?: string | null, status?: string | null }} next */
	const refine = (next) => nav.go(adminRoutes.merchants({ q: filter.q ?? null, status: filter.status ?? null, ...next }));
	const runBulk = async () => {
		if (!bulk) return;
		setBusy(true);
		setProblem(null);
		const result = await apiFetch(adminApi.bulk(), {
			method: 'POST',
			body: { action: bulk, merchantIds: selection.keys, ...(bulk === 'suspend' ? { reason: reason.trim() } : {}) },
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
		selection.done();
		await list.reload();
	};
	const filtered = Boolean(filter.q || filter.status);
	const end = start + rows.length;
	const more = pageNo * PAGE_SIZE + PAGE_SIZE < list.items.length || list.cursor !== null;
	return (
		<>
			<Page
				flush
				crumbs={[{ label: ADMIN.merchantsTitle }]}
				info={ADMIN.merchantsInfo}
				linkAs={Link}
				{...(adminCan(admin, 'merchants.write')
					? {
							actions: {
								primary: { label: ADMIN.addMerchant, icon: 'plus', onClick: () => setAdding(true) },
							},
						}
					: {})}
				toolbar={
					<Toolbar
						label={ADMIN.merchantsTitle}
						search={{
							value: filter.q ?? '',
							label: ADMIN.searchMerchants,
							placeholder: ADMIN.searchMerchants,
							onSearch: (text) => refine({ q: text.trim() || null }),
						}}
						filters={[
							{
								id: 'status',
								label: ADMIN.columns.status,
								allLabel: ADMIN.allStatuses,
								value: filter.status ?? '',
								onChange: (status) => refine({ status: status || null }),
								options: [
									{ value: 'active', label: ADMIN.status.active },
									{ value: 'suspended', label: ADMIN.status.suspended },
									{ value: 'setup_pending', label: ADMIN.setupPending },
								],
							},
						]}
						range={MORE.count(list.items.length, list.cursor !== null)}
						texts={{ selected: ADMIN.bulk.selected }}
						{...(canBulk
							? selection.toolbar(
									<>
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
									</>,
								)
							: {})}
					/>
				}
				{...(rows.length > 0
					? {
							footer: (
								<Pagination
									range={ADMIN.showing(start + 1, end, list.cursor !== null)}
									hasPrevious={pageNo > 0}
									hasNext={more}
									onPrevious={() => setPageNo((n) => Math.max(0, n - 1))}
									onNext={async () => {
										if (start + PAGE_SIZE >= list.items.length) await list.more();
										setPageNo((n) => n + 1);
									}}
								/>
							),
						}
					: {})}>
				{list.problem ? <Callout tone="danger">{describeProblem(list.problem)}</Callout> : null}
				<DataTable
					caption={ADMIN.merchantsTitle}
					rows={rows}
					rowKey={(m) => String(m.merchantId)}
					rowLabel={(m) => m.name}
					selection={canBulk ? selection : undefined}
					onRowClick={(m) => nav.go(adminRoutes.merchant(m.merchantId))}
					empty={
						<EmptyState
							icon="users"
							kind="merchant"
							title={filtered ? ADMIN.noMerchants : ADMIN.noMerchantsYet}
							description={filtered ? undefined : ADMIN.noMerchantsYetHelp}
						/>
					}
					columns={[
						{
							key: 'name',
							header: ADMIN.merchantColumns.name,
							sortable: true,
							render: (m) => (
								<Link href={adminRoutes.merchant(m.merchantId)} className="font-medium text-fg hover:underline">
									{m.name}
								</Link>
							),
						},
						{ key: 'email', header: ADMIN.merchantColumns.email, low: true },
						{ key: 'status', header: ADMIN.columns.status, kind: 'status', pill: (m) => m.pill },
						{
							key: 'balance',
							header: ADMIN.merchantColumns.balance,
							kind: 'money',
							sortValue: (m) => m.billing?.balance,
							render: (m) => (m.billing ? formatCredits(m.billing.balance) : '—'),
						},
						{
							key: 'dailyCost',
							header: ADMIN.merchantColumns.dailyCost,
							kind: 'money',
							low: true,
							sortValue: (m) => m.billing?.dailySpend,
							render: (m) =>
								typeof m.billing?.dailySpend === 'number' ? WEBSITE.perDay(formatCredits(m.billing.dailySpend)) : '—',
						},
						{ key: 'createdAt', header: ADMIN.merchantColumns.added, kind: 'date', low: true, sortable: true },
					]}
				/>
			</Page>
			<AddMerchantDialog
				open={adding}
				onClose={() => setAdding(false)}
				onCreated={(merchant) => {
					setAdding(false);
					if (merchant?.merchantId) nav.go(adminRoutes.merchant(merchant.merchantId));
				}}
			/>
			<ConfirmDialog
				open={bulk !== null}
				onClose={() => setBulk(null)}
				onConfirm={() => void runBulk()}
				busy={busy}
				danger={bulk === 'suspend'}
				confirmLabel={bulk === 'suspend' ? ADMIN.bulk.suspend : bulk === 'resume' ? ADMIN.bulk.resume : ADMIN.bulk.resend}
				title={ADMIN.bulk.selected(selection.count)}
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

/** @param {string | null | undefined} code ISO 3166-1 alpha-2 */
const countryName = (code) => (code ? (COUNTRY_NAMES[code] ?? code) : '—');

/**
 * The merchant's details: what the page header (status, balance, daily cost) does not already show.
 * @param {any} merchant
 */
const detailItems = (merchant) => [
	{ label: MERCHANT_FIELDS.ownerName, value: merchant.ownerName ?? '—' },
	{ label: MERCHANT_FIELDS.email, value: merchant.email },
	{ label: MORE.fields.phone, value: merchant.phone ?? '—' },
	{ label: MORE.fields.country, value: <span suppressHydrationWarning>{countryName(merchant.country)}</span> },
	{ label: MORE.fields.address, value: merchant.address ?? '—' },
	{ label: MORE.fields.added, value: <LocalTime value={merchant.createdAt} /> },
	{
		label: MORE.fields.lastSignIn,
		value: merchant.lastSignInAt ? <LocalTime value={merchant.lastSignInAt} /> : MORE.never,
	},
	{
		label: MORE.fields.twoStep,
		value: merchant.twoStep?.enabled ? MORE.twoStepOn(merchant.twoStep.recoveryCodesLeft ?? 0) : TWO_STEP.off,
	},
	{ label: MORE.fields.password, value: merchant.setupPending ? MORE.fields.setupPending : MORE.fields.passwordSet },
];

/**
 * A merchant's page: the header (status, balance, daily cost, the actions) and one part of it at a time, each part its
 * own address (Websites, Credits, Details, Activity); a website of it has its own page (`website.js`).
 * @param {{ detail: any, admin: any, section?: string }} props
 */
function MerchantPage({ detail, admin, section = 'websites' }) {
	const toast = useToast();
	const [merchant, setMerchant] = useState(detail.merchant);
	const [rows, setRows] = useState(/** @type {Array<{ website: any, cards: any[] }>} */ (detail.rows));
	const [dialog, setDialog] = useState(
		/** @type {null | 'suspend' | 'resume' | 'twoStep' | 'delete' | 'copyLink' | 'addWebsite' | 'edit' | 'credits' | 'usage'} */ (
			null
		),
	);
	const [reason, setReason] = useState('');
	const [link, setLink] = useState(/** @type {string | null} */ (null));
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const merchantId = merchant.merchantId;
	const can = (/** @type {string} */ p) => adminCan(admin, p);
	const billing = detail.billing ?? null;
	const balance = billing?.balance;
	const nav = useNavigation();
	const activity = usePagedList((cursor) => withCursor(adminApi.merchantActivity(merchantId), cursor), detail.activity);
	const activityPages = useListPages(activity);

	/**
	 * @param {string} path
	 * @param {Record<string, unknown>} [body]
	 * @param {string} [method]
	 */
	const act = async (path, body, method = 'POST') => {
		setBusy(true);
		setProblem(null);
		const result = await apiFetch(path, { method, ...(body ? { body } : {}) });
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
	// mailing the setup link again needs no password (the link is not shown); copying it does
	const resendSetupLink = async () => {
		const result = await act(adminApi.setupLink(merchantId), { copy: false });
		if (!result.ok) {
			toast.show({ tone: 'danger', title: describeProblem(result.problem) });
			return;
		}
		toast.show({ title: result.data?.mailed ? ADMIN.setupLinkSent : ADMIN.setupNotMailed });
	};
	// a stolen sign-in must not copy a link that signs in as the merchant, turn off a second step or delete a merchant:
	// these three ask for the person's password (and a code while two-step is on)
	/** @param {{ password: string, code?: string, recoveryCode?: string }} confirmation */
	const sendConfirmed = async (confirmation) => {
		setProblem(null);
		const result =
			dialog === 'copyLink'
				? await apiConfirm(adminApi.setupLink(merchantId), { method: 'POST', body: { copy: true, ...confirmation } })
				: dialog === 'twoStep'
					? await apiConfirm(adminApi.merchantTwoStepOff(merchantId), { method: 'POST', body: confirmation })
					: await apiConfirm(adminApi.merchant(merchantId), {
							method: 'DELETE',
							body: { confirm: merchant.name, ...confirmation },
						});
		if (!result.ok) return result;
		if (dialog === 'copyLink') setLink(result.data?.link ?? null);
		else if (dialog === 'twoStep') setMerchant(result.data);
		else nav.go(adminRoutes.merchants());
		return result;
	};

	/** @type {import('@ss/ui').MenuItem[]} */
	const more = [
		{ label: MORE.usageAll, onSelect: () => openDialog('usage') },
		...(can('merchants.suspend')
			? [
					merchant.status === 'suspended'
						? { label: ADMIN.resume, onSelect: () => openDialog('resume') }
						: { label: ADMIN.suspend, onSelect: () => openDialog('suspend') },
				]
			: []),
		...(can('merchants.setup_link') && merchant.setupPending
			? [
					{ label: ADMIN.resendSetupLink, onSelect: () => void resendSetupLink(), disabled: busy },
					{ label: ADMIN.copySetupLink, onSelect: () => openDialog('copyLink') },
				]
			: []),
		...(can('two_step.turn_off') && merchant.twoStep?.enabled
			? [{ label: ADMIN.turnOffTwoStep, onSelect: () => openDialog('twoStep') }]
			: []),
		...(can('merchants.delete')
			? [
					{
						label: ADMIN.deleteMerchant,
						danger: true,
						disabled: rows.length > 0,
						...(rows.length > 0 ? { hint: ADMIN.deleteBlocked } : {}),
						onSelect: () => openDialog('delete'),
					},
				]
			: []),
	];

	const id = String(merchantId);
	const pill = pillOf(merchant, billing);
	const merchantsCrumb = { label: ADMIN.merchantsTitle, href: adminRoutes.merchants() };
	const attention = billing && ['low_balance', 'grace', 'stopped'].includes(billing.status);
	const tone = /** @type {'danger' | 'warning' | undefined} */ (
		billing?.status === 'stopped' ? 'danger' : attention ? 'warning' : undefined
	);
	const sectionIds = ['websites', 'credits', 'details', 'activity'];
	const part = sectionIds.includes(section) ? section : 'websites';
	const notices = (
		<>
			{merchant.suspension ? <Callout tone="danger">{ADMIN.suspendedBecause(merchant.suspension.reason)}</Callout> : null}
			{!merchant.suspension && billing && attention ? (
				<Callout
					tone={billing.status === 'stopped' ? 'danger' : 'warning'}
					actions={
						can('credits.add') ? (
							<Button size="sm" variant="secondary" onClick={() => openDialog('credits')}>
								{BILLING.addCredits}
							</Button>
						) : null
					}>
					{billing.status === 'stopped' ? (
						MORE.stoppedWarning
					) : billing.status === 'grace' ? (
						<>
							{MORE.graceWarning} <DaysLeft summary={billing} />
						</>
					) : (
						MORE.lowWarning(typeof billing.daysLeft === 'number' ? BILLING.days(billing.daysLeft) : '—')
					)}
				</Callout>
			) : null}
		</>
	);
	/** the websites as table rows */
	const sites = rows.map((r) => ({
		id: String(r.website.websiteId),
		domain: String(r.website.domain),
		products: r.cards.length,
		cost: dailyCostOf(r.cards),
		dot: websiteDot(r.cards),
	}));
	const addWebsite = can('websites.write') ? (
		<Button onClick={() => openDialog('addWebsite')} icon={<Icon name="plus" size={14} />}>
			{WEBSITE.addWebsite}
		</Button>
	) : null;
	const bodies = {
		websites: (
			<>
				{merchant.suspension || (billing && attention) ? <div className="space-y-3 p-4 pb-0">{notices}</div> : null}
				<DataTable
					caption={ADMIN.websitesTitle}
					rows={sites}
					rowKey={(s) => s.id}
					rowLabel={(s) => s.domain}
					onRowClick={(s) => nav.go(adminRoutes.website(id, s.id))}
					rowMenu={(s) => [
						{ label: WEBSITE.open, onSelect: () => nav.go(adminRoutes.website(id, s.id)) },
						...(can('website_settings.read')
							? [{ label: WEBSITE.websiteSettings, onSelect: () => nav.go(adminRoutes.websiteSettings(id, s.id)) }]
							: []),
						...(can('tokens.manage')
							? [{ label: WEBSITE.setup, onSelect: () => nav.go(adminRoutes.websiteSetup(id, s.id)) }]
							: []),
					]}
					empty={
						<EmptyState
							icon="globe"
							kind="website"
							title={WEBSITE.none}
							description={can('websites.write') ? ADMIN.noWebsitesHelp : undefined}
							action={addWebsite}
						/>
					}
					columns={[
						{
							key: 'domain',
							header: ADMIN.merchantColumns.website,
							sortable: true,
							render: (s) => (
								<Link href={adminRoutes.website(id, s.id)} className="font-medium text-fg hover:underline">
									{s.domain}
								</Link>
							),
						},
						{ key: 'status', header: ADMIN.columns.status, kind: 'status', pill: (s) => SITE_PILLS[s.dot] },
						{ key: 'products', header: ADMIN.merchantColumns.products, kind: 'number', sortable: true },
						{
							key: 'cost',
							header: ADMIN.merchantColumns.dailyCost,
							kind: 'money',
							sortable: true,
							render: (s) => WEBSITE.perDay(formatCredits(s.cost)),
						},
					]}
				/>
			</>
		),
		credits: (
			<div className="space-y-4">
				{notices}
				<MerchantCredits billing={billing} receipts={detail.receipts ?? []} dayCharges={detail.dayCharges ?? []} />
			</div>
		),
		details: (
			<div className="space-y-4">
				{notices}
				<Card title={MORE.detailsTitle}>
					<KeyValueList columns={3} items={detailItems(merchant)} />
				</Card>
			</div>
		),
		activity: (
			<>
				{merchant.suspension || (billing && attention) ? <div className="space-y-3 p-4 pb-0">{notices}</div> : null}
				{activity.problem ? (
					<div className="p-4">
						<Callout tone="danger">{describeProblem(activity.problem)}</Callout>
					</div>
				) : null}
				<ActivityTable
					items={activityPages.rows}
					caption={ADMIN.activityTitle}
					empty={MORE.noActivity}
					details
					filterHref={(q) => adminRoutes.activity(q)}
				/>
			</>
		),
	};
	const page = (
		<Page
			linkAs={Link}
			flush={part === 'websites' || part === 'activity'}
			bodyKey={part}
			crumbs={[merchantsCrumb, { label: merchant.name }]}
			status={[{ ...pill, ...(merchant.suspension ? { title: merchant.suspension.reason } : {}) }]}
			facts={[
				...(typeof balance === 'number'
					? [{ label: BILLING.balance, value: formatCredits(balance), ...(tone ? { tone } : {}) }]
					: []),
				...(typeof billing?.dailySpend === 'number'
					? [{ label: ADMIN.merchantColumns.dailyCost, value: WEBSITE.perDay(formatCredits(billing.dailySpend)) }]
					: []),
				{ label: ADMIN.websitesTitle, value: rows.length, href: adminRoutes.merchantPart(id, 'websites') },
			]}
			actions={{
				...(can('credits.add')
					? { primary: { label: BILLING.addCredits, icon: 'plus', onClick: () => openDialog('credits') } }
					: {}),
				secondary: [
					...(can('merchants.write') ? [{ label: ADMIN.editMerchant, onClick: () => openDialog('edit') }] : []),
					...(part === 'websites' && can('websites.write')
						? [{ label: WEBSITE.addWebsite, icon: /** @type {const} */ ('plus'), onClick: () => openDialog('addWebsite') }]
						: []),
				],
				more: [
					...more,
					...(part === 'activity'
						? [{ label: MORE.openInActivity, onSelect: () => nav.go(adminRoutes.activity({ merchantId })) }]
						: []),
				],
			}}
			nav={{
				value: part,
				label: ADMIN.merchantParts,
				items: /** @type {import('@ss/ui').InnerNavItem[]} */ ([
					{ id: 'websites', label: ADMIN.websitesTitle, icon: 'globe', count: rows.length },
					{
						id: 'credits',
						label: ADMIN.creditsTitle,
						...(tone && billing ? { dot: tone, dotLabel: statusLabel(billing.status) } : {}),
					},
					{ id: 'details', label: MORE.detailsTitle },
					{ id: 'activity', label: ADMIN.activityTitle },
				]).map((item) => ({ ...item, href: adminRoutes.merchantPart(id, item.id) })),
			}}
			{...(part === 'activity' && activityPages.pagination ? { footer: <Pagination {...activityPages.pagination} /> } : {})}>
			{bodies[/** @type {keyof typeof bodies} */ (part)]}
		</Page>
	);

	return (
		<>
			{page}

			<Drawer open={dialog === 'edit'} onClose={() => setDialog(null)} title={ADMIN.editMerchant}>
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
				/>
			</Drawer>
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
			<ConfirmChange
				open={dialog === 'copyLink' || dialog === 'twoStep' || dialog === 'delete'}
				title={
					dialog === 'copyLink'
						? ADMIN.copySetupLink
						: dialog === 'twoStep'
							? ADMIN.turnOffTwoStep
							: `${ADMIN.deleteMerchant} ${merchant.name}`
				}
				help={
					dialog === 'copyLink'
						? ADMIN.copySetupLinkHelp
						: dialog === 'twoStep'
							? ADMIN.turnOffTwoStepHelp
							: ADMIN.deleteHelp(typeof balance === 'number' ? formatCredits(balance) : '—')
				}
				confirmLabel={
					dialog === 'copyLink' ? ADMIN.copySetupLink : dialog === 'twoStep' ? ADMIN.turnOffTwoStep : ADMIN.deleteMerchant
				}
				danger={dialog !== 'copyLink'}
				{...(dialog === 'delete' ? { expected: merchant.name } : {})}
				send={sendConfirmed}
				onClose={() => setDialog(null)}
				onDone={() => setDialog(null)}
			/>
			<AddWebsiteDialog
				open={dialog === 'addWebsite'}
				merchantId={merchantId}
				onClose={() => setDialog(null)}
				onAdded={(website) => {
					setDialog(null);
					setRows((list) => [...list, { website, cards: [] }]);
				}}
			/>
			<CopyLinkDialog link={link} onClose={() => setLink(null)} />
			{dialog === 'usage' ? (
				<MerchantUsageDialog
					merchantId={merchantId}
					title={MORE.usageAllTitle(merchant.name)}
					onClose={() => setDialog(null)}
				/>
			) : null}
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
 * The Merchants screens. Without a `detail` the list (a table); with the `detail` of `loadMerchant` a merchant's page,
 * on the part `section` (websites, credits, details, activity).
 * @param {any} props loader result of `loadMerchants` (the list) or `{ detail, admin, section }`
 */
export function MerchantsView(props) {
	const detail = props.detail ?? null;
	if (detail) {
		if (!detail.ok) return <AdminProblem problem={detail.problem} />;
		return (
			<MerchantPage key={String(detail.merchant.merchantId)} detail={detail} admin={props.admin} section={props.section} />
		);
	}
	if (!props.ok) return <AdminProblem problem={props.problem} />;
	return <MerchantsPage key={`${props.filter.q ?? ''}|${props.filter.status ?? ''}`} props={props} admin={props.admin} />;
}
