'use client';
/**
 * The signed-in person's own login (PLAN 0.2 Changing a login, Two-step sign-in), shared by the merchant Account page
 * and the admin My account page: sign-in e-mail (confirmed from the new address), password, two-step (set up with a
 * QR code, 10 recovery codes shown once, turn off, new codes) and the person's own activity.
 * @module
 */
import { useState } from 'react';
import qrcode from 'qrcode-generator';
import {
	Badge,
	Button,
	Callout,
	Card,
	Checkbox,
	CodeBlock,
	Form,
	FormError,
	Input,
	Stepper,
	Table,
	describeProblem,
	fieldErrors,
	formatDateTime,
	useToast,
} from '@ss/ui';
import { LOGIN, TWO_STEP } from '../../texts/console.js';
import { apiFetch, useResource } from '../client.js';

/** @typedef {import('@ss/ui').Problem} Problem */

const PASSWORD_MIN = 12;

/**
 * A QR code as an SVG (no images, no scripts; CSP friendly).
 * @param {{ text: string, size?: number }} props
 */
export function QrCode({ text, size = 192 }) {
	const qr = qrcode(0, 'M');
	qr.addData(text);
	qr.make();
	const count = qr.getModuleCount();
	/** @type {string[]} */
	const cells = [];
	for (let row = 0; row < count; row += 1)
		for (let col = 0; col < count; col += 1) if (qr.isDark(row, col)) cells.push(`M${col + 4} ${row + 4}h1v1h-1z`);
	const box = count + 8;
	return (
		<svg
			role="img"
			aria-label="QR code"
			viewBox={`0 0 ${box} ${box}`}
			width={size}
			height={size}
			className="rounded-lg bg-white"
			shapeRendering="crispEdges">
			<rect width={box} height={box} fill="#ffffff" />
			<path d={cells.join('')} fill="#000000" />
		</svg>
	);
}

/**
 * A two-step or recovery code field value → the API members.
 * @param {string} value
 */
const factorOf = (value) => {
	const v = value.trim();
	if (!v) return {};
	return /^\d{6}$/.test(v) ? { code: v } : { recoveryCode: v };
};

/**
 * Setting two-step up: scan, confirm a code, save the 10 recovery codes.
 * @param {{ onDone: () => void }} props
 */
export function TwoStepSetup({ onDone }) {
	const [secret, setSecret] = useState(/** @type {null | { secret: string, uri: string }} */ (null));
	const [codes, setCodes] = useState(/** @type {string[] | null} */ (null));
	const [code, setCode] = useState('');
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [saved, setSaved] = useState(false);
	const step = codes ? 'codes' : secret ? 'confirm' : 'start';
	const start = async () => {
		setBusy(true);
		setProblem(null);
		const result = await apiFetch('/v1/me/two-step/start', { method: 'POST' });
		setBusy(false);
		if (result.ok) setSecret(result.data);
		else setProblem(result.problem);
	};
	const confirm = async () => {
		setBusy(true);
		setProblem(null);
		const result = await apiFetch('/v1/me/two-step/confirm', { method: 'POST', body: { code: code.trim() } });
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
					{ id: 'start', label: TWO_STEP.stepAdd },
					{ id: 'confirm', label: TWO_STEP.stepConfirm },
					{ id: 'codes', label: TWO_STEP.stepCodes },
				]}
			/>
			{step === 'start' ? (
				<div className="space-y-4">
					<p className="text-sm text-muted">{TWO_STEP.intro}</p>
					<FormError problem={problem} />
					<Button onClick={() => void start()} loading={busy}>
						{TWO_STEP.start}
					</Button>
				</div>
			) : null}
			{step === 'confirm' && secret ? (
				<Form onSubmit={confirm} busy={busy} aria-label={TWO_STEP.stepConfirm}>
					<p className="text-sm text-muted">{TWO_STEP.scan}</p>
					<div className="flex justify-center sm:justify-start">
						<QrCode text={secret.uri} />
					</div>
					<CodeBlock label={TWO_STEP.key} code={secret.secret} secret />
					<Input
						label={TWO_STEP.stepConfirm}
						value={code}
						onChange={(e) => setCode(e.currentTarget.value)}
						autoComplete="one-time-code"
						inputMode="numeric"
						maxLength={6}
						error={fieldErrors(problem).code}
						required
					/>
					<FormError problem={problem} fields={['code']} />
					<Button type="submit" loading={busy}>
						{TWO_STEP.confirm}
					</Button>
				</Form>
			) : null}
			{step === 'codes' && codes ? <RecoveryCodes codes={codes} saved={saved} setSaved={setSaved} onDone={onDone} /> : null}
		</div>
	);
}

/**
 * The recovery codes, shown once.
 * @param {{ codes: string[], saved: boolean, setSaved: (v: boolean) => void, onDone: () => void }} props
 */
function RecoveryCodes({ codes, saved, setSaved, onDone }) {
	return (
		<div className="space-y-4">
			<Callout tone="warning" live={false} title={TWO_STEP.codesTitle}>
				{TWO_STEP.codesHelp}
			</Callout>
			<CodeBlock code={codes.join('\n')} label={TWO_STEP.codesLabel} secret wrap={false} />
			<Checkbox label={TWO_STEP.codesSaved} checked={saved} onChange={(e) => setSaved(e.currentTarget.checked)} />
			<Button disabled={!saved} onClick={onDone}>
				{TWO_STEP.done}
			</Button>
		</div>
	);
}

/**
 * Password plus a two-step or recovery code (turn two-step off, new recovery codes).
 * @param {{ title: string, help: string, label: string, path: string, onDone: (data: any) => void, onCancel: () => void }} props
 */
function ProveForm({ title, help, label, path, onDone, onCancel }) {
	const [password, setPassword] = useState('');
	const [code, setCode] = useState('');
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const submit = async () => {
		setBusy(true);
		setProblem(null);
		const result = await apiFetch(path, { method: 'POST', body: { password, ...factorOf(code) } });
		setBusy(false);
		if (result.ok) onDone(result.data);
		else setProblem(result.problem);
	};
	return (
		<Form onSubmit={submit} busy={busy} aria-label={title}>
			<p className="text-sm text-muted">{help}</p>
			<Input
				label={LOGIN.currentPassword}
				type="password"
				autoComplete="current-password"
				value={password}
				onChange={(e) => setPassword(e.currentTarget.value)}
				error={fieldErrors(problem).password}
				required
			/>
			<Input
				label={LOGIN.twoStepCode}
				value={code}
				onChange={(e) => setCode(e.currentTarget.value)}
				autoComplete="one-time-code"
				error={fieldErrors(problem).code ?? fieldErrors(problem).recoveryCode}
				required
			/>
			<FormError problem={problem} fields={['password', 'code', 'recoveryCode']} />
			<div className="flex flex-wrap gap-2">
				<Button type="submit" loading={busy} variant="danger">
					{label}
				</Button>
				<Button variant="secondary" onClick={onCancel}>
					{LOGIN.cancel}
				</Button>
			</div>
		</Form>
	);
}

/**
 * Two-step on/off with recovery codes.
 * @param {{ twoStep: { enabled: boolean, recoveryCodesLeft: number }, onChange: () => void }} props
 */
export function TwoStepPanel({ twoStep, onChange }) {
	const toast = useToast();
	const [mode, setMode] = useState(/** @type {'idle' | 'setup' | 'off' | 'codes'} */ ('idle'));
	const [fresh, setFresh] = useState(/** @type {string[] | null} */ (null));
	const [saved, setSaved] = useState(false);
	return (
		<Card
			title={TWO_STEP.title}
			actions={<Badge tone={twoStep.enabled ? 'success' : 'neutral'}>{twoStep.enabled ? TWO_STEP.on : TWO_STEP.off}</Badge>}>
			{fresh ? (
				<RecoveryCodes
					codes={fresh}
					saved={saved}
					setSaved={setSaved}
					onDone={() => {
						setFresh(null);
						setSaved(false);
						onChange();
					}}
				/>
			) : mode === 'setup' ? (
				<TwoStepSetup
					onDone={() => {
						setMode('idle');
						onChange();
					}}
				/>
			) : mode === 'off' ? (
				<ProveForm
					title={TWO_STEP.turnOff}
					help={TWO_STEP.turnOffHelp}
					label={TWO_STEP.turnOff}
					path="/v1/me/two-step/off"
					onDone={() => {
						setMode('idle');
						toast.show({ tone: 'success', title: LOGIN.saved });
						onChange();
					}}
					onCancel={() => setMode('idle')}
				/>
			) : mode === 'codes' ? (
				<ProveForm
					title={TWO_STEP.newCodes}
					help={TWO_STEP.newCodesHelp}
					label={TWO_STEP.newCodes}
					path="/v1/me/two-step/recovery-codes"
					onDone={(data) => {
						setMode('idle');
						setFresh(data?.recoveryCodes ?? []);
					}}
					onCancel={() => setMode('idle')}
				/>
			) : twoStep.enabled ? (
				<div className="space-y-3">
					<p className="text-sm text-muted">{TWO_STEP.codesLeft(twoStep.recoveryCodesLeft)}</p>
					<div className="flex flex-wrap gap-2">
						<Button variant="secondary" onClick={() => setMode('codes')}>
							{TWO_STEP.newCodes}
						</Button>
						<Button variant="danger" onClick={() => setMode('off')}>
							{TWO_STEP.turnOff}
						</Button>
					</div>
				</div>
			) : (
				<div className="space-y-3">
					<p className="text-sm text-muted">{TWO_STEP.intro}</p>
					<Button onClick={() => setMode('setup')}>{TWO_STEP.start}</Button>
				</div>
			)}
		</Card>
	);
}

/**
 * Change the sign-in e-mail (current password, plus a code while two-step is on).
 * @param {{ email: string, twoStepOn: boolean }} props
 */
export function EmailPanel({ email, twoStepOn }) {
	const [next, setNext] = useState('');
	const [password, setPassword] = useState('');
	const [code, setCode] = useState('');
	const [busy, setBusy] = useState(false);
	const [sentTo, setSentTo] = useState(/** @type {string | null} */ (null));
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const submit = async () => {
		setBusy(true);
		setProblem(null);
		const result = await apiFetch('/v1/me/email', {
			method: 'POST',
			body: { email: next.trim(), password, ...factorOf(code) },
		});
		setBusy(false);
		if (result.ok) {
			setSentTo(next.trim());
			setPassword('');
			setCode('');
		} else setProblem(result.problem);
	};
	return (
		<Card title={LOGIN.loginTitle} subtitle={email}>
			<Form onSubmit={submit} busy={busy} aria-label={LOGIN.changeEmail}>
				<p className="text-sm text-muted">{LOGIN.loginHelp}</p>
				{sentTo ? <Callout tone="success">{LOGIN.emailSent(sentTo)}</Callout> : null}
				<div className="grid gap-4 md:grid-cols-2">
					<Input
						label={LOGIN.newEmail}
						type="email"
						autoComplete="email"
						value={next}
						onChange={(e) => setNext(e.currentTarget.value)}
						error={fieldErrors(problem).email}
						required
					/>
					<Input
						label={LOGIN.currentPassword}
						type="password"
						autoComplete="current-password"
						value={password}
						onChange={(e) => setPassword(e.currentTarget.value)}
						error={fieldErrors(problem).password}
						required
					/>
					{twoStepOn ? (
						<Input
							label={LOGIN.twoStepCode}
							help={LOGIN.twoStepCodeHelp}
							value={code}
							onChange={(e) => setCode(e.currentTarget.value)}
							autoComplete="one-time-code"
							error={fieldErrors(problem).code ?? fieldErrors(problem).recoveryCode}
							required
						/>
					) : null}
				</div>
				<FormError problem={problem} fields={['email', 'password', 'code', 'recoveryCode']} />
				<Button type="submit" loading={busy}>
					{LOGIN.changeEmail}
				</Button>
			</Form>
		</Card>
	);
}

/**
 * Change the password (other sessions end).
 * @param {{ twoStepOn: boolean }} props
 */
export function PasswordPanel({ twoStepOn }) {
	const toast = useToast();
	const [current, setCurrent] = useState('');
	const [next, setNext] = useState('');
	const [code, setCode] = useState('');
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [error, setError] = useState(/** @type {string | null} */ (null));
	const submit = async () => {
		if (next.length < PASSWORD_MIN) {
			setError(`Use at least ${PASSWORD_MIN} characters.`);
			return;
		}
		setError(null);
		setBusy(true);
		setProblem(null);
		const result = await apiFetch('/v1/me/password', {
			method: 'POST',
			body: { currentPassword: current, newPassword: next, ...factorOf(code) },
		});
		setBusy(false);
		if (result.ok) {
			setCurrent('');
			setNext('');
			setCode('');
			toast.show({ tone: 'success', title: LOGIN.passwordChanged });
		} else setProblem(result.problem);
	};
	return (
		<Card title={LOGIN.passwordTitle}>
			<Form onSubmit={submit} busy={busy} aria-label={LOGIN.changePassword}>
				<p className="text-sm text-muted">{LOGIN.passwordHelp}</p>
				<div className="grid gap-4 md:grid-cols-2">
					<Input
						label={LOGIN.currentPassword}
						type="password"
						autoComplete="current-password"
						value={current}
						onChange={(e) => setCurrent(e.currentTarget.value)}
						error={fieldErrors(problem).currentPassword}
						required
					/>
					<Input
						label="New password"
						type="password"
						autoComplete="new-password"
						value={next}
						onChange={(e) => setNext(e.currentTarget.value)}
						error={error ?? fieldErrors(problem).newPassword}
						required
					/>
					{twoStepOn ? (
						<Input
							label={LOGIN.twoStepCode}
							help={LOGIN.twoStepCodeHelp}
							value={code}
							onChange={(e) => setCode(e.currentTarget.value)}
							autoComplete="one-time-code"
							error={fieldErrors(problem).code ?? fieldErrors(problem).recoveryCode}
							required
						/>
					) : null}
				</div>
				<FormError problem={problem} fields={['currentPassword', 'newPassword', 'code', 'recoveryCode']} />
				<Button type="submit" loading={busy}>
					{LOGIN.changePassword}
				</Button>
			</Form>
		</Card>
	);
}

/** @param {string} action e.g. `merchant.suspended` → `Merchant suspended` */
const actionLabel = (action) => {
	const text = String(action ?? '').replace(/[._]/g, ' ');
	return text.charAt(0).toUpperCase() + text.slice(1);
};

/**
 * Activity entries (newest first, paged).
 * @param {{ items: any[], title?: string, empty: string, hasMore?: boolean, onLoadMore?: () => void, showMerchant?: boolean }} props
 */
export function ActivityTable({ items, title = 'Activity', empty, hasMore = false, onLoadMore, showMerchant = false }) {
	return (
		<Table
			caption={title}
			captionHidden
			rows={items}
			rowKey={(e) => e.activityId}
			empty={empty}
			hasMore={hasMore}
			{...(onLoadMore ? { onLoadMore } : {})}
			columns={[
				{ key: 'at', header: 'When', render: (e) => formatDateTime(e.at) },
				{ key: 'who', header: 'Who', render: (e) => e.actor?.name ?? e.actor?.type ?? '—', rowHeader: true },
				{
					key: 'what',
					header: 'What',
					render: (e) => (
						<span className="space-y-0.5">
							<span className="block">{actionLabel(e.action)}</span>
							{e.reason ? <span className="block text-xs text-muted">{e.reason}</span> : null}
						</span>
					),
				},
				...(showMerchant
					? [
							{
								key: 'merchant',
								header: 'Merchant',
								render: (/** @type {any} */ e) =>
									e.merchantName ? (
										<span>
											{e.merchantName}
											{e.merchantDeleted ? (
												<Badge tone="neutral" className="ml-1">
													Deleted
												</Badge>
											) : null}
										</span>
									) : (
										'—'
									),
							},
						]
					: []),
			]}
		/>
	);
}

/**
 * The person's own activity, loaded from `path` (`{ items, nextCursor }`).
 * @param {{ path: string, initial?: { items: any[], nextCursor?: string | null } }} props
 */
export function OwnActivity({ path, initial = { items: [], nextCursor: null } }) {
	const { data, problem } = useResource(path, initial);
	return (
		<Card title={LOGIN.activityTitle}>
			{problem ? <Callout tone="danger">{describeProblem(problem)}</Callout> : null}
			<ActivityTable items={data.items ?? []} empty="No activity yet." />
		</Card>
	);
}
