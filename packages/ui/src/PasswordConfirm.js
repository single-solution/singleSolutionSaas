'use client';
/**
 * A fresh confirmation of the signed-in person before something a stolen session must not do (showing or renewing a
 * server token): their current password, a two-step or recovery code while two-step is on (`showCode`), and, when the
 * action is destructive, the typed name of what it changes (`expected`). The fields reset every time the dialog opens;
 * a wrong password or code is an error under its own field (`errors`), anything else under the fields (`errors.form`).
 * @module
 */
import { useEffect, useId, useState } from 'react';
import { Button } from './Button.js';
import { Input, TextArea } from './fields.js';
import { Dialog } from './overlay.js';

/** @typedef {import('react').ReactNode} ReactNode */

/** The words of the dialog (US English; a caller passes its own). */
export const PASSWORD_CONFIRM_TEXTS =
	/** @type {Readonly<Record<'password' | 'passwordHelp' | 'code' | 'codeHelp' | 'recoveryCode' | 'recoveryHelp' | 'useRecovery' | 'useTwoStep', string>>} */ (
		Object.freeze({
			password: 'Your password',
			passwordHelp: 'Enter it again to confirm it is you.',
			code: 'Two-step code',
			codeHelp: '6-digit code from your authenticator app.',
			recoveryCode: 'Recovery code',
			recoveryHelp: 'One of your backup recovery codes.',
			useRecovery: 'Use a recovery code instead',
			useTwoStep: 'Use authenticator code instead',
		})
	);

/**
 * @param {{ open: boolean, onClose: () => void, onConfirm: (input: { password?: string, code: string }) => void,
 *   title: ReactNode, description?: ReactNode, children?: ReactNode, confirmLabel?: string, cancelLabel?: string,
 *   busy?: boolean, danger?: boolean, showCode?: boolean, otpOnly?: boolean, expected?: string,
 *   errors?: { password?: ReactNode, code?: ReactNode, form?: ReactNode },
 *   texts?: Partial<Record<'password' | 'passwordHelp' | 'code' | 'codeHelp' | 'recoveryCode' | 'recoveryHelp' | 'useRecovery' | 'useTwoStep', string>> }} props
 */
export function PasswordConfirmDialog({
	open,
	onClose,
	onConfirm,
	title,
	description,
	children,
	confirmLabel = 'Confirm',
	cancelLabel = 'Cancel',
	busy = false,
	danger = false,
	showCode = false,
	otpOnly = false,
	expected,
	errors = {},
	texts,
}) {
	const T = { ...PASSWORD_CONFIRM_TEXTS, ...texts };
	const [password, setPassword] = useState('');
	const [code, setCode] = useState('');
	const [typed, setTyped] = useState('');
	const [useRecovery, setUseRecovery] = useState(false);
	const formId = useId();
	useEffect(() => {
		if (open) {
			setPassword('');
			setCode('');
			setTyped('');
			setUseRecovery(false);
		}
	}, [open]);
	const effectiveShowCode = otpOnly || showCode;
	const ready =
		(otpOnly || password !== '') &&
		(!effectiveShowCode || code.trim() !== '') &&
		(expected === undefined || typed.trim() === expected) &&
		!busy;
	return (
		<Dialog
			open={open}
			onClose={busy ? () => undefined : onClose}
			title={title}
			{...(description ? { description } : {})}
			size="sm"
			footer={
				<>
					<Button variant="secondary" onClick={onClose} disabled={busy}>
						{cancelLabel}
					</Button>
					<Button type="submit" form={formId} variant={danger ? 'danger' : 'primary'} loading={busy} disabled={!ready}>
						{confirmLabel}
					</Button>
				</>
			}>
			<form
				id={formId}
				noValidate
				className="space-y-4"
				onSubmit={(event) => {
					event.preventDefault();
					if (ready) onConfirm({ ...(otpOnly ? {} : { password }), code: code.trim() });
				}}>
				{children}
				{otpOnly ? null : (
					<Input
						label={T.password}
						help={T.passwordHelp}
						type="password"
						autoComplete="current-password"
						value={password}
						onChange={(event) => setPassword(event.currentTarget.value)}
						error={errors.password}
						required
						data-autofocus
					/>
				)}
				{effectiveShowCode ? (
					<div className="space-y-2">
						<Input
							label={useRecovery ? (T.recoveryCode ?? 'Recovery code') : T.code}
							help={useRecovery ? (T.recoveryHelp ?? 'One of your backup recovery codes.') : T.codeHelp}
							autoComplete={useRecovery ? 'off' : 'one-time-code'}
							inputMode={useRecovery ? 'text' : 'numeric'}
							maxLength={useRecovery ? 16 : 6}
							placeholder={useRecovery ? 'abcd-efgh-...' : '123456'}
							spellCheck={false}
							value={code}
							onChange={(event) => setCode(event.currentTarget.value)}
							error={errors.code}
							required
							data-autofocus={otpOnly ? true : undefined}
						/>
						<div className="flex justify-end">
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={() => {
									setUseRecovery((v) => !v);
									setCode('');
								}}>
								{useRecovery
									? (T.useTwoStep ?? 'Use authenticator code instead')
									: (T.useRecovery ?? 'Use a recovery code instead')}
							</Button>
						</div>
					</div>
				) : null}
				{expected === undefined ? null : (
					<Input
						label={
							<>
								Type <span className="font-mono normal-case tracking-normal text-fg">{expected}</span> to confirm
							</>
						}
						value={typed}
						onChange={(event) => setTyped(event.currentTarget.value)}
						autoComplete="off"
						spellCheck={false}
					/>
				)}
				{errors.form ? (
					<p role="alert" className="animate-ss-shake text-sm font-medium text-danger">
						{errors.form}
					</p>
				) : null}
			</form>
		</Dialog>
	);
}

/**
 * Step-up confirmation dialog using OTP only (no password prompt).
 * @param {Omit<Parameters<typeof PasswordConfirmDialog>[0], 'otpOnly'>} props
 */
export function OtpConfirmDialog(props) {
	return <PasswordConfirmDialog {...props} otpOnly />;
}

/**
 * Typed confirmation for destructive operations: the confirm button stays disabled until the exact `expected`
 * text (a domain, an email, an id) is typed. Optionally collects a reason (`reason`; required when `reason.required`),
 * which is passed to `onConfirm`. The typed text and reason reset every time the dialog opens.
 * @param {{ open: boolean, onClose: () => void, onConfirm: (input: { reason: string }) => void, title: ReactNode,
 *   expected: string, children?: ReactNode, confirmLabel?: string, cancelLabel?: string, busy?: boolean,
 *   error?: ReactNode, danger?: boolean, reason?: false | { label?: string, required?: boolean, help?: ReactNode,
 *   maxLength?: number } }} props
 */
export function TypedConfirmDialog({
	open,
	onClose,
	onConfirm,
	title,
	expected,
	children,
	confirmLabel = 'Confirm',
	cancelLabel = 'Cancel',
	busy = false,
	error,
	danger = true,
	reason = false,
}) {
	const [typed, setTyped] = useState('');
	const [why, setWhy] = useState('');
	const formId = useId();
	useEffect(() => {
		if (open) {
			setTyped('');
			setWhy('');
		}
	}, [open]);
	const matches = typed.trim() === expected;
	const reasonOk = !reason || !reason.required || why.trim().length > 0;
	const ready = matches && reasonOk && !busy;
	const submit = () => {
		if (ready) onConfirm({ reason: why.trim() });
	};
	return (
		<Dialog
			open={open}
			onClose={busy ? () => undefined : onClose}
			title={title}
			size="sm"
			footer={
				<>
					<Button variant="secondary" onClick={onClose} disabled={busy}>
						{cancelLabel}
					</Button>
					<Button
						type="submit"
						form={formId}
						variant={danger ? 'danger' : 'primary'}
						loading={busy}
						disabled={!matches || !reasonOk}>
						{confirmLabel}
					</Button>
				</>
			}>
			<form
				id={formId}
				noValidate
				className="space-y-4"
				onSubmit={(event) => {
					event.preventDefault();
					submit();
				}}>
				{children}
				{reason ? (
					<TextArea
						label={reason.label ?? 'Reason'}
						value={why}
						rows={2}
						maxLength={reason.maxLength ?? 500}
						required={reason.required === true}
						help={reason.help}
						onChange={(e) => setWhy(e.currentTarget.value)}
					/>
				) : null}
				<Input
					label={
						<>
							Type <span className="font-mono normal-case tracking-normal text-fg">{expected}</span> to confirm
						</>
					}
					value={typed}
					onChange={(e) => setTyped(e.currentTarget.value)}
					autoComplete="off"
					spellCheck={false}
					data-autofocus
				/>
				{error ? (
					<p role="alert" className="text-sm font-medium text-danger">
						{error}
					</p>
				) : null}
			</form>
		</Dialog>
	);
}
