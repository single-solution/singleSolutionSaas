'use client';
/**
 * Products (PLAN 0.8.2, 0.6; layout contract 2026-10-17): the Products page is a table of the connected products
 * (search, a status filter Active / Inactive, a sort by name, credits this month or websites; per row the name, the
 * status, the websites using it and the credits earned this month) with **Add product** (the product URL and connect
 * secret in a drawer; new products start inactive; an id already connected is refused with "use Reconnect"). A row opens
 * the product's page: a header (name, Active / Inactive, the credits earned this month and the websites as numbers;
 * Open as admin, Set active / inactive and a More menu with Copy address and Reconnect) and its parts in the inner
 * navigation, each its own address: Websites (the 30-day earnings chart above the websites using it with their
 * merchant, status, features on and daily cost; paged), Features and prices, and Connection (address, connected date,
 * id, version, price list, widget script, docs). Owners manage products; Support sees them read-only. The Portal
 * checks every right again.
 * @module
 */
import { useId, useState } from 'react';
import {
	BarChart,
	Button,
	Callout,
	Card,
	DataTable,
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
	SoftBreaks,
	TextLink,
	Toolbar,
	copyText,
	describeProblem,
	fieldErrors,
	formatCredits,
	isEmptySeries,
	problemCode,
	useToast,
	usePaged,
} from '@ss/ui';
import { MORE, PRODUCTS } from '../../../texts/console.js';
import { Link } from '../../link.js';
import { useNavigation } from '../../navigation.js';
import { creditDayBars, formatChartCredits, productPill } from '../../views/billing.js';
import { openDashboard } from '../../views/common.js';
import { useListPages } from '../../views/paging.js';
import { apiFetch } from '../../client.js';
import { adminApi, adminRoutes } from '../paths.js';
import { AdminProblem, adminCan } from './common.js';

/** @typedef {import('@ss/ui').Problem} Problem */

/** The parts of a product's page, each its own address (Websites is the product's own address). */
export const PRODUCT_PARTS = ['websites', 'features', 'connection'];

/**
 * The pill of a connected product's status.
 * @param {{ status: string }} product
 * @returns {{ status: 'active' | 'off', label: string }}
 */
const activePill = (product) =>
	product.status === 'active'
		? { status: 'active', label: PRODUCTS.status.active }
		: { status: 'off', label: PRODUCTS.status.inactive };

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
 * The Products list: a table with search, a status filter and a sort; Add product opens the connect drawer.
 * @param {{ props: any, owner: boolean }} input
 */
function ProductsPage({ props, owner }) {
	const toast = useToast();
	const nav = useNavigation();
	const [adding, setAdding] = useState(false);
	const [sort, setSort] = useState(/** @type {'name' | 'earned' | 'websites'} */ ('name'));
	const status = props.filter.status ?? '';
	const sorted = /** @type {any[]} */ ([...props.items]).sort((a, b) =>
		sort === 'earned'
			? (b.earnedThisMonth ?? 0) - (a.earnedThisMonth ?? 0)
			: sort === 'websites'
				? (b.websites ?? 0) - (a.websites ?? 0)
				: 0,
	);
	const paged = usePaged(sorted, {
		pageSize: 50,
		text: (p) => `${p.name} ${p.productId}`,
	});
	const nothingYet = props.items.length === 0 && !status;
	const add = owner ? (
		<Button onClick={() => setAdding(true)} icon={<Icon name="plus" size={14} />}>
			{PRODUCTS.add}
		</Button>
	) : null;
	return (
		<>
			<Page
				flush
				linkAs={Link}
				crumbs={[{ label: PRODUCTS.title }]}
				info={PRODUCTS.info}
				{...(owner ? { actions: { primary: { label: PRODUCTS.add, icon: 'plus', onClick: () => setAdding(true) } } } : {})}
				toolbar={
					<Toolbar
						label={PRODUCTS.title}
						search={{
							value: paged.query,
							label: PRODUCTS.search,
							placeholder: PRODUCTS.search,
							onSearch: paged.setQuery,
						}}
						filters={[
							{
								id: 'status',
								label: PRODUCTS.columns.status,
								allLabel: PRODUCTS.allStatuses,
								value: status,
								onChange: (next) => nav.go(adminRoutes.products({ status: next || null })),
								options: [
									{ value: 'active', label: PRODUCTS.status.active },
									{ value: 'inactive', label: PRODUCTS.status.inactive },
								],
							},
						]}
						sort={{
							label: MORE.sort.label,
							value: sort,
							onChange: (next) => setSort(/** @type {'name'} */ (next)),
							options: [
								{ value: 'name', label: MORE.sort.name },
								{ value: 'earned', label: MORE.sort.earned },
								{ value: 'websites', label: MORE.sort.websites },
							],
						}}
						range={MORE.count(paged.found.length)}
					/>
				}
				{...(paged.found.length > 0 ? { footer: <Pagination {...paged.pagination} /> } : {})}>
				<DataTable
					caption={PRODUCTS.title}
					rows={paged.rows}
					rowKey={(p) => String(p.productId)}
					rowLabel={(p) => p.name}
					onRowClick={(p) => nav.go(adminRoutes.product(p.productId))}
					empty={
						nothingYet ? (
							<EmptyState
								icon="box"
								kind="product"
								title={PRODUCTS.none}
								description={owner ? PRODUCTS.noneHelp : undefined}
								action={add}
							/>
						) : (
							<EmptyState compact icon="box" kind="product" title={PRODUCTS.noneFound} />
						)
					}
					columns={[
						{
							key: 'name',
							header: PRODUCTS.listColumns.name,
							rowHeader: true,
							render: (p) => (
								<Link href={adminRoutes.product(p.productId)} className="font-medium text-fg hover:underline">
									{p.name}
								</Link>
							),
						},
						{ key: 'status', header: PRODUCTS.columns.status, kind: 'status', pill: (p) => activePill(p) },
						{
							key: 'websites',
							header: PRODUCTS.listColumns.websites,
							kind: 'number',
							render: (p) => p.websites ?? 0,
						},
						{
							key: 'earned',
							header: PRODUCTS.listColumns.earned,
							kind: 'money',
							render: (p) => formatCredits(p.earnedThisMonth ?? 0),
						},
					]}
				/>
			</Page>
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
						nav.go(adminRoutes.product(product.productId));
					}}
				/>
			) : null}
		</>
	);
}

/**
 * The websites using a product: the first page from the loader, then the next ones by cursor (the shape `useListPages`
 * pages through).
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
	return { items, cursor, loading, problem, more };
}

/**
 * A product's page: the header and one part of it at a time, each part its own address.
 * @param {{ detail: any, owner: boolean, part: string }} props
 */
function ProductPage({ detail, owner, part }) {
	const toast = useToast();
	const nav = useNavigation();
	const [product, setProduct] = useState(detail.product);
	const [reconnecting, setReconnecting] = useState(false);
	const [busy, setBusy] = useState(/** @type {null | 'open' | 'status'} */ (null));
	const sites = useProductWebsites(String(product.productId), detail.websites, detail.websitesProblem);
	const pages = useListPages(sites);
	const id = String(product.productId);
	const numbers = product.numbers ?? {};
	const earned = creditDayBars(numbers.days);
	const features = /** @type {any[]} */ (product.features ?? []);
	const shown = PRODUCT_PARTS.includes(part) ? part : 'websites';

	const openAsAdmin = async () => {
		setBusy('open');
		const result = await openDashboard(adminApi.launch(id), { websiteId: null });
		setBusy(null);
		if (!result.ok) toast.show({ tone: 'danger', title: describeProblem(result.problem) });
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

	const bodies = {
		websites: (
			<>
				{sites.problem ? (
					<div className="p-4">
						<Callout tone="danger">{describeProblem(sites.problem)}</Callout>
					</div>
				) : null}
				{isEmptySeries(earned) ? null : (
					<div className="shrink-0 border-b border-line-soft px-4 py-3">
						<p className="mb-2 text-label text-muted">{PRODUCTS.earnedChart}</p>
						<BarChart label={PRODUCTS.earnedChart} data={earned} format={formatChartCredits} height={120} />
					</div>
				)}
				<DataTable
					caption={PRODUCTS.websitesTitle}
					rows={pages.rows}
					rowKey={(w) => String(w.websiteId)}
					rowLabel={(w) => w.domain}
					onRowClick={(w) => nav.go(adminRoutes.website(w.merchantId, w.websiteId))}
					empty={<EmptyState compact icon="globe" kind="website" title={PRODUCTS.noWebsites} />}
					columns={[
						{
							key: 'domain',
							header: PRODUCTS.websiteColumns.website,
							rowHeader: true,
							// a long domain wraps between its parts and a long merchant name on words
							wrap: true,
							render: (w) => (
								<span className="block min-w-0">
									<TextLink
										as={Link}
										href={adminRoutes.website(w.merchantId, w.websiteId)}
										title={w.domain}
										className="line-clamp-2 break-words">
										<SoftBreaks text={w.domain} />
									</TextLink>
									<Link
										href={adminRoutes.merchant(w.merchantId)}
										title={w.merchantName}
										className="line-clamp-2 text-xs font-normal text-muted hover:text-fg hover:underline">
										{w.merchantName}
									</Link>
								</span>
							),
						},
						{ key: 'status', header: PRODUCTS.websiteColumns.status, kind: 'status', pill: (w) => productPill(w) },
						{
							key: 'featuresOn',
							header: PRODUCTS.websiteColumns.featuresOn,
							low: true,
							render: (w) => {
								const names = featureNames(features, w.featuresOn);
								return (
									<span className="block max-w-56 truncate" title={names}>
										{names}
									</span>
								);
							},
						},
						{
							key: 'dailyCost',
							header: PRODUCTS.websiteColumns.dailyCost,
							kind: 'money',
							render: (w) => formatCredits(w.dailyCost ?? 0),
						},
					]}
				/>
			</>
		),
		features: (
			<DataTable
				caption={MORE.featuresTitle}
				rows={features}
				rowKey={(f) => String(f.key)}
				empty={<EmptyState compact icon="sliders" kind="product" title={MORE.noFeatures} />}
				columns={[
					{
						key: 'name',
						header: MORE.featureColumns.feature,
						rowHeader: true,
						wrap: true,
						render: (f) => (
							<span className="block min-w-48 space-y-0.5">
								<span className="block font-semibold text-fg">{f.name}</span>
								{f.description ? <span className="block text-xs text-muted">{f.description}</span> : null}
							</span>
						),
					},
					{
						key: 'needs',
						header: MORE.featureColumns.needs,
						wrap: true,
						render: (f) =>
							(f.dependsOn ?? []).length > 0 ? featureNames(features, f.dependsOn) : <span className="text-muted">—</span>,
					},
					{
						key: 'perHour',
						header: MORE.featureColumns.perHour,
						kind: 'money',
						render: (f) => formatCredits(f.millicreditsPerHour ?? 0),
					},
					{
						key: 'perDay',
						header: MORE.featureColumns.perDay,
						kind: 'money',
						render: (f) => formatCredits(24 * (f.millicreditsPerHour ?? 0)),
					},
				]}
			/>
		),
		connection: (
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
	};

	return (
		<>
			<Page
				linkAs={Link}
				flush={shown !== 'connection'}
				bodyKey={shown}
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
						href: adminRoutes.productPart(id, 'websites'),
					},
				]}
				{...(owner
					? {
							actions: {
								primary: {
									label: PRODUCTS.openAsAdmin,
									icon: 'external',
									title: PRODUCTS.openAsAdminHelp,
									loading: busy === 'open',
									onClick: () => openAsAdmin(),
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
								],
							},
						}
					: {})}
				nav={{
					value: shown,
					label: PRODUCTS.parts,
					items: /** @type {import('@ss/ui').InnerNavItem[]} */ ([
						{ id: 'websites', label: PRODUCTS.websitesTitle, icon: 'globe', count: pages.count },
						{ id: 'features', label: MORE.featuresTitle, icon: 'sliders', count: features.length },
						{ id: 'connection', label: MORE.connectionTitle, icon: 'link' },
					]).map((item) => ({ ...item, href: adminRoutes.productPart(id, item.id) })),
				}}
				{...(shown === 'websites' && pages.pagination ? { footer: <Pagination {...pages.pagination} /> } : {})}>
				{bodies[/** @type {keyof typeof bodies} */ (shown)]}
			</Page>
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
 * The Products screens. Without a `detail` the list (a table); with the `detail` of `loadProduct` a product's page, on
 * the part `section` (websites, features, connection).
 * @param {any} props loader result of `loadProducts` (the list) or `{ detail, admin, section }`
 */
export function ProductsView(props) {
	const owner = adminCan(props.admin, 'products.manage');
	const detail = props.detail ?? null;
	if (detail) {
		if (!detail.ok)
			return <AdminProblem problem={detail.problem} back={{ href: adminRoutes.products(), label: PRODUCTS.title }} />;
		return (
			<ProductPage key={String(detail.product.productId)} detail={detail} owner={owner} part={props.section ?? 'websites'} />
		);
	}
	if (!props.ok) return <AdminProblem problem={props.problem} />;
	return <ProductsPage key={props.filter.status ?? ''} props={props} owner={owner} />;
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
