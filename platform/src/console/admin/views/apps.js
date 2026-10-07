'use client';
/**
 * Apps (products): list with status / kind filters; adding a service product (its URL and connect secret; connecting
 * again replaces the binding and stores a changed manifest as the current version); uploading a built pack folder
 * (`ss pack build` output: `descriptor.json` + assets) for a new pack, a pack version or a service product's widgets;
 * app detail with the Active / Inactive switch, "Retry deliveries now" and the admin launch.
 * @module
 */
import { useState } from 'react';
import {
	Badge,
	Button,
	ButtonLink,
	Callout,
	Card,
	Dialog,
	Form,
	FormActions,
	FormError,
	Icon,
	Input,
	KeyValueList,
	Meter,
	PageHeader,
	RadioGroup,
	Select,
	StatusBadge,
	Switch,
	Table,
	describeProblem,
	fieldErrors,
	formatDate,
	formatDateTime,
	formatNumber,
	humanize,
	useToast,
} from '@ss/ui';
import { Link } from '../../link.js';
import { adminFetch, adminUpload, useAdminResource, usePagedList } from '../client.js';
import { ID, adminApi, adminRoutes } from '../paths.js';
import { ActionProblem, AdminProblem, Crumbs, IdChip, localProblem, staffCan } from './common.js';

/** @typedef {import('@ss/ui').Problem} Problem */

const STATUSES = ['active', 'inactive'];

/**
 * @param {any} props loader result of `loadApps` plus `staff`
 */
export function AppsView(props) {
	const ok = props.ok === true;
	const filter = ok ? props.filter : {};
	const list = usePagedList(
		(cursor) => (ok ? adminApi.apps({ status: filter.status, kind: filter.kind, cursor, limit: 50 }) : null),
		ok ? props.page : null,
	);
	const [dialog, setDialog] = useState(/** @type {null | 'add' | 'pack'} */ (null));
	if (!ok) return <AdminProblem problem={props.problem} />;
	const canManage = staffCan(props.staff, 'platform.apps.manage');
	return (
		<div className="space-y-6">
			<PageHeader
				title="Apps"
				subtitle="Service products and element packs."
				actions={
					canManage ? (
						<>
							<Button variant="secondary" onClick={() => setDialog('pack')} icon={<Icon name="box" size={14} />}>
								Add pack
							</Button>
							<Button onClick={() => setDialog('add')} icon={<Icon name="plus" size={14} />}>
								Add product
							</Button>
						</>
					) : null
				}
			/>
			<form method="get" action="/admin/apps" className="flex flex-wrap items-end gap-3" aria-label="Filter apps">
				<Select
					label="Status"
					name="status"
					defaultValue={filter.status ?? ''}
					fieldClassName="w-44"
					options={[{ value: '', label: 'Any' }, ...STATUSES.map((s) => ({ value: s, label: humanize(s) }))]}
				/>
				<Select
					label="Kind"
					name="kind"
					defaultValue={filter.kind ?? ''}
					fieldClassName="w-44"
					options={[
						{ value: '', label: 'Any' },
						{ value: 'service', label: 'Service' },
						{ value: 'pack', label: 'Pack' },
					]}
				/>
				<Button type="submit" variant="secondary">
					Apply
				</Button>
			</form>
			<Table
				caption="Apps"
				rows={list.items}
				rowKey={(a) => a.appId}
				empty="No apps match."
				hasMore={Boolean(list.cursor)}
				loadingMore={list.loading}
				onLoadMore={() => void list.more()}
				columns={[
					{
						key: 'name',
						header: 'App',
						rowHeader: true,
						sortable: true,
						sortValue: (a) => a.name ?? a.slug,
						render: (a) => (
							<span className="space-y-0.5">
								<Link href={adminRoutes.app(a.appId)} className="block font-semibold text-primary hover:underline">
									{a.name ?? a.slug}
								</Link>
								<span className="block font-mono text-xs text-muted">{a.slug}</span>
							</span>
						),
					},
					{ key: 'kind', header: 'Kind', render: (a) => <Badge>{a.kind}</Badge> },
					{ key: 'status', header: 'Status', render: (a) => <StatusBadge status={a.status} /> },
					{
						key: 'version',
						header: 'Version',
						render: (a) => (
							<span className="space-x-1">
								<span className="tabular-nums">{a.currentVersion ? `v${a.currentVersion}` : '—'}</span>
								{a.productVersion ? <span className="text-xs text-muted">({a.productVersion})</span> : null}
							</span>
						),
					},
					{ key: 'createdAt', header: 'Created', sortable: true, render: (a) => formatDate(a.createdAt) },
				]}
			/>
			<ActionProblem problem={list.problem} />
			<AddProductDialog open={dialog === 'add'} onClose={() => setDialog(null)} />
			<PackDialog open={dialog === 'pack'} onClose={() => setDialog(null)} />
		</div>
	);
}

/**
 * Price changes of a reconnect (`[{ element, before, after }]`): a read-only note.
 * @param {{ changes: any[] | undefined }} props
 */
export function PriceChanges({ changes }) {
	if (!Array.isArray(changes) || changes.length === 0) return null;
	return (
		<Callout tone="warning" title="Prices changed">
			<ul className="mt-1 space-y-1">
				{changes.map((c) => (
					<li key={c.element} className="text-sm">
						<span className="font-mono text-xs">{c.element}</span>: {JSON.stringify(c.before ?? null)} →{' '}
						{JSON.stringify(c.after ?? null)}
					</li>
				))}
			</ul>
		</Callout>
	);
}

/**
 * Add a service product: its URL and the connect secret its deployer set as `CONNECT_SECRET`. The Portal calls the
 * product's `/.well-known/ss-connect` (HMAC with the secret, which is never sent nor stored) and pins its address and
 * key. Connecting an existing product again replaces its binding and stores a changed manifest as the current version.
 * @param {{ open: boolean, onClose: () => void }} props
 */
export function AddProductDialog({ open, onClose }) {
	const [url, setUrl] = useState('');
	const [secret, setSecret] = useState('');
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState(/** @type {any} */ (null));
	const close = () => {
		setDone(null);
		setProblem(null);
		setSecret('');
		onClose();
	};
	const connect = async () => {
		setBusy(true);
		setProblem(null);
		const result = await adminFetch(adminApi.connect(), { method: 'POST', body: { url: url.trim(), secret } });
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		setSecret('');
		setDone(result.data);
	};
	const errors = fieldErrors(problem);
	return (
		<Dialog
			open={open}
			onClose={close}
			title={done ? (done.reconnected ? 'Product reconnected' : 'Product connected') : 'Add a service product'}
			description={
				done
					? undefined
					: 'Deploy the product with MONGODB_URI and CONNECT_SECRET (a random string of at least 32 characters), then enter its address and that secret.'
			}
			footer={
				done ? (
					<ButtonLink as={Link} href={adminRoutes.app(done.appId)} variant="primary">
						Open {done.slug}
					</ButtonLink>
				) : null
			}>
			{done ? (
				<div className="space-y-3">
					<KeyValueList
						columns={1}
						items={[
							{ label: 'App', value: <IdChip id={done.appId} label="app id" /> },
							{ label: 'Address', value: done.baseUrl },
							{ label: 'Key', value: done.kid },
						]}
					/>
					<PriceChanges changes={done.priceChanges} />
				</div>
			) : (
				<Form onSubmit={connect} busy={busy} aria-label="Add a service product">
					<FormError problem={problem} />
					<Input
						label="Product URL"
						type="url"
						placeholder="https://product.example.com"
						value={url}
						onChange={(e) => setUrl(e.currentTarget.value)}
						error={errors.url}
						required
						autoFocus
					/>
					<Input
						label="Connect secret"
						type="password"
						autoComplete="off"
						value={secret}
						onChange={(e) => setSecret(e.currentTarget.value)}
						error={errors.secret}
						required
					/>
					<FormActions>
						<Button variant="secondary" onClick={close}>
							Cancel
						</Button>
						<Button type="submit" loading={busy}>
							Connect
						</Button>
					</FormActions>
				</Form>
			)}
		</Dialog>
	);
}

/**
 * The files of a picked `ss pack build` folder: its `descriptor.json` and every other file by its path relative to
 * the folder (`webkitRelativePath` without the folder's own name).
 * @param {ArrayLike<File>} picked
 * @returns {{ descriptor: File | null, files: Map<string, File> }}
 */
export const packFolder = (picked) => {
	const all = Array.from(picked).map((file) => ({ file, path: file.webkitRelativePath || file.name }));
	const top = all
		.filter((f) => f.path === 'descriptor.json' || f.path.endsWith('/descriptor.json'))
		.sort((a, b) => a.path.length - b.path.length)[0];
	if (!top) return { descriptor: null, files: new Map() };
	const root = top.path.slice(0, top.path.length - 'descriptor.json'.length);
	const files = new Map(all.filter((f) => f.path.startsWith(root)).map((f) => [f.path.slice(root.length), f.file]));
	return { descriptor: top.file, files };
};

/** Non-standard attributes that turn a file input into a folder picker. */
const FOLDER_PICKER = { webkitdirectory: '', directory: '' };

/** @param {string} path an asset path (`ui/x.js`) URL-encoded segment by segment */
const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');

/**
 * Upload a built pack folder (`ss pack build` output): `POST /v1/admin/packs { descriptor }`, then `PUT` the raw bytes
 * of every asset the Portal reports missing to `${uploadPath}<path>`. The same path serves a new pack, a new pack
 * version and a service product's widgets (the Portal tells them apart by the descriptor's manifest).
 * @param {{ open: boolean, onClose: () => void, title?: string, onDone?: () => unknown }} props
 */
export function PackDialog({ open, onClose, title = 'Upload a pack', onDone }) {
	const [picked, setPicked] = useState(/** @type {ReturnType<typeof packFolder> | null} */ (null));
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [busy, setBusy] = useState(false);
	const [progress, setProgress] = useState(/** @type {{ sent: number, total: number } | null} */ (null));
	const [done, setDone] = useState(/** @type {any} */ (null));
	const close = () => {
		setPicked(null);
		setDone(null);
		setProblem(null);
		setProgress(null);
		onClose();
	};
	const upload = async () => {
		if (!picked?.descriptor) {
			setProblem(localProblem('Choose the pack folder', 'Choose the folder `ss pack build` wrote (it has descriptor.json).'));
			return;
		}
		/** @type {any} */
		let descriptor;
		try {
			descriptor = JSON.parse(await picked.descriptor.text());
		} catch {
			setProblem(
				localProblem('Invalid descriptor', 'descriptor.json is not valid JSON: build the pack again with `ss pack build`.'),
			);
			return;
		}
		setBusy(true);
		setProblem(null);
		const result = await adminFetch(adminApi.packs(), { method: 'POST', body: { descriptor } });
		if (!result.ok) {
			setBusy(false);
			setProblem(result.problem);
			return;
		}
		const r = /** @type {any} */ (result.data);
		const missing = /** @type {string[]} */ (r.missing ?? []);
		const assets = new Map((descriptor.assets ?? []).map((/** @type {any} */ a) => [a.path, a]));
		setProgress({ sent: 0, total: missing.length });
		for (const [index, path] of missing.entries()) {
			const file = picked.files.get(path);
			if (!file) {
				setBusy(false);
				setProblem(
					localProblem('Missing file', `${path} is missing from the folder: build the pack again with \`ss pack build\`.`),
				);
				return;
			}
			const put = await adminUpload(`${r.uploadPath}${encodePath(path)}`, file, assets.get(path)?.contentType);
			if (!put.ok) {
				setBusy(false);
				setProblem(localProblem('Upload failed', `${path}: ${describeProblem(put.problem)}`));
				return;
			}
			setProgress({ sent: index + 1, total: missing.length });
		}
		setBusy(false);
		setDone(r);
		await onDone?.();
	};
	return (
		<Dialog
			open={open}
			onClose={close}
			title={done ? (done.changed || (done.missing ?? []).length > 0 ? 'Uploaded' : 'Nothing new') : title}
			description={done ? undefined : 'Pick the folder `ss pack build` wrote: descriptor.json and its assets.'}
			footer={
				done ? (
					<ButtonLink as={Link} href={adminRoutes.app(done.appId)} variant="primary">
						Open {done.slug}
					</ButtonLink>
				) : null
			}>
			{done ? (
				<p className="text-sm text-fg">
					{done.changed || (done.missing ?? []).length > 0
						? `Version v${done.version} of ${done.slug} is uploaded (${formatNumber((done.missing ?? []).length)} files sent).`
						: `This build matches version v${done.version} of ${done.slug}; nothing was stored.`}
				</p>
			) : (
				<Form onSubmit={upload} busy={busy} aria-label={title}>
					<label className="block space-y-1.5 text-sm font-semibold text-fg">
						<span>Pack folder</span>
						<input
							type="file"
							multiple
							{...FOLDER_PICKER}
							className="block w-full text-sm font-normal"
							onChange={(e) => {
								setProblem(null);
								setPicked(packFolder(e.currentTarget.files ?? []));
							}}
						/>
					</label>
					{picked ? (
						<p className="text-xs text-muted">
							{picked.descriptor
								? `${formatNumber(picked.files.size)} files, descriptor.json found.`
								: 'No descriptor.json in this folder.'}
						</p>
					) : null}
					{progress ? (
						<Meter
							label="Assets"
							value={progress.sent}
							max={Math.max(progress.total, 1)}
							valueText={`${progress.sent} / ${progress.total}`}
							tone="primary"
						/>
					) : null}
					<FormError problem={problem} />
					<FormActions>
						<Button variant="secondary" onClick={close}>
							Cancel
						</Button>
						<Button type="submit" loading={busy}>
							Upload
						</Button>
					</FormActions>
				</Form>
			)}
		</Dialog>
	);
}

/** Whether a manifest declares mode-A elements (widgets rendered on the website). */
export const hasWidgets = (/** @type {any} */ manifest) =>
	(manifest?.elements ?? []).some((/** @type {any} */ e) => (e.modes ?? []).includes('A'));

/**
 * @param {any} props loader result of `loadApp` plus `staff`
 */
export function AppView(props) {
	const toast = useToast();
	const ok = props.ok === true;
	const appId = ok ? props.app.appId : null;
	const { data: app, reload } = useAdminResource(appId ? adminApi.app(appId) : null, ok ? props.app : null);
	const [uploading, setUploading] = useState(false);
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [retrying, setRetrying] = useState(false);
	if (!ok) return <AdminProblem problem={props.problem} back={{ href: adminRoutes.apps(), label: 'Back to apps' }} />;
	const { staff, manifest } = props;
	const canManage = staffCan(staff, 'platform.apps.manage');
	const canLaunch = staffCan(staff, 'platform.launch.admin');
	const upload = app.kind === 'pack' ? 'Upload pack version' : hasWidgets(manifest) ? 'Upload widgets' : null;

	const setStatus = async (/** @type {boolean} */ active) => {
		setBusy(true);
		setProblem(null);
		const result = await adminFetch(adminApi.status(app.appId), {
			method: 'POST',
			body: { status: active ? 'active' : 'inactive' },
		});
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		toast.show({ title: `${app.name ?? app.slug}: ${active ? 'active' : 'inactive'}` });
		await reload();
	};

	// failed event deliveries wait for a natural retry (the next event or call of the product); staff can force it
	const retryDeliveries = async () => {
		setRetrying(true);
		setProblem(null);
		const result = await adminFetch(adminApi.retryDeliveries(app.appId), { method: 'POST', body: {} });
		setRetrying(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		const r = result.data;
		const failing = (r.retried ?? 0) + (r.failed ?? 0);
		toast.show({
			title: 'Deliveries retried',
			description: `${formatNumber(r.succeeded ?? 0)} delivered, ${formatNumber(failing)} still failing`,
			tone: failing > 0 ? 'danger' : 'success',
		});
	};

	return (
		<div className="space-y-6">
			<PageHeader
				breadcrumbs={<Crumbs items={[{ label: 'Apps', href: adminRoutes.apps() }, { label: app.name ?? app.slug }]} />}
				title={app.name ?? app.slug}
				badge={
					<>
						<StatusBadge status={app.status} />
						<Badge>{app.kind}</Badge>
					</>
				}
				subtitle={
					<span className="inline-flex flex-wrap items-center gap-2">
						<span className="font-mono text-xs">{app.slug}</span>
						<IdChip id={app.appId} label="app id" />
					</span>
				}
				actions={
					<>
						<ButtonLink as={Link} href={adminRoutes.policies(app.appId)} icon={<Icon name="sliders" size={14} />}>
							Platform policy
						</ButtonLink>
						{upload && canManage ? (
							<Button variant="secondary" onClick={() => setUploading(true)} icon={<Icon name="box" size={14} />}>
								{upload}
							</Button>
						) : null}
						{app.kind === 'service' && staffCan(staff, 'platform.jobs.manage') ? (
							<Button
								variant="secondary"
								onClick={() => void retryDeliveries()}
								loading={retrying}
								icon={<Icon name="send" size={14} />}>
								Retry deliveries now
							</Button>
						) : null}
					</>
				}
			/>
			<ActionProblem problem={problem} />
			<Card title="Overview">
				<div className="space-y-4">
					<Switch
						label="Active"
						description="Active apps are listed to merchants and can be subscribed. Existing subscriptions keep working either way."
						checked={app.status === 'active'}
						disabled={!canManage || busy}
						onChange={(next) => void setStatus(next)}
					/>
					<KeyValueList
						columns={3}
						items={[
							{
								label: 'Current version',
								value: app.currentVersion
									? `v${app.currentVersion}${app.productVersion ? ` (${app.productVersion})` : ''}`
									: 'None yet',
							},
							{ label: 'Created', value: formatDateTime(app.createdAt) },
							{
								label: app.kind === 'service' ? 'Address' : 'Endpoints base',
								value: <span className="break-all font-mono text-xs">{app.baseUrl ?? app.endpoints?.base ?? '—'}</span>,
							},
						]}
					/>
				</div>
			</Card>

			{canLaunch && app.kind === 'service' ? <LaunchCard app={app} staff={staff} /> : null}

			{upload ? <PackDialog open={uploading} onClose={() => setUploading(false)} title={upload} onDone={reload} /> : null}
		</div>
	);
}

/**
 * Open the product as admin (production): scoped to one merchant (optionally one website) or app-wide (`all`,
 * superadmin/admin).
 * @param {{ app: any, staff: any }} props
 */
function LaunchCard({ app, staff }) {
	const allowAll = (staff?.roles ?? []).some((/** @type {string} */ r) => r === 'superadmin' || r === 'admin');
	const [scope, setScope] = useState('merchant');
	const [merchantId, setMerchantId] = useState('');
	const [websiteId, setWebsiteId] = useState('');
	const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [busy, setBusy] = useState(false);
	const launch = async () => {
		/** @type {Record<string, string>} */
		const local = {};
		if (scope === 'merchant' && !ID.merchant.test(merchantId.trim())) local.merchantId = 'Enter a merchant id (mer_…).';
		if (scope === 'merchant' && websiteId.trim() && !ID.website.test(websiteId.trim()))
			local.websiteId = 'Enter a website id (web_…) or leave empty.';
		setErrors(local);
		if (Object.keys(local).length > 0) return;
		setBusy(true);
		setProblem(null);
		const result = await adminFetch(adminApi.launch(app.appId), {
			method: 'POST',
			body: {
				kind: 'admin',
				...(scope === 'all'
					? { all: true }
					: { merchantId: merchantId.trim(), ...(websiteId.trim() ? { websiteId: websiteId.trim() } : {}) }),
			},
		});
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		window.open(result.data.url, '_blank', 'noopener,noreferrer');
	};
	return (
		<Card title="Launch as admin" subtitle="Single-use launch link, valid for a minute. Audited.">
			<Form onSubmit={launch} busy={busy} aria-label="Launch as admin">
				<RadioGroup
					legend="Scope"
					value={scope}
					onChange={setScope}
					options={[
						{ value: 'merchant', label: 'One merchant' },
						{ value: 'all', label: 'App-wide (all merchants)', disabled: !allowAll },
					]}
					help={allowAll ? undefined : 'App-wide launches need the superadmin or admin role.'}
				/>
				{scope === 'merchant' ? (
					<div className="grid gap-4 sm:grid-cols-2">
						<Input
							label="Merchant id"
							value={merchantId}
							onChange={(e) => setMerchantId(e.currentTarget.value)}
							error={errors.merchantId}
							className="font-mono"
							placeholder="mer_…"
						/>
						<Input
							label="Website id (optional)"
							value={websiteId}
							onChange={(e) => setWebsiteId(e.currentTarget.value)}
							error={errors.websiteId}
							className="font-mono"
							placeholder="web_…"
						/>
					</div>
				) : null}
				<FormError problem={problem} fields={['merchantId', 'websiteId', 'all']} />
				<FormActions>
					<Button type="submit" loading={busy} icon={<Icon name="external" size={14} />}>
						Open {app.name ?? app.slug}
					</Button>
				</FormActions>
			</Form>
		</Card>
	);
}
