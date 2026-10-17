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
import { Input } from './fields.js';
import { Dialog } from './overlay.js';

/** @typedef {import('react').ReactNode} ReactNode */

/** The words of the dialog (US English; a caller passes its own). */
export const PASSWORD_CONFIRM_TEXTS = /** @type {Readonly<Record<'password' | 'passwordHelp' | 'code' | 'codeHelp', string>>} */ (
	Object.freeze({
		password: 'Your password',
		passwordHelp: 'Enter it again to confirm it is you.',
		code: 'Two-step or recovery code',
		codeHelp: 'From your authenticator app, or one of your recovery codes.',
	})
);

/**
 * @param {{ open: boolean, onClose: () => void, onConfirm: (input: { password: string, code: string }) => void,
 *   title: ReactNode, description?: ReactNode, children?: ReactNode, confirmLabel?: string, cancelLabel?: string,
 *   busy?: boolean, danger?: boolean, showCode?: boolean, expected?: string,
 *   errors?: { password?: ReactNode, code?: ReactNode, form?: ReactNode },
 *   texts?: Partial<Record<'password' | 'passwordHelp' | 'code' | 'codeHelp', string>> }} props
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
	expected,
	errors = {},
	texts,
}) {
	const T = { ...PASSWORD_CONFIRM_TEXTS, ...texts };
	const [password, setPassword] = useState('');
	const [code, setCode] = useState('');
	const [typed, setTyped] = useState('');
	const formId = useId();
	useEffect(() => {
		if (open) {
			setPassword('');
			setCode('');
			setTyped('');
		}
	}, [open]);
	const ready =
		password !== '' && (!showCode || code.trim() !== '') && (expected === undefined || typed.trim() === expected) && !busy;
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
					if (ready) onConfirm({ password, code: code.trim() });
				}}>
				{children}
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
				{showCode ? (
					<Input
						label={T.code}
						help={T.codeHelp}
						autoComplete="one-time-code"
						spellCheck={false}
						value={code}
						onChange={(event) => setCode(event.currentTarget.value)}
						error={errors.code}
						required
					/>
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
