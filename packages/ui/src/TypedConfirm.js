'use client';
/**
 * Typed confirmation for destructive operations: the confirm button stays disabled until the exact `expected`
 * text (a domain, an e-mail, an id) is typed. Optionally collects a reason (required when `reasonRequired`), which
 * is passed to `onConfirm`. The typed text and reason reset every time the dialog opens.
 * @module
 */
import { useEffect, useId, useState } from 'react';
import { Button } from './Button.js';
import { Input, TextArea } from './fields.js';
import { Dialog } from './overlay.js';

/** @typedef {import('react').ReactNode} ReactNode */

/**
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
