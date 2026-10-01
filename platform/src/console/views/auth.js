'use client';
/**
 * Public account pages: sign in (with the MFA challenge), sign up, e-mail verification, password reset and invite
 * acceptance. Tokens from e-mail links arrive in the URL fragment and are posted to the API, never logged.
 * @module
 */
import { useEffect, useRef, useState } from 'react';
import { Button, Callout, Form, FormError, Icon, Input, Spinner, describeProblem, fieldErrors } from '@ss/ui';
import { apiFetch, takeFragmentToken } from '../client.js';
import { Link } from '../link.js';
import { routes } from '../paths.js';

/** @typedef {import('@ss/ui').Problem} Problem */

export const PASSWORD_MIN = 12;

/**
 * Only same-site relative paths are followed after sign-in (no open redirects).
 * @param {string | null | undefined} next
 */
export const safeNext = (next) =>
	typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\')
		? next
		: routes.websites();

/**
 * Centred card of the auth pages.
 * @param {{ title: string, subtitle?: import('react').ReactNode, children: import('react').ReactNode,
 *   footer?: import('react').ReactNode }} props
 */
export function AuthFrame({ title, subtitle, children, footer }) {
	return (
		<main className="flex min-h-screen items-center justify-center bg-canvas px-4 py-10">
			<div className="w-full max-w-md space-y-6">
				<div className="flex items-center gap-3">
					<span className="flex size-10 items-center justify-center rounded-xl bg-primary text-on-primary shadow-card">
						<Icon name="zap" size={18} />
					</span>
					<div>
						<p className="text-sm font-extrabold tracking-tight text-fg">Single Solution</p>
						<p className="text-[11px] font-bold uppercase tracking-wider text-muted">Merchant console</p>
					</div>
				</div>
				<section
					aria-labelledby="auth-title"
					className="space-y-5 rounded-card border border-line bg-surface p-6 shadow-card sm:p-8">
					<div className="space-y-1">
						<h1 id="auth-title" className="text-xl font-bold tracking-tight text-fg">
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

/** @param {string} password */
const passwordProblem = (password) =>
	password.length < PASSWORD_MIN
		? `Use at least ${PASSWORD_MIN} characters.`
		: password.trim() === ''
			? 'Must not be blank.'
			: null;

/** @param {string} email */
const emailProblem = (email) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? null : 'Enter your e-mail address.');

/**
 * Second factor step (TOTP code or a recovery code).
 * @param {{ challenge: string, onDone: () => void, onRestart: () => void }} props
 */
export function MfaStep({ challenge, onDone, onRestart }) {
	const [useRecovery, setUseRecovery] = useState(false);
	const [code, setCode] = useState('');
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [error, setError] = useState(/** @type {string | null} */ (null));
	const submit = async () => {
		const value = code.trim();
		if (useRecovery ? !/^[a-z2-7]{5}-?[a-z2-7]{5}$/i.test(value) : !/^\d{6}$/.test(value)) {
			setError(useRecovery ? 'Enter a recovery code like abcde-fghij.' : 'Enter the 6-digit code from your app.');
			return;
		}
		setBusy(true);
		setError(null);
		const result = await apiFetch('/v1/auth/merchant/login/mfa', {
			method: 'POST',
			body: { challenge, ...(useRecovery ? { recoveryCode: value } : { code: value }) },
			redirectOn401: false,
		});
		setBusy(false);
		if (result.ok) onDone();
		else setProblem(result.problem);
	};
	const expired = problem && /expired/i.test(problem.detail ?? '');
	return (
		<Form onSubmit={submit} busy={busy} aria-label="Two-factor verification">
			<p className="text-sm text-muted">
				{useRecovery
					? 'Enter one of your recovery codes. Each code works once.'
					: 'Open your authenticator app and enter the current code.'}
			</p>
			<Input
				label={useRecovery ? 'Recovery code' : 'Authentication code'}
				name="code"
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
 * @param {{ next?: string | null, expired?: boolean, reset?: boolean }} props
 */
export function LoginView({ next = null, expired = false, reset = false }) {
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
	const [challenge, setChallenge] = useState(/** @type {string | null} */ (null));
	const done = () => window.location.assign(safeNext(next));
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
		const result = await apiFetch('/v1/auth/merchant/login', {
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
		if (result.data?.status === 'mfa_required') setChallenge(result.data.challenge);
		else done();
	};
	if (challenge)
		return (
			<AuthFrame title="Two-factor verification" subtitle={email}>
				<MfaStep
					challenge={challenge}
					onDone={done}
					onRestart={() => {
						setChallenge(null);
						setPassword('');
					}}
				/>
			</AuthFrame>
		);
	return (
		<AuthFrame
			title="Sign in"
			subtitle="Manage your websites, elements and credits."
			footer={
				<>
					New here?{' '}
					<Link href={routes.signup()} className="font-semibold text-primary hover:underline">
						Create an account
					</Link>
				</>
			}>
			{expired ? <Callout tone="info">Your session ended. Sign in again to continue.</Callout> : null}
			{reset ? <Callout tone="success">Your password was changed. Sign in with the new password.</Callout> : null}
			<Form onSubmit={submit} busy={busy} aria-label="Sign in">
				<Input
					label="E-mail"
					type="email"
					name="email"
					autoComplete="email"
					value={email}
					onChange={(e) => setEmail(e.currentTarget.value)}
					error={errors.email}
					required
				/>
				<Input
					label="Password"
					type="password"
					name="password"
					autoComplete="current-password"
					value={password}
					onChange={(e) => setPassword(e.currentTarget.value)}
					error={errors.password}
					aside={
						<Link
							href={routes.forgotPassword()}
							className="font-semibold normal-case tracking-normal text-primary hover:underline">
							Forgot password?
						</Link>
					}
					required
				/>
				<FormError problem={problem} fields={['email', 'password']} />
				<Button type="submit" block loading={busy}>
					Sign in
				</Button>
			</Form>
		</AuthFrame>
	);
}

export function SignupView() {
	const [values, setValues] = useState({ merchantName: '', name: '', email: '', password: '' });
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
	const [sent, setSent] = useState(false);
	/** @param {keyof typeof values} key */
	const bind = (key) => ({
		value: values[key],
		onChange: (/** @type {import('react').ChangeEvent<HTMLInputElement>} */ e) => {
			const value = e.currentTarget.value;
			setValues((v) => ({ ...v, [key]: value }));
		},
		error: errors[key],
	});
	const submit = async () => {
		/** @type {Record<string, string>} */
		const local = {};
		if (!values.merchantName.trim()) local.merchantName = 'Enter the name of your business.';
		const e1 = emailProblem(values.email);
		if (e1) local.email = e1;
		const p1 = passwordProblem(values.password);
		if (p1) local.password = p1;
		setErrors(local);
		if (Object.keys(local).length > 0) return;
		setBusy(true);
		setProblem(null);
		const result = await apiFetch('/v1/auth/merchant/signup', {
			method: 'POST',
			body: {
				merchantName: values.merchantName.trim(),
				email: values.email.trim(),
				password: values.password,
				...(values.name.trim() ? { name: values.name.trim() } : {}),
			},
			redirectOn401: false,
		});
		setBusy(false);
		if (result.ok) setSent(true);
		else {
			setProblem(result.problem);
			setErrors(fieldErrors(result.problem));
		}
	};
	if (sent)
		return (
			<AuthFrame title="Check your inbox" subtitle={values.email}>
				<Callout tone="success" title="Verification link sent">
					Open the link we sent to {values.email.trim()} to activate your account. It expires soon and works once.
				</Callout>
				<p className="text-sm text-muted">
					Wrong address?{' '}
					<button type="button" className="font-semibold text-primary hover:underline" onClick={() => setSent(false)}>
						Change it
					</button>
				</p>
			</AuthFrame>
		);
	return (
		<AuthFrame
			title="Create your account"
			subtitle="Add your website and switch on elements in minutes."
			footer={
				<>
					Already have an account?{' '}
					<Link href={routes.login()} className="font-semibold text-primary hover:underline">
						Sign in
					</Link>
				</>
			}>
			<Form onSubmit={submit} busy={busy} aria-label="Create account">
				<Input label="Business name" name="merchantName" autoComplete="organization" required {...bind('merchantName')} />
				<Input label="Your name" name="name" autoComplete="name" {...bind('name')} />
				<Input label="E-mail" type="email" name="email" autoComplete="email" required {...bind('email')} />
				<Input
					label="Password"
					type="password"
					name="password"
					autoComplete="new-password"
					help={`At least ${PASSWORD_MIN} characters. A passphrase works well.`}
					required
					{...bind('password')}
				/>
				<FormError problem={problem} fields={['merchantName', 'name', 'email', 'password']} />
				<Button type="submit" block loading={busy}>
					Create account
				</Button>
			</Form>
		</AuthFrame>
	);
}

/**
 * Runs once on mount with the fragment token (guarded against double effects in development).
 * @param {(token: string | null) => void | Promise<void>} run
 */
const useFragmentToken = (run) => {
	const started = useRef(false);
	const fn = useRef(run);
	fn.current = run;
	useEffect(() => {
		if (started.current) return;
		started.current = true;
		void fn.current(takeFragmentToken());
	}, []);
};

export function VerifyEmailView() {
	const [state, setState] = useState(/** @type {'verifying' | 'missing' | 'failed' | 'done'} */ ('verifying'));
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	useFragmentToken(async (token) => {
		if (!token) {
			setState('missing');
			return;
		}
		const result = await apiFetch('/v1/auth/merchant/verify-email', { method: 'POST', body: { token }, redirectOn401: false });
		if (result.ok) {
			setState('done');
			window.location.assign(routes.onboarding());
		} else {
			setProblem(result.problem);
			setState('failed');
		}
	});
	return (
		<AuthFrame title="Verify your e-mail">
			{state === 'verifying' || state === 'done' ? (
				<Spinner label={state === 'done' ? 'Verified — opening your console…' : 'Verifying your e-mail…'} />
			) : null}
			{state === 'missing' ? (
				<Callout tone="warning" title="This link is incomplete">
					Open the verification link from the e-mail exactly as it was sent, or sign up again.
				</Callout>
			) : null}
			{state === 'failed' ? (
				<Callout tone="danger" title="We could not verify your e-mail">
					{describeProblem(problem)}
				</Callout>
			) : null}
			{state === 'missing' || state === 'failed' ? (
				<div className="flex flex-wrap gap-3 text-sm">
					<Link href={routes.signup()} className="font-semibold text-primary hover:underline">
						Sign up again
					</Link>
					<Link href={routes.login()} className="font-semibold text-primary hover:underline">
						Sign in
					</Link>
				</div>
			) : null}
		</AuthFrame>
	);
}

export function ForgotPasswordView() {
	const [email, setEmail] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(/** @type {string | null} */ (null));
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [sent, setSent] = useState(false);
	const submit = async () => {
		const e1 = emailProblem(email);
		setError(e1);
		if (e1) return;
		setBusy(true);
		setProblem(null);
		const result = await apiFetch('/v1/auth/merchant/password-reset', {
			method: 'POST',
			body: { email: email.trim() },
			redirectOn401: false,
		});
		setBusy(false);
		if (result.ok) setSent(true);
		else setProblem(result.problem);
	};
	return (
		<AuthFrame
			title="Reset your password"
			subtitle="We e-mail you a link to choose a new password."
			footer={
				<Link href={routes.login()} className="font-semibold text-primary hover:underline">
					Back to sign in
				</Link>
			}>
			{sent ? (
				<Callout tone="success" title="Check your inbox">
					If an account exists for {email.trim()}, a reset link is on its way. It expires soon and works once.
				</Callout>
			) : (
				<Form onSubmit={submit} busy={busy} aria-label="Request a password reset">
					<Input
						label="E-mail"
						type="email"
						autoComplete="email"
						value={email}
						onChange={(e) => setEmail(e.currentTarget.value)}
						error={error ?? fieldErrors(problem).email}
						required
					/>
					<FormError problem={problem} fields={['email']} />
					<Button type="submit" block loading={busy}>
						Send reset link
					</Button>
				</Form>
			)}
		</AuthFrame>
	);
}

export function ResetPasswordView() {
	const [token, setToken] = useState(/** @type {string | null | undefined} */ (undefined));
	const [password, setPassword] = useState('');
	const [confirm, setConfirm] = useState('');
	const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	useFragmentToken((t) => setToken(t));
	const submit = async () => {
		/** @type {Record<string, string>} */
		const local = {};
		const p1 = passwordProblem(password);
		if (p1) local.password = p1;
		if (confirm !== password) local.confirm = 'The passwords do not match.';
		setErrors(local);
		if (Object.keys(local).length > 0 || !token) return;
		setBusy(true);
		setProblem(null);
		const result = await apiFetch('/v1/auth/merchant/password-reset/confirm', {
			method: 'POST',
			body: { token, password },
			redirectOn401: false,
		});
		setBusy(false);
		if (result.ok) window.location.assign('/login?reset=1');
		else {
			setProblem(result.problem);
			setErrors(fieldErrors(result.problem));
		}
	};
	return (
		<AuthFrame title="Choose a new password" subtitle="Every other session is signed out when you save.">
			{token === undefined ? <Spinner label="Reading your link…" /> : null}
			{token === null ? (
				<Callout tone="warning" title="This link is incomplete">
					Open the reset link from the e-mail exactly as it was sent, or{' '}
					<Link href={routes.forgotPassword()} className="font-semibold underline">
						request a new one
					</Link>
					.
				</Callout>
			) : null}
			{token ? (
				<Form onSubmit={submit} busy={busy} aria-label="Set a new password">
					<Input
						label="New password"
						type="password"
						autoComplete="new-password"
						value={password}
						onChange={(e) => setPassword(e.currentTarget.value)}
						help={`At least ${PASSWORD_MIN} characters.`}
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
		</AuthFrame>
	);
}

export function AcceptInviteView() {
	const [token, setToken] = useState(/** @type {string | null | undefined} */ (undefined));
	const [name, setName] = useState('');
	const [password, setPassword] = useState('');
	const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [challenge, setChallenge] = useState(/** @type {string | null} */ (null));
	useFragmentToken((t) => setToken(t));
	const done = () => window.location.assign(routes.websites());
	const submit = async () => {
		if (!password) {
			setErrors({ password: 'Enter a password (your existing one if you already have an account).' });
			return;
		}
		setErrors({});
		setBusy(true);
		setProblem(null);
		const result = await apiFetch('/v1/auth/invites/accept', {
			method: 'POST',
			body: { token, password, ...(name.trim() ? { name: name.trim() } : {}) },
			redirectOn401: false,
		});
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			setErrors(fieldErrors(result.problem));
			return;
		}
		if (result.data?.status === 'mfa_required') setChallenge(result.data.challenge);
		else done();
	};
	if (challenge)
		return (
			<AuthFrame title="Two-factor verification">
				<MfaStep challenge={challenge} onDone={done} onRestart={() => window.location.assign(routes.login())} />
			</AuthFrame>
		);
	return (
		<AuthFrame title="Join your team" subtitle="Accept the invitation to the organisation's console.">
			{token === undefined ? <Spinner label="Reading your invitation…" /> : null}
			{token === null ? (
				<Callout tone="warning" title="This invitation link is incomplete">
					Open the link from the invitation e-mail exactly as it was sent.
				</Callout>
			) : null}
			{token ? (
				<Form onSubmit={submit} busy={busy} aria-label="Accept invitation">
					<Input
						label="Your name"
						autoComplete="name"
						value={name}
						onChange={(e) => setName(e.currentTarget.value)}
						error={errors.name}
					/>
					<Input
						label="Password"
						type="password"
						autoComplete="new-password"
						value={password}
						onChange={(e) => setPassword(e.currentTarget.value)}
						help={`New to Single Solution? Choose a password of at least ${PASSWORD_MIN} characters. Otherwise use your current password.`}
						error={errors.password}
						required
					/>
					<FormError problem={problem} fields={['name', 'password', 'token']} />
					<Button type="submit" block loading={busy}>
						Accept invitation
					</Button>
				</Form>
			) : null}
		</AuthFrame>
	);
}
