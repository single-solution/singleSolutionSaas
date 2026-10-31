'use client';
/**
 * Credits and billing (PLAN 0.5.8, 0.8.2; layout contract 2026-10-17): the receipt form with its confirm step (Owner
 * and Finance, in a drawer), all receipts, charges by day, merchant or product, the merchants that need attention, and a
 * merchant's Credits section. Credits are whole numbers on screen and integer millicredits on the wire; receipts are
 * never edited or reversed. The page has three sub-pages, each its own address: Needs attention (`/admin/finance`),
 * Receipts (`/admin/finance/receipts`) and Charges (`/admin/finance/charges`); the filters are in the query.
 * @module
 */
import { useMemo, useState } from 'react';
import {
	ActionMenu,
	BarChart,
	Button,
	Card,
	Drawer,
	EmptyState,
	FiguresTable,
	Form,
	FormError,
	Icon,
	Input,
	LocalTime,
	Page,
	Pagination,
	Row,
	Select,
	Toolbar,
	ButtonLink,
	describeProblem,
	fieldErrors,
	formatCredits,
	isEmptySeries,
	useToast,
	usePaged,
	TextLink,
} from '@ss/ui';
import { BILLING, MORE } from '../../../texts/console.js';
import { Link } from '../../link.js';
import { useNavigation } from '../../navigation.js';
import { BillingStats, DaysLeft, formatChartCredits, merchantPill } from '../../views/billing.js';
import { DateFields, periodFilter } from '../../views/range.js';
import { apiFetch } from '../../client.js';
import { adminApi, adminRoutes } from '../paths.js';
import { AdminProblem, adminCan } from './shell.js';

/** @typedef {import('@ss/ui').Problem} Problem */

const F = BILLING.receiptForm;

/** @returns {string} */
const oneTimeKey = () =>
	typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
		? crypto.randomUUID()
		: `rct-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/**
 * Add credits (PLAN 0.5.8): credits, amount paid, payment method and reference, then a confirm step that repeats the
 * merchant, the credits, the amount paid and the new balance. The form carries a one-time key, so a double submit
 * saves once.
 * @param {{ merchant: { merchantId: string, name: string }, balance: number | null | undefined, onClose: () => void,
 *   onAdded: () => void | Promise<void> }} props
 */
export function AddCreditsDialog({ merchant, balance, onClose, onAdded }) {
	const toast = useToast();
	const key = useMemo(oneTimeKey, []);
	const [form, setForm] = useState({ credits: '', amountPaid: '', method: '', reference: '' });
	const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
	const [reviewing, setReviewing] = useState(false);
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const credits = /^\d{1,10}$/.test(form.credits.trim()) ? Number(form.credits.trim()) : 0;
	/** @param {'credits' | 'amountPaid' | 'method' | 'reference'} name */
	const field = (name) => ({
		value: form[name],
		onChange: (/** @type {import('react').ChangeEvent<HTMLInputElement>} */ e) =>
			setForm({ ...form, [name]: e.currentTarget.value }),
		error: errors[`/${name}`] ?? errors[name],
	});
	const review = () => {
		/** @type {Record<string, string>} */
		const local = {};
		if (credits < 1) local.credits = F.creditsHelp;
		if (!form.amountPaid.trim()) local.amountPaid = F.amountPaidHelp;
		if (!form.method.trim()) local.method = F.method;
		setErrors(local);
		if (Object.keys(local).length === 0) setReviewing(true);
	};
	const save = async () => {
		setBusy(true);
		setProblem(null);
		try {
			const result = await apiFetch(adminApi.addReceipt(merchant.merchantId), {
				method: 'POST',
				idempotencyKey: key,
				body: {
					credits,
					amountPaid: form.amountPaid.trim(),
					method: form.method.trim(),
					...(form.reference.trim() ? { reference: form.reference.trim() } : {}),
				},
			});
			setBusy(false);
			if (!result.ok) {
				setProblem(result.problem);
				setErrors(fieldErrors(result.problem));
				setReviewing(false);
				return;
			}
			toast.show({ title: F.added, description: `${BILLING.balance}: ${formatCredits(result.data?.summary?.balance)}` });
			await onAdded();
			onClose();
		} catch (error) {
			setBusy(false);
			setProblem({ status: 500, detail: error instanceof Error ? error.message : 'The request failed.' });
		}
	};
	return (
		<Drawer
			open
			onClose={onClose}
			title={reviewing ? F.confirmTitle : `${BILLING.addCredits} · ${merchant.name}`}
			footer={
				reviewing ? (
					<>
						<Button variant="secondary" onClick={() => setReviewing(false)} disabled={busy}>
							{F.back}
						</Button>
						<Button onClick={() => void save()} loading={busy}>
							{F.confirm}
						</Button>
					</>
				) : (
					<Button onClick={review}>{F.review}</Button>
				)
			}>
			{reviewing ? (
				<dl className="space-y-2 text-sm">
					{[
						[BILLING.receiptColumns.merchant, merchant.name],
						[F.credits, formatCredits(credits * 1000)],
						[F.amountPaid, form.amountPaid.trim()],
						[F.method, form.method.trim()],
						...(form.reference.trim() ? [[F.reference, form.reference.trim()]] : []),
						[F.newBalance, typeof balance === 'number' ? formatCredits(balance + credits * 1000) : '—'],
					].map(([label, value]) => (
						<div key={label} className="flex justify-between gap-4">
							<dt className="text-muted">{label}</dt>
							<dd className="font-semibold text-fg">{value}</dd>
						</div>
					))}
					<p className="pt-2 text-xs text-muted">{F.permanent}</p>
				</dl>
			) : (
				<Form onSubmit={review} aria-label={BILLING.addCredits}>
					<Input
						label={F.credits}
						type="number"
						min={1}
						inputMode="numeric"
						help={F.creditsHelp}
						required
						{...field('credits')}
					/>
					<Input
						label={F.amountPaid}
						inputMode="decimal"
						help={F.amountPaidHelp}
						maxLength={60}
						required
						{...field('amountPaid')}
					/>
					<Input label={F.method} maxLength={60} required {...field('method')} />
					<Input label={F.reference} maxLength={120} {...field('reference')} />
				</Form>
			)}
			<FormError problem={problem} />
		</Drawer>
	);
}

/**
 * A merchant's Credits section: the money numbers, receipts and day charges.
 * @param {{ billing: any, receipts: any[], dayCharges: any[] }} props
 */
export function MerchantCredits({ billing, receipts, dayCharges }) {
	return (
		<div className="space-y-6">
			{billing ? <BillingStats summary={billing} /> : null}
			<Card title={BILLING.receiptsTitle} subtitle={BILLING.receiptsIntro} padded={false}>
				{receipts.length === 0 ? (
					<EmptyState compact icon="receipt" kind="credit" title={BILLING.noReceipts} />
				) : (
					<div className="divide-y divide-line-soft max-h-[26rem] overflow-y-auto">
						{receipts.map((r) => (
							<Row
								key={r.receiptId}
								lead={{ icon: 'receipt', tone: 'neutral' }}
								title={r.reference || r.method || BILLING.receiptsTitle}
								meta={[r.method, r.reference, r.note].filter((x, i, a) => x && a.indexOf(x) === i)}
								value={r.amountPaid || formatCredits(r.credits)}
								time={<LocalTime value={r.at} />}
							/>
						))}
					</div>
				)}
			</Card>
			<Card title={BILLING.dayChargesTitle} subtitle={BILLING.chargesNote} padded={false}>
				<FiguresTable
					caption={BILLING.dayChargesTitle}
					rows={dayCharges}
					rowKey={(d) => `${d.day}:${d.websiteId}:${d.productId}`}
					defaultSort={{ key: 'day', dir: 'desc' }}
					empty={<EmptyState compact icon="coins" kind="credit" title={BILLING.noUsage} />}
					columns={[
						{ key: 'day', header: BILLING.usageColumns.day, kind: 'date', sortable: true },
						{ key: 'domain', header: BILLING.usageColumns.website, sortable: true },
						{ key: 'product', header: BILLING.usageColumns.product, sortable: true },
						{
							key: 'lines',
							header: BILLING.usageColumns.feature,
							render: (d) => d.lines.map((/** @type {any} */ l) => `${l.feature} ${l.hours} h`).join(', '),
						},
						{
							key: 'credits',
							header: BILLING.usageColumns.credits,
							kind: 'money',
							sortable: true,
							render: (d) => formatCredits(d.credits),
						},
					]}
				/>
			</Card>
		</div>
	);
}

/**
 * Add credits from Credits and billing: pick the merchant, then the receipt form opens with its balance.
 * @param {{ merchants: Array<{ value: string, label: string }>, initial?: string | null, onClose: () => void,
 *   onPicked: (merchant: { merchantId: string, merchantName: string, balance: number | null }) => void }} props
 */
function PickMerchantDialog({ merchants, initial = null, onClose, onPicked }) {
	const [merchantId, setMerchantId] = useState(initial ?? merchants[0]?.value ?? '');
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const next = async () => {
		if (!merchantId) return;
		setBusy(true);
		setProblem(null);
		try {
			const result = await apiFetch(adminApi.billing(merchantId));
			setBusy(false);
			if (!result.ok) {
				setProblem(result.problem);
				return;
			}
			const name = merchants.find((m) => m.value === merchantId)?.label ?? merchantId;
			onPicked({ merchantId, merchantName: name, balance: result.data?.balance ?? null });
		} catch (error) {
			setBusy(false);
			setProblem({ status: 500, detail: error instanceof Error ? error.message : 'The request failed.' });
		}
	};
	return (
		<Drawer
			open
			onClose={onClose}
			title={BILLING.addCredits}
			description={MORE.pickMerchantHelp}
			footer={
				<Button onClick={() => void next()} loading={busy} disabled={!merchantId}>
					{MORE.next}
				</Button>
			}>
			<Select
				label={MORE.pickMerchant}
				value={merchantId}
				onChange={(e) => setMerchantId(e.currentTarget.value)}
				options={merchants}
			/>
			{problem ? <p className="mt-3 text-sm text-danger">{describeProblem(problem)}</p> : null}
		</Drawer>
	);
}

/** @param {readonly any[]} rows @param {(row: any) => number} amount */
const sumOf = (rows, amount) => rows.reduce((n, r) => n + (Number(amount(r)) || 0), 0);

/**
 * The page around the three parts: the header (title, the two sums of the period, Add credits), the navigation and the
 * part's toolbar, body and footer.
 * @param {{ props: any, part: 'attention' | 'receipts' | 'charges', toolbar?: import('react').ReactNode,
 *   footer?: import('react').ReactNode, children: import('react').ReactNode }} input
 */
function FinanceFrame({ props, part, toolbar, footer, children }) {
	const [adding, setAdding] = useState(/** @type {any} */ (null));
	const [picking, setPicking] = useState(false);
	const canAdd = adminCan(props.admin, 'credits.add');
	const { filter, receipts, charges, attention } = props;
	const merchants = /** @type {Array<{ value: string, label: string }>} */ (props.merchants ?? []);
	const S = BILLING.billingSections;
	const chargeRows = /** @type {any[]} */ (charges?.rows ?? []);
	const range = charges?.from && charges?.to ? MORE.rangeLine(charges.from, charges.to) : undefined;
	return (
		<>
			<Page
				linkAs={Link}
				flush
				bodyKey={part}
				crumbs={[{ label: BILLING.billingTitle }]}
				info={BILLING.billingIntro}
				facts={[
					{
						label: MORE.creditsAddedRange,
						value: formatCredits(sumOf(receipts, (r) => r.credits)),
						...(range ? { title: range } : {}),
					},
					{
						label: MORE.chargedRange,
						value: formatCredits(sumOf(chargeRows, (r) => r.credits)),
						...(range ? { title: range } : {}),
					},
				]}
				{...(canAdd && merchants.length > 0
					? {
							actions: {
								primary: {
									label: BILLING.addCredits,
									icon: /** @type {const} */ ('plus'),
									onClick: () => setPicking(true),
								},
							},
						}
					: {})}
				nav={{
					value: part,
					label: BILLING.billingTitle,
					items: [
						{
							id: 'attention',
							label: S.attention.title,
							icon: 'alert',
							...(attention.length > 0 ? { count: attention.length, dot: 'attention', dotLabel: S.attention.title } : {}),
							href: adminRoutes.financePart('attention'),
						},
						{
							id: 'receipts',
							label: S.receipts.title,
							icon: 'receipt',
							href: adminRoutes.financePart('receipts', {
								merchantId: filter.merchantId,
								from: filter.from,
								to: filter.to,
								method: filter.method,
							}),
						},
						{
							id: 'charges',
							label: S.charges.title,
							icon: 'trendingUp',
							href: adminRoutes.financePart('charges', { by: filter.by, from: filter.from, to: filter.to }),
						},
					],
				}}
				{...(toolbar ? { toolbar } : {})}
				{...(footer ? { footer } : {})}>
				{children}
			</Page>
			{picking ? (
				<PickMerchantDialog
					merchants={merchants}
					initial={filter.merchantId}
					onClose={() => setPicking(false)}
					onPicked={(m) => {
						setPicking(false);
						setAdding(m);
					}}
				/>
			) : null}
			{adding ? (
				<AddCreditsDialog
					merchant={{ merchantId: adding.merchantId, name: adding.merchantName ?? adding.merchantId }}
					balance={adding.balance}
					onClose={() => setAdding(null)}
					onAdded={() => window.location.reload()}
				/>
			) : null}
		</>
	);
}

/**
 * Needs attention: the merchants that are low, in grace or stopped (checked now); a row opens the merchant's Credits.
 * @param {any} props loader result of `loadBilling` plus `admin`
 */
function AttentionPart(props) {
	const [adding, setAdding] = useState(/** @type {any} */ (null));
	const canAdd = adminCan(props.admin, 'credits.add');
	const rows = /** @type {any[]} */ (props.attention);
	return (
		<>
			<FinanceFrame props={props} part="attention">
				{rows.length === 0 ? (
					<EmptyState compact icon="check" kind="merchant" title={BILLING.noAttention} />
				) : (
					<div className="divide-y divide-line-soft">
						{rows.map((m) => {
							const pill = merchantPill(m.status);
							return (
								<Row
									key={m.merchantId}
									linkAs={Link}
									href={adminRoutes.merchantPart(m.merchantId, 'credits')}
									lead={{ avatar: m.merchantName ?? m.merchantId }}
									title={m.merchantName ?? m.merchantId}
									meta={<DaysLeft summary={m} />}
									status={{
										tone: pill.status === 'active' ? 'success' : pill.status === 'error' ? 'danger' : 'warning',
										label: pill.label,
									}}
									value={formatCredits(m.balance)}
									trailing={
										canAdd ? (
											<ActionMenu
												floating
												label={`Actions for ${m.merchantName ?? m.merchantId}`}
												items={[{ label: BILLING.addCredits, onSelect: () => setAdding(m) }]}
											/>
										) : null
									}
								/>
							);
						})}
					</div>
				)}
			</FinanceFrame>
			{adding ? (
				<AddCreditsDialog
					merchant={{ merchantId: adding.merchantId, name: adding.merchantName ?? adding.merchantId }}
					balance={adding.balance}
					onClose={() => setAdding(null)}
					onAdded={() => window.location.reload()}
				/>
			) : null}
		</>
	);
}

/**
 * Receipts: every credit receipt of the filter, newest first.
 * @param {any} props loader result of `loadBilling` plus `admin`
 */
function ReceiptsPart(props) {
	const nav = useNavigation();
	const { filter } = props;
	const receipts = /** @type {any[]} */ (props.receipts);
	const merchants = /** @type {Array<{ value: string, label: string }>} */ (props.merchants ?? []);
	const methods = [
		...new Set([...receipts.map((r) => String(r.method ?? '')), String(filter.method ?? '')].filter(Boolean)),
	].sort();
	const paged = usePaged(receipts, {
		pageSize: 50,
		text: (r) => `${r.merchantName ?? ''} ${r.method ?? ''} ${r.reference ?? ''} ${r.credits}`,
	});
	/** @param {Record<string, string | null>} next */
	const hrefFor = (next) => adminRoutes.financePart('receipts', { ...filter, ...next });
	const filtered = Boolean(filter.merchantId || filter.from || filter.to || filter.method);
	return (
		<FinanceFrame
			props={props}
			part="receipts"
			toolbar={
				<Toolbar
					label={BILLING.receiptsTitle}
					search={{
						value: paged.query,
						label: BILLING.searchReceipts,
						placeholder: BILLING.searchReceipts,
						onSearch: paged.setQuery,
					}}
					filters={[
						{
							id: 'merchant',
							label: BILLING.receiptColumns.merchant,
							allLabel: MORE.allMerchants,
							value: filter.merchantId ?? '',
							options: merchants,
							onChange: (merchantId) => nav.go(hrefFor({ merchantId: merchantId || null })),
						},
						{
							id: 'method',
							label: BILLING.receiptColumns.method,
							allLabel: MORE.allMethods,
							value: filter.method ?? '',
							options: methods.map((m) => ({ value: m, label: m })),
							onChange: (method) => nav.go(hrefFor({ method: method || null })),
						},
						periodFilter({
							from: filter.from,
							to: filter.to,
							emptyLabel: MORE.range.last30,
							omit: 'last30',
							hrefFor: (range) => hrefFor(range),
							go: nav.go,
						}),
					]}
					end={
						filtered ? (
							<ButtonLink
								as={Link}
								href={adminRoutes.financePart('receipts', { by: filter.by })}
								variant="ghost"
								size="sm">
								{MORE.clearFilters}
							</ButtonLink>
						) : null
					}>
					<DateFields
						from={filter.from}
						to={filter.to}
						fromLabel={BILLING.filters.from}
						toLabel={BILLING.filters.to}
						hrefFor={(range) => hrefFor(range)}
						go={nav.go}
					/>
				</Toolbar>
			}
			{...(paged.found.length > 0 ? { footer: <Pagination {...paged.pagination} /> } : {})}>
			{paged.rows.length === 0 ? (
				<EmptyState compact icon="receipt" kind="credit" title={BILLING.noReceipts} />
			) : (
				<div className="divide-y divide-line-soft">
					{paged.rows.map((r) => (
						<Row
							key={r.receiptId}
							linkAs={Link}
							href={r.merchantId ? adminRoutes.merchantPart(r.merchantId, 'credits') : undefined}
							lead={{ icon: 'receipt', tone: 'neutral' }}
							title={r.merchantName ?? r.merchantId ?? BILLING.receiptsTitle}
							meta={[r.method, r.reference, r.note].filter(Boolean)}
							value={formatCredits(r.credits)}
							time={<LocalTime value={r.at} />}
						/>
					))}
				</div>
			)}
		</FinanceFrame>
	);
}

/**
 * Charges by day, merchant or product: the chart of the days and the rows.
 * @param {any} props loader result of `loadBilling` plus `admin`
 */
function ChargesPart(props) {
	const nav = useNavigation();
	const { filter, charges } = props;
	const productsLinked = adminCan(props.admin, 'products.manage');
	const rows = /** @type {any[]} */ (charges?.rows ?? []);
	const paged = usePaged(rows, { pageSize: 50, text: (r) => String(r.label) });
	const dayBars =
		filter.by === 'day' ? rows.map((r) => ({ label: String(r.label).slice(5), value: r.credits / 1000, hint: r.label })) : [];
	const range = charges?.from && charges?.to ? MORE.rangeLine(charges.from, charges.to) : undefined;
	/** @param {Record<string, string | null>} next */
	const hrefFor = (next) => adminRoutes.financePart('charges', { by: filter.by, from: filter.from, to: filter.to, ...next });
	return (
		<FinanceFrame
			props={props}
			part="charges"
			toolbar={
				<Toolbar
					label={BILLING.billingSections.charges.title}
					search={{
						value: paged.query,
						label: BILLING.searchCharges,
						placeholder: BILLING.searchCharges,
						onSearch: paged.setQuery,
					}}
					view={{
						label: BILLING.chargesGroup,
						value: filter.by,
						onChange: (by) => nav.go(hrefFor({ by })),
						options: /** @type {const} */ (['day', 'merchant', 'product']).map((by) => ({
							value: by,
							label: BILLING.chargesBy[by],
						})),
					}}
					filters={[
						periodFilter({
							from: filter.from,
							to: filter.to,
							emptyLabel: MORE.range.last30,
							omit: 'last30',
							hrefFor: (r) => hrefFor(r),
							go: nav.go,
						}),
					]}>
					<DateFields
						from={filter.from}
						to={filter.to}
						fromLabel={BILLING.filters.from}
						toLabel={BILLING.filters.to}
						hrefFor={(r) => hrefFor(r)}
						go={nav.go}
					/>
				</Toolbar>
			}
			{...(paged.found.length > 0 ? { footer: <Pagination {...paged.pagination} /> } : {})}>
			{isEmptySeries(dayBars) ? null : (
				<div className="shrink-0 border-b border-line px-4 py-3">
					{range ? <p className="mb-2 text-label text-muted">{MORE.chargesChart + ' · ' + range}</p> : null}
					<BarChart label={MORE.chargesChart} data={dayBars} format={formatChartCredits} height={120} />
				</div>
			)}
			{paged.rows.length === 0 ? (
				<EmptyState compact icon="coins" kind="credit" title={BILLING.noUsage} />
			) : (
				<div className="divide-y divide-line-soft">
					{paged.rows.map((r) => (
						<Row
							key={r.key}
							linkAs={Link}
							href={
								filter.by === 'merchant'
									? adminRoutes.merchantPart(r.key, 'credits')
									: filter.by === 'product' && productsLinked
										? adminRoutes.product(r.key)
										: undefined
							}
							lead={{
								icon: filter.by === 'product' ? 'box' : filter.by === 'merchant' ? 'user' : 'calendar',
								tone: 'neutral',
							}}
							title={r.label}
							value={formatCredits(r.credits)}
						/>
					))}
				</div>
			)}
		</FinanceFrame>
	);
}

/**
 * Credits and billing page (Owner and Finance; Support read-only): needs attention, receipts with their filters, and
 * the charges by day, merchant or product, each its own address.
 * @param {any} props loader result of `loadBilling` plus `admin` and the `part` of the address
 */
export function FinanceView(props) {
	if (props.ok !== true) return <AdminProblem problem={props.problem} />;
	return props.part === 'receipts' ? (
		<ReceiptsPart {...props} />
	) : props.part === 'charges' ? (
		<ChargesPart {...props} />
	) : (
		<AttentionPart {...props} />
	);
}
