'use client';
/**
 * The public account pages (PLAN 0.8.2 Sign-in): the one sign-in page for admins and merchants (with the two-step
 * step, Create admin while no admin exists and the suspended message), Forgot password, the reset link, the setup
 * link (merchant setup and admin invite) and the new-e-mail confirmation. Tokens from links arrive in the URL fragment
 * and are posted to the API, never logged. After signing in, the Portal opens the console of the login.
 * @module
 */
import { useEffect, useRef, useState } from 'react';
import { Button, Callout, Form, FormError, Input, Spinner, describeProblem, fieldErrors, problemCode } from '@ss/ui';
import { AUTH } from '../../texts/console.js';
import { apiFetch, takeFragmentToken } from '../client.js';
import { Link } from '../link.js';
import { BrandMark } from './brand.js';

/** @typedef {import('@ss/ui').Problem} Problem */
/** @typedef {{ name: string, accent: string, logoUrl: string | null, support: { email: string | null, phone: string | null, whatsapp: string | null } }} Branding */

export const PASSWORD_MIN = 12;

/**
 * Where to go after signing in: a same-site relative `next` of that console (no open redirects), else its home.
 * @param {'admin' | 'merchant'} console
 * @param {string | null | undefined} next
 */
export const homeOf = (console, next) => {
	const home = console === 'admin' ? '/admin' : '/websites';
	if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return home;
	const isAdminPath = next === '/admin' || next.startsWith('/admin/');
	return isAdminPath === (console === 'admin') ? next : home;
};

/**
 * The support contact as one line (`e-mail, phone`), or the fallback word.
 * @param {Branding['support'] | null | undefined} support
 */
export const contactLine = (support) =>
	[support?.email, support?.phone, support?.whatsapp ? `WhatsApp ${support.whatsapp}` : null].filter(Boolean).join(', ') ||
	AUTH.supportFallback;

/** @param {string} password */
const passwordProblem = (password) =>
	password.length < PASSWORD_MIN
		? AUTH.passwordShort(PASSWORD_MIN)
		: password.trim() === ''
			? AUTH.passwordShort(PASSWORD_MIN)
			: null;

/** @param {string} email */
const emailProblem = (email) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? null : AUTH.emailInvalid);

/**
 * Centred card of the public pages, with the Branding.
 * @param {{ branding: Branding, title: string, subtitle?: import('react').ReactNode, children: import('react').ReactNode,
 *   footer?: import('react').ReactNode }} props
 */
export function AuthFrame({ branding, title, subtitle, children, footer }) {
	return (
		<main className="flex min-h-screen items-center justify-center bg-canvas px-4 py-10">
			<div className="w-full max-w-md space-y-6">
				<BrandMark branding={branding} />
				<section
					aria-labelledby="auth-title"
					className="space-y-5 rounded-card border border-line bg-surface p-5 shadow-card sm:p-8">
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

/**
 * The second step: a two-step code or a recovery code.
 * @param {{ challenge: string, onDone: (console: 'admin' | 'merchant') => void, onRestart: () => void,
 *   onProblem: (problem: Problem) => void }} props
 */
export function TwoStepStep({ challenge, onDone, onRestart, onProblem }) {
	const [useRecovery, setUseRecovery] = useState(false);
	const [code, setCode] = useState('');
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [error, setError] = useState(/** @type {string | null} */ (null));
	const submit = async () => {
		const value = code.trim();
		if (useRecovery ? !/^[a-z2-7]{5}-?[a-z2-7]{5}$/i.test(value) : !/^\d{6}$/.test(value)) {
			setError(useRecovery ? AUTH.recoveryInvalid : AUTH.codeInvalid);
			return;
		}
		setBusy(true);
		setError(null);
		const result = await apiFetch('/v1/auth/sign-in/two-step', {
			method: 'POST',
			body: { challenge, ...(useRecovery ? { recoveryCode: value } : { code: value }) },
			redirectOn401: false,
		});
		setBusy(false);
		if (result.ok) onDone(result.data?.console === 'admin' ? 'admin' : 'merchant');
		else if (problemCode(result.problem) === 'merchant_suspended') onProblem(result.problem);
		else setProblem(result.problem);
	};
	const expired = problemCode(problem) === 'token_invalid';
	return (
		<Form onSubmit={submit} busy={busy} aria-label={AUTH.twoStepTitle}>
			<p className="text-sm text-muted">{useRecovery ? AUTH.recoveryHelp : AUTH.twoStepHelp}</p>
			<Input
				label={useRecovery ? AUTH.recoveryCode : AUTH.code}
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
					{AUTH.again}
				</Button>
			) : (
				<Button type="submit" block loading={busy}>
					{AUTH.verify}
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
				{useRecovery ? AUTH.useApp : AUTH.useRecovery}
			</button>
		</Form>
	);
}

/**
 * Create admin (only while no admin exists): name, e-mail and password; the first admin is an Owner.
 * @param {{ branding: Branding }} props
 */
function CreateAdmin({ branding }) {
	const [name, setName] = useState('');
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
	const submit = async () => {
		/** @type {Record<string, string>} */
		const local = {};
		if (!name.trim()) local.name = AUTH.nameMissing;
		const e1 = emailProblem(email);
		if (e1) local.email = e1;
		const p1 = passwordProblem(password);
		if (p1) local.password = p1;
		setErrors(local);
		if (Object.keys(local).length > 0) return;
		setBusy(true);
		setProblem(null);
		const result = await apiFetch('/v1/auth/first-admin', {
			method: 'POST',
			body: { name: name.trim(), email: email.trim(), password },
			redirectOn401: false,
		});
		setBusy(false);
		if (result.ok) window.location.assign('/admin');
		else {
			setProblem(result.problem);
			setErrors(fieldErrors(result.problem));
		}
	};
	return (
		<AuthFrame branding={branding} title={AUTH.createAdminTitle} subtitle={AUTH.createAdminHelp}>
			<Form onSubmit={submit} busy={busy} aria-label={AUTH.createAdminTitle}>
				<Input label={AUTH.name} value={name} onChange={(e) => setName(e.currentTarget.value)} error={errors.name} required />
				<Input
					label={AUTH.email}
					type="email"
					autoComplete="email"
					value={email}
					onChange={(e) => setEmail(e.currentTarget.value)}
					error={errors.email}
					required
				/>
				<Input
					label={AUTH.password}
					type="password"
					autoComplete="new-password"
					value={password}
					onChange={(e) => setPassword(e.currentTarget.value)}
					error={errors.password}
					help={AUTH.passwordShort(PASSWORD_MIN)}
					required
				/>
				<FormError problem={problem} fields={['name', 'email', 'password']} />
				<Button type="submit" block loading={busy}>
					{AUTH.createAdmin}
				</Button>
			</Form>
		</AuthFrame>
	);
}

/**
 * The one sign-in page.
 * @param {{ branding: Branding, firstAdmin: boolean, next?: string | null, notice?: 'expired' | 'reset' | 'email' | null }} props
 */
export function SignInView({ branding, firstAdmin, next = null, notice = null }) {
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
	const [challenge, setChallenge] = useState(/** @type {string | null} */ (null));
	if (firstAdmin) return <CreateAdmin branding={branding} />;
	const done = (/** @type {'admin' | 'merchant'} */ console) => window.location.assign(homeOf(console, next));
	const suspended = problemCode(problem) === 'merchant_suspended';
	const submit = async () => {
		/** @type {Record<string, string>} */
		const local = {};
		const e1 = emailProblem(email);
		if (e1) local.email = e1;
		if (!password) local.password = AUTH.passwordMissing;
		setErrors(local);
		if (Object.keys(local).length > 0) return;
		setBusy(true);
		setProblem(null);
		const result = await apiFetch('/v1/auth/sign-in', {
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
		if (result.data?.status === 'two_step_required') setChallenge(result.data.challenge);
		else done(result.data?.console === 'admin' ? 'admin' : 'merchant');
	};
	if (challenge && !suspended)
		return (
			<AuthFrame branding={branding} title={AUTH.twoStepTitle} subtitle={email}>
				<TwoStepStep
					challenge={challenge}
					onDone={done}
					onProblem={(p) => {
						setChallenge(null);
						setProblem(p);
					}}
					onRestart={() => {
						setChallenge(null);
						setPassword('');
					}}
				/>
			</AuthFrame>
		);
	return (
		<AuthFrame branding={branding} title={AUTH.signInTitle} subtitle={AUTH.signInSubtitle}>
			{notice === 'expired' ? <Callout tone="info">{AUTH.expired}</Callout> : null}
			{notice === 'reset' ? <Callout tone="success">{AUTH.resetDone}</Callout> : null}
			{notice === 'email' ? <Callout tone="success">{AUTH.emailConfirmed}</Callout> : null}
			{suspended ? <Callout tone="danger">{AUTH.suspended(contactLine(branding.support))}</Callout> : null}
			<Form onSubmit={submit} busy={busy} aria-label={AUTH.signInTitle}>
				<Input
					label={AUTH.email}
					type="email"
					name="email"
					autoComplete="username"
					value={email}
					onChange={(e) => setEmail(e.currentTarget.value)}
					error={errors.email}
					required
					autoFocus
				/>
				<Input
					label={AUTH.password}
					type="password"
					name="password"
					autoComplete="current-password"
					value={password}
					onChange={(e) => setPassword(e.currentTarget.value)}
					error={errors.password}
					required
				/>
				{suspended ? null : <FormError problem={problem} fields={['email', 'password']} />}
				<Button type="submit" block loading={busy}>
					{AUTH.signIn}
				</Button>
				<p className="text-center text-sm">
					<Link href="/forgot-password" className="font-semibold text-primary hover:underline">
						{AUTH.forgot}
					</Link>
				</p>
			</Form>
		</AuthFrame>
	);
}

/** @param {{ branding: Branding }} props */
export function ForgotPasswordView({ branding }) {
	const [email, setEmail] = useState('');
	const [busy, setBusy] = useState(false);
	const [sent, setSent] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [error, setError] = useState(/** @type {string | null} */ (null));
	const submit = async () => {
		const e1 = emailProblem(email);
		setError(e1);
		if (e1) return;
		setBusy(true);
		setProblem(null);
		const result = await apiFetch('/v1/auth/forgot-password', {
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
			branding={branding}
			title={AUTH.forgotTitle}
			subtitle={AUTH.forgotHelp}
			footer={
				<Link href="/login" className="font-semibold text-primary hover:underline">
					{AUTH.backToSignIn}
				</Link>
			}>
			{sent ? (
				<Callout tone="success">{AUTH.forgotSent}</Callout>
			) : (
				<Form onSubmit={submit} busy={busy} aria-label={AUTH.forgotTitle}>
					<Input
						label={AUTH.email}
						type="email"
						autoComplete="email"
						value={email}
						onChange={(e) => setEmail(e.currentTarget.value)}
						error={error ?? fieldErrors(problem).email}
						required
					/>
					<FormError problem={problem} fields={['email']} />
					<Button type="submit" block loading={busy}>
						{AUTH.forgotSend}
					</Button>
				</Form>
			)}
		</AuthFrame>
	);
}

/**
 * The token of a link (read once from the fragment).
 * @returns {{ token: string | null, ready: boolean }}
 */
const useLinkToken = () => {
	const [state, setState] = useState(/** @type {{ token: string | null, ready: boolean }} */ ({ token: null, ready: false }));
	const read = useRef(false);
	useEffect(() => {
		if (read.current) return;
		read.current = true;
		setState({ token: takeFragmentToken(), ready: true });
	}, []);
	return state;
};

/** @param {{ branding: Branding }} props */
export function ResetPasswordView({ branding }) {
	const { token, ready } = useLinkToken();
	const [password, setPassword] = useState('');
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [error, setError] = useState(/** @type {string | null} */ (null));
	const submit = async () => {
		const p1 = passwordProblem(password);
		setError(p1);
		if (p1 || !token) return;
		setBusy(true);
		setProblem(null);
		const result = await apiFetch('/v1/auth/reset-password', {
			method: 'POST',
			body: { token, password },
			redirectOn401: false,
		});
		setBusy(false);
		if (result.ok) window.location.assign('/login?notice=reset');
		else setProblem(result.problem);
	};
	return (
		<AuthFrame branding={branding} title={AUTH.resetTitle}>
			{!ready ? (
				<Spinner />
			) : !token ? (
				<Callout tone="danger">{AUTH.linkMissing}</Callout>
			) : (
				<Form onSubmit={submit} busy={busy} aria-label={AUTH.resetTitle}>
					<Input
						label={AUTH.newPassword}
						type="password"
						autoComplete="new-password"
						value={password}
						onChange={(e) => setPassword(e.currentTarget.value)}
						error={error ?? fieldErrors(problem).password}
						help={AUTH.passwordShort(PASSWORD_MIN)}
						required
					/>
					<FormError problem={problem} fields={['password']} />
					<Button type="submit" block loading={busy}>
						{AUTH.resetSave}
					</Button>
				</Form>
			)}
		</AuthFrame>
	);
}

/**
 * The setup link: a merchant chooses a password; an invited admin also enters a name. Then they are signed in.
 * @param {{ branding: Branding }} props
 */
export function SetPasswordView({ branding }) {
	const { token, ready } = useLinkToken();
	const [info, setInfo] = useState(
		/** @type {null | { console: 'admin' | 'merchant', email: string, needsName: boolean }} */ (null),
	);
	const [name, setName] = useState('');
	const [password, setPassword] = useState('');
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
	useEffect(() => {
		if (!token) return;
		void apiFetch('/v1/auth/set-password/check', { method: 'POST', body: { token }, redirectOn401: false }).then((result) => {
			if (result.ok) setInfo(result.data);
			else setProblem(result.problem);
		});
	}, [token]);
	const submit = async () => {
		/** @type {Record<string, string>} */
		const local = {};
		if (info?.needsName && !name.trim()) local.name = AUTH.nameMissing;
		const p1 = passwordProblem(password);
		if (p1) local.password = p1;
		setErrors(local);
		if (Object.keys(local).length > 0 || !token) return;
		setBusy(true);
		setProblem(null);
		const result = await apiFetch('/v1/auth/set-password', {
			method: 'POST',
			body: { token, password, ...(info?.needsName ? { name: name.trim() } : {}) },
			redirectOn401: false,
		});
		setBusy(false);
		if (result.ok) window.location.assign(homeOf(result.data?.console === 'admin' ? 'admin' : 'merchant', null));
		else {
			setProblem(result.problem);
			setErrors(fieldErrors(result.problem));
		}
	};
	return (
		<AuthFrame
			branding={branding}
			title={AUTH.setTitle}
			subtitle={info ? (info.needsName ? AUTH.setHelpAdmin : AUTH.setHelpMerchant) : undefined}>
			{!ready ? (
				<Spinner />
			) : !token ? (
				<Callout tone="danger">{AUTH.linkMissing}</Callout>
			) : !info ? (
				problem ? (
					<Callout tone="danger">{describeProblem(problem)}</Callout>
				) : (
					<Spinner />
				)
			) : (
				<Form onSubmit={submit} busy={busy} aria-label={AUTH.setTitle}>
					<Input label={AUTH.email} value={info.email} readOnly />
					{info.needsName ? (
						<Input
							label={AUTH.name}
							value={name}
							onChange={(e) => setName(e.currentTarget.value)}
							error={errors.name}
							required
						/>
					) : null}
					<Input
						label={AUTH.password}
						type="password"
						autoComplete="new-password"
						value={password}
						onChange={(e) => setPassword(e.currentTarget.value)}
						error={errors.password}
						help={AUTH.passwordShort(PASSWORD_MIN)}
						required
					/>
					<FormError problem={problem} fields={['name', 'password']} />
					<Button type="submit" block loading={busy}>
						{AUTH.setSave}
					</Button>
				</Form>
			)}
		</AuthFrame>
	);
}

/** @param {{ branding: Branding }} props */
export function ConfirmEmailView({ branding }) {
	const { token, ready } = useLinkToken();
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	useEffect(() => {
		if (!token) return;
		void apiFetch('/v1/auth/confirm-email', { method: 'POST', body: { token }, redirectOn401: false }).then((result) => {
			if (result.ok) window.location.assign('/login?notice=email');
			else setProblem(result.problem);
		});
	}, [token]);
	return (
		<AuthFrame
			branding={branding}
			title={AUTH.confirmTitle}
			footer={
				<Link href="/login" className="font-semibold text-primary hover:underline">
					{AUTH.backToSignIn}
				</Link>
			}>
			{!ready ? (
				<Spinner />
			) : !token ? (
				<Callout tone="danger">{AUTH.linkMissing}</Callout>
			) : problem ? (
				<Callout tone="danger">{describeProblem(problem)}</Callout>
			) : (
				<p className="flex items-center gap-2 text-sm text-muted">
					<Spinner /> {AUTH.confirming}
				</p>
			)}
		</AuthFrame>
	);
}
