'use client';
/**
 * Products (PLAN 0.8.2, 0.6; flat layout 2026-10-21): the Products page is a ListColumn of rich rows beside the
 * selected product's page (or the first product on wide screens). All sections open on one page: Websites (the 30-day
 * earnings chart above the websites using it), Features and prices, and Connection (address, connected date, id,
 * version, price list, widget script, docs). Owners manage products; Support sees them read-only.
 * @module
 */
import { useEffect, useId, useMemo, useState } from 'react';
import {
	BarChart,
	Button,
	Callout,
	Card,
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
	TextLink,
	copyText,
	describeProblem,
	fieldErrors,
	formatCredits,
	isEmptySeries,
	problemCode,
	useToast,
} from '@ss/ui';
import { MORE, PRODUCTS, WEBSITE } from '../../../texts/console.js';
import { Link } from '../../link.js';
import { useNavigation } from '../../navigation.js';
import { creditDayBars, formatChartCredits, productPill } from '../../views/billing.js';
import { openDashboard } from '../../views/common.js';
import { ConfirmOtp } from '../../views/common.js';
import { apiFetch } from '../../client.js';
import { adminApi, adminRoutes } from '../paths.js';
import { AdminProblem, adminCan } from './shell.js';

/** @typedef {import('@ss/ui').Problem} Problem */

/**
 * The pill of a connected product's status.
 * @param {{ status: string }} product
 * @returns {{ status: 'active' | 'off', label: string }}
 */
const activePill = (product) =>
	product.status === 'active'
		? { status: /** @type {const} */ ('active'), label: PRODUCTS.status.active }
		: { status: /** @type {const} */ ('off'), label: PRODUCTS.status.inactive };

/** True on phone viewports (< 768 px). */
function usePhone() {
	const [phone, setPhone] = useState(false);
	useEffect(() => {
		if (typeof window === 'undefined' || !window.matchMedia) return;
		const mql = window.matchMedia('(max-width: 767px)');
		setPhone(mql.matches);
		const handler = (/** @type {MediaQueryListEvent} */ e) => setPhone(e.matches);
		mql.addEventListener('change', handler);
		return () => mql.removeEventListener('change', handler);
	}, []);
	return phone;
}

/**
 * The connect form of Add product and Reconnect, in a drawer: the product URL (optional on Reconnect) and the connect
 * secret.
 * @param {{ open: boolean, title: string, description: string, submitLabel: string, urlRequired: boolean,
 *   path: string, onClose: () => void, onDone: (product: any) => void, conflict?: string }} props
 */
function ConnectDialog({ open, title, description, submitLabel, urlRequired, path, onClose, onDone, conflict }) {
	const [url, setUrl] = useState('');
	const [secret, setSecret] = useState('');
	const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const formId = useId();

	const submit = async () => {
		/** @type {Record<string, string>} */
		const local = {};
		if (urlRequired && !url.trim()) local.url = PRODUCTS.urlMissing;
		if (!secret) local.secret = PRODUCTS.secretMissing;
		setErrors(local);
		if (Object.keys(local).length > 0) return;
		setBusy(true);
		setProblem(null);
		const result = await apiFetch(path, { method: 'POST', body: { ...(url.trim() ? { url: url.trim() } : {}), secret } });
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		setUrl('');
		setSecret('');
		onDone(result.data.product);
	};

	const fields = fieldErrors(problem);
	const refused = conflict && problem && problemCode(problem) === 'conflict' ? conflict : null;

	return (
		<Drawer
			open={open}
			onClose={onClose}
			title={title}
			description={description}
			footer={
				<>
					<Button variant="secondary" onClick={onClose}>
						{MORE.cancel}
					</Button>
					<Button type="submit" form={formId} loading={busy}>
						{submitLabel}
					</Button>
				</>
			}>
			<Form id={formId} onSubmit={submit} busy={busy} aria-label={title}>
				<Input
					label={urlRequired ? PRODUCTS.url : PRODUCTS.urlOptional}
					help={urlRequired ? PRODUCTS.urlHelp : PRODUCTS.urlOptionalHelp}
					type="url"
					placeholder="https://"
					inputMode="url"
					autoComplete="off"
					value={url}
					onChange={(e) => setUrl(e.currentTarget.value)}
					error={errors.url ?? fields.url}
					required={urlRequired}
				/>
				<Input
					label={PRODUCTS.secret}
					help={PRODUCTS.secretHelp}
					type="password"
					autoComplete="off"
					value={secret}
					onChange={(e) => setSecret(e.currentTarget.value)}
					error={errors.secret ?? fields.secret}
					required
				/>
				{refused ? (
					<p role="alert" className="text-sm font-medium text-danger">
						{refused}
					</p>
				) : (
					<FormError problem={problem} fields={['url', 'secret']} />
				)}
			</Form>
		</Drawer>
	);
}

/**
 * The websites using a product: the first page from the loader, then the next ones by cursor.
 * @param {string} productId
 * @param {{ items: any[], cursor: string | null }} first
 * @param {Problem | null} firstProblem
 */
function useProductWebsites(productId, first, firstProblem) {
	const [items, setItems] = useState(first.items);
	const [cursor, setCursor] = useState(first.cursor);
	const [loading, setLoading] = useState(false);
	const [problem, setProblem] = useState(firstProblem);

	const more = async () => {
		if (!cursor || loading) return;
		setLoading(true);
		setProblem(null);
		const result = await apiFetch(adminApi.productWebsites(productId, cursor));
		setLoading(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		setItems((list) => [...list, ...(result.data?.items ?? [])]);
		setCursor(result.data?.cursor ?? null);
	};

	useEffect(() => {
		if (loading || problem || cursor === null || items.length >= 50) return;
		void more();
	}, [loading, problem, cursor, items.length]);

	return { items, cursor, loading, problem, more };
}

/**
 * A product's page: all sections open on one page beside the list of products.
 * @param {{
 *   detail: any,
 *   owner: boolean,
 *   list?: any,
 *   admin?: any,
 *   onAdd?: (() => void) | null,
 * }} props
 */
function ProductPageView({ detail, owner, list, admin = null, onAdd = null }) {
	const toast = useToast();
	const [product, setProduct] = useState(detail.product);
	const [reconnecting, setReconnecting] = useState(false);
	const [busy, setBusy] = useState(/** @type {null | 'open' | 'status'} */ (null));
	const [askOpen, setAskOpen] = useState(false);
	const sites = useProductWebsites(String(product.productId), detail.websites, detail.websitesProblem);

	const id = String(product.productId);
	const numbers = product.numbers ?? {};
	const earned = creditDayBars(numbers.days);
	const features = /** @type {any[]} */ (product.features ?? []);

	/** @param {{ password: string, code?: string, recoveryCode?: string }} confirmation */
	const sendLaunch = async (confirmation) => {
		setBusy('open');
		const result = await openDashboard(adminApi.launch(id), { websiteId: null, ...confirmation });
		setBusy(null);
		if (!result.ok) return result;
		setAskOpen(false);
		return { ok: /** @type {const} */ (true) };
	};

	const toggle = async () => {
		const next = product.status === 'active' ? 'inactive' : 'active';
		setBusy('status');
		const result = await apiFetch(adminApi.productStatus(id), { method: 'POST', body: { status: next } });
		setBusy(null);
		if (!result.ok) {
			toast.show({ tone: 'danger', title: describeProblem(result.problem) });
			return;
		}
		setProduct((/** @type {any} */ p) => ({ ...p, ...result.data.product }));
		toast.show({ title: next === 'active' ? PRODUCTS.activated : PRODUCTS.deactivated });
	};

	const copyAddress = async () => {
		const copied = await copyText(product.baseUrl);
		toast.show(copied ? { title: MORE.copied } : { tone: 'danger', title: product.baseUrl });
	};

	const sections = [
		{
			id: 'websites',
			label: PRODUCTS.websitesTitle,
			body: (
				<div className="space-y-4">
					{sites.problem ? (
						<div>
							<Callout tone="danger">{describeProblem(sites.problem)}</Callout>
						</div>
					) : null}
					{isEmptySeries(earned) ? null : (
						<div className="rounded-card border border-line bg-surface p-4">
							<p className="mb-2 text-label text-muted">{PRODUCTS.earnedChart}</p>
							<BarChart label={PRODUCTS.earnedChart} data={earned} format={formatChartCredits} height={120} />
						</div>
					)}
					<Card title={PRODUCTS.websitesTitle}>
						{sites.items.length === 0 ? (
							<EmptyState compact icon="globe" kind="website" title={PRODUCTS.noWebsites} />
						) : (
							<div className="divide-y divide-line-soft">
								{sites.items.map((w) => (
									<Row
										key={String(w.websiteId)}
										lead={{ icon: 'globe' }}
										title={w.domain}
										meta={[w.merchantName, featureNames(features, w.featuresOn)].filter(Boolean)}
										status={{
											tone: productPill(w).status === 'active' ? 'success' : 'neutral',
											label: productPill(w).label,
										}}
										value={formatCredits(w.dailyCost ?? 0)}
										href={adminRoutes.website(w.merchantId, w.websiteId)}
										linkAs={Link}
										trailing={
											<Link
												href={adminRoutes.merchant(w.merchantId)}
												title={w.merchantName}
												className="line-clamp-2 text-xs font-normal text-muted hover:text-fg hover:underline">
												{w.merchantName}
											</Link>
										}
									/>
								))}
							</div>
						)}
						{sites.cursor ? (
							<div className="flex justify-center pt-3">
								<Button variant="secondary" size="sm" loading={sites.loading} onClick={() => void sites.more()}>
									{MORE.showMore}
								</Button>
							</div>
						) : null}
					</Card>
				</div>
			),
		},
		{
			id: 'features',
			label: MORE.featuresTitle,
			body: (
				<Card title={MORE.featuresTitle}>
					{features.length === 0 ? (
						<EmptyState compact icon="sliders" kind="product" title={MORE.noFeatures} />
					) : (
						<div className="divide-y divide-line-soft">
							{features.map((f) => (
								<Row
									key={String(f.key)}
									lead={{ icon: 'sliders' }}
									title={f.name}
									meta={[
										f.description,
										(f.dependsOn ?? []).length > 0
											? `${MORE.featureColumns.needs}: ${featureNames(features, f.dependsOn)}`
											: null,
										`${MORE.featureColumns.perHour}: ${formatCredits(f.millicreditsPerHour ?? 0)}`,
									].filter(Boolean)}
									value={`${formatCredits(24 * (f.millicreditsPerHour ?? 0))}/day`}
								/>
							))}
						</div>
					)}
				</Card>
			),
		},
		{
			id: 'connection',
			label: MORE.connectionTitle,
			body: (
				<Card title={MORE.connectionTitle}>
					<KeyValueList
						columns={2}
						items={[
							{
								label: MORE.connection.address,
								value: <span className="font-mono text-xs break-all">{product.baseUrl}</span>,
							},
							{ label: MORE.connection.connected, value: <LocalTime value={product.connectedAt} /> },
							...(product.reconnectedAt
								? [{ label: MORE.connection.reconnected, value: <LocalTime value={product.reconnectedAt} /> }]
								: []),
							{ label: MORE.connection.productId, value: <span className="font-mono text-xs">{id}</span> },
							{ label: MORE.connection.version, value: product.version ?? '—' },
							{ label: MORE.connection.priceList, value: MORE.priceListVersion(product.priceListVersion ?? 0) },
							{
								label: MORE.connection.widget,
								value: product.widgetScriptUrl ? (
									<span className="font-mono text-xs break-all">{product.widgetScriptUrl}</span>
								) : (
									MORE.noWidget
								),
							},
							{
								label: MORE.connection.docs,
								value: product.docsUrl ? (
									<TextLink href={product.docsUrl} external className="break-all">
										{product.docsUrl}
									</TextLink>
								) : (
									'—'
								),
							},
						]}
					/>
				</Card>
			),
		},
	];

	return (
		<>
			<Page
				flush
				linkAs={Link}
				list={list ?? undefined}
				crumbs={[{ label: PRODUCTS.title, href: adminRoutes.products() }, { label: product.name }]}
				info={PRODUCTS.pageInfo}
				status={[activePill(product)]}
				facts={[
					{
						label: PRODUCTS.earnedShort,
						value: formatCredits(numbers.earnedThisMonth ?? 0),
						title: isEmptySeries(earned) ? PRODUCTS.noEarnings : PRODUCTS.earnedThisMonth,
					},
					{
						label: PRODUCTS.websitesShort,
						value: numbers.websites ?? 0,
						title: PRODUCTS.websitesUsing,
					},
				]}
				actions={
					owner
						? {
								primary: {
									label: PRODUCTS.openAsAdmin,
									icon: 'external',
									title: PRODUCTS.openAsAdminHelp,
									loading: busy === 'open',
									onClick: () => setAskOpen(true),
								},
								secondary: [
									{
										label: product.status === 'active' ? PRODUCTS.setInactive : PRODUCTS.setActive,
										title: PRODUCTS.inactiveHelp,
										loading: busy === 'status',
										onClick: () => toggle(),
									},
								],
								more: [
									{ label: MORE.copyAddress, onSelect: () => void copyAddress() },
									{ label: PRODUCTS.reconnect, onSelect: () => setReconnecting(true) },
									...(onAdd ? [{ label: PRODUCTS.add, onSelect: onAdd }] : []),
								],
							}
						: {}
				}
				sections={sections}
			/>
			<ConfirmOtp
				open={askOpen}
				title={WEBSITE.openConfirmTitle(product.name)}
				help={WEBSITE.openConfirmHelp}
				confirmLabel={WEBSITE.openConfirmLabel}
				twoStepOn={Boolean(admin?.twoStep?.enabled)}
				send={sendLaunch}
				onClose={() => setAskOpen(false)}
				onDone={() => setAskOpen(false)}
			/>
			{owner ? (
				<ConnectDialog
					open={reconnecting}
					title={PRODUCTS.reconnect}
					description={PRODUCTS.reconnectHelp}
					submitLabel={PRODUCTS.reconnect}
					urlRequired={false}
					path={adminApi.reconnect(id)}
					onClose={() => setReconnecting(false)}
					onDone={(next) => {
						setReconnecting(false);
						setProduct((/** @type {any} */ p) => ({ ...p, ...next }));
						toast.show({ title: PRODUCTS.reconnected });
					}}
				/>
			) : null}
		</>
	);
}

/**
 * Products screen: ListColumn on left, selected product page on right.
 * @param {{
 *   items: any[],
 *   owner: boolean,
 *   detail?: any,
 *   admin?: any,
 *   productId?: string | null,
 *   fromList?: boolean,
 *   filterStatus?: string | null,
 * }} props
 */
function ProductsScreen({ items, owner, detail, admin = null, productId: explicitId, fromList, filterStatus: initialStatus }) {
	const toast = useToast();
	const nav = useNavigation();
	const phone = usePhone();
	const [adding, setAdding] = useState(false);
	const [query, setQuery] = useState('');
	const [statusFilter, setStatusFilter] = useState(initialStatus ?? 'all');

	const filteredItems = useMemo(() => {
		const q = query.trim().toLowerCase();
		return items.filter((p) => {
			if (statusFilter !== 'all' && p.status !== statusFilter) return false;
			if (!q) return true;
			const name = (p.name ?? '').toLowerCase();
			const id = (p.productId ?? '').toLowerCase();
			return name.includes(q) || id.includes(q);
		});
	}, [items, query, statusFilter]);

	const selectedId =
		explicitId ??
		(detail?.product?.productId
			? String(detail.product.productId)
			: fromList
				? phone
					? null
					: items[0]?.productId
						? String(items[0].productId)
						: null
				: null);

	const listColumn = (
		<ListColumn
			label={PRODUCTS.title}
			items={filteredItems}
			idOf={(p) => String(p.productId)}
			selected={selectedId}
			onBack={() => nav.go(adminRoutes.products())}
			search={{
				value: query,
				placeholder: PRODUCTS.search,
				onChange: setQuery,
			}}
			filters={{
				value: statusFilter,
				onChange: (status) => setStatusFilter(status),
				options: [
					{ id: 'all', label: PRODUCTS.allStatuses },
					{ id: 'active', label: PRODUCTS.status.active },
					{ id: 'inactive', label: PRODUCTS.status.inactive },
				],
			}}
			rowOf={(p) => ({
				lead: { icon: 'box' },
				title: p.name,
				status: {
					tone: p.status === 'active' ? 'success' : 'neutral',
					label: p.status === 'active' ? PRODUCTS.status.active : PRODUCTS.status.inactive,
				},
				meta: [`${p.websites ?? 0} ${p.websites === 1 ? 'website' : PRODUCTS.listColumns.websites}`],
				value: formatCredits(p.earnedThisMonth ?? 0),
				href: adminRoutes.product(p.productId),
				linkAs: Link,
			})}
			empty={{
				icon: 'box',
				kind: 'product',
				title: query || statusFilter !== 'all' ? PRODUCTS.noneFound : PRODUCTS.none,
				description: query || statusFilter !== 'all' ? undefined : owner ? PRODUCTS.noneHelp : undefined,
			}}
		/>
	);

	const connectDialog = owner ? (
		<ConnectDialog
			open={adding}
			title={PRODUCTS.add}
			description={PRODUCTS.addHelp}
			submitLabel={PRODUCTS.connect}
			urlRequired
			path={adminApi.connect()}
			conflict={PRODUCTS.alreadyConnected}
			onClose={() => setAdding(false)}
			onDone={(product) => {
				setAdding(false);
				toast.show({ title: PRODUCTS.connected(product.name) });
				nav.go(adminRoutes.product(product.productId));
			}}
		/>
	) : null;

	if (detail) {
		return (
			<>
				<ProductPageView
					detail={detail}
					owner={owner}
					list={listColumn}
					admin={admin}
					onAdd={owner ? () => setAdding(true) : null}
				/>
				{connectDialog}
			</>
		);
	}

	const isFiltered = Boolean(query || (statusFilter && statusFilter !== 'all'));

	if (items.length === 0) {
		return (
			<>
				<Page
					flush
					crumbs={[{ label: PRODUCTS.title }]}
					info={PRODUCTS.info}
					linkAs={Link}
					actions={owner ? { primary: { label: PRODUCTS.add, icon: 'plus', onClick: () => setAdding(true) } } : {}}>
					<EmptyState
						icon="box"
						kind="product"
						title={isFiltered ? PRODUCTS.noneFound : PRODUCTS.none}
						description={isFiltered ? undefined : owner ? PRODUCTS.noneHelp : undefined}
						action={
							!isFiltered && owner ? (
								<Button onClick={() => setAdding(true)} icon={<Icon name="plus" size={14} />}>
									{PRODUCTS.add}
								</Button>
							) : null
						}
					/>
				</Page>
				{connectDialog}
			</>
		);
	}

	return (
		<>
			<Page
				flush
				crumbs={[{ label: PRODUCTS.title }]}
				info={PRODUCTS.info}
				linkAs={Link}
				list={listColumn}
				actions={owner ? { primary: { label: PRODUCTS.add, icon: 'plus', onClick: () => setAdding(true) } } : {}}>
				<></>
			</Page>
			{connectDialog}
		</>
	);
}

/**
 * The Products screens.
 * @param {any} props loader result of `loadProducts` (the list) or `{ detail, admin, list, section, productId }`
 */
export function ProductsView(props) {
	const owner = adminCan(props.admin, 'products.manage');
	const detail = props.detail ?? null;

	if (detail && detail.ok === false) {
		return <AdminProblem problem={detail.problem} back={{ href: adminRoutes.products(), label: PRODUCTS.title }} />;
	}
	if (props.ok === false) return <AdminProblem problem={props.problem} />;

	const items = /** @type {any[]} */ (props.items ?? []);
	const filterStatus = props.filter?.status ?? null;

	return (
		<ProductsScreen
			items={items}
			owner={owner}
			detail={detail}
			admin={props.admin}
			productId={props.productId ?? (detail?.product ? String(detail.product.productId) : null)}
			fromList={Boolean(props.fromList)}
			filterStatus={filterStatus}
		/>
	);
}

/**
 * Names of the switched-on features (from the product's price list; unknown keys show as they are).
 * @param {ReadonlyArray<{ key: string, name: string }> | undefined} features
 * @param {readonly string[] | undefined} on
 */
export const featureNames = (features, on) =>
	(on ?? []).length === 0
		? PRODUCTS.noFeatures
		: (on ?? []).map((key) => (features ?? []).find((f) => f.key === key)?.name ?? key).join(', ');
