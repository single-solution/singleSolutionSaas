'use client';
/**
 * Admin Merchants (flat layout 2026-10-21, K-3a): a list of rich rows beside the picked merchant's page.
 * The list column has a search box (by business name, owner email or domain), status filter chips, cursor paging,
 * and bulk select mode (Suspend, Resume, Resend setup link). The merchant's page: a header (status, balance, daily cost,
 * actions and a More menu with dialogs) and all sections open on one page: Websites (each website a rich Row linking
 * to its own page), Credits, Details, and Activity (a timeline of Rows with Show more).
 * @module
 */
import { useId, useState } from 'react';
import {
	ActionMenu,
	Button,
	Callout,
	Card,
	CodeBlock,
	ConfirmDialog,
	Dialog,
	Drawer,
	EmptyState,
	Form,
	FormError,
	Icon,
	Input,
	KeyValueList,
	ListColumn,
	LocalTime,
	Page,
	Row,
	Select,
	TextArea,
	describeProblem,
	fieldErrors,
	formatCredits,
	useNarrow,
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

/** How the status of a merchant looks as a pill. */
const STATUS_PILLS = /** @type {Record<string, 'active' | 'warning' | 'error' | 'setup'>} */ ({
	active: 'active',
	low_balance: 'warning',
	grace: 'warning',
	stopped: 'error',
	suspended: 'error',
	setup: 'setup',
});

/** @type {Record<string, 'success' | 'warning' | 'danger' | 'accent'>} */
const ROW_STATUS_TONES = {
	active: 'success',
	warning: 'warning',
	error: 'danger',
	setup: 'accent',
};

/** Merchants per page of the list. */
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
		? { status: /** @type {const} */ ('setup'), label: ADMIN.setupPending }
		: { status: STATUS_PILLS[status] ?? /** @type {const} */ ('active'), label: statusLabel(status) };
};

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
	const handleInput = (/** @type {any} */ e) => {
		const { name, value } = e.currentTarget;
		setForm((f) => ({ ...f, [name]: value }));
	};
	const handleCountry = (/** @type {any} */ e) => {
		const { value } = e.currentTarget;
		setForm((f) => ({ ...f, country: value }));
	};
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
					name="name"
					label={MERCHANT_FIELDS.name}
					value={form.name}
					onChange={handleInput}
					error={errors.name}
					required
					maxLength={120}
				/>
				<Input
					name="ownerName"
					label={MERCHANT_FIELDS.ownerName}
					value={form.ownerName}
					onChange={handleInput}
					error={errors.ownerName}
					required
					maxLength={120}
				/>
				<Input
					name="email"
					label={MERCHANT_FIELDS.email}
					type="email"
					value={form.email}
					onChange={handleInput}
					error={errors.email}
					required
				/>
				<Input
					name="phone"
					label={MERCHANT_FIELDS.phone}
					help={MERCHANT_FIELDS.phoneHelp}
					value={form.phone}
					onChange={handleInput}
					error={errors.phone}
					maxLength={40}
				/>
				<Select
					label={MERCHANT_FIELDS.country}
					value={form.country}
					onChange={handleCountry}
					error={errors.country}
					options={countryOptions(MERCHANT_FIELDS.countryNone)}
				/>
				<Input
					name="address"
					label={MERCHANT_FIELDS.address}
					value={form.address}
					onChange={handleInput}
					error={errors.address}
					maxLength={300}
					wide
				/>
				<FormError problem={problem} fields={['name', 'ownerName', 'email', 'phone', 'address', 'country']} />
			</Form>
		</Drawer>
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
 * A merchant's page with all sections open: Websites, Credits, Details, Activity.
 * @param {{ detail: any, admin: any, list?: import('react').ReactElement<any>, onAddMerchant?: () => void }} props
 */
function MerchantPageView({ detail, admin, list, onAddMerchant }) {
	const toast = useToast();
	const nav = useNavigation();
	const [merchant, setMerchant] = useState(detail.merchant);
	const [rows, setRows] = useState(/** @type {Array<{ website: any, cards: any[] }>} */ (detail.rows ?? []));
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
	const id = String(merchantId);
	const can = (/** @type {string} */ p) => adminCan(admin, p);
	const billing = detail.billing ?? null;
	const balance = billing?.balance;
	const activityList = usePagedList((cursor) => withCursor(adminApi.merchantActivity(merchantId), cursor), detail.activity);

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
	const closeDialog = () => setDialog(null);

	const suspendOrResume = async () => {
		const suspend = dialog === 'suspend';
		const result = await act(
			suspend ? adminApi.suspend(merchantId) : adminApi.resume(merchantId),
			suspend ? { reason: reason.trim() } : {},
		);
		if (!result.ok) return;
		setMerchant(result.data);
		closeDialog();
		setReason('');
	};

	const resendSetupLink = async () => {
		const result = await act(adminApi.setupLink(merchantId), { copy: false });
		if (!result.ok) {
			toast.show({ tone: 'danger', title: describeProblem(result.problem) });
			return;
		}
		toast.show({ title: result.data?.mailed ? ADMIN.setupLinkSent : ADMIN.setupNotMailed });
	};

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
		{ label: MORE.openInActivity, onSelect: () => nav.go(adminRoutes.activity({ merchantId })) },
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

	const pill = pillOf(merchant, billing);
	const merchantsCrumb = { label: ADMIN.merchantsTitle, href: adminRoutes.merchants() };
	const attention = billing && ['low_balance', 'grace', 'stopped'].includes(billing.status);
	const tone = /** @type {'danger' | 'warning' | undefined} */ (
		billing?.status === 'stopped' ? 'danger' : attention ? 'warning' : undefined
	);

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

	const sites = rows.map((r) => ({
		id: String(r.website.websiteId),
		domain: String(r.website.domain),
		products: r.cards?.length ?? 0,
		cost: dailyCostOf(r.cards ?? []),
		dot: websiteDot(r.cards ?? []),
	}));

	const addWebsite = can('websites.write') ? (
		<Button onClick={() => openDialog('addWebsite')} icon={<Icon name="plus" size={14} />}>
			{WEBSITE.addWebsite}
		</Button>
	) : null;

	const sections = [
		{
			id: 'websites',
			label: ADMIN.websitesTitle,
			body: (
				<div className="space-y-4">
					{merchant.suspension || (billing && attention) ? notices : null}
					<Card title={ADMIN.websitesTitle} actions={addWebsite}>
						{sites.length === 0 ? (
							<EmptyState
								icon="globe"
								kind="website"
								title={WEBSITE.none}
								description={can('websites.write') ? ADMIN.noWebsitesHelp : undefined}
								action={addWebsite}
							/>
						) : (
							<div className="divide-y divide-line-soft">
								{sites.map((s) => (
									<Row
										key={s.id}
										lead={{ icon: 'globe' }}
										title={s.domain}
										status={{ tone: s.dot, label: SITE_PILLS[s.dot]?.label ?? s.dot }}
										meta={[
											s.products > 0
												? `${s.products} ${s.products === 1 ? 'product' : ADMIN.merchantColumns.products}`
												: WEBSITE.noProductsMerchant,
											typeof s.cost === 'number' ? WEBSITE.perDay(formatCredits(s.cost)) : null,
										].filter(Boolean)}
										href={adminRoutes.website(id, s.id)}
										linkAs={Link}
										trailing={
											<ActionMenu
												floating
												label={`Actions for ${s.domain}`}
												items={[
													{ label: WEBSITE.open, onSelect: () => nav.go(adminRoutes.website(id, s.id)) },
													...(can('website_settings.read')
														? [
																{
																	label: WEBSITE.websiteSettings,
																	onSelect: () => nav.go(adminRoutes.websiteSettings(id, s.id)),
																},
															]
														: []),
													...(can('tokens.manage')
														? [{ label: WEBSITE.setup, onSelect: () => nav.go(adminRoutes.websiteSetup(id, s.id)) }]
														: []),
												]}
											/>
										}
									/>
								))}
							</div>
						)}
					</Card>
				</div>
			),
		},
		{
			id: 'credits',
			label: ADMIN.creditsTitle,
			body: (
				<div className="space-y-4">
					<Card title={ADMIN.creditsTitle}>
						<MerchantCredits billing={billing} receipts={detail.receipts ?? []} dayCharges={detail.dayCharges ?? []} />
					</Card>
				</div>
			),
		},
		{
			id: 'details',
			label: MORE.detailsTitle,
			body: (
				<Card title={MORE.detailsTitle}>
					<KeyValueList columns={3} items={detailItems(merchant)} />
				</Card>
			),
		},
		{
			id: 'activity',
			label: ADMIN.activityTitle,
			body: (
				<Card title={ADMIN.activityTitle}>
					<ActivityTable
						items={activityList.items}
						caption={ADMIN.activityTitle}
						empty={MORE.noActivity}
						details
						filterHref={(q) => adminRoutes.activity(q)}
					/>
					{activityList.cursor ? (
						<div className="flex justify-center pt-3">
							<Button
								variant="secondary"
								size="sm"
								loading={activityList.loading}
								onClick={() => void activityList.more()}>
								{MORE.showMore}
							</Button>
						</div>
					) : null}
				</Card>
			),
		},
	];

	return (
		<>
			<Page
				linkAs={Link}
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
						...(can('websites.write')
							? [
									{
										label: WEBSITE.addWebsite,
										icon: /** @type {const} */ ('plus'),
										onClick: () => openDialog('addWebsite'),
									},
								]
							: []),
						...(onAddMerchant && can('merchants.write')
							? [{ label: ADMIN.addMerchant, icon: /** @type {const} */ ('plus'), onClick: onAddMerchant }]
							: []),
					],
					more,
				}}
				sections={sections}
				{...(list ? { list } : {})}>
				<></>
			</Page>

			<Drawer open={dialog === 'edit'} onClose={closeDialog} title={ADMIN.editMerchant}>
				<MerchantFieldsForm
					merchant={merchant}
					path={adminApi.merchant(merchantId)}
					withEmail
					emailLocked={!merchant.setupPending}
					emailLockedHelp={ADMIN.emailLocked}
					onSaved={(m) => {
						setMerchant(m);
						closeDialog();
					}}
				/>
			</Drawer>
			<ConfirmDialog
				open={dialog === 'suspend' || dialog === 'resume'}
				onClose={closeDialog}
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
				onClose={closeDialog}
				onDone={closeDialog}
			/>
			<AddWebsiteDialog
				open={dialog === 'addWebsite'}
				merchantId={merchantId}
				onClose={closeDialog}
				onAdded={(website) => {
					closeDialog();
					setRows((prev) => [...prev, { website, cards: [] }]);
				}}
			/>
			<CopyLinkDialog link={link} onClose={() => setLink(null)} />
			{dialog === 'usage' ? (
				<MerchantUsageDialog merchantId={merchantId} title={MORE.usageAllTitle(merchant.name)} onClose={closeDialog} />
			) : null}
			{dialog === 'credits' ? (
				<AddCreditsDialog
					merchant={{ merchantId, name: merchant.name }}
					balance={balance}
					onClose={closeDialog}
					onAdded={() => window.location.reload()}
				/>
			) : null}
		</>
	);
}

/**
 * The unified Merchants screen: ListColumn beside the picked merchant's page.
 * @param {{ list?: any, detail?: any, merchantId?: string | null, fromList?: boolean, section?: string, admin: any }} props
 */
function MerchantsScreen({ list, detail, merchantId, fromList = false, admin }) {
	const nav = useNavigation();
	const toast = useToast();
	const phone = useNarrow();
	const filter = list?.filter ?? {};
	const [query, setQuery] = useState(filter.q ?? '');
	const pagedList = usePagedList(
		(cursor) => adminApi.merchants({ ...merchantFilter(filter.status), q: filter.q, cursor, limit: PAGE_SIZE }),
		list?.page,
	);
	const [adding, setAdding] = useState(false);
	const [bulk, setBulk] = useState(/** @type {null | 'suspend' | 'resume' | 'resend_setup_link'} */ (null));
	const closeAdding = () => setAdding(false);
	const openAdding = () => setAdding(true);
	const closeBulk = () => setBulk(null);
	const [reason, setReason] = useState('');
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const canSuspend = adminCan(admin, 'merchants.suspend');
	const canLink = adminCan(admin, 'merchants.setup_link');
	const canBulk = canSuspend || canLink;

	const selection = useRowSelection(pagedList.items, (m) => String(m.merchantId));
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
		closeBulk();
		setReason('');
		selection.done();
		await pagedList.reload();
	};

	const filtered = Boolean(filter.q || filter.status);
	const items = pagedList.items;
	const selectedId =
		merchantId ?? (fromList ? (phone ? null : items[0]?.merchantId ? String(items[0].merchantId) : null) : null);

	const listColumn = (
		<ListColumn
			label={ADMIN.merchantsTitle}
			items={items}
			idOf={(m) => String(m.merchantId)}
			selected={selectedId}
			onBack={() => nav.go(adminRoutes.merchants())}
			search={{
				value: query,
				placeholder: ADMIN.searchMerchants,
				onChange: setQuery,
				onSearch: (q) => refine({ q: q.trim() || null }),
			}}
			filters={{
				value: filter.status ?? 'all',
				onChange: (status) => refine({ status: status === 'all' ? null : status }),
				options: [
					{ id: 'all', label: ADMIN.allStatuses },
					{ id: 'active', label: ADMIN.status.active },
					{ id: 'suspended', label: ADMIN.status.suspended },
					{ id: 'setup_pending', label: ADMIN.setupPending },
				],
			}}
			hasMore={pagedList.cursor !== null}
			onMore={() => pagedList.more()}
			rowOf={(m) => {
				const billing = list?.billing?.[m.merchantId] ?? m.billing ?? null;
				const pill = pillOf(m, billing);
				const trouble =
					m.status === 'suspended'
						? {
								tone: /** @type {const} */ ('danger'),
								text: m.suspension?.reason ? ADMIN.suspendedBecause(m.suspension.reason) : ADMIN.status.suspended,
							}
						: billing && ['low_balance', 'grace', 'stopped'].includes(billing.status)
							? {
									tone:
										billing.status === 'stopped' ? /** @type {const} */ ('danger') : /** @type {const} */ ('warning'),
									text: statusLabel(billing.status),
								}
							: m.setupPending
								? { tone: /** @type {const} */ ('accent'), text: ADMIN.setupPending }
								: null;
				return {
					lead: { avatar: m.name },
					title: m.name,
					status: { tone: ROW_STATUS_TONES[pill.status] ?? 'neutral', label: pill.label },
					...(trouble ? { warning: trouble } : { meta: [m.email].filter(Boolean) }),
					value: billing ? formatCredits(billing.balance) : '—',
					time: m.lastSignInAt ? <LocalTime value={m.lastSignInAt} /> : null,
					href: adminRoutes.merchant(m.merchantId),
					linkAs: Link,
				};
			}}
			empty={{
				icon: 'users',
				kind: 'merchant',
				title: filtered ? ADMIN.noMerchants : ADMIN.noMerchantsYet,
				description: filtered ? undefined : ADMIN.noMerchantsYetHelp,
			}}
			{...(canBulk
				? {
						selection: {
							...selection,
							actions: (
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
								</>
							),
						},
					}
				: {})}
		/>
	);

	const confirmDialog = (
		<ConfirmDialog
			open={bulk !== null}
			onClose={closeBulk}
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
	);

	const addMerchantDialog = (
		<AddMerchantDialog
			open={adding}
			onClose={closeAdding}
			onCreated={(m) => {
				closeAdding();
				if (m?.merchantId) nav.go(adminRoutes.merchant(m.merchantId));
			}}
		/>
	);

	if (detail) {
		return (
			<>
				<MerchantPageView
					detail={detail}
					admin={admin}
					list={list ? listColumn : undefined}
					onAddMerchant={adminCan(admin, 'merchants.write') ? openAdding : undefined}
				/>
				{addMerchantDialog}
				{confirmDialog}
			</>
		);
	}

	if (items.length === 0 && !pagedList.loading) {
		return (
			<>
				<Page
					flush
					crumbs={[{ label: ADMIN.merchantsTitle }]}
					info={ADMIN.merchantsInfo}
					linkAs={Link}
					{...(adminCan(admin, 'merchants.write')
						? { actions: { primary: { label: ADMIN.addMerchant, icon: 'plus', onClick: openAdding } } }
						: {})}>
					<EmptyState
						icon="users"
						kind="merchant"
						title={filtered ? ADMIN.noMerchants : ADMIN.noMerchantsYet}
						description={filtered ? undefined : ADMIN.noMerchantsYetHelp}
					/>
				</Page>
				{addMerchantDialog}
			</>
		);
	}

	return (
		<>
			<Page
				flush
				crumbs={[{ label: ADMIN.merchantsTitle }]}
				info={ADMIN.merchantsInfo}
				linkAs={Link}
				list={listColumn}
				{...(adminCan(admin, 'merchants.write')
					? { actions: { primary: { label: ADMIN.addMerchant, icon: 'plus', onClick: openAdding } } }
					: {})}>
				<></>
			</Page>
			{addMerchantDialog}
			{confirmDialog}
		</>
	);
}

/**
 * The Merchants screen.
 * @param {any} props loader result of `loadMerchants` (the list) or `{ detail, admin, list, section, merchantId }`
 */
export function MerchantsView(props) {
	if (props.ok === false) return <AdminProblem problem={props.problem} />;
	const detail = props.detail ?? null;
	const list = props.list ?? (props.page ? props : null);
	const admin = props.admin;

	if (detail && !detail.ok) return <AdminProblem problem={detail.problem} />;
	if (list && !list.ok) return <AdminProblem problem={list.problem} />;

	return (
		<MerchantsScreen
			list={list}
			detail={detail}
			merchantId={props.merchantId ?? (detail?.merchant ? String(detail.merchant.merchantId) : null)}
			fromList={Boolean(props.fromList)}
			admin={admin}
		/>
	);
}
