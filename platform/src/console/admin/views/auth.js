'use client';
/**
 * Staff sign-in: password, then the mandatory second factor — a TOTP / recovery code, or (first sign-in, or after
 * an authenticator reset) enrolment: the secret and `otpauth://` link are shown once, the first code confirms it,
 * and the recovery codes are shown once. The staff session cookie (`__Host-ss_staff`) is separate from merchant
 * sessions and only reaches the MFA routes until the second factor is done (infra auth). Also: password reset
 * request and the setup / reset link page (tokens arrive in the URL fragment, never in logs).
 * @module
 */
import { useEffect, useState } from 'react';
import { Button, Callout, CodeBlock, Form, FormError, Icon, Input, Spinner, Stepper, fieldErrors, problemCode } from '@ss/ui';
import { takeFragmentToken } from '../../client.js';
import { Link } from '../../link.js';
import { adminFetch } from '../client.js';
import { adminApi, adminRoutes } from '../paths.js';

/** @typedef {import('@ss/ui').Problem} Problem */

export const STAFF_PASSWORD_MIN = 12;

/**
 * Only Admin Console paths are followed after sign-in (no open redirects, no hop into the merchant console).
 * @param {string | null | undefined} next
 */
export const safeAdminNext = (next) =>
	typeof next === 'string' && /^\/admin(?:[/?#]|$)/.test(next) && !next.startsWith('//') && !next.includes('\\')
		? next
		: adminRoutes.dashboard();

/**
 * @param {{ title: string, subtitle?: import('react').ReactNode, children: import('react').ReactNode,
 *   footer?: import('react').ReactNode }} props
 */
export function StaffAuthFrame({ title, subtitle, children, footer }) {
	return (
		<main className="flex min-h-screen items-center justify-center bg-canvas px-4 py-10">
			<div className="w-full max-w-md space-y-6">
				<div className="flex items-center gap-3">
					<span className="flex size-10 items-center justify-center rounded-xl bg-fg text-canvas shadow-card">
						<Icon name="shield" size={18} />
					</span>
					<div>
						<p className="text-sm font-extrabold tracking-tight text-fg">Single Solution</p>
						<p className="text-[11px] font-bold uppercase tracking-wider text-muted">Admin console · staff only</p>
					</div>
				</div>
				<section
					aria-labelledby="staff-auth-title"
					className="space-y-5 rounded-card border border-line bg-surface p-6 shadow-card sm:p-8">
					<div className="space-y-1">
						<h1 id="staff-auth-title" className="text-xl font-bold tracking-tight text-fg">
							{title}
						</h1>
						{subtitle ? <p className="text-sm text-muted">{subtitle}</p> : null}
					</div>
					{children}
				</section>
				{footer ? <div className="text-center text-sm text-muted">{footer}</div> : null}
			</div>
		</main>
	);
}

/** @param {string} email */
const emailProblem = (email) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? null : 'Enter your e-mail address.');

/**
 * Second factor of a half-signed staff session.
 * @param {{ onDone: () => void, onRestart: () => void }} props
 */
export function StaffMfaVerify({ onDone, onRestart }) {
	const [useRecovery, setUseRecovery] = useState(false);
	const [code, setCode] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(/** @type {string | null} */ (null));
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const submit = async () => {
		const value = code.trim();
		if (useRecovery ? !/^[a-z2-7]{5}-?[a-z2-7]{5}$/i.test(value) : !/^\d{6}$/.test(value)) {
			setError(useRecovery ? 'Enter a recovery code like abcde-fghij.' : 'Enter the 6-digit code from your app.');
			return;
		}
		setBusy(true);
		setError(null);
		setProblem(null);
		const result = await adminFetch(adminApi.mfaVerify(), {
			method: 'POST',
			body: useRecovery ? { recoveryCode: value } : { code: value },
			redirectOn401: false,
		});
		setBusy(false);
		if (result.ok) onDone();
		else setProblem(result.problem);
	};
	// an expired half-signed session (not a wrong code, which is `invalid_credentials`)
	const expired = problem !== null && problemCode(problem) === 'unauthorized';
	return (
		<Form onSubmit={submit} busy={busy} aria-label="Two-factor verification">
			<p className="text-sm text-muted">
				{useRecovery
					? 'Enter one of your recovery codes. Each code works once.'
					: 'Open your authenticator app and enter the current code.'}
			</p>
			<Input
				label={useRecovery ? 'Recovery code' : 'Authentication code'}
				value={code}
				onChange={(e) => setCode(e.currentTarget.value)}
				autoComplete="one-time-code"
				inputMode={useRecovery ? 'text' : 'numeric'}
				maxLength={useRecovery ? 11 : 6}
				error={error ?? fieldErrors(problem).code ?? fieldErrors(problem).recoveryCode}
				autoFocus
				required
			/>
			<FormError problem={problem} fields={['code', 'recoveryCode']} />
			{expired ? (
				<Button variant="secondary" block onClick={onRestart}>
					Sign in again
				</Button>
			) : (
				<Button type="submit" block loading={busy}>
					Verify
				</Button>
			)}
			<button
				type="button"
				className="w-full text-center text-sm font-semibold text-primary hover:underline"
				onClick={() => {
					setUseRecovery((v) => !v);
					setCode('');
					setError(null);
				}}>
				{useRecovery ? 'Use the authenticator app instead' : 'Use a recovery code instead'}
			</button>
		</Form>
	);
}

/**
 * Mandatory enrolment of an authenticator (first staff sign-in or after a reset).
 * @param {{ onDone: () => void, onRestart: () => void }} props
 */
export function StaffMfaEnrol({ onDone, onRestart }) {
	const [secret, setSecret] = useState(/** @type {null | { secret: string, uri: string }} */ (null));
	const [codes, setCodes] = useState(/** @type {string[] | null} */ (null));
	const [code, setCode] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(/** @type {string | null} */ (null));
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [saved, setSaved] = useState(false);
	const step = codes ? 'codes' : secret ? 'confirm' : 'start';
	const start = async () => {
		setBusy(true);
		setProblem(null);
		const result = await adminFetch(adminApi.mfaEnrol(), { method: 'POST', redirectOn401: false });
		setBusy(false);
		if (result.ok) setSecret(result.data);
		else setProblem(result.problem);
	};
	const confirm = async () => {
		if (!/^\d{6}$/.test(code.trim())) {
			setError('Enter the 6-digit code from your app.');
			return;
		}
		setBusy(true);
		setError(null);
		setProblem(null);
		const result = await adminFetch(adminApi.mfaConfirm(), {
			method: 'POST',
			body: { code: code.trim() },
			redirectOn401: false,
		});
		setBusy(false);
		if (result.ok) {
			setSecret(null);
			setCodes(result.data?.recoveryCodes ?? []);
		} else setProblem(result.problem);
	};
	return (
		<div className="space-y-5">
			<Stepper
				current={step}
				steps={[
					{ id: 'start', label: 'Add the key' },
					{ id: 'confirm', label: 'Confirm a code' },
					{ id: 'codes', label: 'Save recovery codes' },
				]}
			/>
			{step === 'start' ? (
				<>
					<Callout tone="info" live={false} title="Two-factor authentication is mandatory for staff">
						Set up an authenticator app (TOTP) to finish signing in.
					</Callout>
					<FormError problem={problem} />
					{problem && problemCode(problem) === 'unauthorized' ? (
						<Button variant="secondary" block onClick={onRestart}>
							Sign in again
						</Button>
					) : (
						<Button block onClick={() => void start()} loading={busy}>
							Set up the authenticator
						</Button>
					)}
				</>
			) : null}
			{step === 'confirm' && secret ? (
				<Form onSubmit={confirm} busy={busy} aria-label="Confirm the authenticator">
					<p className="text-sm text-muted">
						Open the link on the device with your authenticator app, or type the key. It is shown only now.
					</p>
					<CodeBlock label="Setup link (otpauth)" code={secret.uri} />
					<CodeBlock label="Or type this key" code={secret.secret} secret />
					<Input
						label="Code from the app"
						value={code}
						onChange={(e) => setCode(e.currentTarget.value)}
						autoComplete="one-time-code"
						inputMode="numeric"
						maxLength={6}
						error={error ?? fieldErrors(problem).code}
						required
					/>
					<FormError problem={problem} fields={['code']} />
					<Button type="submit" block loading={busy}>
						Confirm
					</Button>
				</Form>
			) : null}
			{step === 'codes' && codes ? (
				<div className="space-y-4">
					<Callout tone="warning" live={false} title="Save your recovery codes now">
						Each code signs you in once if you lose your device. They are not shown again.
					</Callout>
					<CodeBlock code={codes.join('\n')} label="Recovery codes" secret wrap={false} />
					<label className="flex items-center gap-2 text-sm text-fg">
						<input type="checkbox" checked={saved} onChange={(e) => setSaved(e.currentTarget.checked)} />I have stored the
						recovery codes safely
					</label>
					<Button block disabled={!saved} onClick={onDone}>
						Continue to the console
					</Button>
				</div>
			) : null}
		</div>
	);
}

/**
 * @param {{ next?: string | null, expired?: boolean, reset?: boolean }} props
 */
export function StaffLoginView({ next = null, expired = false, reset = false }) {
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
	const [stage, setStage] = useState(/** @type {'password' | 'verify' | 'enrol'} */ ('password'));
	const done = () => window.location.assign(safeAdminNext(next));
	const restart = () => {
		setStage('password');
		setPassword('');
	};
	const submit = async () => {
		/** @type {Record<string, string>} */
		const local = {};
		const e1 = emailProblem(email);
		if (e1) local.email = e1;
		if (!password) local.password = 'Enter your password.';
		setErrors(local);
		if (Object.keys(local).length > 0) return;
		setBusy(true);
		setProblem(null);
		const result = await adminFetch(adminApi.login(), {
			method: 'POST',
			body: { email: email.trim(), password },
			redirectOn401: false,
		});
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			setErrors(fieldErrors(result.problem));
			return;
		}
		setPassword('');
		setStage(result.data?.status === 'mfa_enrolment_required' ? 'enrol' : 'verify');
	};
	if (stage === 'verify')
		return (
			<StaffAuthFrame title="Two-factor verification" subtitle={email}>
				<StaffMfaVerify onDone={done} onRestart={restart} />
			</StaffAuthFrame>
		);
	if (stage === 'enrol')
		return (
			<StaffAuthFrame title="Set up two-factor authentication" subtitle={email}>
				<StaffMfaEnrol onDone={done} onRestart={restart} />
			</StaffAuthFrame>
		);
	return (
		<StaffAuthFrame
			title="Staff sign in"
			subtitle="Platform operations. Two-factor authentication is required."
			footer={
				<Link href={adminRoutes.forgotPassword()} className="font-semibold text-primary hover:underline">
					Forgot your password?
				</Link>
			}>
			{expired ? (
				<Callout tone="warning" title="Your session ended">
					Sign in again to continue.
				</Callout>
			) : null}
			{reset ? <Callout tone="success">Your password is set. Sign in with it now.</Callout> : null}
			<Form onSubmit={submit} busy={busy} aria-label="Staff sign in">
				<Input
					label="E-mail"
					type="email"
					autoComplete="username"
					value={email}
					onChange={(e) => setEmail(e.currentTarget.value)}
					error={errors.email}
					autoFocus
					required
				/>
				<Input
					label="Password"
					type="password"
					autoComplete="current-password"
					value={password}
					onChange={(e) => setPassword(e.currentTarget.value)}
					error={errors.password}
					required
				/>
				<FormError problem={problem} fields={['email', 'password']} />
				<Button type="submit" block loading={busy}>
					Continue
				</Button>
			</Form>
		</StaffAuthFrame>
	);
}

export function StaffForgotPasswordView() {
	const [email, setEmail] = useState('');
	const [busy, setBusy] = useState(false);
	const [sent, setSent] = useState(false);
	const [error, setError] = useState(/** @type {string | null} */ (null));
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const submit = async () => {
		const e1 = emailProblem(email);
		setError(e1);
		if (e1) return;
		setBusy(true);
		setProblem(null);
		const result = await adminFetch(adminApi.passwordReset(), {
			method: 'POST',
			body: { email: email.trim() },
			redirectOn401: false,
		});
		setBusy(false);
		if (result.ok) setSent(true);
		else setProblem(result.problem);
	};
	return (
		<StaffAuthFrame
			title="Reset your staff password"
			subtitle="We e-mail a link if the address belongs to an active staff account."
			footer={
				<Link href={adminRoutes.login()} className="font-semibold text-primary hover:underline">
					Back to sign in
				</Link>
			}>
			{sent ? (
				<Callout tone="success" title="Check your inbox">
					If {email.trim()} is a staff account, a reset link is on its way. It expires soon.
				</Callout>
			) : (
				<Form onSubmit={submit} busy={busy} aria-label="Request a password reset">
					<Input
						label="E-mail"
						type="email"
						autoComplete="username"
						value={email}
						onChange={(e) => setEmail(e.currentTarget.value)}
						error={error}
						required
					/>
					<FormError problem={problem} fields={['email']} />
					<Button type="submit" block loading={busy}>
						Send the link
					</Button>
				</Form>
			)}
		</StaffAuthFrame>
	);
}

/** Setup / reset link of a staff account (`/staff/reset-password#token=…`). */
export function StaffResetPasswordView() {
	const [token, setToken] = useState(/** @type {string | null | undefined} */ (undefined));
	const [password, setPassword] = useState('');
	const [confirm, setConfirm] = useState('');
	const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	useEffect(() => {
		setToken(takeFragmentToken());
	}, []);
	const submit = async () => {
		/** @type {Record<string, string>} */
		const local = {};
		if (password.length < STAFF_PASSWORD_MIN) local.password = `Use at least ${STAFF_PASSWORD_MIN} characters.`;
		if (confirm !== password) local.confirm = 'The passwords do not match.';
		setErrors(local);
		if (Object.keys(local).length > 0 || !token) return;
		setBusy(true);
		setProblem(null);
		const result = await adminFetch(adminApi.passwordResetConfirm(), {
			method: 'POST',
			body: { token, password },
			redirectOn401: false,
		});
		setBusy(false);
		if (result.ok) window.location.assign(`${adminRoutes.login()}?reset=1`);
		else {
			setProblem(result.problem);
			setErrors(fieldErrors(result.problem));
		}
	};
	return (
		<StaffAuthFrame
			title="Set your staff password"
			subtitle="Then sign in and set up two-factor authentication. Other sessions are signed out.">
			{token === undefined ? <Spinner label="Reading your link…" /> : null}
			{token === null ? (
				<Callout tone="warning" title="This link is incomplete">
					Open the link from the e-mail exactly as it was sent, or{' '}
					<Link href={adminRoutes.forgotPassword()} className="font-semibold underline">
						request a new one
					</Link>
					.
				</Callout>
			) : null}
			{token ? (
				<Form onSubmit={submit} busy={busy} aria-label="Set a password">
					<Input
						label="New password"
						type="password"
						autoComplete="new-password"
						value={password}
						onChange={(e) => setPassword(e.currentTarget.value)}
						help={`At least ${STAFF_PASSWORD_MIN} characters.`}
						error={errors.password}
						required
					/>
					<Input
						label="Repeat the password"
						type="password"
						autoComplete="new-password"
						value={confirm}
						onChange={(e) => setConfirm(e.currentTarget.value)}
						error={errors.confirm}
						required
					/>
					<FormError problem={problem} fields={['password', 'token']} />
					<Button type="submit" block loading={busy}>
						Save password
					</Button>
				</Form>
			) : null}
		</StaffAuthFrame>
	);
}
