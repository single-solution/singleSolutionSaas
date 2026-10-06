'use client';
/**
 * Apps (products): list with status / kind filters; registration of a service product (base URL + one-time token,
 * never shown again); upload of a signed pack bundle (descriptor + detached signature + key); app detail with
 * manifest versions (diff viewer with breaking flags, approve / reject with reason), lifecycle (activate,
 * deprecate with a sunset date, retire), environments, keys (revoke), health and the admin launch (one merchant,
 * or app-wide `all` for superadmins/admins).
 * @module
 */
import { useState } from 'react';
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
	FormActions,
	FormError,
	Icon,
	Input,
	KeyValueList,
	PageHeader,
	RadioGroup,
	Select,
	StatusBadge,
	Table,
	TextArea,
	TypedConfirmDialog,
	describeProblem,
	fieldErrors,
	formatDate,
	formatDateTime,
	formatNumber,
	humanize,
	useToast,
} from '@ss/ui';
import { Link } from '../../link.js';
import { adminFetch, useAdminResource, usePagedList } from '../client.js';
import { ID, adminApi, adminRoutes } from '../paths.js';
import { ActionProblem, AdminProblem, Crumbs, IdChip, localProblem, staffCan } from './common.js';

/** @typedef {import('@ss/ui').Problem} Problem */

const STATUSES = ['pending', 'active', 'deprecated', 'retired'];

/** Health label of an app: `Healthy`, `Stale`, the reported status, or null for packs. */
export const healthLabel = (/** @type {any} */ app) => {
	if (app.kind !== 'service' || !app.health) return null;
	if (app.health.stale) return { status: 'failing', label: app.health.lastSeenAt ? 'Stale' : 'Never seen' };
	if (app.health.status && app.health.status !== 'ok') return { status: 'failing', label: humanize(app.health.status) };
	return { status: 'ok', label: 'Healthy' };
};

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
	const [dialog, setDialog] = useState(/** @type {null | 'register' | 'pack'} */ (null));
	if (!ok) return <AdminProblem problem={props.problem} />;
	const canManage = staffCan(props.staff, 'platform.apps.manage');
	return (
		<div className="space-y-6">
			<PageHeader
				title="Apps"
				subtitle="Service products and element packs: review, lifecycle, keys and health."
				actions={
					canManage ? (
						<>
							<Button variant="secondary" onClick={() => setDialog('pack')} icon={<Icon name="box" size={14} />}>
								Upload pack
							</Button>
							<Button onClick={() => setDialog('register')} icon={<Icon name="plus" size={14} />}>
								Register service
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
								<span className="tabular-nums">v{a.currentVersion}</span>
								{a.productVersion ? <span className="text-xs text-muted">({a.productVersion})</span> : null}
								{a.pendingVersion ? <Badge tone="info">v{a.pendingVersion} to review</Badge> : null}
							</span>
						),
					},
					{
						key: 'health',
						header: 'Health',
						render: (a) => {
							const h = healthLabel(a);
							return h ? <StatusBadge status={h.status} label={h.label} /> : <span className="text-muted">—</span>;
						},
					},
					{ key: 'createdAt', header: 'Created', sortable: true, render: (a) => formatDate(a.createdAt) },
				]}
			/>
			<ActionProblem problem={list.problem} />
			<RegisterDialog open={dialog === 'register'} onClose={() => setDialog(null)} />
			<PackDialog open={dialog === 'pack'} onClose={() => setDialog(null)} />
		</div>
	);
}

/**
 * Register a service product: the Portal calls the product's registration endpoint with the one-time token and
 * verifies its proof of possession. The token is write-only (never stored or shown by the Portal).
 * @param {{ open: boolean, onClose: () => void }} props
 */
export function RegisterDialog({ open, onClose }) {
	const [baseUrl, setBaseUrl] = useState('');
	const [stagingBaseUrl, setStaging] = useState('');
	const [token, setToken] = useState('');
	const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState(/** @type {any} */ (null));
	const close = () => {
		setToken('');
		setDone(null);
		setProblem(null);
		setErrors({});
		onClose();
	};
	const submit = async () => {
		/** @type {Record<string, string>} */
		const local = {};
		if (!/^https:\/\/[^\s/]+/.test(baseUrl.trim())) local.baseUrl = 'Enter the product base URL (https://…).';
		if (stagingBaseUrl.trim() && !/^https:\/\/[^\s/]+/.test(stagingBaseUrl.trim()))
			local.stagingBaseUrl = 'Enter an https URL or leave empty.';
		if (!/^[\x21-\x7e]{16,512}$/.test(token)) local.token = 'Paste the one-time registration token (16+ characters).';
		setErrors(local);
		if (Object.keys(local).length > 0) return;
		setBusy(true);
		setProblem(null);
		const result = await adminFetch(adminApi.register(), {
			method: 'POST',
			body: { baseUrl: baseUrl.trim(), token, ...(stagingBaseUrl.trim() ? { stagingBaseUrl: stagingBaseUrl.trim() } : {}) },
		});
		setBusy(false);
		setToken(''); // a token burns on use: never keep it in the form
		if (!result.ok) {
			setProblem(result.problem);
			setErrors(fieldErrors(result.problem));
			return;
		}
		setDone(result.data);
	};
	return (
		<Dialog
			open={open}
			onClose={close}
			title={done ? 'Service registered' : 'Register a service product'}
			description={done ? undefined : 'Generate a one-time token on the product (ss app register), then paste it here.'}
			footer={
				done ? (
					<ButtonLink as={Link} href={adminRoutes.app(done.appId)} variant="primary">
						Open {done.name ?? done.slug}
					</ButtonLink>
				) : null
			}>
			{done ? (
				<KeyValueList
					columns={1}
					items={[
						{ label: 'App', value: <IdChip id={done.appId} label="app id" /> },
						{ label: 'Status', value: <StatusBadge status={done.status} /> },
						{ label: 'Key id', value: <span className="font-mono text-xs">{done.kid}</span> },
						{ label: 'Thumbprint', value: <span className="break-all font-mono text-xs">{done.thumbprint}</span> },
					]}
				/>
			) : (
				<Form onSubmit={submit} busy={busy} aria-label="Register a service product">
					<Input
						label="Production base URL"
						type="url"
						value={baseUrl}
						onChange={(e) => setBaseUrl(e.currentTarget.value)}
						error={errors.baseUrl}
						placeholder="https://chat.example.com"
						required
					/>
					<Input
						label="Staging base URL (optional)"
						type="url"
						value={stagingBaseUrl}
						onChange={(e) => setStaging(e.currentTarget.value)}
						error={errors.stagingBaseUrl}
					/>
					<Input
						label="One-time registration token"
						type="password"
						autoComplete="off"
						spellCheck={false}
						value={token}
						onChange={(e) => setToken(e.currentTarget.value)}
						error={errors.token}
						help="Used once and burnt by the product; a failed attempt needs a new token."
						required
					/>
					<FormError problem={problem} fields={['baseUrl', 'stagingBaseUrl', 'token']} />
					<FormActions>
						<Button variant="secondary" onClick={close}>
							Cancel
						</Button>
						<Button type="submit" loading={busy}>
							Register
						</Button>
					</FormActions>
				</Form>
			)}
		</Dialog>
	);
}

/**
 * Parse a JSON text field: `{ ok, value }` or `{ ok: false, message }`.
 * @param {string} text
 * @param {{ optional?: boolean }} [options]
 */
export const parseJsonField = (text, { optional = false } = {}) => {
	if (!text.trim()) return optional ? { ok: true, value: undefined } : { ok: false, message: 'Paste the JSON here.' };
	try {
		const value = JSON.parse(text);
		if (typeof value !== 'object' || value === null || Array.isArray(value))
			return { ok: false, message: 'Must be a JSON object.' };
		return { ok: true, value };
	} catch (error) {
		return { ok: false, message: `Not valid JSON (${error instanceof Error ? error.message : 'parse error'}).` };
	}
};

/**
 * Upload a signed pack bundle descriptor (`ss app publish` output): descriptor, detached signature and — for a new
 * pack only — the public key to pin.
 * @param {{ open: boolean, onClose: () => void }} props
 */
export function PackDialog({ open, onClose }) {
	const [descriptor, setDescriptor] = useState('');
	const [signature, setSignature] = useState('');
	const [publicJwk, setPublicJwk] = useState('');
	const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState(/** @type {any} */ (null));
	const close = () => {
		setDone(null);
		setProblem(null);
		setErrors({});
		onClose();
	};
	/** @param {import('react').ChangeEvent<HTMLInputElement>} event @param {(text: string) => void} set */
	const readFile = async (event, set) => {
		const file = event.currentTarget.files?.[0];
		if (file) set(await file.text());
	};
	const submit = async () => {
		const d = parseJsonField(descriptor);
		const s = parseJsonField(signature);
		const k = parseJsonField(publicJwk, { optional: true });
		/** @type {Record<string, string>} */
		const local = {};
		if (!d.ok) local.descriptor = /** @type {any} */ (d).message;
		if (!s.ok) local.signature = /** @type {any} */ (s).message;
		if (!k.ok) local.publicJwk = /** @type {any} */ (k).message;
		setErrors(local);
		if (Object.keys(local).length > 0) return;
		setBusy(true);
		setProblem(null);
		const result = await adminFetch(adminApi.packs(), {
			method: 'POST',
			body: {
				descriptor: /** @type {any} */ (d).value,
				signature: /** @type {any} */ (s).value,
				.../** @type {any} */ (k.value ? { publicJwk: /** @type {any} */ (k).value } : {}),
			},
		});
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			const fe = fieldErrors(result.problem);
			setErrors(
				Object.fromEntries(
					['descriptor', 'signature', 'publicJwk'].flatMap((name) => {
						const hit = Object.entries(fe).find(([k2]) => k2 === name || k2.startsWith(`${name}.`));
						return hit ? [[name, hit[1]]] : [];
					}),
				),
			);
			return;
		}
		setDone(result.data);
	};
	return (
		<Dialog
			open={open}
			onClose={close}
			size="lg"
			title={done ? (done.changed ? 'Pack uploaded' : 'Nothing new') : 'Upload a pack bundle'}
			description={done ? undefined : 'Element packs are published as signed bundles (no registration handshake).'}
			footer={
				done ? (
					<ButtonLink as={Link} href={adminRoutes.app(done.app.appId)} variant="primary">
						Open {done.app.name ?? done.app.slug}
					</ButtonLink>
				) : null
			}>
			{done ? (
				<p className="text-sm text-fg">
					{done.changed
						? `Version v${done.version.version} of ${done.app.slug} is stored with status ${done.version.status}.`
						: `This bundle matches version v${done.version.version}; nothing was stored.`}
				</p>
			) : (
				<Form onSubmit={submit} busy={busy} aria-label="Upload a pack bundle">
					<JsonField
						label="Bundle descriptor (JSON)"
						value={descriptor}
						onChange={setDescriptor}
						onFile={(e) => void readFile(e, setDescriptor)}
						error={errors.descriptor}
						rows={8}
					/>
					<JsonField
						label="Signature (JSON: kid, alg, sig)"
						value={signature}
						onChange={setSignature}
						onFile={(e) => void readFile(e, setSignature)}
						error={errors.signature}
						rows={3}
					/>
					<JsonField
						label="Public key (JWK, new packs only)"
						value={publicJwk}
						onChange={setPublicJwk}
						onFile={(e) => void readFile(e, setPublicJwk)}
						error={errors.publicJwk}
						rows={3}
						help="Pinned for the pack on its first upload. Later uploads must be signed with a pinned key."
					/>
					<FormError problem={problem} fields={['descriptor', 'signature', 'publicJwk']} />
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

/**
 * @param {{ label: string, value: string, onChange: (v: string) => void, onFile: (e: import('react').ChangeEvent<HTMLInputElement>) => void,
 *   error?: string, rows?: number, help?: string }} props
 */
function JsonField({ label, value, onChange, onFile, error, rows = 4, help }) {
	return (
		<div className="space-y-1.5">
			<TextArea
				label={label}
				value={value}
				rows={rows}
				onChange={(e) => onChange(e.currentTarget.value)}
				error={error}
				help={help}
				spellCheck={false}
				className="font-mono text-xs"
			/>
			<label className="inline-flex cursor-pointer items-center gap-2 text-xs font-semibold text-primary">
				<Icon name="plus" size={12} />
				Load from a file
				<input type="file" accept="application/json,.json" className="sr-only" onChange={onFile} />
			</label>
		</div>
	);
}

/**
 * @param {any} props loader result of `loadApp` plus `staff`
 */
export function AppView(props) {
	const toast = useToast();
	const ok = props.ok === true;
	const appId = ok ? props.app.appId : null;
	const { data: app, reload } = useAdminResource(appId ? adminApi.app(appId) : null, ok ? props.app : null);
	const versions = usePagedList((cursor) => (appId ? adminApi.versions(appId, { cursor }) : null), ok ? props.versions : null);
	const [lifecycle, setLifecycle] = useState(/** @type {null | 'activate' | 'deprecate' | 'retire'} */ (null));
	const [sunset, setSunset] = useState('');
	const [force, setForce] = useState(false);
	const [revoking, setRevoking] = useState(/** @type {any} */ (null));
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [refreshing, setRefreshing] = useState(false);
	const [retrying, setRetrying] = useState(false);
	if (!ok) return <AdminProblem problem={props.problem} back={{ href: adminRoutes.apps(), label: 'Back to apps' }} />;
	const { staff } = props;
	const canReview = staffCan(staff, 'platform.apps.review');
	const canManage = staffCan(staff, 'platform.apps.manage');
	const canLaunch = staffCan(staff, 'platform.launch.admin');
	const keys = /** @type {any[]} */ (app.keys ?? []);
	const health = app.health;

	const runLifecycle = async (/** @type {{ reason: string }} */ { reason }) => {
		if (!lifecycle) return;
		let sunsetAt = '';
		if (lifecycle === 'deprecate') {
			const at = Date.parse(`${sunset}T00:00:00Z`);
			if (!Number.isFinite(at)) {
				setProblem(localProblem('Choose a sunset date', 'Pick the day the app retires (at least one day ahead).'));
				return;
			}
			sunsetAt = new Date(at).toISOString();
		}
		setBusy(true);
		setProblem(null);
		const result = await adminFetch(adminApi.lifecycle(app.appId), {
			method: 'POST',
			body: {
				action: lifecycle,
				...(reason ? { reason } : {}),
				...(sunsetAt ? { sunsetAt } : {}),
				...(lifecycle === 'retire' && force ? { force: true } : {}),
			},
		});
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		toast.show({ title: `${app.name ?? app.slug}: ${humanize(result.data.status)}` });
		setLifecycle(null);
		await reload();
	};
	const revoke = async (/** @type {{ reason: string }} */ { reason }) => {
		setBusy(true);
		setProblem(null);
		const result = await adminFetch(adminApi.revokeAppKey(app.appId, revoking.kid), { method: 'POST', body: { reason } });
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		toast.show({ title: `Key ${revoking.kid} revoked`, description: 'Assertions signed with it are refused from now on.' });
		setRevoking(null);
		await reload();
	};
	const refresh = async () => {
		setRefreshing(true);
		setProblem(null);
		const result = await adminFetch(adminApi.refresh(app.appId), { method: 'POST', body: {} });
		setRefreshing(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		const r = result.data;
		toast.show({
			title: r.rejected ? 'Manifest refresh rejected' : r.changed ? 'New manifest version to review' : 'Manifest unchanged',
			description: r.rejected ? humanize(r.reason) : undefined,
			tone: r.rejected ? 'danger' : 'success',
		});
		await Promise.all([reload(), versions.reload()]);
	};

	// event deliveries that failed wait for a natural retry (the next event or call of the product); staff can force it
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
		toast.show({
			title: 'Deliveries retried',
			description: `${formatNumber(r.succeeded ?? 0)} delivered, ${formatNumber(r.retried ?? 0)} still failing, ${formatNumber(r.dead ?? 0)} dead-lettered`,
			tone: (r.retried ?? 0) + (r.dead ?? 0) > 0 ? 'danger' : 'success',
		});
	};

	const actions = [];
	if (canReview && (app.status === 'pending' || app.status === 'deprecated')) actions.push('activate');
	if (canReview && app.status === 'active') actions.push('deprecate');
	if (canReview && (app.status === 'pending' || app.status === 'deprecated')) actions.push('retire');

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
						{app.kind === 'service' && canManage ? (
							<Button
								variant="secondary"
								onClick={() => void refresh()}
								loading={refreshing}
								icon={<Icon name="refresh" size={14} />}>
								Refresh manifest
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
						{actions.map((a) => (
							<Button
								key={a}
								variant={a === 'activate' ? 'primary' : 'danger'}
								onClick={() => {
									setProblem(null);
									setSunset('');
									setForce(false);
									setLifecycle(/** @type {any} */ (a));
								}}>
								{humanize(a)}
							</Button>
						))}
					</>
				}
			/>
			<ActionProblem problem={!lifecycle && !revoking ? problem : null} />
			{app.status === 'deprecated' && app.sunsetAt ? (
				<Callout tone="warning" title={`Deprecated — retires ${formatDate(app.sunsetAt)}`}>
					Merchants see the sunset date; the app is retired the first time it is used after the sunset.
				</Callout>
			) : null}
			<Card title="Overview">
				<KeyValueList
					columns={3}
					items={[
						{
							label: 'Current version',
							value: `v${app.currentVersion}${app.productVersion ? ` (${app.productVersion})` : ''}`,
						},
						{
							label: 'Pending review',
							value: app.pendingVersion ? (
								<Link
									href={adminRoutes.version(app.appId, app.pendingVersion)}
									className="font-semibold text-primary hover:underline">
									v{app.pendingVersion}
								</Link>
							) : (
								'None'
							),
						},
						{ label: 'Created', value: formatDateTime(app.createdAt) },
						{
							label: 'Endpoints base',
							value: <span className="break-all font-mono text-xs">{app.endpoints?.base ?? '—'}</span>,
						},
						{ label: 'Sunset', value: app.sunsetAt ? formatDate(app.sunsetAt) : '—' },
					]}
				/>
			</Card>

			{app.kind === 'service' ? (
				<Card title="Health" subtitle="Last heartbeat reported by the product (POST /v1/product/heartbeat).">
					{health ? (
						<div className="space-y-3">
							<KeyValueList
								columns={3}
								items={[
									{
										label: 'State',
										value: (() => {
											const h = healthLabel(app);
											return h ? <StatusBadge status={h.status} label={h.label} /> : '—';
										})(),
									},
									{ label: 'Last seen', value: formatDateTime(health.lastSeenAt) },
									{ label: 'Last heartbeat', value: formatDateTime(health.lastHeartbeatAt) },
									{ label: 'Reported version', value: health.version ?? '—' },
								]}
							/>
							{health.queues ? <CodeBlock label="Queues" code={JSON.stringify(health.queues, null, 2)} /> : null}
							<p className="text-xs text-muted">Only the latest heartbeat is kept; there is no heartbeat history yet.</p>
						</div>
					) : (
						<p className="text-sm text-muted">No heartbeat yet.</p>
					)}
				</Card>
			) : null}

			<Card title="Manifest versions" subtitle="Open a version to see its diff against the accepted manifest.">
				<Table
					caption="Manifest versions"
					dense
					rows={versions.items}
					rowKey={(v) => String(v.version)}
					empty="No versions."
					hasMore={Boolean(versions.cursor)}
					loadingMore={versions.loading}
					onLoadMore={() => void versions.more()}
					columns={[
						{
							key: 'version',
							header: 'Version',
							rowHeader: true,
							render: (v) => (
								<Link
									href={adminRoutes.version(app.appId, v.version)}
									className="font-semibold text-primary hover:underline">
									v{v.version}
								</Link>
							),
						},
						{ key: 'productVersion', header: 'Product', render: (v) => v.productVersion },
						{ key: 'status', header: 'Status', render: (v) => <StatusBadge status={v.status} /> },
						{
							key: 'breaking',
							header: 'Breaking',
							render: (v) =>
								v.breaking ? (
									<Badge tone="danger">{formatNumber(v.diff?.breaking?.length ?? 0)} breaking</Badge>
								) : (
									<span className="text-muted">No</span>
								),
						},
						{ key: 'source', header: 'Source', render: (v) => humanize(v.source) },
						{ key: 'createdAt', header: 'Submitted', render: (v) => formatDateTime(v.createdAt) },
						{
							key: 'review',
							header: 'Review',
							render: (v) =>
								v.review ? (
									<span className="text-xs">
										{v.review.reason ?? '—'} ({v.review.by})
									</span>
								) : (
									'—'
								),
						},
					]}
				/>
			</Card>

			{app.kind === 'service' ? <EnvironmentsCard app={app} canManage={canManage} onSaved={reload} /> : null}

			<Card title="Signing keys" subtitle="Keys the product signs client assertions and manifests with.">
				<Table
					caption="Signing keys"
					dense
					rows={keys}
					rowKey={(k) => k.kid}
					empty={app.kind === 'pack' ? 'Pack keys are pinned from the first upload.' : 'No keys.'}
					columns={[
						{
							key: 'kid',
							header: 'Key id',
							rowHeader: true,
							render: (k) => <span className="font-mono text-xs">{k.kid}</span>,
						},
						{
							key: 'status',
							header: 'Status',
							render: (k) => <StatusBadge status={k.status} label={k.usable ? 'Usable' : humanize(k.status)} />,
						},
						{
							key: 'thumbprint',
							header: 'Thumbprint',
							render: (k) => <span className="break-all font-mono text-[11px]">{k.thumbprint}</span>,
						},
						{ key: 'source', header: 'Source', render: (k) => humanize(k.source) },
						{ key: 'notAfter', header: 'Valid until', render: (k) => (k.notAfter ? formatDateTime(k.notAfter) : '—') },
						{
							key: 'actions',
							header: <span className="sr-only">Actions</span>,
							align: 'right',
							render: (k) =>
								canManage && k.status === 'active' ? (
									<Button size="sm" variant="ghost" onClick={() => setRevoking(k)}>
										Revoke
									</Button>
								) : k.revoked ? (
									<span className="text-xs text-muted">{k.revoked.reason}</span>
								) : null,
						},
					]}
				/>
			</Card>

			{canLaunch && app.kind === 'service' ? <LaunchCard app={app} staff={staff} /> : null}

			<TypedConfirmDialog
				open={lifecycle === 'deprecate' || lifecycle === 'retire'}
				onClose={() => setLifecycle(null)}
				onConfirm={(input) => void runLifecycle(input)}
				busy={busy}
				title={lifecycle === 'deprecate' ? `Deprecate ${app.slug}?` : `Retire ${app.slug}?`}
				expected={app.slug}
				confirmLabel={lifecycle === 'deprecate' ? 'Deprecate' : 'Retire'}
				reason={{ required: true, label: 'Reason (shown to merchants with the sunset date)' }}
				error={problem ? describeProblem(problem) : null}>
				{lifecycle === 'deprecate' ? (
					<>
						<p className="text-sm text-muted">New subscriptions stop; existing ones keep working until the sunset date.</p>
						<Input
							label="Sunset date (UTC)"
							type="date"
							value={sunset}
							onChange={(e) => setSunset(e.currentTarget.value)}
							help="At least one day and at most two years ahead."
							required
						/>
					</>
				) : (
					<>
						<p className="text-sm text-muted">Retired apps stop serving: launches, entitlements and deliveries end.</p>
						{app.status === 'deprecated' ? (
							<label className="flex items-center gap-2 text-sm">
								<input type="checkbox" checked={force} onChange={(e) => setForce(e.currentTarget.checked)} />
								Retire before the sunset date (force)
							</label>
						) : null}
					</>
				)}
			</TypedConfirmDialog>
			<ConfirmDialog
				open={lifecycle === 'activate'}
				onClose={() => setLifecycle(null)}
				onConfirm={() => void runLifecycle({ reason: '' })}
				busy={busy}
				title={`Activate ${app.slug}?`}
				confirmLabel="Activate"
				error={problem ? describeProblem(problem) : null}>
				<p className="text-sm text-muted">
					{app.status === 'deprecated'
						? 'The deprecation is withdrawn and the sunset date cleared.'
						: 'The app is listed in the catalog and merchants can subscribe.'}
				</p>
			</ConfirmDialog>
			<TypedConfirmDialog
				open={Boolean(revoking)}
				onClose={() => setRevoking(null)}
				onConfirm={(input) => void revoke(input)}
				busy={busy}
				title="Revoke this signing key?"
				expected={revoking?.kid ?? ''}
				confirmLabel="Revoke key"
				reason={{ required: true }}
				error={problem ? describeProblem(problem) : null}>
				<p className="text-sm text-muted">
					The product can no longer authenticate with this key. If it is the only key, the product stops working until it is
					registered again.
				</p>
			</TypedConfirmDialog>
		</div>
	);
}

/**
 * @param {{ app: any, canManage: boolean, onSaved: () => Promise<unknown> }} props
 */
function EnvironmentsCard({ app, canManage, onSaved }) {
	const toast = useToast();
	const [production, setProduction] = useState(app.environments?.production ?? '');
	const [staging, setStaging] = useState(app.environments?.staging ?? '');
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [busy, setBusy] = useState(false);
	const save = async () => {
		setBusy(true);
		setProblem(null);
		const result = await adminFetch(adminApi.environments(app.appId), {
			method: 'PUT',
			body: { production: production.trim(), staging: staging.trim() ? staging.trim() : null },
		});
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		toast.show({ title: 'Environments saved' });
		await onSaved();
	};
	const errors = fieldErrors(problem);
	return (
		<Card title="Environments" subtitle="Base URLs of the product. Staging is used for staff launches only.">
			<Form onSubmit={save} busy={busy} aria-label="Environments">
				<div className="grid gap-4 sm:grid-cols-2">
					<Input
						label="Production"
						type="url"
						value={production}
						onChange={(e) => setProduction(e.currentTarget.value)}
						error={errors.production}
						disabled={!canManage}
					/>
					<Input
						label="Staging"
						type="url"
						value={staging}
						onChange={(e) => setStaging(e.currentTarget.value)}
						error={errors.staging}
						disabled={!canManage}
						help="Leave empty to remove."
					/>
				</div>
				<FormError problem={problem} fields={['production', 'staging']} />
				{canManage ? (
					<FormActions>
						<Button type="submit" variant="secondary" loading={busy}>
							Save environments
						</Button>
					</FormActions>
				) : null}
			</Form>
		</Card>
	);
}

/**
 * Open the product as admin: scoped to one merchant (optionally one website) or app-wide (`all`, superadmin/admin).
 * @param {{ app: any, staff: any }} props
 */
function LaunchCard({ app, staff }) {
	const allowAll = (staff?.roles ?? []).some((/** @type {string} */ r) => r === 'superadmin' || r === 'admin');
	const [scope, setScope] = useState('merchant');
	const [merchantId, setMerchantId] = useState('');
	const [websiteId, setWebsiteId] = useState('');
	const [environment, setEnvironment] = useState('production');
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
				environment,
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
				<Select
					label="Environment"
					value={environment}
					onChange={(e) => setEnvironment(e.currentTarget.value)}
					fieldClassName="w-48"
					options={[
						{ value: 'production', label: 'Production' },
						{ value: 'staging', label: 'Staging', disabled: !app.environments?.staging },
					]}
				/>
				<FormError problem={problem} fields={['merchantId', 'websiteId', 'all', 'environment']} />
				<FormActions>
					<Button type="submit" loading={busy} icon={<Icon name="external" size={14} />}>
						Open {app.name ?? app.slug}
					</Button>
				</FormActions>
			</Form>
		</Card>
	);
}

/**
 * Manifest diff sections (pure presentation of the catalog `ManifestDiff`).
 * @param {{ diff: any }} props
 */
export function ManifestDiffView({ diff }) {
	if (!diff) return <p className="text-sm text-muted">No diff recorded.</p>;
	if (!diff.changed) return <EmptyState compact icon="check" title="No changes against the accepted manifest" />;
	const breaking = /** @type {any[]} */ (diff.breaking ?? []);
	/** @param {string[]} list @param {'success' | 'danger' | 'neutral'} tone */
	const chips = (list, tone) =>
		list.length === 0 ? (
			<span className="text-muted">—</span>
		) : (
			<span className="flex flex-wrap gap-1">
				{list.map((x) => (
					<Badge key={x} tone={tone}>
						{x}
					</Badge>
				))}
			</span>
		);
	const other = diff.other ?? {};
	const flags = Object.entries(other).filter(([, v]) => v === true);
	return (
		<div className="space-y-5">
			{breaking.length > 0 ? (
				<Callout
					tone="danger"
					title={`${breaking.length} breaking change${breaking.length === 1 ? '' : 's'} for existing subscribers`}>
					<ul className="mt-1 space-y-1">
						{breaking.map((b, i) => (
							<li key={i} className="flex flex-wrap items-baseline gap-2">
								<Badge tone="danger">{humanize(b.code)}</Badge>
								<span className="font-mono text-xs">{b.path}</span>
								<span>{b.message}</span>
							</li>
						))}
					</ul>
				</Callout>
			) : (
				<Callout tone="success" live={false}>
					No breaking changes.
				</Callout>
			)}
			<KeyValueList
				columns={3}
				items={[
					{ label: 'Product version', value: `${diff.version?.from ?? '—'} → ${diff.version?.to ?? '—'}` },
					{ label: 'Elements added', value: chips(diff.elements?.added ?? [], 'success') },
					{ label: 'Elements removed', value: chips(diff.elements?.removed ?? [], 'danger') },
					{
						label: 'Elements changed',
						value: chips(
							(diff.elements?.changed ?? []).map((/** @type {any} */ c) => `${c.key} (${c.fields.join(', ')})`),
							'neutral',
						),
					},
					{ label: 'Plans added', value: chips(diff.plans?.added ?? [], 'success') },
					{ label: 'Plans removed', value: chips(diff.plans?.removed ?? [], 'danger') },
					{ label: 'Scopes added', value: chips(other.scopesAdded ?? [], 'neutral') },
					{ label: 'Scopes removed', value: chips(other.scopesRemoved ?? [], 'neutral') },
					{
						label: 'Also changed',
						value: chips(
							flags.map(([k]) => humanize(k)),
							'neutral',
						),
					},
				]}
			/>
			{(diff.prices ?? []).length > 0 ? (
				<Table
					caption="Price changes"
					captionHidden={false}
					dense
					rows={diff.prices}
					rowKey={(p) => `${p.element}:${p.field}`}
					columns={[
						{ key: 'element', header: 'Element', rowHeader: true },
						{ key: 'field', header: 'Price', render: (p) => <span className="font-mono text-xs">{p.field}</span> },
						{ key: 'from', header: 'From', render: (p) => JSON.stringify(p.from ?? null) },
						{ key: 'to', header: 'To', render: (p) => JSON.stringify(p.to ?? null) },
						{
							key: 'direction',
							header: 'Direction',
							render: (p) => (
								<Badge tone={p.direction === 'increase' || p.direction === 'added' ? 'danger' : 'success'}>
									{p.direction}
								</Badge>
							),
						},
					]}
				/>
			) : null}
			{(diff.plans?.changed ?? []).length > 0 ? (
				<Table
					caption="Plan changes"
					captionHidden={false}
					dense
					rows={diff.plans.changed}
					rowKey={(p) => p.code}
					columns={[
						{ key: 'code', header: 'Plan', rowHeader: true },
						{
							key: 'in',
							header: 'Elements',
							render: (p) => `+${p.elementsAdded.join(', ') || '—'} / −${p.elementsRemoved.join(', ') || '—'}`,
						},
						{
							key: 'add',
							header: 'Add-ons',
							render: (p) => `+${p.addonsAdded.join(', ') || '—'} / −${p.addonsRemoved.join(', ') || '—'}`,
						},
					]}
				/>
			) : null}
			{(diff.features ?? []).length > 0 ? (
				<Table
					caption="Feature changes"
					captionHidden={false}
					dense
					rows={diff.features}
					rowKey={(f) => `${f.element}.${f.feature}`}
					columns={[
						{
							key: 'feature',
							header: 'Feature',
							rowHeader: true,
							render: (f) => (
								<span className="font-mono text-xs">
									{f.element}.{f.feature}
								</span>
							),
						},
						{
							key: 'change',
							header: 'Change',
							render: (f) => (
								<Badge tone={f.change === 'removed' ? 'danger' : f.change === 'added' ? 'success' : 'neutral'}>
									{f.change}
								</Badge>
							),
						},
						{ key: 'fields', header: 'Fields', render: (f) => (f.fields ?? []).join(', ') || '—' },
					]}
				/>
			) : null}
		</div>
	);
}

/**
 * @param {any} props loader result of `loadVersion` plus `staff`
 */
export function VersionView(props) {
	const toast = useToast();
	const ok = props.ok === true;
	const [version, setVersion] = useState(/** @type {any} */ (ok ? props.version : null));
	const [review, setReview] = useState(/** @type {null | 'approve' | 'reject'} */ (null));
	const [reason, setReason] = useState('');
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	if (!ok) return <AdminProblem problem={props.problem} back={{ href: adminRoutes.apps(), label: 'Back to apps' }} />;
	const { app, staff } = props;
	const canReview = staffCan(staff, 'platform.apps.review') && version.status === 'pending' && app.status !== 'retired';
	const submit = async () => {
		if (review === 'reject' && !reason.trim()) {
			setProblem(localProblem('A reason is required', 'Say why the version is rejected; the developer sees it.'));
			return;
		}
		setBusy(true);
		setProblem(null);
		const path =
			review === 'approve' ? adminApi.approve(app.appId, version.version) : adminApi.reject(app.appId, version.version);
		const result = await adminFetch(path, { method: 'POST', body: reason.trim() ? { reason: reason.trim() } : {} });
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		toast.show({
			title: review === 'approve' ? `v${version.version} accepted` : `v${version.version} rejected`,
			description: review === 'approve' ? 'Subscribers get re-signed entitlement documents.' : undefined,
		});
		setVersion({ ...version, ...result.data });
		setReview(null);
		setReason('');
	};
	return (
		<div className="space-y-6">
			<PageHeader
				breadcrumbs={
					<Crumbs
						items={[
							{ label: 'Apps', href: adminRoutes.apps() },
							{ label: app.name ?? app.slug, href: adminRoutes.app(app.appId) },
							{ label: `v${version.version}` },
						]}
					/>
				}
				title={`${app.name ?? app.slug} v${version.version}`}
				badge={
					<>
						<StatusBadge status={version.status} />
						{version.breaking ? <Badge tone="danger">Breaking</Badge> : null}
					</>
				}
				subtitle={`Product ${version.productVersion} · ${humanize(version.source)} · submitted ${formatDateTime(version.createdAt)}`}
				actions={
					canReview ? (
						<>
							<Button variant="danger" onClick={() => setReview('reject')}>
								Reject
							</Button>
							<Button onClick={() => setReview('approve')}>Approve</Button>
						</>
					) : null
				}
			/>
			{version.review ? (
				<Callout
					tone={version.status === 'rejected' ? 'danger' : 'info'}
					title={`Reviewed by ${version.review.by} ${formatDateTime(version.review.at)}`}>
					{version.review.reason ?? 'No reason given.'}
				</Callout>
			) : null}
			<Card title="Changes against the accepted manifest">
				<ManifestDiffView diff={version.diff} />
			</Card>
			{version.assets ? (
				<Card title="Bundle assets">
					<Table
						caption="Bundle assets"
						dense
						rows={version.assets}
						rowKey={(a) => a.path}
						columns={[
							{
								key: 'path',
								header: 'Path',
								rowHeader: true,
								render: (a) => <span className="font-mono text-xs">{a.path}</span>,
							},
							{ key: 'size', header: 'Size', align: 'right', render: (a) => `${formatNumber(a.size)} B` },
							{
								key: 'sha256',
								header: 'SHA-256',
								render: (a) => <span className="break-all font-mono text-[11px]">{a.sha256}</span>,
							},
						]}
					/>
				</Card>
			) : null}
			<Card title="Manifest" subtitle={<span className="break-all font-mono">{version.manifestHash}</span>}>
				{version.manifest ? (
					<details>
						<summary className="cursor-pointer text-sm font-semibold text-primary">Show the full manifest</summary>
						<div className="mt-3">
							<CodeBlock code={JSON.stringify(version.manifest, null, 2)} label="Manifest JSON" wrap={false} />
						</div>
					</details>
				) : (
					<p className="text-sm text-muted">The manifest body is not available.</p>
				)}
			</Card>
			<ConfirmDialog
				open={review !== null}
				onClose={() => setReview(null)}
				onConfirm={() => void submit()}
				busy={busy}
				danger={review === 'reject'}
				title={review === 'approve' ? `Approve v${version.version}?` : `Reject v${version.version}?`}
				confirmLabel={review === 'approve' ? 'Approve' : 'Reject'}
				error={problem ? describeProblem(problem) : null}>
				{review === 'approve' && version.breaking ? (
					<Callout tone="warning" live={false}>
						This version has breaking changes for existing subscribers. Make sure merchants were notified.
					</Callout>
				) : null}
				<TextArea
					label={review === 'reject' ? 'Reason (required, sent to the developer)' : 'Note (optional)'}
					rows={3}
					maxLength={500}
					value={reason}
					onChange={(e) => setReason(e.currentTarget.value)}
					required={review === 'reject'}
				/>
			</ConfirmDialog>
		</div>
	);
}
