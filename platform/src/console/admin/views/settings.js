'use client';
/**
 * Portal settings, kept in the Portal database (never environment variables): the mailer (the password is sealed and
 * never shown). The Portal URL is shown only: it is the address the Portal was opened at. Keys and secrets are
 * generated on first start and never shown. Changes reach every server instance within seconds.
 * @module
 */
import { useState } from 'react';
import {
	Button,
	Card,
	Checkbox,
	ConfirmDialog,
	Form,
	FormActions,
	FormError,
	Input,
	PageHeader,
	fieldErrors,
	useToast,
} from '@ss/ui';
import { adminFetch, useAdminResource } from '../client.js';
import { adminApi } from '../paths.js';
import { AdminProblem } from './common.js';

/** @typedef {import('@ss/ui').Problem} Problem */

/**
 * @param {any} props loader result of `loadSettings`
 */
export function SettingsView(props) {
	const toast = useToast();
	const ok = props.ok === true;
	const { data: settings, reload } = useAdminResource(ok ? adminApi.settings() : null, ok ? props.settings : null);
	if (!ok || !settings) return <AdminProblem problem={props.problem} title="Settings are unavailable" />;
	/** @param {string} title */
	const saved = async (title) => {
		toast.show({ title, description: 'Every server applies it within a few seconds.' });
		await reload();
	};
	return (
		<div className="space-y-6">
			<PageHeader title="Settings" subtitle="Stored in the Portal database. The Portal URL is the address you opened it at." />
			<Card title="Portal URL" subtitle="The address you opened the Portal at. Nothing to configure.">
				<p className="font-mono text-sm">{settings.portalUrl}</p>
			</Card>
			<MailCard current={settings.mail} onSaved={() => saved('Mail settings saved')} />
		</div>
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
