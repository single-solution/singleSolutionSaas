'use client';
/**
 * The signed-in person's own login (PLAN 0.2 Changing a login, Two-step sign-in), shared by the merchant Account page
 * and the admin My account page: sign-in email (confirmed from the new address), password, two-step (set up with a
 * QR code, 10 recovery codes shown once, turn off, new codes) and the person's own activity.
 * @module
 */
import { useState } from 'react';
import qrcode from 'qrcode-generator';
import {
	Badge,
	Button,
	Callout,
	Checkbox,
	CodeBlock,
	Drawer,
	EmptyState,
	FieldLayoutContext,
	Form,
	FormError,
	Input,
	KeyValueList,
	LocalTime,
	Pagination,
	Row,
	SettingsCard,
	Stepper,
	Timeline,
	describeProblem,
	fieldErrors,
	humanize,
	useToast,
	TextLink,
} from '@ss/ui';
import { AUTH, LOGIN, MORE, TWO_STEP } from '../../texts/console.js';
import { apiConfirm, usePagedList } from '../client.js';
import { Link } from '../link.js';
import { withCursor } from '../paths.js';
import { factorOf } from './common.js';
import { ConfirmChange } from './confirm-change.js';

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
	const [asking, setAsking] = useState(false);
	const step = codes ? 'codes' : secret ? 'confirm' : 'start';
	// starting asks for the password again: a stolen session alone must not be able to claim the sign-in's second step
	/** @param {{ password: string }} confirmation */
	const start = async ({ password }) => {
		const result = await apiConfirm('/v1/me/two-step/start', { method: 'POST', body: { password } });
		if (result.ok) setSecret(result.data);
		return result;
	};
	const confirm = async () => {
		setBusy(true);
		setProblem(null);
		const result = await apiConfirm('/v1/me/two-step/confirm', { method: 'POST', body: { code: code.trim() } });
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
					<Button onClick={() => setAsking(true)}>{TWO_STEP.start}</Button>
					<ConfirmChange
						open={asking}
						title={TWO_STEP.start}
						help={TWO_STEP.startHelp}
						confirmLabel={TWO_STEP.startConfirm}
						send={start}
						onClose={() => setAsking(false)}
						onDone={() => setAsking(false)}
					/>
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
						label={TWO_STEP.codeLabel}
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
	const [useRecovery, setUseRecovery] = useState(false);
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const submit = async () => {
		setBusy(true);
		setProblem(null);
		const result = await apiConfirm(path, { method: 'POST', body: { password, ...factorOf(code) } });
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
				label={useRecovery ? AUTH.recoveryCode : LOGIN.twoStepCode}
				value={code}
				onChange={(e) => setCode(e.currentTarget.value)}
				autoComplete={useRecovery ? 'off' : 'one-time-code'}
				inputMode={useRecovery ? 'text' : 'numeric'}
				maxLength={useRecovery ? 16 : 6}
				placeholder={useRecovery ? 'abcd-efgh-...' : '123456'}
				error={fieldErrors(problem).code ?? fieldErrors(problem).recoveryCode}
				required
			/>
			<div className="flex justify-start">
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={() => {
						setUseRecovery((v) => !v);
						setCode('');
					}}>
					{useRecovery ? AUTH.useApp : AUTH.useRecovery}
				</Button>
			</div>
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
		<SettingsCard
			title={TWO_STEP.title}
			actions={<Badge tone={twoStep.enabled ? 'success' : 'neutral'}>{twoStep.enabled ? TWO_STEP.on : TWO_STEP.off}</Badge>}>
			<FieldLayoutContext.Provider value="stack">
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
			</FieldLayoutContext.Provider>
		</SettingsCard>
	);
}

/**
 * Change the sign-in email (current password, plus a code while two-step is on).
 * @param {{ email: string, twoStepOn: boolean }} props
 */
export function EmailPanel({ email, twoStepOn }) {
	const [next, setNext] = useState('');
	const [password, setPassword] = useState('');
	const [code, setCode] = useState('');
	const [useRecovery, setUseRecovery] = useState(false);
	const [busy, setBusy] = useState(false);
	const [sentTo, setSentTo] = useState(/** @type {string | null} */ (null));
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const submit = async () => {
		setBusy(true);
		setProblem(null);
		const result = await apiConfirm('/v1/me/email', {
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
		<SettingsCard title={LOGIN.loginTitle} description={email}>
			<Form onSubmit={submit} busy={busy} aria-label={LOGIN.changeEmail}>
				<p className="text-sm text-muted">{LOGIN.loginHelp}</p>
				{sentTo ? <Callout tone="success">{LOGIN.emailSent(sentTo)}</Callout> : null}
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
					<div className="space-y-2">
						<Input
							label={useRecovery ? AUTH.recoveryCode : LOGIN.twoStepCode}
							help={useRecovery ? AUTH.recoveryHelp : LOGIN.twoStepCodeHelp}
							value={code}
							onChange={(e) => setCode(e.currentTarget.value)}
							autoComplete={useRecovery ? 'off' : 'one-time-code'}
							inputMode={useRecovery ? 'text' : 'numeric'}
							maxLength={useRecovery ? 16 : 6}
							placeholder={useRecovery ? 'abcd-efgh-...' : '123456'}
							error={fieldErrors(problem).code ?? fieldErrors(problem).recoveryCode}
							required
						/>
						<div className="flex justify-start">
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={() => {
									setUseRecovery((v) => !v);
									setCode('');
								}}>
								{useRecovery ? AUTH.useApp : AUTH.useRecovery}
							</Button>
						</div>
					</div>
				) : null}
				<FormError problem={problem} fields={['email', 'password', 'code', 'recoveryCode']} />
				<Button type="submit" loading={busy}>
					{LOGIN.changeEmail}
				</Button>
			</Form>
		</SettingsCard>
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
	const [useRecovery, setUseRecovery] = useState(false);
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
		const result = await apiConfirm('/v1/me/password', {
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
		<SettingsCard title={LOGIN.passwordTitle}>
			<Form onSubmit={submit} busy={busy} aria-label={LOGIN.changePassword}>
				<p className="text-sm text-muted">{LOGIN.passwordHelp}</p>
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
					label={AUTH.newPassword}
					type="password"
					autoComplete="new-password"
					value={next}
					onChange={(e) => setNext(e.currentTarget.value)}
					error={error ?? fieldErrors(problem).newPassword}
					required
				/>
				{twoStepOn ? (
					<div className="space-y-2">
						<Input
							label={useRecovery ? AUTH.recoveryCode : LOGIN.twoStepCode}
							help={useRecovery ? AUTH.recoveryHelp : LOGIN.twoStepCodeHelp}
							value={code}
							onChange={(e) => setCode(e.currentTarget.value)}
							autoComplete={useRecovery ? 'off' : 'one-time-code'}
							inputMode={useRecovery ? 'text' : 'numeric'}
							maxLength={useRecovery ? 16 : 6}
							placeholder={useRecovery ? 'abcd-efgh-...' : '123456'}
							error={fieldErrors(problem).code ?? fieldErrors(problem).recoveryCode}
							required
						/>
						<div className="flex justify-start">
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={() => {
									setUseRecovery((v) => !v);
									setCode('');
								}}>
								{useRecovery ? AUTH.useApp : AUTH.useRecovery}
							</Button>
						</div>
					</div>
				) : null}
				<FormError problem={problem} fields={['currentPassword', 'newPassword', 'code', 'recoveryCode']} />
				<Button type="submit" loading={busy}>
					{LOGIN.changePassword}
				</Button>
			</Form>
		</SettingsCard>
	);
}

/**
 * Who did an entry: the actor's name, else its kind (`system` → `System`).
 * @param {any} entry
 */
const actorName = (entry) => entry.actor?.name ?? (entry.actor?.type ? humanize(entry.actor.type) : '—');

/** @param {string} action e.g. `merchant.suspended` → `Merchant suspended`, `login.signed_in` → `Signed in` */
const actionLabel = (action) => {
	const named = /** @type {Record<string, string>} */ (MORE.actions)[String(action)];
	if (named) return named;
	const text = String(action ?? '').replace(/[._]/g, ' ');
	return text.charAt(0).toUpperCase() + text.slice(1);
};

/** @param {unknown} value one value of an entry’s before / after, shown short @returns {string} */
const shortValue = (value) => {
	if (value === null || value === undefined || value === '') return '—';
	if (Array.isArray(value)) return value.length === 0 ? '—' : value.map((v) => shortValue(v)).join(', ');
	const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
	return text.length > 80 ? `${text.slice(0, 79)}…` : text;
};

/**
 * What an entry changed (admins only: `before` / `after`), one line per field.
 * @param {{ entry: any }} props
 */
function Changes({ entry }) {
	const before = entry.before && typeof entry.before === 'object' ? entry.before : {};
	const after = entry.after && typeof entry.after === 'object' ? entry.after : {};
	const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
	if (keys.length === 0) return <p className="text-sm text-muted">{MORE.noChanges}</p>;
	return (
		<div className="space-y-1.5">
			<h3 className="text-label font-semibold text-fg">{MORE.changes}</h3>
			<ul className="space-y-1 text-sm text-muted">
				{keys.map((key) => (
					<li key={key} className="break-words">
						<span className="font-semibold text-fg">{key}</span>: {key in before ? `${shortValue(before[key])} → ` : ''}
						{shortValue(after[key])}
					</li>
				))}
			</ul>
		</div>
	);
}

/**
 * The latest activity as a timeline (who, what, for which merchant, when in the viewer's local time): the Overview's
 * short view of the log. `showMerchant` (admin views) names the merchant of each entry; the merchant console leaves it
 * out.
 * @param {{ items: any[], empty: string, showMerchant?: boolean }} props
 */
export function ActivityTimeline({ items, empty, showMerchant = true }) {
	return (
		<Timeline
			empty={empty}
			items={items.map((e) => ({
				key: e.activityId,
				who: actorName(e),
				what: (
					<>
						{actionLabel(e.action)}
						{showMerchant && e.merchantName ? <span className="text-muted"> · {e.merchantName}</span> : null}
					</>
				),
				at: e.at,
			}))}
		/>
	);
}

/**
 * Activity entries (newest first) as a table: when, who, what (the reason after it) and, with `showMerchant`, for which
 * merchant. `filterHref` turns the admin and merchant names into links that filter the Activity page by them; `details`
 * makes a row open a drawer with what the entry changed (admin views). The caller pages the rows (`useListPages`).
 * @param {{ items: any[], caption?: string, empty: string, showMerchant?: boolean, details?: boolean,
 *   filterHref?: (q: { merchantId?: string, adminId?: string }) => string }} props
 */
export function ActivityTable({
	items,
	caption = MORE.activityColumns.what,
	empty,
	showMerchant = false,
	details = false,
	filterHref,
}) {
	const [open, setOpen] = useState(/** @type {any} */ (null));
	/** @param {string} name @param {string} href */
	const filterLink = (name, href) => (
		<TextLink as={Link} tone="plain" href={href} title={MORE.onlyThis(name)}>
			{name}
		</TextLink>
	);
	const C = MORE.activityColumns;
	return (
		<>
			{items.length === 0 ? (
				<EmptyState compact icon="activity" kind="activity" title={empty} />
			) : (
				<div aria-label={caption} className="divide-y divide-line-soft rounded-card border border-line-soft bg-surface">
					{items.map((e) => {
						const name = actorName(e);
						const who =
							filterHref && e.actor?.id
								? e.actor.type === 'admin'
									? filterLink(name, filterHref({ adminId: e.actor.id }))
									: e.actor.type === 'merchant'
										? filterLink(name, filterHref({ merchantId: e.actor.id }))
										: name
								: name;
						const merchant =
							filterHref && e.merchantId && e.merchantName
								? filterLink(e.merchantName, filterHref({ merchantId: e.merchantId }))
								: e.merchantName;
						return (
							<Row
								key={e.activityId}
								lead={{ avatar: name }}
								title={actionLabel(e.action)}
								meta={[who !== name ? who : null, showMerchant && merchant ? merchant : null, e.reason].filter(Boolean)}
								time={<LocalTime value={e.at} />}
								{...(details ? { onSelect: () => setOpen(e) } : {})}
							/>
						);
					})}
				</div>
			)}
			{details ? (
				<Drawer open={Boolean(open)} onClose={() => setOpen(null)} title={MORE.entryTitle}>
					{open ? (
						<div className="space-y-4">
							<KeyValueList
								items={[
									{ label: C.when, value: <LocalTime value={open.at} /> },
									{ label: C.who, value: actorName(open) },
									{ label: C.what, value: actionLabel(open.action) },
									...(open.merchantName ? [{ label: C.merchant, value: open.merchantName }] : []),
									...(open.reason ? [{ label: MORE.reasonLabel, value: open.reason }] : []),
								]}
							/>
							<Changes entry={open} />
						</div>
					) : null}
				</Drawer>
			) : null}
		</>
	);
}

/**
 * The signed-in person's own activity as a timeline of rich rows (flat layout 2026-10-21, K-4b):
 * each entry has an avatar with the actor's initials, the action label, the reason, and the date in local time.
 * When there are more entries, a "Show more" button appends the next page.
 * @param {{ path: string, initial?: { items: any[], nextCursor?: string | null }, empty?: string, showMerchant?: boolean }} props
 */
export function OwnActivityTimeline({
	path,
	initial = { items: [], nextCursor: null },
	empty = MORE.noActivity,
	showMerchant = false,
}) {
	const list = usePagedList((cursor) => withCursor(path, cursor), initial);
	return (
		<div className="space-y-4">
			{list.problem ? <Callout tone="danger">{describeProblem(list.problem)}</Callout> : null}
			{list.items.length === 0 && !list.loading ? (
				<EmptyState compact icon="activity" kind="activity" title={empty} />
			) : (
				<div className="divide-y divide-line-soft rounded-card border border-line-soft bg-surface">
					{list.items.map((e) => (
						<Row
							key={e.activityId}
							lead={{ avatar: actorName(e) }}
							title={actionLabel(e.action)}
							meta={[showMerchant && e.merchantName ? e.merchantName : null, e.reason].filter(Boolean)}
							time={<LocalTime value={e.at} />}
						/>
					))}
				</div>
			)}
			{list.cursor ? (
				<div className="flex justify-center pt-2">
					<Button variant="secondary" size="sm" loading={list.loading} onClick={() => void list.more()}>
						{MORE.showMore}
					</Button>
				</div>
			) : null}
		</div>
	);
}

/**
 * The person's own activity as a timeline of rows with "Show more" (flat layout 2026-10-21, K-4b).
 * @param {string} path the activity API path (`{ items, nextCursor }`)
 * @param {{ items: any[], nextCursor?: string | null } | undefined} initial
 */
export function useOwnActivity(path, initial = { items: [], nextCursor: null }) {
	return {
		body: <OwnActivityTimeline path={path} initial={initial} />,
		footer: null,
	};
}
