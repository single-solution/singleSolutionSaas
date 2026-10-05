'use client';
/**
 * Account: profile and organisation name, password, two-factor authentication (enrol, recovery codes, disable)
 * and sessions. Secrets (TOTP secret, recovery codes) are shown once, right after the API returns them.
 * @module
 */
import { useState } from 'react';
import {
	Badge,
	Button,
	Callout,
	Card,
	CodeBlock,
	ConfirmDialog,
	Dialog,
	Form,
	FormActions,
	FormError,
	Input,
	KeyValueList,
	PageHeader,
	Table,
	describeProblem,
	fieldErrors,
	formatDateTime,
	useToast,
} from '@ss/ui';
import { apiFetch } from '../client.js';
import { api, routes } from '../paths.js';
import { PageProblem } from './common.js';

/** @typedef {import('@ss/ui').Problem} Problem */

/**
 * Second-factor input that accepts a 6-digit code or a recovery code.
 * @param {string} value
 * @returns {{ code: string } | { recoveryCode: string } | null}
 */
export const secondFactor = (value) => {
	const v = value.trim();
	if (/^\d{6}$/.test(v)) return { code: v };
	if (/^[a-z2-7]{5}-?[a-z2-7]{5}$/i.test(v)) return { recoveryCode: v };
	return null;
};

/**
 * @param {any} props loader result of `loadAccount`
 */
export function AccountView(props) {
	const toast = useToast();
	const ok = props.ok === true;
	const [me, setMe] = useState(ok ? props.me : null);
	const [sessions, setSessions] = useState(/** @type {any[]} */ (ok ? props.sessions : []));
	const [merchantName, setMerchantName] = useState(ok ? (props.merchant?.name ?? '') : '');
	const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirm: '' });
	const [pwErrors, setPwErrors] = useState(/** @type {Record<string, string>} */ ({}));
	const [problem, setProblem] = useState(/** @type {{ area: string, problem: Problem } | null} */ (null));
	const [busy, setBusy] = useState(/** @type {string | null} */ (null));
	const [enrol, setEnrol] = useState(/** @type {null | { secret: string, uri: string }} */ (null));
	const [code, setCode] = useState('');
	const [codes, setCodes] = useState(/** @type {string[] | null} */ (null));
	const [disabling, setDisabling] = useState(false);
	const [regenerating, setRegenerating] = useState(false);
	const [factor, setFactor] = useState('');
	const [password, setPassword] = useState('');
	const [revoking, setRevoking] = useState(/** @type {any} */ (null));
	if (!ok || !me) return <PageProblem problem={props.problem} />;
	const { merchantId } = props;
	const roles = /** @type {string[]} */ (
		(me.memberships ?? []).find((/** @type {any} */ m) => m.merchantId === merchantId)?.roles ?? []
	);
	const canRename = roles.includes('owner') || roles.includes('admin');
	const mfa = me.user?.mfa ?? { enabled: false, recoveryCodesLeft: 0 };
	/** @param {string} area @param {Problem} p */
	const fail = (area, p) => setProblem({ area, problem: p });
	/** @param {string} area */
	const problemOf = (area) => (problem?.area === area ? problem.problem : null);
	const refreshMe = async () => {
		const r = await apiFetch(api.me());
		if (r.ok) setMe(r.data);
	};
	const refreshSessions = async () => {
		const r = await apiFetch('/v1/me/sessions');
		if (r.ok) setSessions(r.data.items ?? []);
	};

	const rename = async () => {
		if (!merchantId) return;
		setBusy('rename');
		setProblem(null);
		const r = await apiFetch(api.merchant(merchantId), { method: 'PATCH', body: { name: merchantName.trim() } });
		setBusy(null);
		if (!r.ok) return fail('rename', r.problem);
		toast.show({ title: 'Organisation renamed' });
		await refreshMe();
	};
	const changePassword = async () => {
		/** @type {Record<string, string>} */
		const local = {};
		if (!pw.currentPassword) local.currentPassword = 'Enter your current password.';
		if (pw.newPassword.length < 12) local.newPassword = 'Use at least 12 characters.';
		if (pw.confirm !== pw.newPassword) local.confirm = 'The passwords do not match.';
		setPwErrors(local);
		if (Object.keys(local).length > 0) return;
		setBusy('password');
		setProblem(null);
		const r = await apiFetch('/v1/me/password', {
			method: 'POST',
			body: { currentPassword: pw.currentPassword, newPassword: pw.newPassword },
		});
		setBusy(null);
		if (!r.ok) {
			setPwErrors(fieldErrors(r.problem));
			return fail('password', r.problem);
		}
		setPw({ currentPassword: '', newPassword: '', confirm: '' });
		toast.show({ title: 'Password changed', description: 'Your other sessions were signed out.' });
		await refreshSessions();
	};
	const startEnrol = async () => {
		setBusy('enrol');
		setProblem(null);
		const r = await apiFetch('/v1/me/mfa/enrol', { method: 'POST', body: {} });
		setBusy(null);
		if (!r.ok) return fail('mfa', r.problem);
		setCode('');
		setEnrol(r.data);
	};
	const confirmEnrol = async () => {
		if (!/^\d{6}$/.test(code.trim()))
			return fail('enrol', { title: 'Invalid code', detail: 'Enter the 6-digit code from your app.', code: 'validation' });
		setBusy('confirm');
		setProblem(null);
		const r = await apiFetch('/v1/me/mfa/confirm', { method: 'POST', body: { code: code.trim() } });
		setBusy(null);
		if (!r.ok) return fail('enrol', r.problem);
		setEnrol(null);
		setCodes(r.data.recoveryCodes ?? []);
		await refreshMe();
	};
	const disable = async () => {
		const f = secondFactor(factor);
		if (!f || !password)
			return fail('disable', {
				title: 'Missing',
				detail: 'Enter your password and a code (or a recovery code).',
				code: 'validation',
			});
		setBusy('disable');
		setProblem(null);
		const r = await apiFetch('/v1/me/mfa/disable', { method: 'POST', body: { password, ...f } });
		setBusy(null);
		if (!r.ok) return fail('disable', r.problem);
		setDisabling(false);
		setPassword('');
		setFactor('');
		toast.show({ title: 'Two-factor authentication turned off' });
		await refreshMe();
	};
	const regenerate = async () => {
		const f = secondFactor(factor);
		if (!f)
			return fail('regenerate', {
				title: 'Missing',
				detail: 'Enter a current code (or a recovery code).',
				code: 'validation',
			});
		setBusy('regenerate');
		setProblem(null);
		const r = await apiFetch('/v1/me/mfa/recovery-codes', { method: 'POST', body: f });
		setBusy(null);
		if (!r.ok) return fail('regenerate', r.problem);
		setRegenerating(false);
		setFactor('');
		setCodes(r.data.recoveryCodes ?? []);
		await refreshMe();
	};
	const revoke = async () => {
		setBusy('session');
		const r = await apiFetch(`/v1/me/sessions/${encodeURIComponent(revoking.sessionId)}`, { method: 'DELETE' });
		setBusy(null);
		if (!r.ok) return fail('sessions', r.problem);
		setRevoking(null);
		toast.show({ title: 'Session signed out' });
		await refreshSessions();
	};
	const signOut = async () => {
		await apiFetch('/v1/auth/merchant/logout', { method: 'POST', redirectOn401: false });
		window.location.assign(routes.login());
	};

	return (
		<div className="space-y-6">
			<PageHeader title="Account" subtitle="Your sign-in, security and sessions." />
			<div className="grid gap-6 lg:grid-cols-2">
				<Card title="Profile">
					<KeyValueList
						columns={1}
						items={[
							{ label: 'E-mail', value: me.user?.email },
							{ label: 'Name', value: me.user?.name ?? '—' },
							{ label: 'Roles here', value: roles.join(', ') || '—' },
						]}
					/>
					{canRename && merchantId ? (
						<Form
							onSubmit={rename}
							busy={busy === 'rename'}
							className="mt-5 border-t border-line pt-5"
							aria-label="Organisation name">
							<Input
								label="Organisation name"
								value={merchantName}
								maxLength={120}
								onChange={(e) => setMerchantName(e.currentTarget.value)}
								error={fieldErrors(problemOf('rename')).name}
							/>
							<FormError problem={problemOf('rename')} fields={['name']} />
							<FormActions>
								<Button
									type="submit"
									variant="secondary"
									loading={busy === 'rename'}
									disabled={!merchantName.trim() || merchantName.trim() === props.merchant?.name}>
									Rename
								</Button>
							</FormActions>
						</Form>
					) : null}
				</Card>
				<Card title="Password">
					<Form onSubmit={changePassword} busy={busy === 'password'} aria-label="Change password">
						<Input
							label="Current password"
							type="password"
							autoComplete="current-password"
							value={pw.currentPassword}
							onChange={(e) => {
								const v = e.currentTarget.value;
								setPw((p) => ({ ...p, currentPassword: v }));
							}}
							error={pwErrors.currentPassword}
							required
						/>
						<Input
							label="New password"
							type="password"
							autoComplete="new-password"
							help="At least 12 characters. Other sessions are signed out."
							value={pw.newPassword}
							onChange={(e) => {
								const v = e.currentTarget.value;
								setPw((p) => ({ ...p, newPassword: v }));
							}}
							error={pwErrors.newPassword}
							required
						/>
						<Input
							label="Repeat the new password"
							type="password"
							autoComplete="new-password"
							value={pw.confirm}
							onChange={(e) => {
								const v = e.currentTarget.value;
								setPw((p) => ({ ...p, confirm: v }));
							}}
							error={pwErrors.confirm}
							required
						/>
						<FormError problem={problemOf('password')} fields={['currentPassword', 'newPassword']} />
						<FormActions>
							<Button type="submit" loading={busy === 'password'}>
								Change password
							</Button>
						</FormActions>
					</Form>
				</Card>
			</div>
			<Card
				title="Two-factor authentication"
				subtitle="A code from an authenticator app at every sign-in."
				actions={
					mfa.enabled ? (
						<Badge tone="success" dot>
							On
						</Badge>
					) : (
						<Badge tone="warning" dot>
							Off
						</Badge>
					)
				}>
				{problemOf('mfa') ? <FormError problem={problemOf('mfa')} className="mb-4" /> : null}
				{mfa.enabled ? (
					<div className="space-y-4">
						<p className="text-sm text-muted">
							{mfa.recoveryCodesLeft} recovery code{mfa.recoveryCodesLeft === 1 ? '' : 's'} left.
							{mfa.recoveryCodesLeft <= 3 ? ' Generate new ones soon.' : ''}
						</p>
						<div className="flex flex-wrap gap-2">
							<Button
								variant="secondary"
								onClick={() => {
									setFactor('');
									setProblem(null);
									setRegenerating(true);
								}}>
								New recovery codes
							</Button>
							<Button
								variant="ghost"
								onClick={() => {
									setFactor('');
									setPassword('');
									setProblem(null);
									setDisabling(true);
								}}>
								Turn off
							</Button>
						</div>
					</div>
				) : (
					<div className="space-y-4">
						<p className="text-sm text-muted">Protect your organisation's websites and credits with a second factor.</p>
						<Button onClick={() => void startEnrol()} loading={busy === 'enrol'}>
							Set up two-factor authentication
						</Button>
					</div>
				)}
			</Card>
			<Table
				caption="Sessions"
				captionHidden={false}
				rows={sessions}
				rowKey={(s) => s.sessionId}
				defaultSort={{ key: 'lastSeenAt', direction: 'desc' }}
				columns={[
					{
						key: 'current',
						header: 'Session',
						rowHeader: true,
						render: (s) => (
							<span className="flex flex-wrap items-center gap-1.5">
								{s.current ? (
									<Badge tone="primary">This device</Badge>
								) : (
									<span className="font-mono text-xs">{String(s.sessionId).slice(0, 8)}…</span>
								)}
								{s.mfa ? <Badge tone="success">2FA</Badge> : null}
							</span>
						),
					},
					{ key: 'createdAt', header: 'Signed in', sortable: true, render: (s) => formatDateTime(s.createdAt) },
					{ key: 'lastSeenAt', header: 'Last active', sortable: true, render: (s) => formatDateTime(s.lastSeenAt) },
					{ key: 'expiresAt', header: 'Expires', render: (s) => formatDateTime(s.expiresAt) },
					{
						key: 'actions',
						header: <span className="sr-only">Actions</span>,
						align: 'right',
						render: (s) =>
							s.current ? (
								<Button size="sm" variant="ghost" onClick={() => void signOut()}>
									Sign out
								</Button>
							) : (
								<Button size="sm" variant="ghost" onClick={() => setRevoking(s)}>
									Sign out
								</Button>
							),
					},
				]}
			/>
			{problemOf('sessions') ? <FormError problem={problemOf('sessions')} /> : null}
			<Dialog
				open={Boolean(enrol)}
				onClose={() => setEnrol(null)}
				title="Set up two-factor authentication"
				description="Scan or paste into your authenticator app, then enter the code it shows."
				footer={
					<>
						<Button variant="secondary" onClick={() => setEnrol(null)}>
							Cancel
						</Button>
						<Button onClick={() => void confirmEnrol()} loading={busy === 'confirm'}>
							Turn on
						</Button>
					</>
				}>
				{enrol ? (
					<>
						<CodeBlock label="Setup link (otpauth)" code={enrol.uri} />
						<CodeBlock label="Or type this key" code={enrol.secret} secret />
						<Input
							label="Code from the app"
							inputMode="numeric"
							autoComplete="one-time-code"
							maxLength={6}
							value={code}
							onChange={(e) => setCode(e.currentTarget.value)}
							error={fieldErrors(problemOf('enrol')).code}
						/>
						<FormError problem={problemOf('enrol')} fields={['code']} />
					</>
				) : null}
			</Dialog>
			<Dialog
				open={Boolean(codes)}
				onClose={() => setCodes(null)}
				title="Your recovery codes"
				description="Each code signs you in once if you lose your device. Store them somewhere safe."
				footer={<Button onClick={() => setCodes(null)}>I have saved them</Button>}>
				{codes ? <CodeBlock code={codes.join('\n')} label="Recovery codes" secret wrap={false} /> : null}
				<Callout tone="info" live={false}>
					Generating new codes invalidates these.
				</Callout>
			</Dialog>
			<ConfirmDialog
				open={disabling}
				onClose={() => setDisabling(false)}
				onConfirm={() => void disable()}
				busy={busy === 'disable'}
				danger
				title="Turn off two-factor authentication?"
				confirmLabel="Turn off"
				error={problemOf('disable') ? describeProblem(problemOf('disable')) : null}>
				<Input
					label="Password"
					type="password"
					autoComplete="current-password"
					value={password}
					onChange={(e) => setPassword(e.currentTarget.value)}
				/>
				<Input
					label="Code or recovery code"
					autoComplete="one-time-code"
					value={factor}
					onChange={(e) => setFactor(e.currentTarget.value)}
				/>
			</ConfirmDialog>
			<ConfirmDialog
				open={regenerating}
				onClose={() => setRegenerating(false)}
				onConfirm={() => void regenerate()}
				busy={busy === 'regenerate'}
				title="Generate new recovery codes?"
				confirmLabel="Generate"
				error={problemOf('regenerate') ? describeProblem(problemOf('regenerate')) : null}>
				<p className="text-sm text-muted">Your current recovery codes stop working.</p>
				<Input
					label="Code or recovery code"
					autoComplete="one-time-code"
					value={factor}
					onChange={(e) => setFactor(e.currentTarget.value)}
				/>
			</ConfirmDialog>
			<ConfirmDialog
				open={Boolean(revoking)}
				onClose={() => setRevoking(null)}
				onConfirm={() => void revoke()}
				busy={busy === 'session'}
				title="Sign out this session?"
				confirmLabel="Sign out"
				error={problemOf('sessions') ? describeProblem(problemOf('sessions')) : null}>
				<p className="text-sm text-muted">
					Signed in {formatDateTime(revoking?.createdAt)}, last active {formatDateTime(revoking?.lastSeenAt)}.
				</p>
			</ConfirmDialog>
		</div>
	);
}
