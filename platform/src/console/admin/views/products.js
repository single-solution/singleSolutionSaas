'use client';
/**
 * Products (PLAN 0.8.2, 0.6): the connected products as a table (filter Active / Inactive, search) with **Add product**
 * (the product URL and connect secret; new products start inactive; an id already connected is refused with "use
 * Reconnect"), and the product page — an inner sidebar with the list, a header (name, Active / Inactive, address,
 * connected date; actions Open as admin, Set active / inactive, Reconnect) and the tabs Overview (credits earned this
 * month with the 30-day chart, websites using it) and Websites (merchant, domain, features on, daily cost; paged).
 * Owners manage products; Support sees them read-only. The Portal checks every right again.
 * @module
 */
import { useState } from 'react';
import {
	Badge,
	BarChart,
	Button,
	Card,
	Dialog,
	EmptyState,
	Form,
	FormError,
	Icon,
	Input,
	KeyValueList,
	PageHeader,
	Select,
	Stat,
	Table,
	Tabs,
	describeProblem,
	fieldErrors,
	formatCredits,
	problemCode,
	useToast,
} from '@ss/ui';
import { PRODUCTS } from '../../../texts/console.js';
import { Link } from '../../link.js';
import { LocalTime, ProductStatusBadge } from '../../views/billing.js';
import { BackLink, InnerList, openDashboard } from '../../views/common.js';
import { adminFetch } from '../client.js';
import { adminApi, adminRoutes } from '../paths.js';
import { AdminProblem, adminCan } from './common.js';
import { dayBars } from './overview.js';

/** @typedef {import('@ss/ui').Problem} Problem */

/**
 * Active / Inactive badge of a connected product.
 * @param {{ status: string }} props
 */
export function ProductActiveBadge({ status }) {
	return (
		<Badge tone={status === 'active' ? 'success' : 'neutral'} dot>
			{status === 'active' ? PRODUCTS.status.active : PRODUCTS.status.inactive}
		</Badge>
	);
}

/** @param {number} v credits */
const creditsOf = (v) => formatCredits(Math.round(v * 1000));

/**
 * The connect form of Add product and Reconnect: the product URL (optional on Reconnect) and the connect secret.
 * @param {{ open: boolean, title: string, description: string, submitLabel: string, urlRequired: boolean,
 *   path: string, onClose: () => void, onDone: (product: any) => void, conflict?: string }} props
 */
export function ConnectDialog({ open, title, description, submitLabel, urlRequired, path, onClose, onDone, conflict }) {
	const [url, setUrl] = useState('');
	const [secret, setSecret] = useState('');
	const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const submit = async () => {
		/** @type {Record<string, string>} */
		const local = {};
		if (urlRequired && !url.trim()) local.url = PRODUCTS.urlMissing;
		if (!secret) local.secret = PRODUCTS.secretMissing;
		setErrors(local);
		if (Object.keys(local).length > 0) return;
		setBusy(true);
		setProblem(null);
		const result = await adminFetch(path, { method: 'POST', body: { ...(url.trim() ? { url: url.trim() } : {}), secret } });
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
		<Dialog open={open} onClose={onClose} title={title} description={description}>
			<Form onSubmit={submit} busy={busy} aria-label={title}>
				<Input
					label={urlRequired ? PRODUCTS.url : PRODUCTS.urlOptional}
					help={urlRequired ? PRODUCTS.urlHelp : PRODUCTS.urlOptionalHelp}
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
				<Button type="submit" loading={busy}>
					{submitLabel}
				</Button>
			</Form>
		</Dialog>
	);
}

/**
 * The Products list.
 * @param {any} props loader result of `loadProducts` plus `admin`
 */
export function ProductsView(props) {
	const toast = useToast();
	const [adding, setAdding] = useState(false);
	const [q, setQ] = useState('');
	if (!props.ok) return <AdminProblem problem={props.problem} />;
	const owner = adminCan(props.admin, 'products.manage');
	const needle = q.trim().toLowerCase();
	const rows = /** @type {any[]} */ (props.items).filter(
		(p) => !needle || String(p.name).toLowerCase().includes(needle) || String(p.productId).includes(needle),
	);
	return (
		<div className="space-y-6">
			<PageHeader
				title={PRODUCTS.title}
				actions={
					owner ? (
						<Button onClick={() => setAdding(true)} icon={<Icon name="plus" size={14} />}>
							{PRODUCTS.add}
						</Button>
					) : null
				}
			/>
			<div className="flex flex-wrap items-end gap-3">
				<form method="get" className="flex items-end gap-3">
					<Select
						label={PRODUCTS.columns.status}
						name="status"
						defaultValue={props.filter.status ?? ''}
						options={[
							{ value: '', label: PRODUCTS.allStatuses },
							{ value: 'active', label: PRODUCTS.status.active },
							{ value: 'inactive', label: PRODUCTS.status.inactive },
						]}
						onChange={(e) => e.currentTarget.form?.requestSubmit()}
					/>
				</form>
				<Input label={PRODUCTS.search} value={q} onChange={(e) => setQ(e.currentTarget.value)} />
			</div>
			<Table
				caption={PRODUCTS.title}
				captionHidden
				rows={rows}
				rowKey={(p) => p.productId}
				empty={<EmptyState icon="box" title={PRODUCTS.none} />}
				defaultSort={{ key: 'name', direction: 'asc' }}
				columns={[
					{
						key: 'name',
						header: PRODUCTS.columns.name,
						rowHeader: true,
						sortable: true,
						render: (p) => (
							<Link href={adminRoutes.product(p.productId)} className="font-semibold text-primary hover:underline">
								{p.name}
							</Link>
						),
					},
					{
						key: 'status',
						header: PRODUCTS.columns.status,
						sortable: true,
						render: (p) => <ProductActiveBadge status={p.status} />,
					},
					{
						key: 'earnedThisMonth',
						header: PRODUCTS.columns.earned,
						align: 'right',
						sortable: true,
						render: (p) => formatCredits(p.earnedThisMonth ?? 0),
					},
					{ key: 'websites', header: PRODUCTS.columns.websites, align: 'right', sortable: true },
					{
						key: 'baseUrl',
						header: PRODUCTS.columns.address,
						render: (p) => <span className="break-all text-xs text-muted">{p.baseUrl}</span>,
					},
				]}
			/>
			{owner ? (
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
						window.location.assign(adminRoutes.product(product.productId));
					}}
				/>
			) : null}
		</div>
	);
}

/**
 * A product page.
 * @param {any} props loader result of `loadProduct` plus `admin`
 */
export function ProductView(props) {
	const toast = useToast();
	const [product, setProduct] = useState(props.ok ? props.product : null);
	const [tab, setTab] = useState(props.ok ? props.tab : 'overview');
	const [reconnecting, setReconnecting] = useState(false);
	const [busy, setBusy] = useState(/** @type {null | 'open' | 'status'} */ (null));
	const [rows, setRows] = useState(/** @type {any[]} */ (props.ok ? props.websites.items : []));
	const [cursor, setCursor] = useState(/** @type {string | null} */ (props.ok ? props.websites.cursor : null));
	const [loadingMore, setLoadingMore] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (props.ok ? props.websitesProblem : null));
	if (!props.ok || !product)
		return <AdminProblem problem={props.problem} back={{ href: adminRoutes.products(), label: PRODUCTS.title }} />;
	const owner = adminCan(props.admin, 'products.manage');
	const numbers = product.numbers ?? {};

	const openAsAdmin = async () => {
		setBusy('open');
		const result = await openDashboard(adminFetch, adminApi.launch(product.productId), { websiteId: null });
		setBusy(null);
		if (!result.ok) toast.show({ tone: 'danger', title: describeProblem(result.problem) });
	};
	const toggle = async () => {
		const next = product.status === 'active' ? 'inactive' : 'active';
		setBusy('status');
		const result = await adminFetch(adminApi.productStatus(product.productId), { method: 'POST', body: { status: next } });
		setBusy(null);
		if (!result.ok) {
			toast.show({ tone: 'danger', title: describeProblem(result.problem) });
			return;
		}
		setProduct((/** @type {any} */ p) => ({ ...p, ...result.data.product }));
		toast.show({ title: next === 'active' ? PRODUCTS.activated : PRODUCTS.deactivated });
	};
	const more = async () => {
		setLoadingMore(true);
		const result = await adminFetch(adminApi.productWebsites(product.productId, cursor));
		setLoadingMore(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		setRows((list) => [...list, ...(result.data?.items ?? [])]);
		setCursor(result.data?.cursor ?? null);
	};

	const overview = (
		<div className="space-y-6">
			<div className="grid gap-4 sm:grid-cols-2">
				<Stat label={PRODUCTS.earnedThisMonth} value={formatCredits(numbers.earnedThisMonth ?? 0)} icon="wallet" />
				<Stat label={PRODUCTS.websitesUsing} value={numbers.websites ?? 0} icon="globe" />
			</div>
			<Card title={PRODUCTS.earnedChart}>
				<BarChart label={PRODUCTS.earnedChart} data={dayBars(numbers.days)} format={creditsOf} />
			</Card>
		</div>
	);
	const websites = (
		<div className="space-y-3">
			{problem ? <p className="text-sm text-danger">{describeProblem(problem)}</p> : null}
			<Table
				caption={PRODUCTS.tabs.websites}
				captionHidden
				rows={rows}
				rowKey={(w) => w.websiteId}
				empty={<EmptyState compact icon="globe" title={PRODUCTS.noWebsites} />}
				hasMore={cursor !== null}
				loadingMore={loadingMore}
				onLoadMore={() => void more()}
				columns={[
					{
						key: 'domain',
						header: PRODUCTS.websiteColumns.domain,
						rowHeader: true,
						render: (w) => (
							<Link
								href={adminRoutes.website(w.merchantId, w.websiteId)}
								className="break-all font-semibold text-primary hover:underline">
								{w.domain}
							</Link>
						),
					},
					{
						key: 'status',
						header: PRODUCTS.websiteColumns.status,
						render: (w) => <ProductStatusBadge status={w.status} featuresOn={w.featuresOn} />,
					},
					{
						key: 'dailyCost',
						header: PRODUCTS.websiteColumns.dailyCost,
						align: 'right',
						render: (w) => formatCredits(w.dailyCost ?? 0),
					},
					{
						key: 'merchant',
						header: PRODUCTS.websiteColumns.merchant,
						render: (w) => (
							<Link href={adminRoutes.merchant(w.merchantId)} className="hover:underline">
								{w.merchantName}
							</Link>
						),
					},
					{
						key: 'featuresOn',
						header: PRODUCTS.websiteColumns.featuresOn,
						render: (w) => featureNames(product.features, w.featuresOn),
					},
				]}
			/>
		</div>
	);

	return (
		<div className="flex gap-6">
			<InnerList
				label={PRODUCTS.title}
				search={PRODUCTS.search}
				currentId={product.productId}
				entries={props.products.map((/** @type {any} */ p) => ({
					id: p.productId,
					label: p.name,
					href: adminRoutes.product(p.productId),
					dot: p.status === 'active' ? 'success' : 'neutral',
				}))}
			/>
			<div className="min-w-0 flex-1 space-y-6">
				<BackLink href={adminRoutes.products()} label={PRODUCTS.title} />
				<PageHeader
					title={product.name}
					badge={<ProductActiveBadge status={product.status} />}
					subtitle={<span className="break-all">{product.baseUrl}</span>}
					actions={
						owner ? (
							<div className="flex flex-wrap gap-2">
								<Button
									variant="secondary"
									loading={busy === 'open'}
									title={PRODUCTS.openAsAdminHelp}
									onClick={() => void openAsAdmin()}
									icon={<Icon name="external" size={14} />}>
									{PRODUCTS.openAsAdmin}
								</Button>
								<Button
									variant="secondary"
									loading={busy === 'status'}
									title={PRODUCTS.inactiveHelp}
									onClick={() => void toggle()}>
									{product.status === 'active' ? PRODUCTS.setInactive : PRODUCTS.setActive}
								</Button>
								<Button variant="secondary" onClick={() => setReconnecting(true)}>
									{PRODUCTS.reconnect}
								</Button>
							</div>
						) : null
					}
				/>
				<KeyValueList
					columns={3}
					items={[
						{ label: PRODUCTS.address, value: <span className="break-all">{product.baseUrl}</span> },
						{ label: PRODUCTS.connectedAt, value: <LocalTime value={product.connectedAt} /> },
						...(product.reconnectedAt
							? [{ label: PRODUCTS.reconnectedAt, value: <LocalTime value={product.reconnectedAt} /> }]
							: []),
					]}
				/>
				<Tabs
					label={product.name}
					value={tab}
					onChange={setTab}
					tabs={[
						{ id: 'overview', label: PRODUCTS.tabs.overview, content: overview },
						{ id: 'websites', label: PRODUCTS.tabs.websites, content: websites },
					]}
				/>
			</div>
			{owner ? (
				<ConnectDialog
					open={reconnecting}
					title={PRODUCTS.reconnect}
					description={PRODUCTS.reconnectHelp}
					submitLabel={PRODUCTS.reconnect}
					urlRequired={false}
					path={adminApi.reconnect(product.productId)}
					onClose={() => setReconnecting(false)}
					onDone={(next) => {
						setReconnecting(false);
						setProduct((/** @type {any} */ p) => ({ ...p, ...next }));
						toast.show({ title: PRODUCTS.reconnected });
					}}
				/>
			) : null}
		</div>
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
