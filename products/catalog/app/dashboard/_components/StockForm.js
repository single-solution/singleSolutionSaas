'use client';
/** Set a variant's stock (POST /v1/dashboard/variants/{id}/stock with the dashboard session; guarded by the quantity shown; audited). */
import { createElement as h, useState } from 'react';
import { Button, Input } from '@ss/ui';
import { createTranslator } from '../../../headless/strings.js';
import en from '../../../strings/en.json' with { type: 'json' };

const t = createTranslator(en);

/** @param {{ variantId: string, quantity: number, websiteId: string }} props */
export function StockForm({ variantId, quantity, websiteId }) {
	const [value, setValue] = useState(String(quantity));
	const [shown, setShown] = useState(quantity);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState(/** @type {string | null} */ (null));
	/** @param {any} event */
	const submit = async (event) => {
		event.preventDefault();
		setBusy(true);
		const response = await fetch(`/v1/dashboard/variants/${encodeURIComponent(variantId)}/stock`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID(), 'x-ss-website': websiteId },
			body: JSON.stringify({ quantity: Number(value), expectedQuantity: shown, reason: 'dashboard' }),
		});
		const json = await response.json().catch(() => ({}));
		setBusy(false);
		if (response.ok) {
			setShown(json.quantity);
			setMessage(t('dashboard.stock.saved'));
		} else setMessage(json.detail ?? json.title ?? String(response.status));
	};
	return h(
		'form',
		{ className: 'flex items-end gap-2', onSubmit: submit },
		h(Input, {
			label: t('dashboard.items.stock'),
			type: 'number',
			value,
			step: 1,
			onChange: (/** @type {any} */ e) => setValue(e.target.value),
		}),
		h(Button, { type: 'submit', loading: busy, variant: 'secondary' }, t('dashboard.stock.save')),
		message ? h('span', { role: 'status', className: 'text-sm text-muted' }, message) : null,
	);
}
