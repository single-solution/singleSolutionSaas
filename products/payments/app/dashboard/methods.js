'use client';
/**
 * The manual payment methods editor (fixed-choices P1, P2): the merchant's own list of ways to pay outside a gateway —
 * add, rename, reorder and remove methods; each with its kind (pay first, on delivery, at pickup), details, instructions,
 * proof upload and accounts (label/value rows with an optional currency). The list is read with
 * `GET /v1/dashboard/websites/:websiteId/lists/manual_methods` and saved whole with `PUT … { value }`; a 422 lists the
 * server's check errors under the editor. The methods are rich rows (icon, name, a dot for shown to payers or not, kind,
 * key, accounts) with a row menu; a method opens in a drawer, because it has many fields and accounts of its own. An
 * empty list is an empty state with the one Add action.
 * @module
 */
import { useState } from 'react';
import {
	ActionMenu,
	Button,
	Callout,
	Card,
	Checkbox,
	Drawer,
	EmptyState,
	EntryGroup,
	FieldGrid,
	Icon,
	Input,
	Row,
	RowListSkeleton,
	Select,
	TextArea,
	SaveBar,
} from '@ss/ui';
import { BANK_ROW_LABELS, METHOD_KINDS, METHOD_LIMITS, methodReady } from '../../core/methods.js';
import { Loaded, SaveOutcome, call, fill, useLoad } from '@ss/ui/dashboard';
import { TEXTS } from './texts.js';

const M = TEXTS.methods;

/** The icon of each kind of method's row. */
const KIND_ICONS = Object.freeze(
	/** @type {Record<string, import('@ss/ui').IconName>} */ ({ pay_first: 'creditCard', on_delivery: 'bag', at_pickup: 'home' }),
);

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
 * One method's fields: name, key, kind, words, proof and accounts (the drawer's body).
 * @param {{ method: ManualMethod, noStorage: boolean, onChange: (next: ManualMethod) => void }} props `noStorage`:
 *   Storage is not connected (proofs need it)
 */
function MethodFields({ method, noStorage, onChange }) {
	const ready = methodReady(method, null);
	return (
		<div className="space-y-4">
			{ready.ready ? null : <Callout tone="warning">{M.notReady}</Callout>}
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
		</div>
	);
}

/**
 * The editor: the saved list (or today's bank transfer before one is saved), edited locally and saved whole with the
 * frame's Save bar. The methods are rows (the row menu moves a method up or down or removes it); a click on a row
 * opens the method's fields in a drawer that edits the draft only (Done closes it).
 * @param {{ websiteId: string, bare?: boolean }} props `bare`: the page already says the title, so the card has none
 */
export function MethodsEditor({ websiteId, bare = false }) {
	const path = `/v1/dashboard/websites/${websiteId}/lists/manual_methods`;
	const { answer, reload } = useLoad(path);
	const connections = useLoad(`/v1/dashboard/websites/${websiteId}/connections`);
	const noStorage =
		connections.answer?.ok === true &&
		!connections.answer.data.connections.some(
			(/** @type {{ name: string, status: string }} */ item) => item.name === 'storage' && item.status === 'connected',
		);
	const [draft, setDraft] = useState(/** @type {ManualMethod[] | null} */ (null));
	const [opened, setOpened] = useState(/** @type {number | null} */ (null));
	const [result, setResult] = useState(/** @type {import('@ss/ui/dashboard').Answer | null} */ (null));
	/** @type {ManualMethod[]} */
	const saved = answer?.ok ? answer.data.value : [];
	const methods = draft ?? saved;
	/** @param {ManualMethod[]} next */
	const change = (next) => {
		setDraft(next);
		setResult(null);
	};
	/** @param {ManualMethod} method @param {number} index */
	const nameFor = (method, index) => method.name.trim() || fill(M.untitled, { n: index + 1 });
	const current = opened === null ? undefined : methods[opened];
	const add = () => {
		change([...methods, newMethod(methods)]);
		setOpened(methods.length);
	};
	const empty = answer?.ok === true && methods.length === 0;
	return (
		<Card
			{...(bare ? {} : { title: M.title })}
			subtitle={`${M.help} ${fill(M.max, { max: METHOD_LIMITS.methods })}`}
			actions={
				empty ? null : (
					<Button size="sm" disabled={!answer?.ok || methods.length >= METHOD_LIMITS.methods} onClick={add}>
						<Icon name="plus" size={14} />
						{M.addMethod}
					</Button>
				)
			}>
			<div className="space-y-4">
				<Loaded answer={answer} skeleton={<RowListSkeleton rows={3} label={TEXTS.loading} />}>
					{() =>
						methods.length === 0 ? (
							<EmptyState
								compact
								icon="creditCard"
								title={M.none}
								action={
									<Button size="sm" onClick={add}>
										<Icon name="plus" size={14} />
										{M.addMethod}
									</Button>
								}
							/>
						) : (
							<div>
								{methods.map((method, index) => {
									const ready = methodReady(method, null).ready;
									const name = nameFor(method, index);
									return (
										<Row
											key={index}
											lead={{ icon: KIND_ICONS[method.kind] ?? 'wallet', tone: 'primary' }}
											title={name}
											status={{
												tone: ready ? 'success' : 'warning',
												label: ready ? M.columns.ready : M.columns.notReady,
											}}
											meta={[M.kinds[method.kind], method.key, `${M.columns.accounts}: ${method.accounts.length}`]}
											value={ready ? M.columns.ready : M.columns.notReady}
											selected={opened === index}
											onSelect={() => setOpened(index)}
											trailing={
												<ActionMenu
													floating
													label={fill(TEXTS.rowActions, { name })}
													items={[
														{
															label: M.up,
															disabled: index === 0,
															onSelect: () => change(moved(methods, index, -1)),
														},
														{
															label: M.down,
															disabled: index === methods.length - 1,
															onSelect: () => change(moved(methods, index, 1)),
														},
														{
															label: M.remove,
															danger: true,
															onSelect: () => change(methods.filter((_, at) => at !== index)),
														},
													]}
												/>
											}
										/>
									);
								})}
							</div>
						)
					}
				</Loaded>
				<SaveBar
					show={draft !== null}
					saveLabel={TEXTS.save}
					discardLabel={M.cancel}
					onDiscard={() => {
						change(saved);
						setOpened(null);
					}}
					onSave={async () => {
						setOpened(null);
						const next = await call('PUT', path, { value: methods });
						setResult(next);
						if (next.ok) {
							setDraft(null);
							reload();
						}
					}}
				/>
				<SaveOutcome result={result} />
			</div>
			<Drawer
				open={current !== undefined}
				onClose={() => setOpened(null)}
				title={current && opened !== null ? nameFor(current, opened) : ''}
				size="lg"
				footer={<Button onClick={() => setOpened(null)}>{M.done}</Button>}>
				{current && opened !== null ? (
					<MethodFields
						method={current}
						noStorage={noStorage}
						onChange={(next) => change(methods.map((item, i) => (i === opened ? next : item)))}
					/>
				) : null}
			</Drawer>
		</Card>
	);
}
