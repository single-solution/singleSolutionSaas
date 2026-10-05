'use client';
/**
 * Website keys: publishable `pk_` (browser, domain-locked) and secret `sk_` (server) keys with scopes. A new or
 * rotated key is shown exactly once; afterwards only its hint is listed.
 * @module
 */
import { useState } from 'react';
import {
	Badge,
	Button,
	Callout,
	CheckboxGroup,
	Checkbox,
	CodeBlock,
	ConfirmDialog,
	Dialog,
	FormError,
	Icon,
	Input,
	RadioGroup,
	StatusBadge,
	Table,
	describeProblem,
	fieldErrors,
	formatDate,
	formatDateTime,
	useToast,
} from '@ss/ui';
import { apiFetch, useResource } from '../client.js';
import { api } from '../paths.js';
import { PageProblem, WebsiteHeader } from './common.js';

/** @typedef {import('@ss/ui').Problem} Problem */

/** Default scopes of a new key (also what the Portal applies when none are chosen). */
export const DEFAULT_KEY_SCOPES = Object.freeze(['elements.read', 'events.write']);

/** Platform scopes when the catalogue could not be loaded. */
const FALLBACK_CATALOGUE = Object.freeze([
	{ scope: 'elements.read', group: 'platform', label: 'Read elements', description: '' },
	{ scope: 'events.write', group: 'platform', label: 'Send events', description: '' },
]);

/**
 * The scope catalogue (`GET …/keys/scopes`, F.16) grouped for the form: platform scopes first, then one group per
 * listed service product.
 * @param {ReadonlyArray<{ scope: string, group: string, label: string, description?: string, product?: string }>} catalogue
 * @returns {Array<{ group: string, title: string, options: Array<{ value: string, label: string }> }>}
 */
export const scopeGroups = (catalogue) => {
	/** @type {Map<string, { group: string, title: string, options: Array<{ value: string, label: string }> }>} */
	const groups = new Map();
	for (const entry of catalogue) {
		const group = groups.get(entry.group) ?? {
			group: entry.group,
			title: entry.group === 'platform' ? 'Platform' : (entry.product ?? entry.group),
			options: [],
		};
		group.options.push({ value: entry.scope, label: `${entry.label} (${entry.scope})` });
		groups.set(entry.group, group);
	}
	return [...groups.values()];
};

/**
 * @param {any} props loader result of `loadKeys`
 */
export function KeysView(props) {
	const toast = useToast();
	const ok = props.ok === true;
	const { data, reload } = useResource(ok ? api.keys(props.merchantId, props.website.websiteId) : null, {
		items: ok ? props.keys : [],
	});
	const [creating, setCreating] = useState(false);
	const [kind, setKind] = useState(/** @type {'pk' | 'sk'} */ ('pk'));
	const [scopes, setScopes] = useState(/** @type {string[]} */ ([...DEFAULT_KEY_SCOPES]));
	const [allowSubdomains, setAllowSubdomains] = useState(false);
	const [expiresAt, setExpiresAt] = useState('');
	const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [busy, setBusy] = useState(false);
	const [secret, setSecret] = useState(/** @type {{ key: string, kind: string, rotated?: boolean } | null} */ (null));
	const [rotating, setRotating] = useState(/** @type {any} */ (null));
	const [grace, setGrace] = useState('86400');
	const [revoking, setRevoking] = useState(/** @type {any} */ (null));
	const [reason, setReason] = useState('');
	if (!ok) return <PageProblem problem={props.problem} />;
	const { merchantId, website } = props;
	const keys = /** @type {any[]} */ (data.items ?? []);
	const base = api.keys(merchantId, website.websiteId);
	const groups = scopeGroups(Array.isArray(props.scopes) && props.scopes.length > 0 ? props.scopes : FALLBACK_CATALOGUE);

	const openCreate = () => {
		setKind('pk');
		setScopes([...DEFAULT_KEY_SCOPES]);
		setAllowSubdomains(false);
		setExpiresAt('');
		setErrors({});
		setProblem(null);
		setCreating(true);
	};
	const create = async () => {
		const all = [...new Set(scopes)];
		/** @type {Record<string, string>} */
		const local = {};
		if (all.length === 0) local.scopes = 'Choose at least one scope.';
		const exp = expiresAt ? new Date(`${expiresAt}T23:59:59Z`) : null;
		if (exp && exp.getTime() <= Date.now() + 60_000) local.expiresAt = 'Choose a date in the future.';
		setErrors(local);
		if (Object.keys(local).length > 0) return;
		setBusy(true);
		setProblem(null);
		const result = await apiFetch(base, {
			method: 'POST',
			body: {
				kind,
				scopes: all,
				...(kind === 'pk' && allowSubdomains ? { allowSubdomains: true } : {}),
				...(exp ? { expiresAt: exp.toISOString() } : {}),
			},
		});
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			setErrors(fieldErrors(result.problem));
			return;
		}
		setCreating(false);
		setSecret({ key: result.data.key, kind });
		await reload();
	};
	const rotate = async () => {
		const seconds = Number(grace);
		setBusy(true);
		setProblem(null);
		const result = await apiFetch(`${api.key(merchantId, website.websiteId, rotating.keyId)}/rotate`, {
			method: 'POST',
			body: Number.isInteger(seconds) ? { graceSeconds: seconds } : {},
		});
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		setRotating(null);
		setSecret({ key: result.data.key, kind: rotating.kind, rotated: true });
		await reload();
	};
	const revoke = async () => {
		setBusy(true);
		setProblem(null);
		const result = await apiFetch(`${api.key(merchantId, website.websiteId, revoking.keyId)}/revoke`, {
			method: 'POST',
			body: reason.trim() ? { reason: reason.trim() } : {},
		});
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		toast.show({ title: 'Key revoked', description: 'Requests with it are refused within minutes everywhere.' });
		setRevoking(null);
		setReason('');
		await reload();
	};

	return (
		<div className="space-y-6">
			<WebsiteHeader
				website={website}
				active="keys"
				actions={
					<Button onClick={openCreate} icon={<Icon name="plus" size={14} />}>
						Create key
					</Button>
				}
			/>
			<Callout tone="info" live={false}>
				<strong>pk_</strong> keys go in your site's pages (locked to {website.domain}); <strong>sk_</strong> keys stay on your
				server. {website.env === 'test' ? 'These are test keys.' : 'Use the test twin for test keys.'} Keys are shown once
				when created.
			</Callout>
			<Table
				caption="Website keys"
				rows={keys}
				rowKey={(k) => k.keyId}
				defaultSort={{ key: 'createdAt', direction: 'desc' }}
				empty="No keys yet. Create a pk_ key to send events from your site."
				columns={[
					{
						key: 'hint',
						header: 'Key',
						rowHeader: true,
						render: (k) => (
							<span className="space-y-0.5">
								<span className="block font-mono text-xs">{k.hint}</span>
								<span className="flex gap-1">
									<Badge tone={k.kind === 'sk' ? 'warning' : 'primary'}>
										{k.kind === 'sk' ? 'Secret' : 'Publishable'}
									</Badge>
									<Badge>{k.env}</Badge>
								</span>
							</span>
						),
					},
					{
						key: 'scopes',
						header: 'Scopes',
						render: (k) => (
							<span className="flex max-w-xs flex-wrap gap-1">
								{k.scopes.map((/** @type {string} */ s) => (
									<span key={s} className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px]">
										{s}
									</span>
								))}
								{k.allowSubdomains ? <Badge tone="info">+ subdomains</Badge> : null}
							</span>
						),
					},
					{ key: 'status', header: 'Status', render: (k) => <StatusBadge status={k.status} /> },
					{ key: 'createdAt', header: 'Created', sortable: true, render: (k) => formatDate(k.createdAt) },
					{
						key: 'expiresAt',
						header: 'Expires',
						render: (k) =>
							k.revokeAt ? `Revokes ${formatDateTime(k.revokeAt)}` : k.expiresAt ? formatDate(k.expiresAt) : 'Never',
					},
					{
						key: 'actions',
						header: <span className="sr-only">Actions</span>,
						align: 'right',
						render: (k) =>
							k.status === 'active' ? (
								<span className="inline-flex gap-1">
									<Button
										size="sm"
										variant="ghost"
										onClick={() => {
											setProblem(null);
											setGrace('86400');
											setRotating(k);
										}}>
										Rotate
									</Button>
									<Button
										size="sm"
										variant="ghost"
										onClick={() => {
											setProblem(null);
											setReason('');
											setRevoking(k);
										}}>
										Revoke
									</Button>
								</span>
							) : null,
					},
				]}
			/>
			<Dialog
				open={creating}
				onClose={() => setCreating(false)}
				title="Create a key"
				footer={
					<>
						<Button variant="secondary" onClick={() => setCreating(false)}>
							Cancel
						</Button>
						<Button onClick={() => void create()} loading={busy}>
							Create key
						</Button>
					</>
				}>
				<RadioGroup
					legend="Kind"
					value={kind}
					onChange={(v) => {
						const next = v === 'sk' ? 'sk' : 'pk';
						setKind(next);
						setScopes([...DEFAULT_KEY_SCOPES]);
					}}
					options={[
						{ value: 'pk', label: 'Publishable (pk_) — for the browser' },
						{ value: 'sk', label: 'Secret (sk_) — for your server only' },
					]}
				/>
				{groups.map((g, i) => (
					<CheckboxGroup
						key={g.group}
						legend={g.group === 'platform' ? 'Scopes' : `${g.title} scopes`}
						value={scopes.filter((s) => g.options.some((o) => o.value === s))}
						onChange={(chosen) => setScopes([...scopes.filter((s) => !g.options.some((o) => o.value === s)), ...chosen])}
						options={g.options}
						error={i === 0 ? (errors.scopes ?? errors['scopes.0']) : undefined}
					/>
				))}
				{kind === 'pk' ? (
					<Checkbox
						label={`Also allow subdomains of ${website.domain}`}
						checked={allowSubdomains}
						onChange={(e) => setAllowSubdomains(e.currentTarget.checked)}
					/>
				) : null}
				<Input
					label="Expires (optional)"
					type="date"
					value={expiresAt}
					onChange={(e) => setExpiresAt(e.currentTarget.value)}
					error={errors.expiresAt}
				/>
				<FormError problem={problem} fields={['scopes', 'expiresAt', 'kind']} />
			</Dialog>
			<Dialog
				open={Boolean(secret)}
				onClose={() => setSecret(null)}
				title={secret?.rotated ? 'New key — copy it now' : 'Your new key — copy it now'}
				dismissible
				footer={<Button onClick={() => setSecret(null)}>I have copied it</Button>}>
				{secret ? (
					<>
						<CodeBlock code={secret.key} label={secret.kind === 'sk' ? 'Secret key' : 'Publishable key'} secret />
						{secret.kind === 'sk' ? (
							<Callout tone="warning" live={false}>
								Store it in your server's secret manager. Never put an sk_ key in a web page or a repository.
							</Callout>
						) : null}
						{secret.rotated ? (
							<p className="text-sm text-muted">The previous key keeps working until its grace period ends.</p>
						) : null}
					</>
				) : null}
			</Dialog>
			<ConfirmDialog
				open={Boolean(rotating)}
				onClose={() => setRotating(null)}
				onConfirm={() => void rotate()}
				busy={busy}
				title="Rotate this key?"
				confirmLabel="Rotate"
				error={problem ? describeProblem(problem) : null}>
				<p className="text-sm text-muted">
					A new key with the same scopes is created. The old one is revoked after the grace period.
				</p>
				<RadioGroup
					legend="Grace period"
					value={grace}
					onChange={setGrace}
					options={[
						{ value: '0', label: 'Revoke the old key now' },
						{ value: '3600', label: '1 hour' },
						{ value: '86400', label: '24 hours' },
						{ value: '604800', label: '7 days' },
					]}
				/>
			</ConfirmDialog>
			<ConfirmDialog
				open={Boolean(revoking)}
				onClose={() => setRevoking(null)}
				onConfirm={() => void revoke()}
				busy={busy}
				danger
				title="Revoke this key?"
				confirmLabel="Revoke key"
				error={problem ? describeProblem(problem) : null}>
				<p className="text-sm text-muted">
					Everything using <span className="font-mono">{revoking?.hint}</span> stops working. This cannot be undone.
				</p>
				<Input label="Reason (optional)" value={reason} maxLength={500} onChange={(e) => setReason(e.currentTarget.value)} />
			</ConfirmDialog>
		</div>
	);
}
