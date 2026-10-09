'use client';
/**
 * Products (PLAN 0.8.2, 0.6): one list-and-detail screen. The list of connected products (search, filter Active /
 * Inactive; per row the name, a status dot and the websites using it) with **Add product** (the product URL and
 * connect secret; new products start inactive; an id already connected is refused with "use Reconnect") sits beside
 * the selected product — on wide screens the first one until another is picked: a header (name, Active / Inactive,
 * address and connected date; actions Open as admin, Set active / inactive, Reconnect), its numbers (credits earned
 * this month with the 30-day chart — one line while there is nothing to draw — and websites using it) and its websites
 * (domain with its merchant, status, features on, daily cost; paged). Owners manage products; Support sees them
 * read-only. The Portal checks every right again.
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
	PageHeader,
	Section,
	Select,
	Stat,
	Table,
	describeProblem,
	fieldErrors,
	formatCredits,
	isEmptySeries,
	problemCode,
	useToast,
} from '@ss/ui';
import { PRODUCTS } from '../../../texts/console.js';
import { Link } from '../../link.js';
import { LocalTime, ProductStatusBadge } from '../../views/billing.js';
import { ListDetail, ListPane, ListRow, ListSearch, openDashboard } from '../../views/common.js';
import { adminFetch } from '../client.js';
import { adminApi, adminRoutes } from '../paths.js';
import { AdminProblem, adminCan } from './common.js';
import { dayBars } from './overview.js';

/** @typedef {import('@ss/ui').Problem} Problem */

/**
 * Active / Inactive badge of a connected product.
 * @param {{ status: string }} props
 */
function ProductActiveBadge({ status }) {
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
function ConnectDialog({ open, title, description, submitLabel, urlRequired, path, onClose, onDone, conflict }) {
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
 * The Products list pane (by name). `selectedId` is the product the URL picks; `autoId` the one opened by default.
 * @param {{ props: any, owner: boolean, selectedId: string | null, autoId?: string | null }} input
 */
function ProductList({ props, owner, selectedId, autoId = null }) {
	const toast = useToast();
	const [adding, setAdding] = useState(false);
	const [q, setQ] = useState('');
	const needle = q.trim().toLowerCase();
	const status = props.filter.status ?? '';
	const rows = /** @type {any[]} */ (props.items).filter(
		(p) => !needle || String(p.name).toLowerCase().includes(needle) || String(p.productId).includes(needle),
	);
	const keep = { status: props.filter.status };
	return (
		<>
			<ListPane
				title={PRODUCTS.title}
				action={
					owner ? (
						<Button size="sm" onClick={() => setAdding(true)} icon={<Icon name="plus" size={14} />}>
							{PRODUCTS.add}
						</Button>
					) : null
				}
				tools={
					<ListSearch label={PRODUCTS.search} value={q} onChange={setQ}>
						<Select
							label={PRODUCTS.columns.status}
							hideLabel
							fieldClassName="min-w-0 flex-1"
							value={status}
							options={[
								{ value: '', label: PRODUCTS.allStatuses },
								{ value: 'active', label: PRODUCTS.status.active },
								{ value: 'inactive', label: PRODUCTS.status.inactive },
							]}
							onChange={(e) => {
								const next = { status: e.currentTarget.value || null };
								window.location.assign(selectedId ? adminRoutes.product(selectedId, next) : adminRoutes.products(next));
							}}
						/>
					</ListSearch>
				}>
				{rows.length === 0 ? (
					<li>
						<EmptyState compact icon="box" kind="product" title={PRODUCTS.none} />
					</li>
				) : (
					rows.map((p) => (
						<ListRow
							key={p.productId}
							href={adminRoutes.product(p.productId, keep)}
							current={p.productId === selectedId ? true : p.productId === autoId ? 'wide' : false}
							label={p.name}
							sublabel={formatCredits(p.earnedThisMonth ?? 0)}
							dot={p.status === 'active' ? 'success' : 'neutral'}
							dotLabel={p.status === 'active' ? PRODUCTS.status.active : PRODUCTS.status.inactive}
							meta={PRODUCTS.websitesCount(p.websites ?? 0)}
						/>
					))
				)}
			</ListPane>
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
						window.location.assign(adminRoutes.product(product.productId, keep));
					}}
				/>
			) : null}
		</>
	);
}

/**
 * The selected product: header with its actions, numbers and websites.
 * @param {{ detail: any, owner: boolean }} props
 */
function ProductDetail({ detail, owner }) {
	const toast = useToast();
	const [product, setProduct] = useState(detail.product);
	const [reconnecting, setReconnecting] = useState(false);
	const [busy, setBusy] = useState(/** @type {null | 'open' | 'status'} */ (null));
	const [rows, setRows] = useState(/** @type {any[]} */ (detail.websites.items));
	const [cursor, setCursor] = useState(/** @type {string | null} */ (detail.websites.cursor));
	const [loadingMore, setLoadingMore] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (detail.websitesProblem));
	const numbers = product.numbers ?? {};
	const earned = dayBars(numbers.days);

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

	return (
		<>
			<PageHeader
				level={2}
				title={product.name}
				badge={<ProductActiveBadge status={product.status} />}
				subtitle={
					<span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
						<span className="max-w-full truncate font-mono text-xs" title={product.baseUrl}>
							{product.baseUrl}
						</span>
						<span>
							{PRODUCTS.connectedOn} <LocalTime value={product.connectedAt} />
							{product.reconnectedAt ? (
								<>
									{' · '}
									{PRODUCTS.reconnectedOn} <LocalTime value={product.reconnectedAt} />
								</>
							) : null}
						</span>
					</span>
				}
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
			<div className="grid gap-5 sm:grid-cols-2">
				<Stat
					label={PRODUCTS.earnedThisMonth}
					value={formatCredits(numbers.earnedThisMonth ?? 0)}
					icon="coins"
					kind="credit"
					{...(isEmptySeries(earned) ? { hint: PRODUCTS.noEarnings } : {})}
				/>
				<Stat label={PRODUCTS.websitesUsing} value={numbers.websites ?? 0} icon="globe" kind="website" />
			</div>
			{isEmptySeries(earned) ? null : (
				<Card title={PRODUCTS.earnedChart}>
					<BarChart label={PRODUCTS.earnedChart} data={earned} format={creditsOf} />
				</Card>
			)}
			<Section id="product-websites" title={PRODUCTS.websitesTitle} description={PRODUCTS.websitesIntro}>
				{problem ? <p className="text-sm text-danger">{describeProblem(problem)}</p> : null}
				<Table
					caption={PRODUCTS.websitesTitle}
					captionHidden
					rows={rows}
					rowKey={(w) => w.websiteId}
					empty={<EmptyState compact icon="globe" kind="website" title={PRODUCTS.noWebsites} />}
					hasMore={cursor !== null}
					loadingMore={loadingMore}
					onLoadMore={() => void more()}
					columns={[
						{
							key: 'domain',
							header: PRODUCTS.websiteColumns.website,
							rowHeader: true,
							className: 'max-w-[20rem]',
							render: (w) => (
								<span className="block min-w-0">
									<Link
										href={adminRoutes.website(w.merchantId, w.websiteId)}
										title={w.domain}
										className="block truncate font-semibold text-primary hover:underline">
										{w.domain}
									</Link>
									<Link
										href={adminRoutes.merchant(w.merchantId)}
										title={w.merchantName}
										className="block truncate text-xs font-normal text-muted hover:text-fg hover:underline">
										{w.merchantName}
									</Link>
								</span>
							),
						},
						{
							key: 'status',
							header: PRODUCTS.websiteColumns.status,
							render: (w) => <ProductStatusBadge status={w.status} featuresOn={w.featuresOn} />,
						},
						{
							key: 'featuresOn',
							header: PRODUCTS.websiteColumns.featuresOn,
							className: 'max-w-[16rem]',
							render: (w) => {
								const names = featureNames(product.features, w.featuresOn);
								return (
									<span className="block truncate" title={names}>
										{names}
									</span>
								);
							},
						},
						{
							key: 'dailyCost',
							header: PRODUCTS.websiteColumns.dailyCost,
							align: 'right',
							className: 'whitespace-nowrap',
							render: (w) => formatCredits(w.dailyCost ?? 0),
						},
					]}
				/>
			</Section>
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
		</>
	);
}

/**
 * The Products screen: the list beside the selected product — the one the URL picks or, with `auto`, the first of the
 * list (shown on wide screens only) — or a short empty state when there are no products.
 * @param {any} props loader result of `loadProducts` plus `admin` and, with a product shown, `detail` (the result of
 *   `loadProduct`), `selectedId` and `auto`
 */
export function ProductsView(props) {
	if (!props.ok) return <AdminProblem problem={props.problem} />;
	const owner = adminCan(props.admin, 'products.manage');
	const detail = props.detail ?? null;
	const auto = props.auto === true;
	const shownId = detail ? (detail.ok ? String(detail.product.productId) : String(props.selectedId)) : null;
	const back = adminRoutes.products({ status: props.filter.status });
	return (
		<ListDetail
			label={PRODUCTS.title}
			auto={auto}
			back={{ href: back, label: PRODUCTS.title }}
			list={<ProductList props={props} owner={owner} selectedId={auto ? null : shownId} autoId={auto ? shownId : null} />}
			empty={
				<EmptyState
					icon="box"
					kind="product"
					title={PRODUCTS.none}
					description={owner && !props.filter.status ? PRODUCTS.noneHelp : undefined}
				/>
			}
			detail={
				detail === null ? null : detail.ok ? (
					<ProductDetail key={shownId} detail={detail} owner={owner} />
				) : (
					<AdminProblem problem={detail.problem} back={{ href: back, label: PRODUCTS.title }} />
				)
			}
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
