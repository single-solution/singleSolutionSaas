'use client';
/**
 * Staff actions on one claim (POST /v1/dashboard/claims/{id}/… with the dashboard session; audited): move it to a next
 * status with a note, add an internal note, assign it, record a refund, decide restock per line and write to the
 * customer. Each form shows only when its element is on.
 */
import { createElement as h, useState } from 'react';
import { Button, Callout, Checkbox, Input, Select, TextArea } from '@ss/ui';
import { createTranslator } from '../../../headless/strings.js';
import en from '../../../strings/en.json' with { type: 'json' };

const t = createTranslator(en);

/**
 * @param {{ claim: Record<string, any>, websiteId: string, statuses: Array<{ key: string, label: string }>,
 *   methods: Array<{ key: string, label: string }> | null, restock: boolean, messages: boolean }} props
 */
export function ClaimActions({ claim, websiteId, statuses, methods, restock, messages }) {
	const [to, setTo] = useState(claim.nextStatuses[0] ?? '');
	const [note, setNote] = useState('');
	const [internal, setInternal] = useState('');
	const [assignee, setAssignee] = useState(claim.assignee ?? '');
	const [amount, setAmount] = useState('');
	const [method, setMethod] = useState(methods?.[0]?.key ?? '');
	const [reference, setReference] = useState('');
	const [message, setMessage] = useState('');
	const [back, setBack] = useState(/** @type {Record<string, boolean>} */ ({}));
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState(/** @type {{ tone: 'success' | 'danger', text: string } | null} */ (null));
	/** @param {string} action @param {Record<string, unknown>} body */
	const send = async (action, body) => {
		setBusy(true);
		const response = await fetch(`/v1/dashboard/claims/${encodeURIComponent(claim.id)}/${action}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID(), 'x-ss-website': websiteId },
			body: JSON.stringify(body),
		});
		const json = await response.json().catch(() => ({}));
		setBusy(false);
		if (response.ok) {
			setNotice({ tone: 'success', text: t('dashboard.claim.saved') });
			globalThis.location.reload();
		} else setNotice({ tone: 'danger', text: json.detail ?? json.title ?? String(response.status) });
	};
	/** @param {string} action @param {() => Record<string, unknown>} body */
	const submit = (action, body) => (/** @type {{ preventDefault: () => void }} */ event) => {
		event.preventDefault();
		void send(action, body());
	};
	const labelOf = (/** @type {string} */ key) => statuses.find((status) => status.key === key)?.label ?? key;
	const undecided = /** @type {Array<Record<string, any>>} */ (claim.lines).filter((line) => line.restock === null);
	return h(
		'div',
		{ className: 'mt-3 grid gap-4 md:grid-cols-2' },
		claim.nextStatuses.length > 0
			? h(
					'form',
					{ className: 'space-y-2', onSubmit: submit('transition', () => ({ to, ...(note ? { note } : {}) })) },
					h(Select, {
						label: t('dashboard.claim.move_to'),
						value: to,
						options: claim.nextStatuses.map((/** @type {string} */ key) => ({ value: key, label: labelOf(key) })),
						onChange: (/** @type {any} */ e) => setTo(e.target.value),
					}),
					h(TextArea, {
						label: t('dashboard.claim.note'),
						rows: 2,
						value: note,
						onChange: (/** @type {any} */ e) => setNote(e.target.value),
					}),
					h(Button, { type: 'submit', loading: busy }, t('dashboard.claim.move')),
				)
			: null,
		h(
			'form',
			{ className: 'space-y-2', onSubmit: submit('notes', () => ({ body: internal })) },
			h(TextArea, {
				label: t('dashboard.claim.internal_note'),
				rows: 2,
				value: internal,
				onChange: (/** @type {any} */ e) => setInternal(e.target.value),
			}),
			h(Button, { type: 'submit', variant: 'secondary', loading: busy }, t('dashboard.claim.add_note')),
		),
		h(
			'form',
			{ className: 'space-y-2', onSubmit: submit('assign', () => ({ assignee: assignee.trim() === '' ? null : assignee })) },
			h(Input, {
				label: t('dashboard.claim.assignee'),
				value: assignee,
				onChange: (/** @type {any} */ e) => setAssignee(e.target.value),
			}),
			h(Button, { type: 'submit', variant: 'secondary', loading: busy }, t('dashboard.claim.assign')),
		),
		methods
			? h(
					'form',
					{
						className: 'space-y-2',
						onSubmit: submit('refunds', () => ({ amount: Number(amount), method, ...(reference ? { reference } : {}) })),
					},
					h(Input, {
						label: t('dashboard.claim.refund_amount', { currency: claim.currency ?? '' }),
						type: 'number',
						min: 1,
						value: amount,
						onChange: (/** @type {any} */ e) => setAmount(e.target.value),
					}),
					h(Select, {
						label: t('dashboard.claim.refund_method'),
						value: method,
						options: methods.map((entry) => ({ value: entry.key, label: entry.label })),
						onChange: (/** @type {any} */ e) => setMethod(e.target.value),
					}),
					h(Input, {
						label: t('dashboard.claim.refund_reference'),
						value: reference,
						onChange: (/** @type {any} */ e) => setReference(e.target.value),
					}),
					h(Button, { type: 'submit', loading: busy }, t('dashboard.claim.refund')),
				)
			: null,
		restock && undecided.length > 0
			? h(
					'form',
					{
						className: 'space-y-2',
						onSubmit: submit('restocks', () => ({
							lines: undecided.map((line) => ({ lineId: line.lineId, restock: back[line.lineId] === true })),
						})),
					},
					...undecided.map((line) =>
						h(Checkbox, {
							key: line.lineId,
							label: t('dashboard.claim.restock_line', { title: line.title ?? line.itemId, quantity: line.quantity }),
							checked: back[line.lineId] === true,
							onChange: (/** @type {any} */ e) => setBack({ ...back, [line.lineId]: e.target.checked }),
						}),
					),
					h(Button, { type: 'submit', variant: 'secondary', loading: busy }, t('dashboard.claim.restock')),
				)
			: null,
		messages
			? h(
					'form',
					{ className: 'space-y-2', onSubmit: submit('messages', () => ({ body: message })) },
					h(TextArea, {
						label: t('dashboard.claim.message'),
						rows: 2,
						value: message,
						onChange: (/** @type {any} */ e) => setMessage(e.target.value),
					}),
					h(Button, { type: 'submit', loading: busy }, t('dashboard.claim.send')),
				)
			: null,
		notice ? h(Callout, { tone: notice.tone }, notice.text) : null,
	);
}
