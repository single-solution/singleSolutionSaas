'use client';
/**
 * The payment methods editor (Settings → Checkout and payment; the `payment_methods` list, fixed-choices E2, E8): the
 * merchant's own ways to pay, in the order the cart lists them, each with its name, kind and note, the fee, the largest
 * order and whether it is offered for delivered and picked-up orders; a method paid first says whether it goes through
 * Payments (whose manual method of the same key holds its accounts) or is paid by hand; a method paid later has its
 * advance and returned-package rules; what is paid by hand has its own instructions, accounts (label/value rows, one
 * per line as `Label: value`, with an optional currency) and proof upload. The server checks the list again
 * (`core/payment-methods.js` `checkPaymentMethods`).
 * @module
 */
import { Button, Checkbox, EntryGroup, FieldGrid, Input, Select, StatusPill, TextArea } from '@ss/ui';
import { currencyDigits } from '@ss/contracts/format';
import { PAYMENT_KINDS, PAY_LATER_KINDS, newAccount, paidByHand } from '../../core/payment-methods.js';
import { fill } from '@ss/ui/dashboard';
import { keyOf } from './drafts.js';
import { ListEditor, amountOf, decimalOf } from './lists.js';
import { TEXTS } from './texts.js';

const L = TEXTS.lists;
const P = L.paymentMethods;

/** @typedef {Record<string, any>} Draft */

/**
 * An account's rows as the text edited: one `Label: value` per line.
 * @param {Array<{ label: string, value: string }>} rows
 */
const rowsText = (rows) => rows.map((row) => `${row.label}: ${row.value}`).join('\n');

/**
 * The rows of an account's text: each non-empty line, its label before the first `:`.
 * @param {unknown} text
 */
const rowsOf = (text) =>
	String(text ?? '')
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const at = line.indexOf(':');
			return at === -1 ? { label: line, value: '' } : { label: line.slice(0, at).trim(), value: line.slice(at + 1).trim() };
		});

/**
 * @param {{ websiteId: string, off?: boolean, bare?: boolean, currency: string }} props
 */
export function PaymentMethodsEditor({ websiteId, off, bare = false, currency }) {
	const step = currencyDigits(currency) === 0 ? '1' : String(10 ** -currencyDigits(currency));
	/** @param {string} label @param {unknown} value @param {(text: string) => void} set */
	const money = (label, value, set) => (
		<Input
			label={fill(label, { currency })}
			type="number"
			min={0}
			step={step}
			inputMode="decimal"
			value={String(value ?? '')}
			onChange={(event) => set(event.target.value)}
		/>
	);
	/** @param {string} label @param {unknown} value @param {(text: string) => void} set @param {string} [stepOf] */
	const number = (label, value, set, stepOf = '1') => (
		<Input
			label={label}
			type="number"
			min={0}
			step={stepOf}
			inputMode="decimal"
			value={String(value ?? '')}
			onChange={(event) => set(event.target.value)}
		/>
	);
	return (
		<ListEditor
			websiteId={websiteId}
			list="payment_methods"
			title={P.title}
			help={P.help}
			itemLabel={P.item}
			max={20}
			off={off}
			bare={bare}
			size="lg"
			columns={[
				{
					key: 'kind',
					header: L.columns.kind,
					render: (method) => P.kinds[/** @type {keyof typeof P.kinds} */ (method.kind)] ?? method.kind,
				},
				{
					key: 'fee',
					header: L.columns.fee,
					kind: 'number',
					low: true,
					render: (method) => `${String(method.feePercent ?? 0)}%`,
				},
				{
					key: 'active',
					header: L.columns.active,
					render: (method) =>
						method.active !== false ? (
							<StatusPill status="active">{L.columns.activeOn}</StatusPill>
						) : (
							<StatusPill status="off">{L.columns.activeOff}</StatusPill>
						),
				},
			]}
			blank={() => ({
				key: '',
				name: '',
				kind: 'pay_first',
				active: true,
				note: '',
				instructions: '',
				delivery: true,
				pickup: true,
				maxOrderValue: '',
				feePercent: '0',
				feeBase: 'order_total',
				advanceAmount: '',
				advancePercent: '0',
				advanceVia: 'payments',
				rtoThreshold: '0',
				rtoRequireAdvance: true,
				via: 'manual',
				proof: true,
				accounts: [newAccount()].map((account) => ({ ...account, rows: rowsText(account.rows) })),
			})}
			load={(method) => ({
				...method,
				maxOrderValue: method.maxOrderValue ? decimalOf(method.maxOrderValue, currency) : '',
				advanceAmount: method.advanceAmount ? decimalOf(method.advanceAmount, currency) : '',
				feePercent: String(method.feePercent ?? 0),
				advancePercent: String(method.advancePercent ?? 0),
				rtoThreshold: String(method.rtoThreshold ?? 0),
				accounts: (Array.isArray(method.accounts) ? method.accounts : []).map((/** @type {any} */ account) => ({
					...account,
					rows: rowsText(account.rows ?? []),
				})),
			})}
			check={(methods) =>
				methods.flatMap((method, index) =>
					[method.maxOrderValue, method.advanceAmount]
						.filter((text) => amountOf(text, currency, 0) === undefined)
						.map((text) =>
							fill(P.badAmount, { method: method.name || `${P.item} ${index + 1}`, value: String(text), currency }),
						),
				)
			}
			clean={(method) => ({
				key: keyOf(method.key, method.name),
				name: String(method.name ?? '').trim(),
				kind: method.kind,
				active: method.active !== false,
				note: String(method.note ?? '').trim(),
				instructions: String(method.instructions ?? '').trim(),
				delivery: method.delivery !== false,
				pickup: method.pickup !== false,
				maxOrderValue: amountOf(method.maxOrderValue, currency, 0),
				feePercent: Number(String(method.feePercent).trim() || 0),
				feeBase: method.feeBase,
				advanceAmount: amountOf(method.advanceAmount, currency, 0),
				advancePercent: Number(String(method.advancePercent).trim() || 0),
				advanceVia: method.advanceVia,
				rtoThreshold: Number(String(method.rtoThreshold).trim() || 0),
				rtoRequireAdvance: method.rtoRequireAdvance !== false,
				via: method.via,
				proof: method.proof !== false,
				accounts: (method.accounts ?? []).map((/** @type {Draft} */ account) => ({
					label: String(account.label ?? '').trim(),
					currency: String(account.currency ?? '')
						.trim()
						.toUpperCase(),
					rows: rowsOf(account.rows),
				})),
			})}
			render={(method, set) => {
				const later = PAY_LATER_KINDS.includes(method.kind);
				const byHand = paidByHand(/** @type {any} */ (method));
				/** @type {Draft[]} */
				const accounts = method.accounts ?? [];
				/** @param {number} index @param {Draft} patch */
				const setAccount = (index, patch) =>
					set({ accounts: accounts.map((account, at) => (at === index ? { ...account, ...patch } : account)) });
				return (
					<div className="space-y-3">
						<FieldGrid>
							<Input
								label={P.name}
								value={method.name ?? ''}
								maxLength={60}
								onChange={(event) => set({ name: event.target.value })}
							/>
							<Input
								label={P.key}
								value={method.key ?? ''}
								maxLength={40}
								autoComplete="off"
								onChange={(event) => set({ key: event.target.value })}
							/>
							<Select
								label={P.kind}
								value={method.kind}
								options={PAYMENT_KINDS.map((kind) => ({ value: kind, label: P.kinds[kind] }))}
								onChange={(event) => set({ kind: event.target.value })}
							/>
							<Input
								label={P.note}
								value={method.note ?? ''}
								maxLength={500}
								onChange={(event) => set({ note: event.target.value })}
							/>
							{money(P.maxOrderValue, method.maxOrderValue, (text) => set({ maxOrderValue: text }))}
							{number(P.feePercent, method.feePercent, (text) => set({ feePercent: text }), '0.1')}
							<Select
								label={P.feeBase}
								value={method.feeBase}
								options={['order_total', 'goods_after_discounts'].map((value) => ({
									value,
									label: P.feeBases[/** @type {'order_total' | 'goods_after_discounts'} */ (value)],
								}))}
								onChange={(event) => set({ feeBase: event.target.value })}
							/>
							{method.kind === 'pay_first' ? (
								<Select
									label={P.via}
									value={method.via}
									options={['payments', 'manual'].map((value) => ({
										value,
										label: P.vias[/** @type {'payments' | 'manual'} */ (value)],
									}))}
									onChange={(event) => set({ via: event.target.value })}
								/>
							) : null}
							{later ? money(P.advanceAmount, method.advanceAmount, (text) => set({ advanceAmount: text })) : null}
							{later ? number(P.advancePercent, method.advancePercent, (text) => set({ advancePercent: text })) : null}
							{later ? (
								<Select
									label={P.advanceVia}
									value={method.advanceVia}
									options={['payments', 'manual'].map((value) => ({
										value,
										label: P.vias[/** @type {'payments' | 'manual'} */ (value)],
									}))}
									onChange={(event) => set({ advanceVia: event.target.value })}
								/>
							) : null}
							{later ? number(P.rtoThreshold, method.rtoThreshold, (text) => set({ rtoThreshold: text })) : null}
						</FieldGrid>
						<div className="flex flex-wrap gap-x-6 gap-y-2">
							<Checkbox
								label={P.active}
								checked={method.active !== false}
								onChange={(event) => set({ active: event.target.checked })}
							/>
							<Checkbox
								label={P.delivery}
								checked={method.delivery !== false}
								onChange={(event) => set({ delivery: event.target.checked })}
							/>
							<Checkbox
								label={P.pickup}
								checked={method.pickup !== false}
								onChange={(event) => set({ pickup: event.target.checked })}
							/>
							{later ? (
								<Checkbox
									label={P.rtoRequireAdvance}
									checked={method.rtoRequireAdvance !== false}
									onChange={(event) => set({ rtoRequireAdvance: event.target.checked })}
								/>
							) : null}
							{byHand ? (
								<Checkbox
									label={P.proof}
									checked={method.proof !== false}
									onChange={(event) => set({ proof: event.target.checked })}
								/>
							) : null}
						</div>
						{method.kind === 'pay_first' && method.via === 'payments' ? (
							<p className="text-sm text-muted">{P.viaPayments}</p>
						) : null}
						{byHand ? (
							<div className="space-y-3">
								<TextArea
									label={P.instructions}
									value={method.instructions ?? ''}
									maxLength={1000}
									onChange={(event) => set({ instructions: event.target.value })}
								/>
								{accounts.map((account, index) => (
									<EntryGroup
										key={index}
										compact
										texts={{ remove: P.removeAccount }}
										onRemove={() => set({ accounts: accounts.filter((_, at) => at !== index) })}>
										<FieldGrid>
											<Input
												label={P.accountLabel}
												value={account.label ?? ''}
												maxLength={60}
												onChange={(event) => setAccount(index, { label: event.target.value })}
											/>
											<Input
												label={P.accountCurrency}
												value={account.currency ?? ''}
												maxLength={3}
												autoComplete="off"
												onChange={(event) => setAccount(index, { currency: event.target.value })}
											/>
										</FieldGrid>
										<TextArea
											label={P.accountRows}
											value={account.rows ?? ''}
											onChange={(event) => setAccount(index, { rows: event.target.value })}
										/>
									</EntryGroup>
								))}
								<Button
									size="sm"
									variant="secondary"
									disabled={accounts.length >= 10}
									onClick={() =>
										set({ accounts: [...accounts, { ...newAccount(), rows: rowsText(newAccount().rows) }] })
									}>
									{P.addAccount}
								</Button>
							</div>
						) : null}
					</div>
				);
			}}
		/>
	);
}
