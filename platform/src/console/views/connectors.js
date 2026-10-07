'use client';
/**
 * Resources of a website: the client-owned connectors (database, storage, AI, messaging, payments) with
 * credential forms per kind/provider, connection-test results, edit (label and/or new credentials), delete and
 * website assignment. Credentials are write-only: the Portal never returns them, and the form is cleared after sending.
 * @module
 */
import { useState } from 'react';
import {
	Badge,
	Button,
	Callout,
	Card,
	Checkbox,
	ConfirmDialog,
	Dialog,
	EmptyState,
	FormError,
	Icon,
	Input,
	KeyValueList,
	Select,
	StatusBadge,
	TextArea,
	describeProblem,
	fieldErrors,
	formatDateTime,
	humanize,
	useToast,
} from '@ss/ui';
import { apiFetch } from '../client.js';
import { api } from '../paths.js';
import { PageProblem, WebsiteHeader, productName, websiteLabel } from './common.js';
import { RESOURCE_KINDS } from './websites.js';

/** @typedef {import('@ss/ui').Problem} Problem */
/**
 * @typedef {{ name: string, label: string, type: 'text' | 'secret' | 'number' | 'boolean' | 'select' | 'pairs' | 'url',
 *   required?: boolean, help?: string, options?: string[], placeholder?: string }} CredentialField
 */

/** Providers per kind (null = free provider slug). */
export const PROVIDERS = Object.freeze({
	database: ['mongodb'],
	storage: ['s3', 'r2', 'gcs', 'minio'],
	ai: ['openai', 'anthropic', 'google', 'generic'],
	messaging: ['generic-http', 'smtp'],
	payments: null,
});

/** Display names of providers. */
const PROVIDER_LABELS = /** @type {Record<string, string>} */ ({
	mongodb: 'MongoDB',
	s3: 'Amazon S3',
	r2: 'Cloudflare R2',
	gcs: 'Google Cloud Storage',
	minio: 'MinIO',
	openai: 'OpenAI',
	anthropic: 'Anthropic',
	google: 'Google',
	generic: 'Other (compatible API)',
	'generic-http': 'HTTP API',
	smtp: 'SMTP',
});

/** @param {string} provider */
export const providerLabel = (provider) => PROVIDER_LABELS[provider] ?? humanize(provider);

/**
 * Credential form fields of a kind/provider (mirrors the Portal's credential schemas).
 * @param {string} kind
 * @param {string} provider
 * @returns {CredentialField[]}
 */
export const credentialFields = (kind, provider) => {
	switch (kind) {
		case 'database':
			return [
				{
					name: 'uri',
					label: 'Connection string',
					type: 'secret',
					required: true,
					placeholder: 'mongodb+srv://user:password@cluster.example.net/?tls=true',
					help: 'A user that can create indexes in its own database only. TLS is required.',
				},
				{ name: 'dbName', label: 'Database name', type: 'text', help: 'Defaults to the database in the connection string.' },
			];
		case 'storage':
			return [
				{ name: 'bucket', label: 'Bucket', type: 'text', required: true },
				{
					name: 'region',
					label: 'Region',
					type: 'text',
					required: true,
					placeholder: provider === 'r2' ? 'auto' : 'eu-west-1',
				},
				{ name: 'accessKeyId', label: 'Access key id', type: 'secret', required: true },
				{ name: 'secretAccessKey', label: 'Secret access key', type: 'secret', required: true },
				{
					name: 'endpoint',
					label: 'Endpoint',
					type: 'url',
					required: provider === 'r2' || provider === 'minio',
					help: 'Origin only, e.g. https://<account>.r2.cloudflarestorage.com.',
				},
				{ name: 'prefix', label: 'Key prefix', type: 'text', help: 'Optional folder, ending with /.' },
				{ name: 'forcePathStyle', label: 'Use path-style URLs', type: 'boolean' },
			];
		case 'ai':
			return [
				{ name: 'apiKey', label: 'API key', type: 'secret', required: true },
				{ name: 'model', label: 'Default model', type: 'text' },
				{
					name: 'baseUrl',
					label: 'Base URL',
					type: 'url',
					required: provider === 'generic',
					help: 'Only for compatible gateways.',
				},
			];
		case 'messaging':
			return provider === 'smtp'
				? [
						{ name: 'host', label: 'SMTP host', type: 'text', required: true },
						{ name: 'port', label: 'Port', type: 'number', placeholder: '587' },
						{ name: 'secure', label: 'Use TLS from the start (port 465)', type: 'boolean' },
						{ name: 'username', label: 'Username', type: 'text', required: true },
						{ name: 'password', label: 'Password', type: 'secret', required: true },
						{ name: 'from', label: 'From address', type: 'text', placeholder: 'shop@example.com' },
					]
				: [
						{ name: 'baseUrl', label: 'Base URL', type: 'url', required: true },
						{ name: 'apiKey', label: 'API key', type: 'secret', required: true },
						{ name: 'authScheme', label: 'Authentication', type: 'select', options: ['bearer', 'header'] },
						{ name: 'authHeader', label: 'Header name', type: 'text', help: 'With header authentication, e.g. X-Api-Key.' },
						{ name: 'testPath', label: 'Test path', type: 'text', placeholder: '/health' },
					];
		case 'payments':
			return [
				{
					name: '_pairs',
					label: 'Credentials',
					type: 'pairs',
					required: true,
					help: 'One NAME=value per line (e.g. publishableKey=…).',
				},
			];
		default:
			return [];
	}
};

/**
 * Build the credentials object from form values (empty optional fields are dropped).
 * @param {string} kind
 * @param {CredentialField[]} fields
 * @param {Record<string, string | boolean>} values
 * @returns {{ credentials: Record<string, unknown>, errors: Record<string, string> }}
 */
export const buildCredentials = (kind, fields, values) => {
	/** @type {Record<string, unknown>} */
	const credentials = {};
	/** @type {Record<string, string>} */
	const errors = {};
	for (const field of fields) {
		const raw = values[field.name];
		if (field.type === 'boolean') {
			if (raw === true) credentials[field.name] = true;
			continue;
		}
		const text = typeof raw === 'string' ? raw.trim() : '';
		if (!text) {
			if (field.required) errors[field.name] = `${field.label} is required.`;
			continue;
		}
		if (field.type === 'number') {
			const n = Number(text);
			if (!Number.isInteger(n)) errors[field.name] = 'Enter a whole number.';
			else credentials[field.name] = n;
		} else if (field.type === 'pairs') {
			/** @type {Record<string, string>} */
			const pairs = {};
			for (const line of text.split('\n')) {
				const t = line.trim();
				if (!t) continue;
				const i = t.indexOf('=');
				if (i <= 0) {
					errors[field.name] = `“${t}” is not NAME=value.`;
					break;
				}
				pairs[t.slice(0, i).trim()] = t.slice(i + 1).trim();
			}
			if (kind === 'payments') Object.assign(credentials, pairs);
			else credentials[field.name] = pairs;
		} else credentials[field.name] = field.type === 'secret' ? String(raw) : text;
	}
	return { credentials, errors };
};

/**
 * Credential inputs.
 * @param {{ fields: CredentialField[], values: Record<string, string | boolean>, errors: Record<string, string>,
 *   onChange: (name: string, value: string | boolean) => void }} props
 */
function CredentialInputs({ fields, values, errors, onChange }) {
	return (
		<>
			{fields.map((f) => {
				const value = values[f.name];
				if (f.type === 'boolean')
					return (
						<Checkbox
							key={f.name}
							label={f.label}
							checked={value === true}
							onChange={(e) => onChange(f.name, e.currentTarget.checked)}
						/>
					);
				if (f.type === 'select')
					return (
						<Select
							key={f.name}
							label={f.label}
							value={typeof value === 'string' ? value : ''}
							onChange={(e) => onChange(f.name, e.currentTarget.value)}
							options={[
								{ value: '', label: 'Default' },
								...(f.options ?? []).map((o) => ({ value: o, label: humanize(o) })),
							]}
							error={errors[f.name]}
						/>
					);
				if (f.type === 'pairs')
					return (
						<TextArea
							key={f.name}
							label={f.label}
							rows={3}
							className="font-mono text-xs"
							value={typeof value === 'string' ? value : ''}
							onChange={(e) => onChange(f.name, e.currentTarget.value)}
							help={f.help}
							error={errors[f.name]}
							required={f.required}
						/>
					);
				return (
					<Input
						key={f.name}
						label={f.label}
						type={f.type === 'secret' ? 'password' : f.type === 'number' ? 'number' : f.type === 'url' ? 'url' : 'text'}
						autoComplete={f.type === 'secret' ? 'new-password' : 'off'}
						spellCheck={false}
						value={typeof value === 'string' ? value : ''}
						placeholder={f.placeholder}
						onChange={(e) => onChange(f.name, e.currentTarget.value)}
						help={f.help}
						error={errors[f.name]}
						required={f.required}
					/>
				);
			})}
		</>
	);
}

/**
 * Connection-check report.
 * @param {{ report: any }} props
 */
export function CheckReport({ report }) {
	if (!report) return <p className="text-xs text-muted">Not tested yet.</p>;
	return (
		<div className="space-y-2">
			<p className={`flex items-center gap-1.5 text-sm font-semibold ${report.ok ? 'text-success' : 'text-danger'}`}>
				<Icon name={report.ok ? 'check' : 'alert'} size={14} />
				{report.ok ? 'All checks passed' : 'Some checks failed'}
				<span className="font-normal text-muted">· {formatDateTime(report.checkedAt)}</span>
			</p>
			<ul className="flex flex-wrap gap-1.5">
				{(report.checks ?? []).map((/** @type {any} */ c) => (
					<li key={c.name}>
						<Badge tone={c.ok ? 'success' : 'danger'} title={c.code ?? undefined}>
							{humanize(c.name)}
							{c.ok ? '' : ` · ${humanize(c.code ?? 'failed')}`}
						</Badge>
					</li>
				))}
			</ul>
			{(report.warnings ?? []).map((/** @type {any} */ w, /** @type {number} */ i) => (
				<p key={i} className="text-xs text-warning">
					{typeof w === 'string' ? w : (w.message ?? humanize(w.code))}
				</p>
			))}
		</div>
	);
}

/**
 * Which resource kinds the website needs now and which only once an element is enabled (F.16). Uses the Portal's
 * `needs` (per product and kind) when present, else every product-level kind as needed now.
 * @param {any[] | null} needs
 * @param {any[]} subscriptions
 * @param {any[]} catalog
 * @returns {{ now: Map<string, string[]>, ifEnabled: Map<string, string[]> }}
 */
export const neededResources = (needs, subscriptions, catalog) => {
	/** @type {Map<string, string[]>} */
	const now = new Map();
	/** @type {Map<string, string[]>} */
	const ifEnabled = new Map();
	/** @param {Map<string, string[]>} map @param {string} kind @param {string} label */
	const add = (map, kind, label) => {
		const list = map.get(kind) ?? [];
		if (!list.includes(label)) map.set(kind, [...list, label]);
	};
	if (Array.isArray(needs)) {
		for (const need of needs) {
			const name = `${productName(catalog, need.appId, need.productSlug)}${need.optional ? ', optional' : ''}`;
			if (need.neededNow) add(now, need.kind, name);
			else
				for (const key of need.elements ?? []) {
					const element = catalog
						.find((p) => p.appId === need.appId)
						?.elements?.find((/** @type {any} */ e) => e.key === key);
					add(ifEnabled, need.kind, `${element?.name ?? key} (${name})`);
				}
		}
		return { now, ifEnabled };
	}
	for (const s of subscriptions) {
		if (s.status === 'cancelled') continue;
		const product = catalog.find((p) => p.appId === s.appId);
		for (const k of product?.requires ?? []) add(now, k, productName(catalog, s.appId, s.productSlug));
	}
	return { now, ifEnabled };
};

/**
 * @param {any} props loader result of `loadResources`
 */
export function ConnectorsView(props) {
	const toast = useToast();
	const ok = props.ok === true;
	const [connectors, setConnectors] = useState(/** @type {any[]} */ (ok ? props.connectors : []));
	const [resources, setResources] = useState(/** @type {any[]} */ (ok ? props.resources : []));
	const [needs, setNeeds] = useState(/** @type {any[] | null} */ (ok ? (props.needs ?? null) : null));
	const [form, setForm] = useState(/** @type {null | { mode: 'create' | 'edit', connector?: any }} */ (null));
	const [kind, setKind] = useState('database');
	const [provider, setProvider] = useState('mongodb');
	const [label, setLabel] = useState('');
	const [values, setValues] = useState(/** @type {Record<string, string | boolean>} */ ({}));
	const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [busy, setBusy] = useState(/** @type {string | null} */ (null));
	const [assigning, setAssigning] = useState(/** @type {any} */ (null));
	const [assigned, setAssigned] = useState(/** @type {string[]} */ ([]));
	const [confirm, setConfirm] = useState(/** @type {null | { action: 'delete', connector: any }} */ (null));
	const [showAll, setShowAll] = useState(false);
	if (!ok) return <PageProblem problem={props.problem} />;
	const { merchantId, website, catalog, subscriptions, websites } = props;
	const websiteId = website.websiteId;

	const reload = async () => {
		const [c, r] = await Promise.all([apiFetch(api.connectors(merchantId)), apiFetch(api.resources(merchantId, websiteId))]);
		if (c.ok) setConnectors(c.data.items ?? []);
		if (r.ok) {
			setResources(r.data.resources ?? []);
			setNeeds(r.data.needs ?? null);
		}
	};
	// F.16: needed now = product-level kinds and kinds of elements that are on; the rest only if an element is enabled
	const { now: required, ifEnabled } = neededResources(needs, subscriptions, catalog);
	const statusOf = (/** @type {string} */ k) => resources.find((r) => r.kind === k)?.status ?? 'missing';
	const here = connectors.filter((c) => (c.websiteIds ?? []).includes(websiteId));
	const others = connectors.filter((c) => !(c.websiteIds ?? []).includes(websiteId));
	const list = showAll ? connectors : here;

	/** @param {string} k @param {string} [p] */
	const openCreate = (k, p) => {
		const providers = /** @type {Record<string, string[] | null>} */ (PROVIDERS)[k];
		setKind(k);
		setProvider(p ?? providers?.[0] ?? '');
		setLabel('');
		setValues({});
		setErrors({});
		setProblem(null);
		setForm({ mode: 'create' });
	};
	/** @param {any} connector */
	const openEdit = (connector) => {
		setKind(connector.kind);
		setProvider(connector.provider);
		setLabel(connector.label ?? '');
		setValues({});
		setErrors({});
		setProblem(null);
		setForm({ mode: 'edit', connector });
	};
	const fields = credentialFields(kind, provider);
	const submit = async () => {
		const editing = form?.mode === 'edit';
		// editing: credentials are optional (leave every field empty to keep the current ones)
		const replace = !editing || Object.values(values).some((v) => v === true || (typeof v === 'string' && v.trim()));
		const built = replace ? buildCredentials(kind, fields, values) : { credentials: {}, errors: {} };
		/** @type {Record<string, string>} */
		const local = { ...built.errors };
		if (!editing && !provider.trim()) local.provider = 'Choose or type a provider.';
		if (editing && !replace && !label.trim()) local.label = 'Enter a label or new credentials.';
		setErrors(local);
		if (Object.keys(local).length > 0) return;
		setBusy('form');
		setProblem(null);
		const result = editing
			? await apiFetch(api.connector(merchantId, form.connector.connectorId), {
					method: 'PATCH',
					body: {
						...(label.trim() ? { label: label.trim() } : {}),
						...(replace ? { credentials: built.credentials } : {}),
					},
				})
			: await apiFetch(api.connectors(merchantId), {
					method: 'POST',
					body: {
						kind,
						provider: provider.trim(),
						...(label.trim() ? { label: label.trim() } : {}),
						credentials: built.credentials,
						websiteIds: [websiteId],
					},
				});
		setBusy(null);
		// credentials never stay in memory longer than needed
		setValues({});
		if (!result.ok) {
			setProblem(result.problem);
			const fe = fieldErrors(result.problem);
			setErrors(Object.fromEntries(Object.entries(fe).map(([k, v]) => [k.replace(/^credentials\./, ''), v])));
			return;
		}
		const report = result.data?.report;
		toast.show({
			title: editing ? 'Connector updated' : 'Resource connected',
			description: report
				? report.ok
					? 'The connection check passed.'
					: 'Saved, but the connection check failed — see the report.'
				: undefined,
			tone: report && !report.ok ? 'info' : 'success',
		});
		setForm(null);
		await reload();
	};
	/** @param {any} connector */
	const test = async (connector) => {
		setBusy(`test:${connector.connectorId}`);
		setProblem(null);
		const result = await apiFetch(`${api.connector(merchantId, connector.connectorId)}/test`, { method: 'POST', body: {} });
		setBusy(null);
		if (!result.ok) setProblem(result.problem);
		else
			toast.show({
				title: result.data?.ok === false || result.data?.report?.ok === false ? 'Check failed' : 'Check passed',
				tone: 'info',
			});
		await reload();
	};
	const saveAssign = async () => {
		setBusy('assign');
		setProblem(null);
		const result = await apiFetch(`${api.connector(merchantId, assigning.connectorId)}/websites`, {
			method: 'PUT',
			body: { websiteIds: assigned },
		});
		setBusy(null);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		setAssigning(null);
		toast.show({ title: 'Websites updated' });
		await reload();
	};
	const remove = async () => {
		if (!confirm) return;
		setBusy('delete');
		setProblem(null);
		const result = await apiFetch(api.connector(merchantId, confirm.connector.connectorId), { method: 'DELETE' });
		setBusy(null);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		setConfirm(null);
		toast.show({ title: 'Connector deleted' });
		await reload();
	};

	const providers = /** @type {Record<string, string[] | null>} */ (PROVIDERS)[kind];
	return (
		<div className="space-y-6">
			<WebsiteHeader website={website} active="resources" />
			<Card
				title="What this website uses"
				subtitle="Products run on your own resources; we only store the encrypted credentials.">
				<ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
					{RESOURCE_KINDS.map((k) => {
						const status = statusOf(k.kind);
						const needed = required.get(k.kind);
						return (
							<li key={k.kind} className="flex flex-col gap-2 rounded-xl border border-line p-4">
								<div className="flex items-center justify-between gap-2">
									<p className="text-sm font-semibold text-fg">{k.label}</p>
									<StatusBadge status={status} label={status === 'missing' ? 'Not connected' : undefined} />
								</div>
								<p className="text-xs text-muted">{k.help}</p>
								{needed && status !== 'connected' ? (
									<p className="text-xs font-medium text-warning">Needed now by {needed.join(', ')}</p>
								) : null}
								{ifEnabled.get(k.kind) && status !== 'connected' ? (
									<p className="text-xs text-muted">Needed if you enable {ifEnabled.get(k.kind)?.join(', ')}</p>
								) : null}
								{status === 'missing' ? (
									<div>
										<Button size="sm" variant={needed ? 'primary' : 'secondary'} onClick={() => openCreate(k.kind)}>
											Connect
										</Button>
									</div>
								) : null}
							</li>
						);
					})}
				</ul>
			</Card>
			{problem && !form && !confirm && !assigning ? <FormError problem={problem} /> : null}
			<Card
				title="Connectors"
				subtitle={showAll ? 'Every connector of your organisation.' : `Connectors assigned to ${websiteLabel(website)}.`}
				padded={false}
				actions={
					<>
						{others.length > 0 ? (
							<Button size="sm" variant="ghost" onClick={() => setShowAll((v) => !v)}>
								{showAll ? 'Only this website' : `Show all (${connectors.length})`}
							</Button>
						) : null}
						<Button size="sm" onClick={() => openCreate('database')} icon={<Icon name="plus" size={14} />}>
							Add connector
						</Button>
					</>
				}>
				{list.length === 0 ? (
					<div className="p-5">
						<EmptyState
							compact
							icon="plug"
							title="No connectors here yet"
							description={
								others.length > 0
									? 'Assign an existing connector of your organisation, or add a new one.'
									: 'Add your database first if a product stores data.'
							}
						/>
					</div>
				) : (
					<ul className="divide-y divide-line">
						{list.map((c) => {
							return (
								<li key={c.connectorId} className="space-y-3 px-5 py-4">
									<div className="flex flex-wrap items-start justify-between gap-3">
										<div className="min-w-0">
											<p className="text-sm font-semibold text-fg">
												{c.label ?? `${humanize(c.kind)} · ${providerLabel(c.provider)}`}
											</p>
											<p className="text-xs text-muted">
												{humanize(c.kind)} · {providerLabel(c.provider)} · added {formatDateTime(c.createdAt)}
											</p>
										</div>
										<StatusBadge status={c.status} />
									</div>
									{c.preview ? (
										<KeyValueList
											columns={3}
											items={Object.entries(c.preview).map(([k, v]) => ({
												label: humanize(k),
												value: (
													<span className="font-mono text-xs">
														{v === null || v === undefined ? '—' : String(v)}
													</span>
												),
											}))}
										/>
									) : null}
									<CheckReport report={c.lastCheckReport} />
									<p className="text-xs text-muted">
										Used by:{' '}
										{(c.websiteIds ?? [])
											.map((/** @type {string} */ id) => websites.find((/** @type {any} */ w) => w.websiteId === id))
											.filter(Boolean)
											.map(websiteLabel)
											.join(', ') || 'no website'}
									</p>
									<div className="flex flex-wrap gap-2">
										<Button
											size="sm"
											variant="secondary"
											onClick={() => void test(c)}
											loading={busy === `test:${c.connectorId}`}>
											Test
										</Button>
										<Button size="sm" variant="secondary" onClick={() => openEdit(c)}>
											Edit
										</Button>
										<Button
											size="sm"
											variant="secondary"
											onClick={() => {
												setProblem(null);
												setAssigned([...(c.websiteIds ?? [])]);
												setAssigning(c);
											}}>
											Websites
										</Button>
										<Button size="sm" variant="ghost" onClick={() => setConfirm({ action: 'delete', connector: c })}>
											Delete
										</Button>
									</div>
								</li>
							);
						})}
					</ul>
				)}
			</Card>
			<Dialog
				open={Boolean(form)}
				onClose={() => {
					setValues({});
					setForm(null);
				}}
				title={form?.mode === 'edit' ? `Edit ${form.connector?.label ?? 'connector'}` : 'Connect a resource'}
				description={
					form?.mode === 'edit'
						? 'Leave the credential fields empty to keep the current ones. New credentials are tested before use.'
						: `Assigned to ${websiteLabel(website)}. Credentials are encrypted and never shown again.`
				}
				footer={
					<>
						<Button
							variant="secondary"
							onClick={() => {
								setValues({});
								setForm(null);
							}}>
							Cancel
						</Button>
						<Button onClick={() => void submit()} loading={busy === 'form'}>
							{form?.mode === 'edit' ? 'Save' : 'Connect and test'}
						</Button>
					</>
				}>
				{form?.mode === 'create' ? (
					<>
						<Select
							label="Kind"
							value={kind}
							onChange={(e) => {
								const k = e.currentTarget.value;
								setKind(k);
								setProvider(/** @type {Record<string, string[] | null>} */ (PROVIDERS)[k]?.[0] ?? '');
								setValues({});
								setErrors({});
							}}
							options={RESOURCE_KINDS.map((k) => ({ value: k.kind, label: k.label }))}
						/>
						{providers ? (
							<Select
								label="Provider"
								value={provider}
								onChange={(e) => {
									setProvider(e.currentTarget.value);
									setValues({});
								}}
								options={providers.map((p) => ({ value: p, label: providerLabel(p) }))}
							/>
						) : (
							<Input
								label="Provider"
								value={provider}
								onChange={(e) => setProvider(e.currentTarget.value.toLowerCase())}
								placeholder="stripe"
								help="Lower-case provider name."
								error={errors.provider}
								required
							/>
						)}
						<Input
							label="Label (optional)"
							value={label}
							maxLength={80}
							onChange={(e) => setLabel(e.currentTarget.value)}
						/>
					</>
				) : (
					<Input
						label="Label"
						value={label}
						maxLength={80}
						onChange={(e) => setLabel(e.currentTarget.value)}
						error={errors.label}
					/>
				)}
				<CredentialInputs
					fields={fields}
					values={values}
					errors={errors}
					onChange={(name, value) => setValues((v) => ({ ...v, [name]: value }))}
				/>
				<FormError problem={problem} fields={['kind', 'provider', 'label', ...fields.map((f) => `credentials.${f.name}`)]} />
			</Dialog>
			<Dialog
				open={Boolean(assigning)}
				onClose={() => setAssigning(null)}
				title="Websites using this connector"
				footer={
					<>
						<Button variant="secondary" onClick={() => setAssigning(null)}>
							Cancel
						</Button>
						<Button onClick={() => void saveAssign()} loading={busy === 'assign'}>
							Save
						</Button>
					</>
				}>
				<div className="space-y-2">
					{websites.map((/** @type {any} */ w) => (
						<Checkbox
							key={w.websiteId}
							label={websiteLabel(w)}
							checked={assigned.includes(w.websiteId)}
							onChange={(e) => {
								const on = e.currentTarget.checked;
								setAssigned((list) => (on ? [...list, w.websiteId] : list.filter((id) => id !== w.websiteId)));
							}}
						/>
					))}
				</div>
				{assigning && others.some((c) => c.connectorId === assigning.connectorId) ? (
					<Callout tone="info" live={false}>
						Assigning it to {websiteLabel(website)} lets this website's products use it.
					</Callout>
				) : null}
				<FormError problem={problem} />
			</Dialog>
			<ConfirmDialog
				open={Boolean(confirm)}
				onClose={() => setConfirm(null)}
				onConfirm={() => void remove()}
				busy={busy !== null}
				danger
				title="Delete this connector?"
				confirmLabel="Delete"
				error={problem ? describeProblem(problem) : null}>
				<p className="text-sm text-muted">
					Every product using it stops on every assigned website. The encrypted credentials are destroyed.
				</p>
			</ConfirmDialog>
		</div>
	);
}
