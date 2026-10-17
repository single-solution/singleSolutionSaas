'use client';
/**
 * The manual payment methods editor (fixed-choices P1, P2): the merchant's own list of ways to pay outside a gateway —
 * add, rename, reorder and remove methods; each with its kind (pay first, on delivery, at pickup), details, instructions,
 * proof upload and accounts (label/value rows with an optional currency). The list is read with
 * `GET /v1/dashboard/websites/:websiteId/lists/manual_methods` and saved whole with `PUT … { value }`; a 422 lists the
 * server's check errors under the editor.
 * @module
 */
import { useState } from 'react';
import {
	Button,
	Callout,
	Card,
	Checkbox,
	EntryGroup,
	FieldGrid,
	Input,
	ItemSwitcher,
	Select,
	TextArea,
	describeProblem,
	SaveRow,
} from '@ss/ui';
import { BANK_ROW_LABELS, METHOD_KINDS, METHOD_LIMITS, methodReady } from '../../core/methods.js';
import { SaveOutcome, call, fill, useLoad } from '@ss/ui/dashboard';
import { TEXTS } from './texts.js';

const M = TEXTS.methods;

/** @typedef {import('../../core/methods.js').ManualMethod} ManualMethod */
/** @typedef {import('../../core/methods.js').Account} Account */

/**
 * A list with one entry moved up or down.
 * @template T
 * @param {T[]} items @param {number} index @param {number} step
 */
const moved = (items, index, step) => {
	const next = [...items];
	const target = index + step;
	if (target < 0 || target >= next.length) return next;
	[next[index], next[target]] = [/** @type {T} */ (next[target]), /** @type {T} */ (next[index])];
	return next;
};

/** A new account: the bank rows to fill in (the merchant renames or removes them). @returns {Account} */
const newAccount = () => ({ label: '', currency: '', rows: BANK_ROW_LABELS.map((label) => ({ label, value: '' })) });

/**
 * A new method with a key not used yet.
 * @param {ManualMethod[]} methods
 * @returns {ManualMethod}
 */
const newMethod = (methods) => {
	let n = methods.length + 1;
	while (methods.some((method) => method.key === `method_${n}`)) n += 1;
	return { key: `method_${n}`, name: '', kind: 'pay_first', details: '', instructions: '', proof: false, accounts: [] };
};

/**
 * One account: its name, currency and label/value rows.
 * @param {{ account: Account, index: number, count: number, onChange: (next: Account) => void, onMove: (step: number) => void,
 *   onRemove: () => void }} props
 */
function AccountEditor({ account, index, count, onChange, onMove, onRemove }) {
	/** @param {number} at @param {Partial<{ label: string, value: string }>} change */
	const setRow = (at, change) =>
		onChange({ ...account, rows: account.rows.map((row, i) => (i === at ? { ...row, ...change } : row)) });
	return (
		<EntryGroup
			compact
			title={fill(M.account, { n: index + 1 })}
			first={index === 0}
			last={index === count - 1}
			texts={{ moveUp: M.up, moveDown: M.down, remove: M.removeAccount }}
			onMove={onMove}
			onRemove={onRemove}>
			<FieldGrid>
				<Input
					label={M.accountLabel}
					help={M.accountLabelHelp}
					maxLength={METHOD_LIMITS.label}
					value={account.label}
					onChange={(event) => onChange({ ...account, label: event.target.value })}
				/>
				<Input
					label={M.currency}
					help={M.currencyHelp}
					maxLength={3}
					value={account.currency}
					onChange={(event) => onChange({ ...account, currency: event.target.value.trim().toUpperCase() })}
				/>
			</FieldGrid>
			{account.rows.map((row, at) => (
				<div key={at} className="flex flex-wrap items-end gap-2">
					<Input
						fieldClassName="min-w-0 flex-1 basis-40"
						label={M.rowLabel}
						maxLength={METHOD_LIMITS.label}
						value={row.label}
						onChange={(event) => setRow(at, { label: event.target.value })}
					/>
					<Input
						fieldClassName="min-w-0 flex-1 basis-56"
						label={M.rowValue}
						maxLength={METHOD_LIMITS.value}
						value={row.value}
						onChange={(event) => setRow(at, { value: event.target.value })}
					/>
					<Button
						size="sm"
						variant="ghost"
						aria-label={fill(M.removeRow, { label: row.label || String(at + 1) })}
						onClick={() => onChange({ ...account, rows: account.rows.filter((_, i) => i !== at) })}>
						{M.remove}
					</Button>
				</div>
			))}
			<div className="flex flex-wrap gap-2">
				<Button
					size="sm"
					variant="secondary"
					disabled={account.rows.length >= METHOD_LIMITS.rows}
					onClick={() => onChange({ ...account, rows: [...account.rows, { label: '', value: '' }] })}>
					{M.addRow}
				</Button>
			</div>
		</EntryGroup>
	);
}

/**
 * One method: name, key, kind, words, proof and accounts.
 * @param {{ method: ManualMethod, index: number, count: number, noStorage: boolean, onChange: (next: ManualMethod) => void,
 *   onMove: (step: number) => void, onRemove: () => void }} props `noStorage`: Storage is not connected (proofs need it)
 */
function MethodEditor({ method, index, count, noStorage, onChange, onMove, onRemove }) {
	const ready = methodReady(method, null);
	return (
		<Card
			title={method.name || fill(M.untitled, { n: index + 1 })}
			subtitle={ready.ready ? M.kinds[method.kind] : `${M.kinds[method.kind]} · ${M.notReady}`}>
			<div className="space-y-4">
				<FieldGrid>
					<Input
						label={M.name}
						required
						maxLength={METHOD_LIMITS.name}
						value={method.name}
						onChange={(event) => onChange({ ...method, name: event.target.value })}
					/>
					<Input
						label={M.key}
						help={M.keyHelp}
						maxLength={40}
						value={method.key}
						onChange={(event) => onChange({ ...method, key: event.target.value.trim().toLowerCase() })}
					/>
					<Select
						label={M.kind}
						help={M.kindHelp}
						value={method.kind}
						options={METHOD_KINDS.map((kind) => ({ value: kind, label: M.kinds[kind] }))}
						onChange={(event) => onChange({ ...method, kind: /** @type {ManualMethod['kind']} */ (event.target.value) })}
					/>
					<Checkbox
						label={M.proof}
						help={method.proof && noStorage ? M.noStorage : M.proofHelp}
						checked={method.proof}
						onChange={(event) => onChange({ ...method, proof: event.target.checked })}
					/>
				</FieldGrid>
				<TextArea
					label={M.details}
					help={M.detailsHelp}
					rows={2}
					maxLength={METHOD_LIMITS.details}
					value={method.details}
					onChange={(event) => onChange({ ...method, details: event.target.value })}
				/>
				<TextArea
					label={M.instructions}
					help={M.instructionsHelp}
					rows={3}
					maxLength={METHOD_LIMITS.instructions}
					value={method.instructions}
					onChange={(event) => onChange({ ...method, instructions: event.target.value })}
				/>
				<div className="space-y-3">
					<p className="text-sm text-muted">{M.accountsHelp}</p>
					{method.accounts.map((account, at) => (
						<AccountEditor
							key={at}
							account={account}
							index={at}
							count={method.accounts.length}
							onChange={(next) =>
								onChange({ ...method, accounts: method.accounts.map((item, i) => (i === at ? next : item)) })
							}
							onMove={(step) => onChange({ ...method, accounts: moved(method.accounts, at, step) })}
							onRemove={() => onChange({ ...method, accounts: method.accounts.filter((_, i) => i !== at) })}
						/>
					))}
					<Button
						size="sm"
						variant="secondary"
						disabled={method.accounts.length >= METHOD_LIMITS.accounts}
						onClick={() => onChange({ ...method, accounts: [...method.accounts, newAccount()] })}>
						{M.addAccount}
					</Button>
				</div>
				<div className="flex flex-wrap gap-2">
					<Button size="sm" variant="ghost" disabled={index === 0} onClick={() => onMove(-1)}>
						{M.up}
					</Button>
					<Button size="sm" variant="ghost" disabled={index === count - 1} onClick={() => onMove(1)}>
						{M.down}
					</Button>
					<Button size="sm" variant="ghost" onClick={onRemove}>
						{M.removeMethod}
					</Button>
				</div>
			</div>
		</Card>
	);
}

/**
 * The editor: the saved list (or today's bank transfer before one is saved), edited locally and saved whole.
 * @param {{ websiteId: string }} props
 */
export function MethodsEditor({ websiteId }) {
	const path = `/v1/dashboard/websites/${websiteId}/lists/manual_methods`;
	const { answer, reload } = useLoad(path);
	const connections = useLoad(`/v1/dashboard/websites/${websiteId}/connections`);
	const noStorage =
		connections.answer?.ok === true &&
		!connections.answer.data.connections.some(
			(/** @type {{ name: string, status: string }} */ item) => item.name === 'storage' && item.status === 'connected',
		);
	const [draft, setDraft] = useState(/** @type {ManualMethod[] | null} */ (null));
	const [result, setResult] = useState(/** @type {import('@ss/ui/dashboard').Answer | null} */ (null));
	if (!answer) return null;
	if (!answer.ok)
		return (
			<Callout tone="danger" title={M.loadFailed}>
				{describeProblem(answer.problem)}
			</Callout>
		);
	/** @type {ManualMethod[]} */
	const saved = answer.data.value;
	const methods = draft ?? saved;
	/** @param {ManualMethod[]} next */
	const change = (next) => {
		setDraft(next);
		setResult(null);
	};
	return (
		<section className="space-y-4" aria-labelledby="manual-methods-title">
			<div>
				<h3 id="manual-methods-title" className="text-base font-semibold">
					{M.title}
				</h3>
				<p className="text-sm text-muted">{M.help}</p>
			</div>
			<ItemSwitcher
				items={methods}
				legend={M.title}
				nameOf={(method) => method.name}
				addLabel={M.addMethod}
				addDisabled={methods.length >= METHOD_LIMITS.methods}
				onAdd={() => change([...methods, newMethod(methods)])}
				renderItem={(method, index) => (
					<MethodEditor
						key={index}
						method={method}
						index={index}
						count={methods.length}
						noStorage={noStorage}
						onChange={(next) => change(methods.map((item, i) => (i === index ? next : item)))}
						onMove={(step) => change(moved(methods, index, step))}
						onRemove={() => change(methods.filter((_, i) => i !== index))}
					/>
				)}
			/>
			<SaveRow
				dirty={draft !== null}
				saveLabel={TEXTS.save}
				cancelLabel={M.cancel}
				onCancel={() => change(saved)}
				onSave={async () => {
					const next = await call('PUT', path, { value: methods });
					setResult(next);
					if (next.ok) {
						setDraft(null);
						reload();
					}
				}}
			/>
			<SaveOutcome result={result} />
		</section>
	);
}
