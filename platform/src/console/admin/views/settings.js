'use client';
/**
 * Portal settings, kept in the Portal database (never environment variables): the Portal URL (superadmins; typed twice,
 * audited — it is the issuer of every token, the base of e-mail links and the consoles' CSRF origin), the dedicated
 * preview URL, the mailer (the password is sealed and never shown) and the generated keys (rotation adds a key and
 * keeps the old ones published). Changes reach every server instance within seconds.
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
	Form,
	FormActions,
	FormError,
	Input,
	PageHeader,
	Table,
	describeProblem,
	fieldErrors,
	formatDateTime,
	useToast,
} from '@ss/ui';
import { adminFetch, useAdminResource } from '../client.js';
import { adminApi } from '../paths.js';
import { AdminProblem, staffCan } from './common.js';

/** @typedef {import('@ss/ui').Problem} Problem */

const KEY_KINDS = /** @type {const} */ ([
	{ kind: 'signing', title: 'Portal signing keys', help: 'Sign launches, entitlement documents and events.' },
	{ kind: 'website', title: 'Website-key signing keys', help: 'Sign pk_/sk_ website keys only.' },
	{ kind: 'encryption', title: 'Encryption keys', help: 'Seal client credentials and the mail password.' },
]);

/**
 * @param {any} props loader result of `loadSettings`
 */
export function SettingsView(props) {
	const toast = useToast();
	const ok = props.ok === true;
	const { data: settings, reload } = useAdminResource(ok ? adminApi.settings() : null, ok ? props.settings : null);
	const superadmin = staffCan(props.me, 'platform.staff.manage');
	if (!ok || !settings) return <AdminProblem problem={props.problem} title="Settings are unavailable" />;
	/** @param {string} title */
	const saved = async (title) => {
		toast.show({ title, description: 'Every server applies it within a few seconds.' });
		await reload();
	};
	return (
		<div className="space-y-6">
			<PageHeader
				title="Settings"
				subtitle="Stored in the Portal database. The environment holds only the database and the asset storage."
			/>
			<PortalUrlCard current={settings.portalUrl} canEdit={superadmin} onSaved={() => saved('Portal URL changed')} />
			<PreviewUrlCard current={settings.previewUrl} onSaved={() => saved('Preview URL saved')} />
			<MailCard current={settings.mail} onSaved={() => saved('Mail settings saved')} />
			<KeysCard keys={settings.keys} canRotate={superadmin} onRotated={() => saved('Key rotated')} />
		</div>
	);
}

/**
 * @param {{ current: string | null, canEdit: boolean, onSaved: () => unknown }} props
 */
function PortalUrlCard({ current, canEdit, onSaved }) {
	const [portalUrl, setPortalUrl] = useState('');
	const [confirmation, setConfirmation] = useState('');
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [busy, setBusy] = useState(false);
	const save = async () => {
		setBusy(true);
		setProblem(null);
		const result = await adminFetch(adminApi.settingsPortalUrl(), { method: 'PUT', body: { portalUrl, confirmation } });
		setBusy(false);
		if (!result.ok) return setProblem(result.problem);
		setPortalUrl('');
		setConfirmation('');
		await onSaved();
	};
	const errors = fieldErrors(problem);
	return (
		<Card
			title="Portal URL"
			subtitle="Recorded at first-run setup. Issuer and audience of every token, base of e-mail links, the consoles' only accepted origin.">
			<p className="font-mono text-sm">{current ?? '—'}</p>
			{canEdit ? (
				<Form onSubmit={save} busy={busy} aria-label="Change the Portal URL">
					<Callout tone="warning" live={false} title="Change it only when the Portal moves">
						Point the new domain at this deployment first. Products keep working (they trust keys), but launches and links
						use the new address at once.
					</Callout>
					<div className="grid gap-4 sm:grid-cols-2">
						<Input
							label="New Portal URL"
							type="url"
							value={portalUrl}
							onChange={(e) => setPortalUrl(e.currentTarget.value)}
							error={errors.portalUrl}
							required
						/>
						<Input
							label="Type it again"
							type="url"
							value={confirmation}
							onChange={(e) => setConfirmation(e.currentTarget.value)}
							error={errors.confirmation}
							required
						/>
					</div>
					<FormError problem={problem} fields={['portalUrl', 'confirmation']} />
					<FormActions>
						<Button type="submit" variant="secondary" loading={busy}>
							Change the Portal URL
						</Button>
					</FormActions>
				</Form>
			) : (
				<p className="text-sm text-muted">Only superadmins change the Portal URL.</p>
			)}
		</Card>
	);
}

/**
 * @param {{ current: string | null, onSaved: () => unknown }} props
 */
function PreviewUrlCard({ current, onSaved }) {
	const [previewUrl, setPreviewUrl] = useState(current ?? '');
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [busy, setBusy] = useState(false);
	const save = async () => {
		setBusy(true);
		setProblem(null);
		const result = await adminFetch(adminApi.settingsPreviewUrl(), {
			method: 'PUT',
			body: { previewUrl: previewUrl.trim() || null },
		});
		setBusy(false);
		if (!result.ok) return setProblem(result.problem);
		await onSaved();
	};
	return (
		<Card
			title="Preview URL (optional)"
			subtitle="A separate cookie-less origin, ideally another registrable domain, pointed at this deployment. It serves merchant previews only.">
			<Form onSubmit={save} busy={busy} aria-label="Preview URL">
				<Input
					label="Preview URL"
					type="url"
					value={previewUrl}
					onChange={(e) => setPreviewUrl(e.currentTarget.value)}
					error={fieldErrors(problem).previewUrl}
					help="Leave empty to serve previews from the Portal itself."
				/>
				<FormError problem={problem} fields={['previewUrl']} />
				<FormActions>
					<Button type="submit" variant="secondary" loading={busy}>
						Save preview URL
					</Button>
				</FormActions>
			</Form>
		</Card>
	);
}

/**
 * @param {{ current: any, onSaved: () => unknown }} props
 */
function MailCard({ current, onSaved }) {
	const [host, setHost] = useState(current?.host ?? '');
	const [port, setPort] = useState(String(current?.port ?? 587));
	const [secure, setSecure] = useState(Boolean(current?.secure));
	const [user, setUser] = useState(current?.user ?? '');
	const [password, setPassword] = useState('');
	const [from, setFrom] = useState(current?.from ?? '');
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [busy, setBusy] = useState(false);
	const [removing, setRemoving] = useState(false);
	/** @param {unknown} mail */
	const put = async (mail) => {
		setBusy(true);
		setProblem(null);
		const result = await adminFetch(adminApi.settingsMail(), { method: 'PUT', body: { mail } });
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			return false;
		}
		setPassword('');
		await onSaved();
		return true;
	};
	const save = () =>
		put({
			host: host.trim(),
			port: Number(port),
			secure,
			user: user.trim() || null,
			...(password ? { password } : {}),
			from: from.trim(),
		});
	const errors = fieldErrors(problem);
	return (
		<Card
			title="Mail"
			subtitle="Sign-up, password and invitation e-mails. Without a mailer, production sends none (development logs them).">
			<Form onSubmit={save} busy={busy} aria-label="Mail settings">
				<div className="grid gap-4 sm:grid-cols-2">
					<Input
						label="SMTP host"
						value={host}
						onChange={(e) => setHost(e.currentTarget.value)}
						error={errors.host}
						required
					/>
					<Input
						label="Port"
						type="number"
						value={port}
						onChange={(e) => setPort(e.currentTarget.value)}
						error={errors.port}
						help="587 with STARTTLS, or 465 with implicit TLS."
						required
					/>
					<Input label="User" value={user} onChange={(e) => setUser(e.currentTarget.value)} autoComplete="off" />
					<Input
						label="Password"
						type="password"
						value={password}
						onChange={(e) => setPassword(e.currentTarget.value)}
						error={errors.password}
						autoComplete="new-password"
						help={current?.hasPassword ? 'Stored (sealed). Leave empty to keep it.' : 'Stored sealed; never shown again.'}
					/>
					<Input
						label="From"
						value={from}
						onChange={(e) => setFrom(e.currentTarget.value)}
						error={errors.from}
						placeholder="Portal <no-reply@example.com>"
						required
					/>
				</div>
				<Checkbox label="Implicit TLS (port 465)" checked={secure} onChange={(e) => setSecure(e.currentTarget.checked)} />
				<FormError problem={problem} fields={['host', 'port', 'password', 'from']} />
				<FormActions>
					{current ? (
						<Button variant="secondary" onClick={() => setRemoving(true)}>
							Remove mailer
						</Button>
					) : null}
					<Button type="submit" variant="secondary" loading={busy}>
						Save mail settings
					</Button>
				</FormActions>
			</Form>
			<ConfirmDialog
				open={removing}
				onClose={() => setRemoving(false)}
				onConfirm={async () => {
					if (await put(null)) setRemoving(false);
				}}
				title="Remove the mailer?"
				confirmLabel="Remove"
				danger
				busy={busy}>
				Production then sends no e-mail until a mailer is set again.
			</ConfirmDialog>
		</Card>
	);
}

/**
 * @param {{ keys: Record<string, Array<{ id: string, createdAt: string, active: boolean }>>, canRotate: boolean,
 *   onRotated: () => unknown }} props
 */
function KeysCard({ keys, canRotate, onRotated }) {
	const [rotating, setRotating] = useState(/** @type {null | 'signing' | 'website' | 'encryption'} */ (null));
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [busy, setBusy] = useState(false);
	const rotate = async () => {
		if (!rotating) return;
		setBusy(true);
		setProblem(null);
		const result = await adminFetch(adminApi.rotateKey(rotating), { method: 'POST' });
		setBusy(false);
		if (!result.ok) return setProblem(result.problem);
		setRotating(null);
		await onRotated();
	};
	return (
		<Card title="Keys" subtitle="Generated on first start and kept in the database. Rotation adds a key; old keys stay valid.">
			<div className="space-y-6">
				{KEY_KINDS.map(({ kind, title, help }) => (
					<div key={kind} className="space-y-2">
						<div className="flex flex-wrap items-center justify-between gap-2">
							<div>
								<p className="font-semibold">{title}</p>
								<p className="text-sm text-muted">{help}</p>
							</div>
							{canRotate ? (
								<Button variant="secondary" onClick={() => setRotating(kind)}>
									Rotate
								</Button>
							) : null}
						</div>
						<Table
							caption={title}
							dense
							rows={keys?.[kind] ?? []}
							rowKey={(k) => k.id}
							columns={[
								{ key: 'id', header: 'Key id', render: (k) => <span className="font-mono text-xs">{k.id}</span> },
								{ key: 'createdAt', header: 'Created', render: (k) => formatDateTime(k.createdAt) },
								{
									key: 'active',
									header: 'State',
									render: (k) => (k.active ? <Badge tone="success">Active</Badge> : <Badge>Published</Badge>),
								},
							]}
						/>
					</div>
				))}
			</div>
			<ConfirmDialog
				open={rotating !== null}
				onClose={() => setRotating(null)}
				onConfirm={() => void rotate()}
				title="Rotate this key?"
				confirmLabel="Rotate"
				busy={busy}
				error={problem ? describeProblem(problem) : undefined}>
				A new key signs (or seals) from now on; the current one stays published so nothing signed with it breaks.
			</ConfirmDialog>
		</Card>
	);
}
