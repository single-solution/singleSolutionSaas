'use client';
/** Manual credit/debit with a reason (POST /v1/dashboard/adjustments with the dashboard session; audited). */
import { createElement as h, useState } from 'react';
import { Button, Callout, Input, Select } from '@ss/ui';
import { createTranslator } from '../../../headless/strings.js';
import en from '../../../strings/en.json' with { type: 'json' };

const t = createTranslator(en);

/** @param {{ customerId: string, websiteId: string, reasons: string[], requireNote: boolean }} props */
export function AdjustForm({ customerId, websiteId, reasons, requireNote }) {
	const [points, setPoints] = useState('');
	const [reason, setReason] = useState(reasons[0] ?? '');
	const [note, setNote] = useState('');
	const [status, setStatus] = useState(/** @type {{ tone: 'success' | 'danger', text: string } | null} */ (null));
	const [busy, setBusy] = useState(false);
	/** @param {{ preventDefault: () => void }} event */
	const submit = async (event) => {
		event.preventDefault();
		setBusy(true);
		const response = await fetch('/v1/dashboard/adjustments', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID(), 'x-ss-website': websiteId },
			body: JSON.stringify({ customerId, points: Number(points), reason, ...(note ? { note } : {}) }),
		});
		const body = await response.json().catch(() => ({}));
		setBusy(false);
		if (response.ok) {
			setStatus({ tone: 'success', text: t('dashboard.member.adjusted') });
			globalThis.location.reload();
		} else setStatus({ tone: 'danger', text: body.detail ?? body.title ?? String(response.status) });
	};
	return h(
		'form',
		{ onSubmit: submit, className: 'grid gap-3 sm:grid-cols-3' },
		h(Input, {
			label: t('dashboard.member.points'),
			type: 'number',
			required: true,
			value: points,
			onChange: (/** @type {any} */ e) => setPoints(e.target.value),
		}),
		h(Select, {
			label: t('dashboard.member.reason'),
			value: reason,
			options: reasons.map((code) => ({ value: code, label: code })),
			onChange: (/** @type {any} */ e) => setReason(e.target.value),
		}),
		h(Input, {
			label: t('dashboard.member.note'),
			required: requireNote,
			value: note,
			onChange: (/** @type {any} */ e) => setNote(e.target.value),
		}),
		h('div', { className: 'sm:col-span-3' }, h(Button, { type: 'submit', loading: busy }, t('dashboard.member.submit'))),
		status ? h('div', { className: 'sm:col-span-3' }, h(Callout, { tone: status.tone }, status.text)) : null,
	);
}
