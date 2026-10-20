'use client';
/**
 * The password step before a change a stolen sign-in must not make (connections, turning two-step on, inviting an
 * Owner, changing a role, copying a link, turning off someone's two-step, removing a person, deleting a merchant): the
 * person's password again, a two-step or recovery code once the Portal asks for one, and the typed name of what it
 * changes when the change is destructive. One dialog for all of them; the Portal checks the password again.
 * @module
 */
import { useState } from 'react';
import { PasswordConfirmDialog, describeProblem, fieldErrors, problemCode } from '@ss/ui';
import { CONFIRM_CHANGE, WEBSITE } from '../../texts/console.js';
import { factorOf } from './common.js';

/** @typedef {import('@ss/ui/problems').Problem} Problem */

/**
 * What the Portal said to a refused confirmation, as words for the field it belongs to: a wrong password under the
 * password, a missing or wrong code under the code; anything else (too many tries, a server problem) under the fields.
 * @param {Problem | null} problem
 * @returns {{ password?: string, code?: string, form?: string }}
 */
export const confirmationErrors = (problem) => {
	if (!problem) return {};
	const fields = fieldErrors(problem);
	if (fields.code || fields.recoveryCode) return { code: WEBSITE.needsCode };
	if (problemCode(problem) === 'invalid_credentials')
		return /code/i.test(String(problem.detail ?? '')) ? { code: WEBSITE.wrongCode } : { password: WEBSITE.wrongPassword };
	if (fields.password) return { password: WEBSITE.wrongPassword };
	return { form: describeProblem(problem) };
};

/**
 * The password dialog of a change: the person's password (and a code when the Portal asks for one), the request, and the
 * reason under its field when refused. It keeps the request in the page's hands: `send(confirmation)` returns the answer.
 * A refusal that is not about the password or the code (a value the Portal does not accept) closes the dialog, so the
 * form behind it can show the reason.
 * @param {{ open: boolean, title: string, help: string, confirmLabel: string, danger?: boolean, expected?: string,
 *   send: (confirmation: { password: string, code?: string, recoveryCode?: string }) => Promise<{ ok: true } | { ok: false, problem: Problem }>,
 *   onClose: () => void, onDone: () => void }} props
 */
export function ConfirmChange({ open, title, help, confirmLabel, danger = false, expected, send, onClose, onDone }) {
	const [busy, setBusy] = useState(false);
	const [errors, setErrors] = useState(/** @type {{ password?: string, code?: string, form?: string }} */ ({}));
	const [wantsCode, setWantsCode] = useState(false);
	/** @param {{ password: string, code: string }} input */
	const confirm = async ({ password, code }) => {
		setBusy(true);
		setErrors({});
		const result = await send({ password, ...factorOf(code) });
		setBusy(false);
		if (result.ok) {
			onDone();
			return;
		}
		const found = confirmationErrors(result.problem);
		if (found.code) setWantsCode(true);
		// a refusal that is not about the password (a value the Portal does not accept) is shown by the form, not here
		if (!found.password && !found.code && result.problem.status === 422) {
			onClose();
			return;
		}
		setErrors(found);
	};
	return (
		<PasswordConfirmDialog
			open={open}
			onClose={onClose}
			onConfirm={(input) => void confirm(input)}
			busy={busy}
			danger={danger}
			showCode={wantsCode}
			{...(expected === undefined ? {} : { expected })}
			confirmLabel={confirmLabel}
			title={title}
			errors={errors}
			texts={CONFIRM_CHANGE}>
			<p className="text-sm text-muted">{help}</p>
		</PasswordConfirmDialog>
	);
}
